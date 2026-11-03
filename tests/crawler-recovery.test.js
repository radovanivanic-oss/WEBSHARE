const assert = require("node:assert/strict");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  algorithmFingerprint,
  buildAlgorithmConfig,
  getCrawlerV2Config,
  STATE_SCHEMA_VERSION,
} = require("../lib/crawler/config");
const {
  loadAndValidateCatalogManifest,
} = require("../lib/catalog-safety");
const { createFaultInjector } = require("../lib/crawler/fault-injection");
const { CrawlerInvariantError } = require("../lib/crawler/errors");
const { exportRunJsonl } = require("../lib/crawler/jsonl-export");
const { pageFingerprint } = require("../lib/crawler/item-store");
const { createStores, executeCrawler } = require("../lib/crawler/orchestrator");
const {
  acquireCrawlerLock,
  inspectLock,
  processStartToken,
} = require("../lib/crawler/lock");
const {
  assertNewRunCanStart,
  recoverRun,
} = require("../lib/crawler/recovery");
const { validateSearchPage } = require("../lib/crawler/page-validator");
const { openCrawlerDatabase } = require("../lib/crawler/state-db");
const {
  createShutdownController,
  processLeasedPrefix,
} = require("../lib/crawler/worker");

process.env.NODE_ENV = "test";

function temporaryDirectory(t, options = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-crawler-v2-test-")
  );
  if (options.cleanup !== false) {
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  }
  return directory;
}

function testConfig(t, overrides = {}) {
  return getCrawlerV2Config({
    runtimeDir: temporaryDirectory(t, {
      cleanup: overrides.databaseCleanup !== true,
    }),
    leaseDurationMs: overrides.leaseDurationMs || 100,
    workerConcurrency: overrides.workerConcurrency || 1,
    maxAttempts: overrides.maxAttempts || 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    algorithm: {
      roots: overrides.roots || ["a"],
      pageSize: overrides.pageSize || 2,
      serverResultCap: overrides.serverResultCap || 100,
      maxPagesPerPrefix: overrides.maxPagesPerPrefix || 10,
      maxDepth: overrides.maxDepth || 5,
      partitionCompletenessProven:
        overrides.partitionCompletenessProven === true,
      partitionCharacters: overrides.partitionCharacters || ["a", "b"],
    },
  });
}

function initializedRun(t, overrides = {}) {
  const config = testConfig(t, { ...overrides, databaseCleanup: true });
  const database = openCrawlerDatabase(config.stateDbPath);
  t.after(() => {
    database.close();
    fs.rmSync(config.runtimeDir, { recursive: true, force: true });
  });
  const stores = createStores(database);
  const runId = overrides.runId || "test-run";
  stores.runStore.createRun(
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      algorithmVersion: config.algorithm.algorithmVersion,
      algorithmFingerprint: config.algorithmFingerprint,
      partitionCompletenessProven:
        config.algorithm.partitionCompletenessProven,
      rootPrefixCount: config.algorithm.roots.length,
    },
    runId
  );
  stores.frontierStore.seedRoots(runId, config.algorithm.roots);
  return { config, database, stores, runId };
}

function crashError(message) {
  const error = new Error(message);
  error.simulateCrash = true;
  return error;
}

function fileSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex"),
  };
}

function runMain(directory, args, env = {}) {
  const mainPath = path.resolve(__dirname, "..", "main.js");
  return childProcess.spawnSync(process.execPath, [mainPath, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      WEBSHARE_USERNAME: "",
      WEBSHARE_PASSWORD: "",
      ...env,
    },
  });
}

function workerContext(state, options = {}) {
  return {
    runId: state.runId,
    frontierStore: state.stores.frontierStore,
    itemStore: state.stores.itemStore,
    runStore: state.stores.runStore,
    transport: options.transport || {
      async fetchPage() {
        return { total: 1, files: [{ ident: "one", name: "One.mkv" }] };
      },
    },
    normalizeItem: (item) => item,
    config: state.config,
    fault: options.fault || (async () => {}),
    shutdown: options.shutdown || createShutdownController(),
  };
}

test("worker crash after lease leaves a durable in_progress prefix", async (t) => {
  const state = initializedRun(t);
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const fault = createFaultInjector({
    after_prefix_lease() {
      throw crashError("crash after lease");
    },
  }, { allowTestFaultInjection: true });
  await assert.rejects(
    processLeasedPrefix(
      { ...workerContext(state, { fault }), leaseOwner: "worker" },
      leased
    ),
    /crash after lease/
  );
  assert.equal(
    state.stores.frontierStore.getFrontier(state.runId, "a", 1).state,
    "in_progress"
  );
  assert.equal(state.stores.itemStore.countItems(state.runId), 0);
});

test("expired lease recovery returns work to queued", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(state.runId, "dead-worker", 10, 1_000);
  assert.equal(
    state.stores.frontierStore.recoverExpiredLeases(state.runId, 2_000),
    1
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "queued");
  assert.equal(frontier.lease_owner, null);
});

test("recovery validates invariants before mutating expired leases", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(state.runId, "dead-worker", 10, 1_000);
  state.database
    .prepare(
      "UPDATE crawl_frontier SET lease_owner = NULL WHERE run_id = ? AND prefix = 'a'"
    )
    .run(state.runId);
  const before = state.database
    .prepare("SELECT * FROM crawl_frontier WHERE run_id = ? AND prefix = 'a'")
    .get(state.runId);

  assert.throws(
    () =>
      recoverRun({
        runId: state.runId,
        runStore: state.stores.runStore,
        frontierStore: state.stores.frontierStore,
        config: state.config,
        nowMs: 2_000,
      }),
    /nekonzistentných lease/
  );

  const after = state.database
    .prepare("SELECT * FROM crawl_frontier WHERE run_id = ? AND prefix = 'a'")
    .get(state.runId);
  assert.deepEqual(after, before);
});

test("resume before lease expiry refuses to finalize or steal the prefix", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(state.runId, "live-worker", 1_000, 1_000);
  assert.throws(
    () =>
      recoverRun({
        runId: state.runId,
        runStore: state.stores.runStore,
        frontierStore: state.stores.frontierStore,
        config: state.config,
        nowMs: 1_500,
      }),
    /ešte nevypršala/
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "in_progress");
  assert.equal(frontier.lease_owner, "live-worker");
  assert.equal(state.stores.runStore.getRun(state.runId).status, "running");
});

test("two SQLite connections cannot lease the same prefix", (t) => {
  const state = initializedRun(t);
  const secondDatabase = openCrawlerDatabase(state.config.stateDbPath, {
    create: false,
  });
  try {
    const secondStores = createStores(secondDatabase);
    const firstLease = state.stores.frontierStore.lease(
      state.runId,
      "worker-one",
      state.config.leaseDurationMs
    );
    const secondLease = secondStores.frontierStore.lease(
      state.runId,
      "worker-two",
      state.config.leaseDurationMs
    );

    assert.equal(firstLease.lease_owner, "worker-one");
    assert.equal(secondLease, null);
    assert.equal(
      secondStores.frontierStore.getFrontier(state.runId, "a", 1).lease_owner,
      "worker-one"
    );
  } finally {
    secondDatabase.close();
  }
});

test("crash before item commit persists neither page nor item", async (t) => {
  const state = initializedRun(t);
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const fault = createFaultInjector({
    after_page_fetch() {
      throw crashError("before item commit");
    },
  }, { allowTestFaultInjection: true });
  await assert.rejects(
    processLeasedPrefix(
      { ...workerContext(state, { fault }), leaseOwner: "worker" },
      leased
    )
  );
  assert.equal(state.stores.itemStore.countItems(state.runId), 0);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM crawl_pages").get().count,
    0
  );
});

test("crash after item commit preserves item, page and watermark atomically", async (t) => {
  const state = initializedRun(t);
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const fault = createFaultInjector({
    after_item_commit() {
      throw crashError("after item commit");
    },
  }, { allowTestFaultInjection: true });
  await assert.rejects(
    processLeasedPrefix(
      { ...workerContext(state, { fault }), leaseOwner: "worker" },
      leased
    )
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "in_progress");
  assert.equal(frontier.pages_processed, 1);
  assert.equal(state.stores.itemStore.countItems(state.runId), 1);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM crawl_commits").get()
      .count,
    1
  );
});

test("duplicate ident is stored once in the same page transaction", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const result = state.stores.itemStore.commitPage({
    runId: state.runId,
    prefix: "a",
    depth: 1,
    leaseOwner: "worker",
    offset: 0,
    reportedTotal: 2,
    items: [
      { ident: "duplicate", name: "One" },
      { ident: "duplicate", name: "Two" },
    ],
  });
  assert.equal(result.insertedItems, 1);
  assert.equal(result.duplicateItems, 1);
  assert.equal(state.stores.itemStore.countItems(state.runId), 1);
});

test("malformed legacy checkpoint is detected without deleting any artifact", (t) => {
  const config = testConfig(t);
  const checkpoint = config.legacyCheckpointPaths[0];
  const jsonl = path.join(config.runtimeDir, "catalog-items.jsonl");
  const seen = path.join(config.runtimeDir, "seen-idents");
  fs.mkdirSync(seen, { recursive: true });
  fs.writeFileSync(checkpoint, "{broken");
  fs.writeFileSync(jsonl, "keep\n");
  fs.writeFileSync(path.join(seen, "aa"), "keep\n");
  assert.throws(() => assertNewRunCanStart(config), /legacy checkpoint/i);
  assert.equal(fs.readFileSync(checkpoint, "utf8"), "{broken");
  assert.equal(fs.readFileSync(jsonl, "utf8"), "keep\n");
  assert.equal(fs.readFileSync(path.join(seen, "aa"), "utf8"), "keep\n");
});

test("corrupt state DB fails closed and is not recreated", (t) => {
  const config = testConfig(t);
  fs.writeFileSync(config.stateDbPath, "not-a-sqlite-database");
  const before = fs.readFileSync(config.stateDbPath);
  assert.throws(
    () => openCrawlerDatabase(config.stateDbPath),
    /vyžaduje recovery/
  );
  assert.deepEqual(fs.readFileSync(config.stateDbPath), before);
});

test("algorithm fingerprint mismatch refuses recovery", (t) => {
  const state = initializedRun(t);
  const changed = getCrawlerV2Config({
    runtimeDir: state.config.runtimeDir,
    algorithm: { roots: ["a"], pageSize: 3 },
  });
  assert.throws(
    () =>
      recoverRun({
        runId: state.runId,
        runStore: state.stores.runStore,
        frontierStore: state.stores.frontierStore,
        config: changed,
      }),
    /inému crawler algoritmu/
  );
});

test("repeated non-empty page blocks the prefix", async (t) => {
  const state = initializedRun(t, { pageSize: 2, serverResultCap: 100 });
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  await processLeasedPrefix(
    {
      ...workerContext(state, {
        transport: {
          async fetchPage() {
            return {
              total: 3,
              files: [
                { ident: "same-1", name: "Same 1" },
                { ident: "same-2", name: "Same 2" },
              ],
            };
          },
        },
      }),
      leaseOwner: "worker",
    },
    leased
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "blocked");
  assert.equal(frontier.saturation_reason, "repeated_page");
});

test("unstable reported total blocks the prefix", async (t) => {
  const state = initializedRun(t, { pageSize: 2, serverResultCap: 100 });
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  let request = 0;
  await processLeasedPrefix(
    {
      ...workerContext(state, {
        transport: {
          async fetchPage() {
            request += 1;
            return request === 1
              ? { total: 3, files: [{ ident: "1" }, { ident: "2" }] }
              : { total: 4, files: [{ ident: "3" }] };
          },
        },
      }),
      leaseOwner: "worker",
    },
    leased
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "blocked");
  assert.equal(frontier.saturation_reason, "unstable_total");
});

test("server result cap blocks an unproven partition", async (t) => {
  const state = initializedRun(t, { pageSize: 2, serverResultCap: 2 });
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  await processLeasedPrefix(
    {
      ...workerContext(state, {
        transport: {
          async fetchPage() {
            return {
              total: 2,
              files: [{ ident: "1" }, { ident: "2" }],
            };
          },
        },
      }),
      leaseOwner: "worker",
    },
    leased
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "blocked");
  assert.equal(frontier.saturation_reason, "unsupported_character_partition");
});

test("server result cap blocks even when the returned page is short", () => {
  const config = getCrawlerV2Config({
    runtimeDir: path.join(os.tmpdir(), "unused-crawler-config"),
    algorithm: {
      roots: ["a"],
      pageSize: 100,
      serverResultCap: 1000,
    },
  });
  const decision = validateSearchPage(
    { total: 1000, files: [{ ident: "one" }] },
    { pages_processed: 0, last_page_fingerprint: null, depth: 1 },
    config.algorithm
  );
  assert.equal(decision.action, "blocked");
  assert.equal(decision.reason, "unsupported_character_partition");
});

test("best-effort capped search continues pages and stops at an empty page", () => {
  const algorithm = buildAlgorithmConfig({
    roots: ["a"],
    pageSize: 2,
    serverResultCap: 2,
    bestEffortSearchContinuation: true,
  });
  const fullPage = validateSearchPage(
    { total: 2, files: [{ ident: "one" }, { ident: "two" }] },
    { pages_processed: 0, items_observed: 0, last_page_fingerprint: null, depth: 1 },
    algorithm
  );
  assert.equal(fullPage.action, "continue");
  assert.equal(fullPage.reason, "best_effort_cap_continuation");
  const emptyPage = validateSearchPage(
    { total: 0, files: [] },
    { pages_processed: 10, items_observed: 20, last_page_fingerprint: fullPage.fingerprint, depth: 1 },
    algorithm
  );
  assert.equal(emptyPage.action, "complete");
  assert.equal(emptyPage.reason, "empty_page_after_unverified_search");
});

test("best-effort partitioning expands capped prefixes without claiming completeness", () => {
  const algorithm = buildAlgorithmConfig({
    roots: ["a"],
    pageSize: 2,
    serverResultCap: 2,
    maxDepth: 2,
    bestEffortSearchContinuation: true,
    bestEffortPartitioning: true,
  });
  const decision = validateSearchPage(
    { total: 2, files: [{ ident: "one" }, { ident: "two" }] },
    { pages_processed: 0, items_observed: 0, last_page_fingerprint: null, depth: 1 },
    algorithm
  );
  assert.equal(decision.action, "split");
  assert.equal(decision.reason, "server_result_cap");
});

test("missing, impossible and premature totals cannot complete a prefix", () => {
  const algorithm = buildAlgorithmConfig({
    roots: ["a"],
    pageSize: 2,
    serverResultCap: 100,
  });
  const frontier = {
    pages_processed: 0,
    items_observed: 0,
    last_page_fingerprint: null,
    depth: 1,
  };
  assert.equal(
    validateSearchPage(
      { total: null, files: [{ ident: "one" }] },
      frontier,
      algorithm
    ).reason,
    "invalid_reported_total"
  );
  assert.equal(
    validateSearchPage(
      { total: 0, files: [{ ident: "one" }] },
      frontier,
      algorithm
    ).reason,
    "total_below_observed"
  );
  assert.equal(
    validateSearchPage(
      { total: 2, files: [{ ident: "one" }] },
      frontier,
      algorithm
    ).reason,
    "premature_short_page"
  );
  assert.equal(
    validateSearchPage(
      {
        total: 3,
        files: [{ ident: "one" }, { ident: "two" }, { ident: "three" }],
      },
      frontier,
      algorithm
    ).reason,
    "page_size_exceeded"
  );
});

test("maximum depth saturation is blocked even with a proven alphabet", async (t) => {
  const state = initializedRun(t, {
    pageSize: 2,
    serverResultCap: 2,
    partitionCompletenessProven: true,
    maxDepth: 1,
  });
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  await processLeasedPrefix(
    {
      ...workerContext(state, {
        transport: {
          async fetchPage() {
            return { total: 2, files: [{ ident: "1" }, { ident: "2" }] };
          },
        },
      }),
      leaseOwner: "worker",
    },
    leased
  );
  assert.equal(
    state.stores.frontierStore.getFrontier(state.runId, "a", 1)
      .saturation_reason,
    "max_partition_depth"
  );
});

test("maximum page guard blocks a still-full prefix", (t) => {
  const config = testConfig(t, {
    pageSize: 2,
    serverResultCap: 100,
    maxPagesPerPrefix: 3,
  });
  const decision = validateSearchPage(
    { total: 4, files: [{ ident: "1" }, { ident: "2" }] },
    {
      pages_processed: 2,
      last_page_fingerprint: null,
      depth: 1,
    },
    config.algorithm
  );
  assert.equal(decision.action, "blocked");
  assert.equal(decision.reason, "max_pages_exceeded");
});

test("temporary failure is retried with bounded attempts", async (t) => {
  const config = testConfig(t, { maxAttempts: 2 });
  let requests = 0;
  const result = await executeCrawler({
    command: "crawl",
    config,
    transport: {
      async fetchPage() {
        requests += 1;
        if (requests === 1) {
          const error = new Error("temporary");
          error.response = { status: 503 };
          throw error;
        }
        return { total: 1, files: [{ ident: "recovered" }] };
      },
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.run.complete_count, 1);
  assert.equal(result.run.failed_count, 0);
});

test("explicit retry requeues failed but never blocked prefixes", (t) => {
  const state = initializedRun(t, { roots: ["a", "b"], maxAttempts: 1 });
  const first = state.stores.frontierStore.lease(
    state.runId,
    "worker-a",
    state.config.leaseDurationMs
  );
  state.stores.frontierStore.fail(
    state.runId,
    first.prefix,
    first.depth,
    "worker-a",
    "temporary",
    Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    { maxAttempts: 1, backoffMs: 1 }
  );
  const second = state.stores.frontierStore.lease(
    state.runId,
    "worker-b",
    state.config.leaseDurationMs
  );
  state.stores.frontierStore.block(
    state.runId,
    second.prefix,
    second.depth,
    "worker-b",
    "server_result_cap"
  );
  assert.equal(state.stores.frontierStore.retryFailed(state.runId), 1);
  assert.equal(
    state.stores.frontierStore.getFrontier(
      state.runId,
      first.prefix,
      first.depth
    ).state,
    "queued"
  );
  assert.equal(
    state.stores.frontierStore.getFrontier(
      state.runId,
      second.prefix,
      second.depth
    ).state,
    "blocked"
  );
});

test("graceful shutdown after fetch commits safely and requeues prefix", async (t) => {
  const state = initializedRun(t);
  const shutdown = createShutdownController();
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const fault = createFaultInjector({
    after_page_fetch() {
      shutdown.request("SIGTERM");
    },
  }, { allowTestFaultInjection: true });
  const outcome = await processLeasedPrefix(
    {
      ...workerContext(state, { fault, shutdown }),
      leaseOwner: "worker",
    },
    leased
  );
  assert.equal(outcome, "aborted");
  assert.equal(
    state.stores.frontierStore.getFrontier(state.runId, "a", 1).state,
    "queued"
  );
  assert.equal(state.stores.itemStore.countItems(state.runId), 1);
});

test("SIGTERM aborts an in-flight request and requeues its lease", async (t) => {
  const state = initializedRun(t);
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const shutdown = createShutdownController();
  let abortObserved = false;
  const processing = processLeasedPrefix(
    {
      ...workerContext(state, {
        shutdown,
        transport: {
          fetchPage({ signal }) {
            return new Promise((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  abortObserved = true;
                  const error = new Error("request aborted");
                  error.code = "ERR_CANCELED";
                  reject(error);
                },
                { once: true }
              );
            });
          },
        },
      }),
      leaseOwner: "worker",
    },
    leased
  );
  setTimeout(() => shutdown.request("SIGTERM"), 20);
  assert.equal(await processing, "aborted");
  assert.equal(abortObserved, true);
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "queued");
  assert.equal(frontier.lease_owner, null);
  assert.equal(
    state.database
      .prepare("SELECT COUNT(*) AS count FROM crawl_failures")
      .get().count,
    0
  );
});

test("atomic lock rejects a second crawler process", async (t) => {
  const config = testConfig(t);
  const fixture = path.join(__dirname, "fixtures", "crawler-lock-child.js");
  const child = childProcess.spawn(process.execPath, [fixture, config.lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Child lock timeout: ${errors}`)),
      2_000
    );
    child.stdout.on("data", () => {
      if (output.includes("LOCKED")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.throws(
    () => acquireCrawlerLock(config.lockPath, "run-two"),
    /Crawler lock existuje/
  );
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, errors);
  assert.match(output, /RELEASED/);
});

test("proven stale lock can be explicitly recovered", (t) => {
  const config = testConfig(t);
  fs.mkdirSync(path.dirname(config.lockPath), { recursive: true });
  fs.writeFileSync(
    config.lockPath,
    JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      process_start_token: "old",
      run_id: "old",
    })
  );
  assert.equal(inspectLock(config.lockPath).recoverable, true);
  const lock = acquireCrawlerLock(config.lockPath, "new", {
    recoverStale: true,
  });
  lock.release();
  assert.equal(fs.existsSync(config.lockPath), false);
});

test("concurrent stale recovery allows only one process to acquire", async (t) => {
  const config = testConfig(t);
  fs.mkdirSync(path.dirname(config.lockPath), { recursive: true });
  fs.writeFileSync(
    config.lockPath,
    JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      process_start_token: "dead",
      owner_nonce: "dead",
      run_id: "dead",
    })
  );
  const fixture = path.join(__dirname, "fixtures", "crawler-lock-child.js");
  function launch() {
    const child = childProcess.spawn(
      process.execPath,
      [fixture, config.lockPath, "--recover-stale"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise((resolve) =>
      child.on("exit", (code) => resolve({ code, stdout, stderr }))
    );
  }
  const results = await Promise.all([launch(), launch()]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(results.filter((result) => result.code === 3).length, 1);
  assert.match(
    results.find((result) => result.code === 3).stderr,
    /lock_acquisition_in_progress|lock_active|stale_lock/
  );
});

test("complete requires all frontier work and proven partition completeness", (t) => {
  const completeState = initializedRun(t, {
    partitionCompletenessProven: true,
  });
  completeState.stores.frontierStore.lease(
    completeState.runId,
    "worker",
    completeState.config.leaseDurationMs
  );
  completeState.stores.frontierStore.complete(
    completeState.runId,
    "a",
    1,
    "worker"
  );
  assert.equal(
    completeState.stores.runStore.finalize(completeState.runId).status,
    "complete"
  );
});

test("unproven search partition finalizes as incomplete", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  state.stores.frontierStore.complete(state.runId, "a", 1, "worker");
  const run = state.stores.runStore.finalize(state.runId);
  assert.equal(run.status, "incomplete");
  assert.equal(run.reconciliation_safe, 0);
});

test("public status transition cannot mark current partition complete or safe", (t) => {
  const state = initializedRun(t);
  assert.throws(
    () =>
      state.stores.runStore.setStatus(state.runId, "complete", {
        reconciliationSafe: true,
      }),
    /nemožno označiť complete/
  );
  assert.throws(
    () =>
      state.stores.runStore.setStatus(state.runId, "running", {
        reconciliationSafe: true,
      }),
    /reconciliation_safe/
  );
});

test("SIGTERM handler produces aborted run and leaves no lock", async (t) => {
  const runtimeDir = temporaryDirectory(t);
  const fixture = path.join(
    __dirname,
    "fixtures",
    "crawler-sigterm-child.js"
  );
  const child = childProcess.spawn(process.execPath, [fixture, runtimeDir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exit = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, errors);
  const config = getCrawlerV2Config({
    runtimeDir,
    algorithm: {
      roots: ["signal"],
      pageSize: 2,
      serverResultCap: 100,
      maxPagesPerPrefix: 10,
    },
  });
  const database = openCrawlerDatabase(config.stateDbPath, {
    create: false,
    readonly: true,
  });
  const run = database
    .prepare("SELECT status FROM crawl_runs ORDER BY started_at DESC LIMIT 1")
    .get();
  const frontier = database.prepare("SELECT state FROM crawl_frontier").get();
  database.close();
  assert.equal(run.status, "aborted");
  assert.equal(frontier.state, "queued");
  assert.equal(fs.existsSync(config.lockPath), false);
});

test("recovery never deletes JSONL, seen, failures or checkpoints", (t) => {
  const config = testConfig(t);
  const paths = {
    jsonl: path.join(config.runtimeDir, "catalog-items.jsonl"),
    failures: path.join(config.runtimeDir, "failed-prefixes.json"),
    checkpoint: config.legacyCheckpointPaths[0],
    seen: path.join(config.runtimeDir, "seen-idents", "ff"),
  };
  fs.mkdirSync(path.dirname(paths.seen), { recursive: true });
  for (const [name, artifactPath] of Object.entries(paths)) {
    fs.writeFileSync(artifactPath, `${name}-sentinel`);
  }
  const before = Object.fromEntries(
    Object.entries(paths).map(([name, artifactPath]) => [
      name,
      fs.readFileSync(artifactPath),
    ])
  );
  assert.throws(() => assertNewRunCanStart(config));
  for (const [name, artifactPath] of Object.entries(paths)) {
    assert.deepEqual(fs.readFileSync(artifactPath), before[name]);
  }
});

test("streamed v2 JSONL export produces a guarded schema 2 manifest", async (t) => {
  const config = testConfig(t);
  let request = 0;
  const result = await executeCrawler({
    command: "crawl",
    config,
    exportJsonl: true,
    transport: {
      async fetchPage() {
        request += 1;
        return request === 1
          ? {
              total: 2,
              files: [
                { ident: "z-exported", name: "Z.mkv", size: 456 },
                { ident: "a-exported", name: "A.mkv", size: 123 },
              ],
            }
          : { total: 2, files: [] };
      },
    },
  });
  assert.equal(result.state, "incomplete");
  const jsonl = fs.readFileSync(result.export.outputPath, "utf8");
  assert.equal(
    jsonl,
    [
      '{"ident":"a-exported","name":"A.mkv","size":123}',
      '{"ident":"z-exported","name":"Z.mkv","size":456}',
      "",
    ].join("\n")
  );
  const stat = fs.statSync(result.export.outputPath);
  const manifest = loadAndValidateCatalogManifest(
    result.export.manifestPath,
    result.export.outputPath,
    stat,
    { requireCurrentSchema: true }
  );
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.run_status, "incomplete");
  assert.equal(manifest.reconciliation_safe, false);
  assert.equal(manifest.is_full, false);
  assert.equal(manifest.items, 2);
  assert.equal(manifest.source_size, Buffer.byteLength(jsonl));
  assert.equal(
    manifest.content_sha256,
    crypto.createHash("sha256").update(jsonl).digest("hex")
  );
});

test("no-argument main entrypoint fails closed without creating runtime state", (t) => {
  const directory = temporaryDirectory(t);
  const result = runMain(directory, []);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /explicitný režim/);
  assert.equal(fs.existsSync(path.join(directory, "runtime")), false);
});

test("lease heartbeat prevents recovery from stealing a long HTTP request", async (t) => {
  const state = initializedRun(t, { leaseDurationMs: 60 });
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "heartbeat-worker",
    state.config.leaseDurationMs
  );
  let recovered = null;
  const recoveryAttempt = setTimeout(() => {
    recovered = state.stores.frontierStore.recoverExpiredLeases(
      state.runId,
      Date.now()
    );
  }, 110);
  await processLeasedPrefix(
    {
      ...workerContext(state, {
        transport: {
          async fetchPage() {
            await new Promise((resolve) => setTimeout(resolve, 180));
            return { total: 1, files: [{ ident: "heartbeat" }] };
          },
        },
      }),
      leaseOwner: "heartbeat-worker",
    },
    leased
  );
  clearTimeout(recoveryAttempt);
  assert.equal(recovered, 0);
  assert.equal(
    state.stores.frontierStore.getFrontier(state.runId, "a", 1).state,
    "complete"
  );
});

test("page fingerprint is canonical, order independent and duplicate sensitive", () => {
  const first = pageFingerprint([{ ident: "b" }, { ident: "a" }]);
  const reordered = pageFingerprint([{ ident: "a" }, { ident: "b" }]);
  const duplicate = pageFingerprint([
    { ident: "a" },
    { ident: "b" },
    { ident: "b" },
  ]);
  assert.equal(first, reordered);
  assert.notEqual(first, duplicate);
  assert.equal(
    pageFingerprint([]),
    crypto.createHash("sha256").digest("hex")
  );
});

test("repeated page with different API order is blocked", async (t) => {
  const state = initializedRun(t, { pageSize: 2, serverResultCap: 100 });
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  let request = 0;
  await processLeasedPrefix(
    {
      ...workerContext(state, {
        transport: {
          async fetchPage() {
            request += 1;
            return request === 1
              ? { total: 3, files: [{ ident: "a" }, { ident: "b" }] }
              : { total: 3, files: [{ ident: "b" }, { ident: "a" }] };
          },
        },
      }),
      leaseOwner: "worker",
    },
    leased
  );
  assert.equal(
    state.stores.frontierStore.getFrontier(state.runId, "a", 1)
      .saturation_reason,
    "repeated_page"
  );
});

test("partial page write rolls back items, page, commit, watermark and counter", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  assert.throws(
    () =>
      state.stores.itemStore.commitPage({
        runId: state.runId,
        prefix: "a",
        depth: 1,
        leaseOwner: "worker",
        offset: 0,
        reportedTotal: 2,
        items: [{ ident: "valid" }, { ident: "" }],
      }),
    /platný ident/
  );
  assert.equal(state.stores.itemStore.countItems(state.runId), 0);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM crawl_pages").get().count,
    0
  );
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM crawl_commits").get()
      .count,
    0
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.pages_processed, 0);
  assert.equal(frontier.last_offset, null);
  assert.equal(state.stores.runStore.getRun(state.runId).unique_items, 0);
  assert.equal(state.database.inTransaction, false);
});

test("crawler database enables WAL, busy timeout, foreign keys and NORMAL sync", (t) => {
  const state = initializedRun(t);
  assert.equal(state.database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(state.database.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(state.database.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(state.database.pragma("synchronous", { simple: true }), 1);
});

test("run counters remain consistent after inserts and duplicate idents", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  state.stores.itemStore.commitPage({
    runId: state.runId,
    prefix: "a",
    depth: 1,
    leaseOwner: "worker",
    offset: 0,
    reportedTotal: 2,
    items: [{ ident: "same" }, { ident: "same" }],
  });
  state.stores.frontierStore.complete(state.runId, "a", 1, "worker");
  const run = state.stores.runStore.finalize(state.runId);
  assert.equal(run.unique_items, 1);
  assert.equal(run.complete_count, 1);
  assert.equal(run.queued_count, 0);
  assert.equal(run.in_progress_count, 0);
  assert.equal(run.failed_count, 0);
  assert.equal(run.blocked_count, 0);
});

test("counter drift is detected instead of silently repaired", (t) => {
  const state = initializedRun(t);
  state.database
    .prepare("UPDATE crawl_runs SET queued_count = queued_count + 1 WHERE run_id = ?")
    .run(state.runId);
  assert.throws(
    () => state.stores.runStore.validateInvariants(state.runId),
    /persistentné counters/
  );
});

test("run finalization is atomic when status update fails", (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  state.stores.frontierStore.complete(state.runId, "a", 1, "worker");
  const before = state.stores.runStore.getRun(state.runId);
  state.database.exec(`
    CREATE TRIGGER reject_finalize
    BEFORE UPDATE OF status ON crawl_runs
    WHEN NEW.status != 'running'
    BEGIN
      SELECT RAISE(ABORT, 'injected finalize failure');
    END
  `);
  assert.throws(
    () => state.stores.runStore.finalize(state.runId),
    /injected finalize failure/
  );
  const run = state.stores.runStore.getRun(state.runId);
  assert.equal(run.status, "running");
  assert.equal(run.complete_count, before.complete_count);
  assert.equal(run.queued_count, before.queued_count);
});

test("fault before prefix completion leaves committed page recoverable", async (t) => {
  const state = initializedRun(t);
  const leased = state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  const fault = createFaultInjector(
    {
      before_prefix_complete() {
        throw crashError("before prefix complete");
      },
    },
    { allowTestFaultInjection: true }
  );
  await assert.rejects(
    processLeasedPrefix(
      { ...workerContext(state, { fault }), leaseOwner: "worker" },
      leased
    ),
    /before prefix complete/
  );
  const frontier = state.stores.frontierStore.getFrontier(state.runId, "a", 1);
  assert.equal(frontier.state, "in_progress");
  assert.equal(frontier.pages_processed, 1);
  assert.equal(state.stores.itemStore.countItems(state.runId), 1);
});

test("fault before run finalize resumes without repeating completed prefix", async (t) => {
  const config = testConfig(t);
  await assert.rejects(
    executeCrawler({
      command: "crawl",
      config,
      allowTestFaultInjection: true,
      faultHooks: {
        before_run_finalize() {
          throw crashError("before run finalize");
        },
      },
      transport: {
        async fetchPage() {
          return { total: 1, files: [{ ident: "finalize-item" }] };
        },
      },
    }),
    /before run finalize/
  );
  let database = openCrawlerDatabase(config.stateDbPath, {
    create: false,
    readonly: true,
  });
  assert.equal(database.prepare("SELECT status FROM crawl_runs").get().status, "running");
  assert.equal(database.prepare("SELECT state FROM crawl_frontier").get().state, "complete");
  database.close();
  const resumed = await executeCrawler({
    command: "resume",
    config,
    transport: {
      async fetchPage() {
        throw new Error("completed prefix must not be fetched");
      },
    },
  });
  assert.equal(resumed.state, "incomplete");
  assert.equal(resumed.run.unique_items, 1);
});

test("automatic resume refuses a run already marked recovery_required", (t) => {
  const state = initializedRun(t);
  state.stores.runStore.setStatus(state.runId, "recovery_required", {
    errorMessage: "injected invariant damage",
  });
  assert.throws(
    () =>
      recoverRun({
        runId: state.runId,
        runStore: state.stores.runStore,
        frontierStore: state.stores.frontierStore,
        config: state.config,
      }),
    /automatický resume je zakázaný/
  );
});

test("SIGTERM while idle aborts without leasing queued work", async (t) => {
  const config = testConfig(t);
  const shutdown = createShutdownController();
  shutdown.request("SIGTERM");
  const result = await executeCrawler({
    command: "crawl",
    config,
    shutdown,
    transport: {
      async fetchPage() {
        throw new Error("idle shutdown must not fetch");
      },
    },
  });
  assert.equal(result.state, "aborted");
  assert.equal(result.run.queued_count, 1);
  assert.equal(result.run.in_progress_count, 0);
});

test("orchestrator awaits other workers after one rejection", async (t) => {
  const config = testConfig(t, {
    roots: ["a", "b"],
    workerConcurrency: 2,
  });
  let secondFinished = false;
  const started = Date.now();
  await assert.rejects(
    executeCrawler({
      command: "crawl",
      config,
      allowTestFaultInjection: true,
      faultHooks: {
        async after_prefix_lease({ leased }) {
          if (leased.prefix === "a") {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new CrawlerInvariantError("worker invariant failure");
          }
        },
      },
      transport: {
        async fetchPage({ prefix }) {
          if (prefix === "b") {
            await new Promise((resolve) => setTimeout(resolve, 90));
            secondFinished = true;
          }
          return { total: 1, files: [{ ident: prefix }] };
        },
      },
    }),
    /worker invariant failure/
  );
  assert.equal(secondFinished, true);
  assert.ok(Date.now() - started >= 80);
});

test("malformed API payload blocks prefix instead of claiming completion", async (t) => {
  const config = testConfig(t);
  const result = await executeCrawler({
    command: "crawl",
    config,
    transport: {
      async fetchPage() {
        return null;
      },
    },
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.run.blocked_count, 1);
  const database = openCrawlerDatabase(config.stateDbPath, {
    create: false,
    readonly: true,
  });
  assert.equal(
    database.prepare("SELECT saturation_reason FROM crawl_frontier").get()
      .saturation_reason,
    "invalid_page_shape"
  );
  database.close();
});

test("algorithm fingerprint is canonical and covers correctness parameters", () => {
  assert.equal(
    algorithmFingerprint({ b: 2, nested: { z: 1, a: 2 }, a: 1 }),
    algorithmFingerprint({ a: 1, nested: { a: 2, z: 1 }, b: 2 })
  );
  const base = buildAlgorithmConfig();
  assert.match(base.searchEndpoint, /\/api\/search\/$/);
  assert.equal(base.category, "video");
  assert.equal(base.sort, "recent");
  assert.ok(base.normalizerVersion);
  for (const changed of [
    buildAlgorithmConfig({ roots: ["x"] }),
    buildAlgorithmConfig({ pageSize: base.pageSize + 1 }),
    buildAlgorithmConfig({ maxDepth: base.maxDepth + 1 }),
    buildAlgorithmConfig({ maxPagesPerPrefix: base.maxPagesPerPrefix + 1 }),
    buildAlgorithmConfig({ bestEffortSearchContinuation: true }),
    buildAlgorithmConfig({ partitionCharacters: ["x", "y"] }),
  ]) {
    assert.notEqual(
      algorithmFingerprint(base),
      algorithmFingerprint(changed)
    );
  }
});

test("lock release refuses a file with changed ownership nonce", (t) => {
  const config = testConfig(t);
  const lock = acquireCrawlerLock(config.lockPath, "owned-run");
  assert.equal(
    lock.payload.process_start_token,
    processStartToken(process.pid)
  );
  const changed = {
    ...lock.payload,
    owner_nonce: "different-owner",
  };
  fs.writeFileSync(config.lockPath, `${JSON.stringify(changed)}\n`);
  assert.throws(() => lock.release(), /lock sa zmenil/i);
  assert.equal(fs.existsSync(config.lockPath), true);
});

test("fault injection requires both test environment and explicit permission", () => {
  assert.throws(
    () => createFaultInjector({ after_page_fetch() {} }),
    /explicitný allowTestFaultInjection/
  );
});

test("CLI help, unknown and conflicting modes fail or succeed deterministically", (t) => {
  const directory = temporaryDirectory(t);
  const help = runMain(directory, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--validate-crawl/);
  const unknown = runMain(directory, ["--unknown"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Neznámy argument/);
  const conflict = runMain(directory, ["--status", "--crawl"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /presne jeden/);
  assert.equal(fs.existsSync(path.join(directory, "runtime")), false);
});

test("CLI missing-state commands fail clearly while status remains read-only", (t) => {
  const directory = temporaryDirectory(t);
  const status = runMain(directory, ["--status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /not_initialized/);
  for (const command of ["--resume", "--retry-failed", "--validate-crawl"]) {
    const result = runMain(directory, [command]);
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /state DB neexistuje/);
  }
  assert.equal(fs.existsSync(path.join(directory, "runtime")), false);
});

test("status and validate-crawl do not change an existing state database", (t) => {
  const directory = temporaryDirectory(t);
  const config = getCrawlerV2Config({ runtimeDir: path.join(directory, "runtime") });
  const database = openCrawlerDatabase(config.stateDbPath);
  const stores = createStores(database);
  stores.runStore.createRun({
    schemaVersion: STATE_SCHEMA_VERSION,
    algorithmVersion: config.algorithm.algorithmVersion,
    algorithmFingerprint: config.algorithmFingerprint,
    partitionCompletenessProven: false,
    rootPrefixCount: config.algorithm.roots.length,
  }, "cli-read-only");
  stores.frontierStore.seedRoots("cli-read-only", config.algorithm.roots);
  database.close();
  const stateFiles = [
    config.stateDbPath,
    `${config.stateDbPath}-wal`,
    `${config.stateDbPath}-shm`,
  ].filter((filePath) => fs.existsSync(filePath));
  const before = Object.fromEntries(
    stateFiles.map((filePath) => [filePath, fileSnapshot(filePath)])
  );
  assert.equal(runMain(directory, ["--status"]).status, 0);
  assert.equal(runMain(directory, ["--validate-crawl"]).status, 0);
  for (const filePath of stateFiles) {
    assert.deepEqual(fileSnapshot(filePath), before[filePath]);
  }
});

test("legacy checkpoint blocks crawl without migration or state creation", (t) => {
  const directory = temporaryDirectory(t);
  const runtime = path.join(directory, "runtime");
  fs.mkdirSync(runtime);
  const checkpoint = path.join(runtime, "webshare-crawler.checkpoint.json");
  fs.writeFileSync(checkpoint, "{broken legacy checkpoint");
  const before = fileSnapshot(checkpoint);
  const result = runMain(directory, ["--crawl"], {
    WEBSHARE_USERNAME: "fixture-user",
    WEBSHARE_PASSWORD: "fixture-password",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /legacy checkpoint/i);
  assert.deepEqual(fileSnapshot(checkpoint), before);
  assert.equal(
    fs.existsSync(path.join(runtime, "crawler-state.sqlite")),
    false
  );
});

test("export failure is atomic, cleans temp data and preserves existing export", async (t) => {
  const state = initializedRun(t);
  state.stores.frontierStore.lease(
    state.runId,
    "worker",
    state.config.leaseDurationMs
  );
  state.stores.itemStore.commitPage({
    runId: state.runId,
    prefix: "a",
    depth: 1,
    leaseOwner: "worker",
    offset: 0,
    reportedTotal: 1,
    items: [{ ident: "export-a" }, { ident: "export-b" }],
  });
  state.stores.frontierStore.complete(state.runId, "a", 1, "worker");
  const run = state.stores.runStore.finalize(state.runId);
  const exportsRoot = path.join(state.config.runtimeDir, "exports");
  const existingDirectory = path.join(exportsRoot, "existing");
  fs.mkdirSync(existingDirectory, { recursive: true });
  const existing = path.join(existingDirectory, "catalog-items.jsonl");
  fs.writeFileSync(existing, "existing-sentinel\n");
  const before = fileSnapshot(existing);
  const targetDirectory = path.join(exportsRoot, "failed");
  const fault = createFaultInjector(
    {
      after_export_item({ items }) {
        if (items === 1) throw new Error("injected export failure");
      },
    },
    { allowTestFaultInjection: true }
  );
  await assert.rejects(
    exportRunJsonl({
      itemStore: state.stores.itemStore,
      run,
      outputPath: path.join(targetDirectory, "catalog-items.jsonl"),
      manifestPath: path.join(targetDirectory, "catalog-items.manifest.json"),
      fault,
    }),
    /injected export failure/
  );
  assert.equal(fs.existsSync(targetDirectory), false);
  assert.deepEqual(fileSnapshot(existing), before);
  assert.deepEqual(
    fs.readdirSync(exportsRoot).filter((name) => name.startsWith(".tmp-")),
    []
  );
});

test("shutdown during export aborts the run and publishes no generation", async (t) => {
  const config = testConfig(t);
  const shutdown = createShutdownController();
  await assert.rejects(
    executeCrawler({
      command: "crawl",
      config,
      shutdown,
      exportJsonl: true,
      allowTestFaultInjection: true,
      faultHooks: {
        after_export_item({ items }) {
          if (items === 1) shutdown.request("SIGTERM");
        },
      },
      transport: {
        async fetchPage() {
          return {
            total: 2,
            files: [{ ident: "export-one" }, { ident: "export-two" }],
          };
        },
      },
    }),
    /shutdown/
  );

  const database = openCrawlerDatabase(config.stateDbPath, {
    create: false,
    readonly: true,
  });
  const run = database
    .prepare("SELECT status FROM crawl_runs ORDER BY started_at DESC LIMIT 1")
    .get();
  database.close();
  assert.equal(run.status, "aborted");
  const runsRoot = path.join(config.runtimeDir, "crawler-runs");
  const entries = fs.existsSync(runsRoot)
    ? fs.readdirSync(runsRoot, { recursive: true })
    : [];
  assert.equal(
    entries.some((entry) => String(entry).includes("catalog-items.jsonl")),
    false
  );
  assert.equal(
    entries.some((entry) => path.basename(String(entry)).startsWith(".tmp-")),
    false
  );
});
