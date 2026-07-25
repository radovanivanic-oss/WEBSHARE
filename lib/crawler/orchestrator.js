const crypto = require("crypto");
const fs = require("fs");
const { getCrawlerV2Config, STATE_SCHEMA_VERSION } = require("./config");
const { RecoveryRequiredError } = require("./errors");
const { createFaultInjector } = require("./fault-injection");
const { createFrontierStore } = require("./frontier-store");
const { createItemStore } = require("./item-store");
const { exportRunJsonl } = require("./jsonl-export");
const { acquireCrawlerLock } = require("./lock");
const {
  assertNewRunCanStart,
  detectLegacyCheckpoints,
  recoverRun,
} = require("./recovery");
const { RUN_STATUSES, createRunStore } = require("./run-store");
const { openCrawlerDatabase } = require("./state-db");
const { buildCrawlerStatus } = require("./status");
const { createShutdownController, runWorkers } = require("./worker");

function createStores(database) {
  return {
    frontierStore: createFrontierStore(database),
    itemStore: createItemStore(database),
    runStore: createRunStore(database),
  };
}

function runIdentity(config) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    algorithmVersion: config.algorithm.algorithmVersion,
    algorithmFingerprint: config.algorithmFingerprint,
  };
}

function resolveRunArtifactPath(template, runId, exportId) {
  return template
    .replaceAll("{run_id}", runId)
    .replaceAll("{export_id}", exportId);
}

function attachShutdownSignals(shutdown) {
  const onSignal = (signal) => shutdown.request(signal);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

async function executeCrawler(options = {}) {
  const config = options.config || getCrawlerV2Config();
  const command = options.command || "crawl";
  const fault = createFaultInjector(options.faultHooks, {
    allowTestFaultInjection: options.allowTestFaultInjection === true,
  });
  const shutdown = options.shutdown || createShutdownController();
  const runId = options.runId || crypto.randomUUID();
  let database;
  let lock;
  let stores;
  let selectedRunId = runId;
  let detachSignals = () => {};
  let crawlFinalized = false;

  if (!options.transport || typeof options.transport.fetchPage !== "function") {
    throw new TypeError("Crawler vyžaduje explicitný search transport.");
  }

  detachSignals = attachShutdownSignals(shutdown);
  try {
    if (command === "crawl") {
      assertNewRunCanStart(config);
      lock = acquireCrawlerLock(config.lockPath, selectedRunId);
      database = openCrawlerDatabase(config.stateDbPath);
      stores = createStores(database);
      database
        .transaction(() => {
          stores.runStore.createRun({
            schemaVersion: STATE_SCHEMA_VERSION,
            algorithmVersion: config.algorithm.algorithmVersion,
            algorithmFingerprint: config.algorithmFingerprint,
            partitionCompletenessProven:
              config.algorithm.partitionCompletenessProven,
            rootPrefixCount: config.algorithm.roots.length,
          }, selectedRunId);
          stores.frontierStore.seedRoots(selectedRunId, config.algorithm.roots);
        })
        .immediate();
    } else {
      if (!fs.existsSync(config.stateDbPath)) {
        throw new Error(`Crawler state DB neexistuje: ${config.stateDbPath}`);
      }
      database = openCrawlerDatabase(config.stateDbPath, { create: false });
      stores = createStores(database);
      const latest = options.runId
        ? stores.runStore.getRun(options.runId)
        : stores.runStore.getLatestRun();
      if (!latest) throw new Error("Crawler state DB neobsahuje žiadny run.");
      selectedRunId = latest.run_id;
      lock = acquireCrawlerLock(config.lockPath, selectedRunId, {
        recoverStale: true,
      });
      recoverRun({
        runId: selectedRunId,
        runStore: stores.runStore,
        frontierStore: stores.frontierStore,
        config,
      });
      if (command === "retry-failed") {
        stores.frontierStore.retryFailed(selectedRunId);
      }
    }

    await runWorkers({
      runId: selectedRunId,
      frontierStore: stores.frontierStore,
      itemStore: stores.itemStore,
      runStore: stores.runStore,
      transport: options.transport,
      normalizeItem: options.normalizeItem || ((item) => item),
      config,
      fault,
      shutdown,
    });
    if (shutdown.requested) {
      stores.runStore.refreshCounts(selectedRunId);
      stores.runStore.setStatus(selectedRunId, RUN_STATUSES.ABORTED, {
        reconciliationSafe: false,
        errorMessage: `Controlled shutdown: ${shutdown.signal || "requested"}`,
      });
      return buildCrawlerStatus(stores.runStore, selectedRunId);
    }
    await fault("before_run_finalize", { runId: selectedRunId });
    if (shutdown.requested) {
      stores.runStore.setStatus(selectedRunId, RUN_STATUSES.ABORTED, {
        reconciliationSafe: false,
        errorMessage: `Controlled shutdown: ${shutdown.signal || "requested"}`,
      });
      return buildCrawlerStatus(stores.runStore, selectedRunId);
    }
    stores.runStore.finalize(selectedRunId);
    crawlFinalized = true;
    if (shutdown.requested) {
      stores.runStore.setStatus(selectedRunId, RUN_STATUSES.ABORTED, {
        reconciliationSafe: false,
        errorMessage: `Controlled shutdown: ${shutdown.signal || "requested"}`,
      });
      return buildCrawlerStatus(stores.runStore, selectedRunId);
    }
    const status = buildCrawlerStatus(stores.runStore, selectedRunId);
    if (options.exportJsonl === true) {
      const exportId = crypto.randomUUID();
      status.export = await exportRunJsonl({
        itemStore: stores.itemStore,
        run: status.run,
        outputPath: resolveRunArtifactPath(
          config.exportPath,
          selectedRunId,
          exportId
        ),
        manifestPath: resolveRunArtifactPath(
          config.manifestPath,
          selectedRunId,
          exportId
        ),
        fault: options.faultHooks ? fault : null,
        shouldAbort: () => shutdown.requested,
      });
    }
    return status;
  } catch (error) {
    if (stores?.runStore && selectedRunId && !error?.simulateCrash) {
      try {
        if (shutdown.requested) {
          stores.runStore.setStatus(selectedRunId, RUN_STATUSES.ABORTED, {
            reconciliationSafe: false,
            errorMessage: `Controlled shutdown: ${shutdown.signal || "requested"}`,
          });
        } else if (error instanceof RecoveryRequiredError) {
          stores.runStore.markRecoveryRequired(selectedRunId, error);
        } else if (!crawlFinalized) {
          stores.runStore.setStatus(selectedRunId, RUN_STATUSES.ABORTED, {
            reconciliationSafe: false,
            errorMessage: error?.message || String(error),
          });
        }
      } catch {
        // The original failure is more useful and no destructive fallback exists.
      }
    }
    throw error;
  } finally {
    detachSignals();
    database?.close();
    lock?.release();
  }
}

function inspectCrawlerState(options = {}) {
  const config = options.config || getCrawlerV2Config();
  if (!fs.existsSync(config.stateDbPath)) {
    return {
      state: "not_initialized",
      stateDbPath: config.stateDbPath,
      legacyCheckpoints: detectLegacyCheckpoints(config.legacyCheckpointPaths),
    };
  }
  const database = openCrawlerDatabase(config.stateDbPath, {
    create: false,
    readonly: true,
  });
  try {
    const stores = createStores(database);
    const status = buildCrawlerStatus(stores.runStore, options.runId);
    if (status.run) {
      stores.runStore.validateInvariants(status.run.run_id, {
        persistCounts: false,
      });
    }
    return { ...status, stateDbPath: config.stateDbPath };
  } finally {
    database.close();
  }
}

function validateCrawlerState(options = {}) {
  const config = options.config || getCrawlerV2Config();
  const database = openCrawlerDatabase(config.stateDbPath, {
    create: false,
    readonly: true,
  });
  try {
    const stores = createStores(database);
    const run = options.runId
      ? stores.runStore.getRun(options.runId)
      : stores.runStore.getLatestRun();
    if (!run) throw new Error("Crawler state DB neobsahuje žiadny run.");
    stores.runStore.validateRunIdentity(run.run_id, runIdentity(config));
    const validation = stores.runStore.validateInvariants(run.run_id, {
      persistCounts: false,
    });
    return {
      valid: true,
      run: validation.run,
      counts: validation.counts,
      reconciliation_safe: validation.run.reconciliation_safe === 1,
    };
  } finally {
    database.close();
  }
}

module.exports = {
  createStores,
  executeCrawler,
  inspectCrawlerState,
  resolveRunArtifactPath,
  validateCrawlerState,
};
