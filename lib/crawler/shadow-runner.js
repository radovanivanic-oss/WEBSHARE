const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  executeCrawler,
  inspectCrawlerState,
  validateCrawlerState,
} = require("./orchestrator");
const { openCrawlerDatabase } = require("./state-db");
const { createShutdownController } = require("./worker");
const {
  assertSafeShadowPath,
  atomicWriteJson,
  createShadowConfig,
  createShadowGuard,
  createShadowPathGuard,
  directorySize,
  pathComparisonKey,
  readShadowReport,
  validateShadowResume,
} = require("./shadow");

function sanitizeShadowErrorMessage(error) {
  return String(error?.message || error || "unknown")
    .replace(/([?&]wst=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(
      /(\"?(?:wst|token|password|digest|authorization)\"?\s*[:=]\s*)[^,\s}]+/gi,
      "$1[REDACTED]"
    )
    .slice(0, 1000);
}

function prepareShadowRoot(shadowConfig) {
  assertSafeShadowPath(
    path.dirname(shadowConfig.paths.root),
    shadowConfig.paths.root,
    "shadow root"
  );
  fs.mkdirSync(shadowConfig.paths.root, { recursive: true, mode: 0o700 });
  const pathGuard = createShadowPathGuard(shadowConfig.paths.root);
  pathGuard.verify();
  fs.mkdirSync(shadowConfig.paths.exports, { recursive: true, mode: 0o700 });
  pathGuard.verify(shadowConfig.paths.exports, "exports");
  fs.mkdirSync(shadowConfig.paths.logs, { recursive: true, mode: 0o700 });
  pathGuard.verify(shadowConfig.paths.logs, "logs");
  for (const [label, target] of Object.entries(shadowConfig.paths)) {
    assertSafeShadowPath(shadowConfig.paths.root, target, label);
  }
  return pathGuard;
}

function assertShadowRunId(runId) {
  if (
    typeof runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      runId
    )
  ) {
    throw new Error("Shadow run_id nemá bezpečný UUID formát.");
  }
  return runId;
}

function frontierSummary(run) {
  if (!run) return null;
  return {
    queued: Number(run.queued_count || 0),
    in_progress: Number(run.in_progress_count || 0),
    complete: Number(run.complete_count || 0),
    failed: Number(run.failed_count || 0),
    blocked: Number(run.blocked_count || 0),
  };
}

function readShadowDiagnostics(shadowConfig, runId = null) {
  if (!fs.existsSync(shadowConfig.paths.stateDb)) {
    return { last_committed_page: null, last_error: null };
  }
  const database = openCrawlerDatabase(shadowConfig.paths.stateDb, {
    create: false,
    readonly: true,
  });
  try {
    const selected =
      runId ||
      database
        .prepare(
          "SELECT run_id FROM crawl_runs ORDER BY started_at DESC, run_id DESC LIMIT 1"
        )
        .get()?.run_id;
    if (!selected) return { last_committed_page: null, last_error: null };
    const lastPage =
      database
        .prepare(`
          SELECT prefix, depth, offset, item_count, reported_total,
                 page_fingerprint, committed_at
          FROM crawl_pages
          WHERE run_id = ?
          ORDER BY committed_at DESC, id DESC
          LIMIT 1
        `)
        .get(selected) || null;
    const lastError =
      database
        .prepare(`
          SELECT prefix, depth, failure_class, error_code, error_message, created_at
          FROM crawl_failures
          WHERE run_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `)
        .get(selected) || null;
    return { last_committed_page: lastPage, last_error: lastError };
  } finally {
    database.close();
  }
}

function reconcileShadowReport(shadowConfig, report) {
  if (!report || !fs.existsSync(shadowConfig.paths.stateDb)) return report;
  const database = openCrawlerDatabase(shadowConfig.paths.stateDb, {
    create: false,
    readonly: true,
  });
  try {
    const run =
      (report.run_id
        ? database
            .prepare("SELECT * FROM crawl_runs WHERE run_id = ?")
            .get(report.run_id)
        : null) ||
      database
        .prepare(
          "SELECT * FROM crawl_runs ORDER BY started_at DESC, run_id DESC LIMIT 1"
        )
        .get();
    if (!run) return report;
    const pages = Number(
      database
        .prepare("SELECT COUNT(*) AS count FROM crawl_pages WHERE run_id = ?")
        .get(run.run_id).count
    );
    const leases = Number(
      database
        .prepare(
          "SELECT COALESCE(SUM(attempt_count), 0) AS count FROM crawl_frontier WHERE run_id = ?"
        )
        .get(run.run_id).count
    );
    const frontierRows = Number(
      database
        .prepare("SELECT COUNT(*) AS count FROM crawl_frontier WHERE run_id = ?")
        .get(run.run_id).count
    );
    const hasBudget = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='shadow_run_budget'"
      )
      .get();
    const budget = hasBudget
      ? database
          .prepare("SELECT * FROM shadow_run_budget WHERE run_id = ?")
          .get(run.run_id)
      : null;
    return {
      ...report,
      run_id: run.run_id,
      items_unique: Math.max(
        Number(report.items_unique || 0),
        Number(run.unique_items || 0)
      ),
      pages_committed: Math.max(
        Number(report.pages_committed || 0),
        pages
      ),
      prefixes_leased: Math.max(
        Number(report.prefixes_leased || 0),
        leases
      ),
      prefixes_complete: Math.max(
        Number(report.prefixes_complete || 0),
        Number(run.complete_count || 0)
      ),
      prefixes_failed: Math.max(
        Number(report.prefixes_failed || 0),
        Number(run.failed_count || 0)
      ),
      prefixes_blocked: Math.max(
        Number(report.prefixes_blocked || 0),
        Number(run.blocked_count || 0)
      ),
      frontier_rows: Math.max(
        Number(report.frontier_rows || 0),
        frontierRows
      ),
      requests_total: Math.max(
        Number(report.requests_total || 0),
        Number(budget?.requests_total || 0)
      ),
      login_requests: Math.max(
        Number(report.login_requests || 0),
        Number(budget?.login_requests || 0)
      ),
      search_requests: Math.max(
        Number(report.search_requests || 0),
        Number(budget?.search_requests || 0)
      ),
      retry_requests: Math.max(
        Number(report.retry_requests || 0),
        Number(budget?.retry_requests || 0)
      ),
      duration_ms: Math.max(
        Number(report.duration_ms || 0),
        Number(budget?.duration_ms || 0)
      ),
      peak_disk_bytes: Math.max(
        Number(report.peak_disk_bytes || 0),
        Number(budget?.peak_disk_bytes || 0)
      ),
    };
  } finally {
    database.close();
  }
}

function buildShadowReport(shadowConfig, guard, status, extra = {}) {
  const run = status?.run || null;
  const frontierStates = frontierSummary(run);
  return guard.snapshot({
    ...extra,
    run_id: run?.run_id || extra.runId || null,
    status: run?.status || status?.state || extra.status || "running",
    algorithm_fingerprint:
      run?.algorithm_fingerprint || shadowConfig.crawler.algorithmFingerprint,
    root_prefixes: [...shadowConfig.crawler.algorithm.roots],
    frontier_states: frontierStates,
    frontier_rows: frontierStates
      ? Object.values(frontierStates).reduce((total, value) => total + value, 0)
      : Number(extra.frontier_rows || 0),
    reconciliation_safe: false,
    partition_completeness_proven: false,
  });
}

function withReadOnlyShadowSnapshot(shadowConfig, operation) {
  if (!fs.existsSync(shadowConfig.paths.stateDb)) return operation(null);
  createShadowPathGuard(shadowConfig.paths.root).verify(
    shadowConfig.paths.stateDb,
    "read-only state DB"
  );
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-shadow-status-")
  );
  const temporaryIdentity = fs.lstatSync(temporaryRoot);
  const snapshotDb = path.join(temporaryRoot, "crawler-state.sqlite");
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${shadowConfig.paths.stateDb}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${snapshotDb}${suffix}`);
    }
    return operation(snapshotDb);
  } finally {
    if (fs.existsSync(temporaryRoot)) {
      const current = fs.lstatSync(temporaryRoot);
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === temporaryIdentity.dev &&
        current.ino === temporaryIdentity.ino
      ) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}

function inspectShadowStateDirect(shadowConfig, runId, stateDbPath) {
  const config = stateDbPath
    ? { ...shadowConfig.crawler, stateDbPath }
    : shadowConfig.crawler;
  const state = inspectCrawlerState({
    config,
    runId,
  });
  const diagnostics = stateDbPath
    ? readShadowDiagnostics(
        {
          ...shadowConfig,
          paths: { ...shadowConfig.paths, stateDb: stateDbPath },
        },
        state.run?.run_id || runId
      )
    : { last_committed_page: null, last_error: null };
  let budget = null;
  if (stateDbPath) {
    const database = openCrawlerDatabase(stateDbPath, {
      create: false,
      readonly: true,
    });
    try {
      const hasBudget = database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='shadow_run_budget'"
        )
        .get();
      if (hasBudget && state.run?.run_id) {
        budget =
          database
            .prepare("SELECT * FROM shadow_run_budget WHERE run_id = ?")
            .get(state.run.run_id) || null;
      }
    } finally {
      database.close();
    }
  }
  return { state, diagnostics, budget };
}

function inspectShadowState(options = {}) {
  const shadowConfig =
    options.shadowConfig || createShadowConfig(options);
  if (fs.existsSync(shadowConfig.paths.root)) {
    createShadowPathGuard(shadowConfig.paths.root).verify(
      shadowConfig.paths.report,
      "shadow report"
    );
  }
  const report = readShadowReport(shadowConfig.paths.report);
  const { state, diagnostics, budget } = withReadOnlyShadowSnapshot(
    shadowConfig,
    (stateDbPath) =>
      inspectShadowStateDirect(shadowConfig, options.runId, stateDbPath)
  );
  return {
    ...state,
    shadow_mode: true,
    shadow_root: shadowConfig.paths.root,
    stop_reason: report?.shadow_stop_reason || null,
    limits: report?.shadow_limits || shadowConfig.limits,
    counters: report
      ? {
          requests_total: report.requests_total,
          login_requests: report.login_requests,
          search_requests: report.search_requests,
          retry_requests: report.retry_requests,
          items_unique: report.items_unique,
          pages_committed: report.pages_committed,
          prefixes_leased: report.prefixes_leased,
        }
      : null,
    frontier_states: frontierSummary(state.run),
    disk_usage_bytes: directorySize(shadowConfig.paths.root),
    duration_ms: report?.duration_ms || 0,
    durable_budget: budget
      ? {
          requests_total: Number(budget.requests_total),
          duration_ms: Number(budget.duration_ms),
          peak_disk_bytes: Number(budget.peak_disk_bytes),
          shadow_root: budget.shadow_root,
          limits: JSON.parse(budget.limits_json),
        }
      : null,
    ...diagnostics,
    reconciliation_safe: false,
  };
}

function validateShadowState(options = {}) {
  const shadowConfig =
    options.shadowConfig || createShadowConfig(options);
  const validation = withReadOnlyShadowSnapshot(
    shadowConfig,
    (stateDbPath) => {
      if (!stateDbPath) {
        throw new Error(`Crawler state DB neexistuje: ${shadowConfig.paths.stateDb}`);
      }
      return validateCrawlerState({
        config: { ...shadowConfig.crawler, stateDbPath },
        runId: options.runId,
      });
    }
  );
  return {
    ...validation,
    shadow_mode: true,
    shadow_root: shadowConfig.paths.root,
    reconciliation_safe: false,
  };
}

function validateShadowRunState(command, report, state, options = {}) {
  const run = state?.run;
  if (!run) throw new Error("Shadow resume nenašiel run v state DB.");
  if (report.run_id !== run.run_id) {
    throw new Error("Shadow report run_id sa nezhoduje so state DB.");
  }
  if (options.runId && options.runId !== run.run_id) {
    throw new Error("Shadow resume nesmie zmeniť run_id.");
  }
  const budget = state.durable_budget;
  if (!budget) {
    throw new Error("Shadow run nemá transakčný durable budget.");
  }
  if (budget.shadow_root !== pathComparisonKey(report.shadow_root)) {
    throw new Error("Shadow durable budget patrí inému canonical rootu.");
  }
  if (
    Number(report.requests_total || 0) < Number(budget.requests_total) ||
    Number(report.duration_ms || 0) < Number(budget.duration_ms) ||
    Number(report.peak_disk_bytes || 0) < Number(budget.peak_disk_bytes)
  ) {
    throw new Error("Shadow report sa pokúsil znížiť durable počítadlá.");
  }
  for (const [field, original] of Object.entries(budget.limits || {})) {
    if (Number(report.shadow_limits?.[field]) > Number(original)) {
      throw new Error(`Shadow report zvýšil durable limit ${field}.`);
    }
  }
  if (run.status === "recovery_required" || run.status === "complete") {
    throw new Error(`Shadow run v stave ${run.status} nemožno automaticky obnoviť.`);
  }
  if (Number(run.blocked_count) > 0) {
    throw new Error("Shadow run s blocked prefixom nemožno automaticky resume/retry.");
  }
  if (command === "resume") {
    if (run.status === "complete_with_failures" || Number(run.failed_count) > 0) {
      throw new Error("Failed prefixy vyžadujú explicitný shadow --retry-failed.");
    }
    if (
      run.status === "incomplete" &&
      Number(run.queued_count) === 0 &&
      Number(run.in_progress_count) === 0
    ) {
      throw new Error("Terminálny/exportovaný incomplete shadow run nemá resumable work.");
    }
  }
  if (command === "retry-failed" && Number(run.failed_count) === 0) {
    throw new Error("Shadow --retry-failed nemá žiadny failed prefix.");
  }
}

async function executeShadowCrawler(options = {}) {
  const shadowConfig =
    options.shadowConfig || createShadowConfig(options);
  const command = options.command || "crawl";
  if (!["crawl", "resume", "retry-failed"].includes(command)) {
    throw new Error(`Nepodporovaný shadow crawler command: ${command}`);
  }
  const pathGuard = prepareShadowRoot(shadowConfig);
  await options.lifecycleHooks?.afterPathValidation?.({
    shadowConfig,
    pathGuard,
  });
  pathGuard.verify();
  const previousReport =
    command === "crawl"
      ? null
      : reconcileShadowReport(
          shadowConfig,
          readShadowReport(shadowConfig.paths.report)
        );
  if (command !== "crawl") {
    validateShadowResume(shadowConfig, previousReport, {
      resumeShadowLimited: options.resumeShadowLimited === true,
    });
    const state = inspectShadowState({
      shadowConfig,
      runId: previousReport?.run_id,
    });
    validateShadowRunState(command, previousReport, state, {
      runId: options.runId,
    });
  }
  const selectedRunId =
    (command === "crawl" ? options.runId : null) ||
    previousReport?.run_id ||
    (command === "crawl" ? crypto.randomUUID() : null);
  assertShadowRunId(selectedRunId);

  const shutdown = options.shutdown || createShutdownController();
  const guard = createShadowGuard({
    shadowConfig,
    shutdown,
    logger: options.logger,
    previousReport,
    pathGuard,
    monotonicNow: options.monotonicNow,
    onUpdate(snapshot) {
      atomicWriteJson(shadowConfig.paths.report, {
        ...snapshot,
        run_id: selectedRunId,
        status: "running",
        algorithm_fingerprint: shadowConfig.crawler.algorithmFingerprint,
        root_prefixes: [...shadowConfig.crawler.algorithm.roots],
        reconciliation_safe: false,
        partition_completeness_proven: false,
      }, { pathGuard });
    },
  });
  let status = null;
  let caught = null;
  const initialReport = buildShadowReport(shadowConfig, guard, null, {
    runId: selectedRunId,
    status: "running",
    finished: false,
  });
  atomicWriteJson(shadowConfig.paths.report, initialReport, { pathGuard });

  try {
    const transport =
      options.transport ||
      (await options.transportFactory?.({
        requestMeter: guard,
        signal: shutdown.abortSignal,
      }));
    if (!transport || typeof transport.fetchPage !== "function") {
      throw new TypeError("Shadow crawler vyžaduje explicitný search transport.");
    }
    status = await executeCrawler({
      command,
      config: shadowConfig.crawler,
      transport,
      normalizeItem: options.normalizeItem,
      exportJsonl: options.exportJsonl !== false,
      shutdown,
      shadowGuard: guard,
      pathGuard,
      runId: selectedRunId,
      faultHooks: options.faultHooks,
      allowTestFaultInjection: options.allowTestFaultInjection,
      exportManifestExtras: {
        shadow_mode: true,
        shadow_limits: shadowConfig.limits,
        reconciliation_safe: false,
        partition_completeness_proven: false,
        is_full: false,
      },
      exportPathGuard: pathGuard,
      exportDiskCheck: ({ additionalBytes = 0 }) => {
        pathGuard.verify();
        guard.check("before_export_write");
        const usage = directorySize(shadowConfig.paths.root);
        const dbBytes = fs.existsSync(shadowConfig.paths.stateDb)
          ? fs.statSync(shadowConfig.paths.stateDb).size
          : 0;
        const walPath = `${shadowConfig.paths.stateDb}-wal`;
        const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
        if (
          usage +
            additionalBytes +
            Math.max(dbBytes, walBytes) >
          shadowConfig.limits.maxDiskBytes
        ) {
          guard.stop(
            require("./shadow").SHADOW_STOP_REASONS.MAX_DISK,
            "Shadow export by prekročil disk limit."
          );
        }
      },
      buildExportExtraFiles(exportStatus) {
        const report = buildShadowReport(
          shadowConfig,
          guard,
          exportStatus,
          { finished: true }
        );
        return [{ name: "shadow-report.json", data: report }];
      },
    });
    return status;
  } catch (error) {
    caught = error;
    throw error;
  } finally {
    guard.dispose();
    if (!status && fs.existsSync(shadowConfig.paths.stateDb)) {
      try {
        status = inspectCrawlerState({ config: shadowConfig.crawler });
      } catch {
        status = null;
      }
    }
    let diagnostics = { last_committed_page: null, last_error: null };
    try {
      diagnostics = readShadowDiagnostics(
        shadowConfig,
        status?.run?.run_id || previousReport?.run_id
      );
    } catch (error) {
      if (!caught) caught = error;
      diagnostics.last_error = {
        code: error.code || "shadow_diagnostics_failed",
        message: error.message,
      };
    }
    let report = buildShadowReport(shadowConfig, guard, status, {
      finished: true,
      error: caught
        ? {
            code: caught.code || null,
            message: sanitizeShadowErrorMessage(caught),
          }
        : null,
      ...diagnostics,
    });
    report = reconcileShadowReport(shadowConfig, report);
    report.reconciliation_safe = false;
    report.partition_completeness_proven = false;
    atomicWriteJson(shadowConfig.paths.report, report, { pathGuard });
  }
}

module.exports = {
  assertShadowRunId,
  buildShadowReport,
  executeShadowCrawler,
  inspectShadowState,
  prepareShadowRoot,
  reconcileShadowReport,
  readShadowDiagnostics,
  validateShadowState,
  validateShadowRunState,
  withReadOnlyShadowSnapshot,
  sanitizeShadowErrorMessage,
};
