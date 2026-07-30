const assert = require("node:assert/strict");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { CrawlerInvariantError } = require("../lib/crawler/errors");
const { algorithmFingerprint } = require("../lib/crawler/config");
const {
  assertFullReconciliationAllowed,
  canRunFullReconciliation,
} = require("../lib/catalog-safety");
const {
  SHADOW_STOP_REASONS,
  createShadowConfig,
  createShadowGuard,
  createShadowPathGuard,
  pathComparisonKey,
  readShadowReport,
  validateShadowResume,
} = require("../lib/crawler/shadow");
const {
  executeShadowCrawler,
  inspectShadowState,
  prepareShadowRoot,
} = require("../lib/crawler/shadow-runner");
const { createShutdownController } = require("../lib/crawler/worker");
const {
  createWebshareSearchTransport,
} = require("../lib/crawler/search-client");
const {
  MAX_DISTRIBUTION_KEYS,
  compareShadowCrawl,
} = require("../scripts/compare-shadow-crawl");
const {
  WebshareSession,
  createLogger,
  fetchSearchPage,
  parseMainCommand,
  parseStrictPositiveInteger,
} = require("../main");

function temporaryProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-shadow-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function shadowConfig(t, limits = {}, options = {}) {
  const projectRoot = options.projectRoot || temporaryProject(t);
  const config = createShadowConfig({
    projectRoot,
    shadowDir: options.shadowDir,
    rootPrefixes: options.rootPrefixes,
    limits: {
      maxPrefixes: 10,
      maxPages: 10,
      maxRequests: 10,
      maxItems: 100,
      maxDurationMinutes: 1,
      maxDiskBytes: 10 * 1024 * 1024,
      concurrency: 1,
      pageSize: 10,
      ...limits,
    },
  });
  return {
    ...config,
    crawler: {
      ...config.crawler,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    },
  };
}

function onePageTransport(items = [{ ident: "id-1", name: "Alpha.mkv" }]) {
  return {
    async fetchPage() {
      return { total: items.length, files: items };
    },
  };
}

function fileTreeSnapshot(root) {
  const snapshot = {};
  if (!fs.existsSync(root)) return snapshot;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    const relative = path.relative(root, current) || ".";
    snapshot[relative] = {
      type: stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: stat.isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(current)).digest("hex")
        : null,
    };
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    }
  }
  return snapshot;
}

function readFrontier(config) {
  const database = new Database(config.paths.stateDb, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare(
        "SELECT state, last_offset, pages_processed, items_observed, saturation_reason FROM crawl_frontier ORDER BY id"
      )
      .all();
  } finally {
    database.close();
  }
}

async function runShadow(t, limits = {}, transport = onePageTransport()) {
  const config = shadowConfig(t, limits);
  const result = await executeShadowCrawler({
    shadowConfig: config,
    transport,
    normalizeItem: (item) => item,
  });
  return { config, result, report: readShadowReport(config.paths.report) };
}

test("shadow default paths are isolated under runtime/shadow-phase-b", (t) => {
  const projectRoot = temporaryProject(t);
  const config = createShadowConfig({ projectRoot });
  assert.equal(
    config.paths.root,
    path.join(projectRoot, "runtime", "shadow-phase-b")
  );
  assert.equal(config.paths.stateDb, path.join(config.paths.root, "crawler-state.sqlite"));
  assert.equal(config.paths.lock, path.join(config.paths.root, "shadow.lock"));
  assert.ok(config.paths.exportPath.startsWith(config.paths.root));
  assert.equal(config.crawler.algorithm.partitionCompletenessProven, false);
});

test("shadow refuses the production runtime and hard-limit escalation", (t) => {
  const projectRoot = temporaryProject(t);
  assert.throws(
    () =>
      createShadowConfig({
        projectRoot,
        shadowDir: path.join(projectRoot, "runtime"),
      }),
    /produkčný runtime/
  );
  assert.throws(
    () =>
      createShadowConfig({
        projectRoot,
        limits: { maxRequests: 351 },
      }),
    /hard limit/
  );
  assert.throws(
    () =>
      createShadowConfig({
        projectRoot,
        shadowDir: path.join(projectRoot, "data"),
      }),
    /produkčnú cestu/
  );
});

test("shadow refuses a symlinked root", (t) => {
  const projectRoot = temporaryProject(t);
  const outside = path.join(projectRoot, "outside");
  const linked = path.join(projectRoot, "linked");
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, linked, "junction");
  } catch (error) {
    t.skip(`Symlink creation is unavailable: ${error.code}`);
    return;
  }
  assert.throws(
    () => createShadowConfig({ projectRoot, shadowDir: linked }),
    /symlink/
  );
});

test("shadow path rejects traversal, Windows-form hazards and platform-specific case collisions", (t) => {
  const projectRoot = temporaryProject(t);
  assert.throws(
    () =>
      createShadowConfig({
        projectRoot,
        shadowDir: "runtime/../elsewhere",
      }),
    /traversal/
  );
  assert.throws(
    () => createShadowConfig({ projectRoot, shadowDir: "C:shadow" }),
    /drive-relative/
  );
  assert.throws(
    () => createShadowConfig({ projectRoot, shadowDir: "\\\\server\\share" }),
    /UNC/
  );
  assert.throws(
    () =>
      createShadowConfig({
        projectRoot,
        rootPrefixes: ["x".repeat(257)],
      }),
    /256/
  );
  const caseVariant = path
    .join(projectRoot, "runtime")
    .replace(/runtime$/i, "RUNTIME");
  const productionRuntime = path.join(projectRoot, "runtime");
  if (process.platform === "win32") {
    assert.throws(
      () => createShadowConfig({ projectRoot, shadowDir: caseVariant }),
      /produkčný runtime/
    );
    assert.equal(
      pathComparisonKey(caseVariant),
      pathComparisonKey(productionRuntime)
    );
  } else if (process.platform === "linux") {
    assert.doesNotThrow(() =>
      createShadowConfig({ projectRoot, shadowDir: caseVariant })
    );
    assert.notEqual(
      pathComparisonKey(caseVariant),
      pathComparisonKey(productionRuntime)
    );
  }
});

test("TOCTOU root swap after validation is detected before any outside write", async (t) => {
  const projectRoot = temporaryProject(t);
  const outside = path.join(projectRoot, "outside");
  fs.mkdirSync(outside);
  const config = shadowConfig(t, {}, { projectRoot });
  let linked = false;
  try {
    await assert.rejects(
      executeShadowCrawler({
        shadowConfig: config,
        transport: onePageTransport(),
        lifecycleHooks: {
          afterPathValidation() {
            fs.rmSync(config.paths.root, { recursive: true, force: true });
            fs.symlinkSync(outside, config.paths.root, "junction");
            linked = true;
          },
        },
      }),
      /identity|symlink/i
    );
  } catch (error) {
    if (!linked && ["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) {
      t.skip(`Junction swap is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("nested junction swap is rejected and never receives shadow output", async (t) => {
  const projectRoot = temporaryProject(t);
  const outside = path.join(projectRoot, "outside-nested");
  fs.mkdirSync(outside);
  const config = shadowConfig(t, {}, { projectRoot });
  await assert.rejects(
    executeShadowCrawler({
      shadowConfig: config,
      transport: onePageTransport(),
      lifecycleHooks: {
        afterPathValidation() {
          fs.rmSync(config.paths.exports, { recursive: true, force: true });
          fs.symlinkSync(outside, config.paths.exports, "junction");
        },
      },
    }),
    /symlink|junction/i
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("strict CLI integer parser rejects ambiguous and unsafe numeric forms", () => {
  assert.equal(parseStrictPositiveInteger("1", "--limit"), 1);
  for (const value of [
    "-1",
    "0",
    "1.5",
    "NaN",
    "Infinity",
    "1e2",
    "0x10",
    "9007199254740992",
    "",
  ]) {
    assert.throws(() => parseStrictPositiveInteger(value, "--limit"));
  }
  assert.match(
    parseMainCommand([
      "--shadow-crawl",
      "--max-requests",
      "1",
      "--max-requests",
      "1",
    ]).error,
    /viackrát/
  );
  assert.match(
    parseMainCommand(["--shadow-crawl", "--max-requests"]).error,
    /vyžaduje hodnotu/
  );
});

test("max requests stops exactly at the configured request bound", async (t) => {
  let calls = 0;
  const { config, result, report } = await runShadow(
    t,
    { maxRequests: 1, pageSize: 1 },
    {
      async fetchPage() {
        calls += 1;
        return {
          total: 2,
          files: [{ ident: `id-${calls}` }],
        };
      },
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.run.status, "incomplete");
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_REQUESTS);
  assert.equal(report.requests_total, 1);
});

test("max pages stops after the bounded atomic page commit", async (t) => {
  const { result, report } = await runShadow(t, { maxPages: 1 });
  assert.equal(result.run.status, "incomplete");
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_PAGES);
  assert.equal(report.pages_committed, 1);
  assert.equal(result.run.unique_items, 1);
});

test("max items never commits a page that would exceed the bound", async (t) => {
  const { config, result, report } = await runShadow(
    t,
    { maxItems: 1 },
    onePageTransport([
      { ident: "id-1" },
      { ident: "id-2" },
    ])
  );
  assert.equal(result.run.status, "incomplete");
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_ITEMS);
  assert.equal(result.run.unique_items, 0);
  const [frontier] = readFrontier(config);
  assert.equal(frontier.state, "queued");
  assert.equal(frontier.last_offset, null);
  assert.equal(frontier.pages_processed, 0);
  assert.equal(frontier.items_observed, 0);
});

test("item-limit rejection remains watermark-safe across resume", async (t) => {
  const config = shadowConfig(t, { maxItems: 1 });
  const transport = onePageTransport([{ ident: "a" }, { ident: "b" }]);
  await executeShadowCrawler({
    shadowConfig: config,
    transport,
    normalizeItem: (item) => item,
    exportJsonl: false,
  });
  await executeShadowCrawler({
    command: "resume",
    shadowConfig: config,
    transport,
    normalizeItem: (item) => item,
    exportJsonl: false,
    resumeShadowLimited: true,
  });
  const report = readShadowReport(config.paths.report);
  const [frontier] = readFrontier(config);
  assert.equal(frontier.state, "queued");
  assert.equal(frontier.last_offset, null);
  assert.equal(frontier.pages_processed, 0);
  assert.equal(report.pages_committed, 0);
  assert.equal(report.items_unique, 0);
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_ITEMS);
});

test("split cannot create frontier rows beyond maxPrefixes", async (t) => {
  const base = shadowConfig(t, { maxPrefixes: 2, pageSize: 10 });
  const testAlgorithm = {
    ...base.crawler.algorithm,
    partitionCompletenessProven: true,
  };
  const config = {
    ...base,
    crawler: {
      ...base.crawler,
      algorithm: testAlgorithm,
      algorithmFingerprint: algorithmFingerprint(testAlgorithm),
    },
  };
  const files = Array.from({ length: 10 }, (_, index) => ({
    ident: `split-${index}`,
  }));
  const result = await executeShadowCrawler({
    shadowConfig: config,
    transport: {
      async fetchPage() {
        return { total: 1000, files };
      },
    },
    normalizeItem: (item) => item,
    exportJsonl: false,
  });
  const report = readShadowReport(config.paths.report);
  const frontier = readFrontier(config);
  assert.equal(result.run.status, "incomplete");
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_PREFIXES);
  assert.equal(frontier.length, 1);
  assert.equal(frontier[0].state, "queued");
  assert.equal(frontier[0].last_offset, null);
  assert.equal(frontier[0].pages_processed, 0);
});

test("maxPrefixes caps frontier cardinality, not retry lease attempts", async (t) => {
  let calls = 0;
  const { report } = await runShadow(
    t,
    { maxPrefixes: 1 },
    {
      async fetchPage() {
        calls += 1;
        const error = new Error("temporary");
        error.code = "ETIMEDOUT";
        throw error;
      },
    }
  );
  assert.equal(calls, 2);
  assert.equal(report.shadow_stop_reason, null);
  assert.equal(report.prefixes_leased, 2);
  assert.equal(report.prefixes_failed, 1);
});

test("duration uses monotonic elapsed time and requests incomplete stop", (t) => {
  const config = shadowConfig(t);
  prepareShadowRoot(config);
  const shutdown = createShutdownController();
  let now = 1_000_000_000n;
  const guard = createShadowGuard({
    shadowConfig: config,
    shutdown,
    monotonicNow: () => now,
  });
  now += 61_000_000_000n;
  assert.throws(() => guard.check("before_lease"), /časový limit/);
  assert.equal(shutdown.stopStatus, "incomplete");
  assert.equal(shutdown.signal, SHADOW_STOP_REASONS.MAX_DURATION);
  guard.dispose();
});

test("duration budget is cumulative and monotonic across resume", async (t) => {
  const config = shadowConfig(t, { maxDurationMinutes: 1 });
  let firstNow = 0n;
  const firstShutdown = createShutdownController();
  await executeShadowCrawler({
    shadowConfig: config,
    shutdown: firstShutdown,
    monotonicNow: () => firstNow,
    exportJsonl: false,
    transport: {
      async fetchPage() {
        firstNow += 30_000_000_000n;
        firstShutdown.request("SIGTERM");
        return { total: 1, files: [{ ident: "first" }] };
      },
    },
  });
  const firstReport = readShadowReport(config.paths.report);
  assert.ok(firstReport.duration_ms >= 30_000);

  let secondNow = 100_000_000_000n;
  await executeShadowCrawler({
    command: "resume",
    shadowConfig: config,
    monotonicNow: () => secondNow,
    exportJsonl: false,
    transport: {
      async fetchPage() {
        secondNow += 31_000_000_000n;
        return { total: 1, files: [{ ident: "second" }] };
      },
    },
  });
  const secondReport = readShadowReport(config.paths.report);
  assert.ok(secondReport.duration_ms >= 61_000);
  assert.equal(
    secondReport.shadow_stop_reason,
    SHADOW_STOP_REASONS.MAX_DURATION
  );
});

test("disk bound scans only the shadow root and stops safely", (t) => {
  const config = shadowConfig(t, { maxDiskBytes: 2 * 1024 * 1024 });
  prepareShadowRoot(config);
  fs.writeFileSync(
    path.join(config.paths.logs, "bound.bin"),
    Buffer.alloc(2 * 1024 * 1024)
  );
  const shutdown = createShutdownController();
  const guard = createShadowGuard({ shadowConfig: config, shutdown });
  assert.throws(() => guard.check("before_lease"), /disk limit/);
  assert.equal(shutdown.signal, SHADOW_STOP_REASONS.MAX_DISK);
  guard.dispose();
});

test("existing large temp data and atomic-write reserve stop before DB page/export growth", async (t) => {
  const config = shadowConfig(t, { maxDiskBytes: 2 * 1024 * 1024 });
  prepareShadowRoot(config);
  fs.writeFileSync(
    path.join(config.paths.root, ".tmp-existing-large"),
    Buffer.alloc(1500 * 1024, 1)
  );
  let calls = 0;
  const result = await executeShadowCrawler({
    shadowConfig: config,
    transport: {
      async fetchPage() {
        calls += 1;
        return { total: 1, files: [{ ident: "disk-item", name: "x".repeat(1024) }] };
      },
    },
    normalizeItem: (item) => item,
  });
  const report = readShadowReport(config.paths.report);
  assert.equal(calls, 0);
  assert.equal(result.run.status, "incomplete");
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_DISK);
  assert.equal(fs.existsSync(config.paths.exports), true);
  assert.deepEqual(
    fs.readdirSync(config.paths.exports).filter((name) => name.startsWith(".tmp-")),
    []
  );
});

test("operator stop deterministically overrides a simultaneous hard-limit stop", (t) => {
  const config = shadowConfig(t);
  prepareShadowRoot(config);
  const shutdown = createShutdownController();
  const guard = createShadowGuard({ shadowConfig: config, shutdown });
  assert.throws(() => guard.stop(SHADOW_STOP_REASONS.MAX_REQUESTS));
  shutdown.request("SIGTERM");
  const report = guard.snapshot();
  assert.equal(shutdown.stopStatus, "aborted");
  assert.equal(shutdown.signal, "SIGTERM");
  assert.equal(report.shadow_stop_reason, null);
  guard.dispose();
});

test("request accounting separates login, search and retries", (t) => {
  const config = shadowConfig(t);
  prepareShadowRoot(config);
  const guard = createShadowGuard({
    shadowConfig: config,
    shutdown: createShutdownController(),
  });
  guard.beforeRequest("login", "salt");
  guard.beforeRequest("login", "salt");
  guard.beforeRequest("search", "a:0");
  const report = guard.snapshot();
  assert.equal(report.requests_total, 3);
  assert.equal(report.login_requests, 2);
  assert.equal(report.search_requests, 1);
  assert.equal(report.retry_requests, 1);
  guard.dispose();
});

test("Webshare search transport meter counts the HTTP attempt before send", async (t) => {
  const config = shadowConfig(t);
  prepareShadowRoot(config);
  const guard = createShadowGuard({
    shadowConfig: config,
    shutdown: createShutdownController(),
  });
  let posts = 0;
  const client = {
    async post() {
      posts += 1;
      return {
        data:
          "<response><status>OK</status><total>0</total></response>",
      };
    },
  };
  const session = {
    async withWst(task) {
      return task("test-token");
    },
  };
  await fetchSearchPage(
    client,
    session,
    {
      prefix: "a",
      offset: 0,
      limit: 10,
      requestMeter: guard,
    },
    null
  );
  const report = guard.snapshot();
  assert.equal(posts, 1);
  assert.equal(report.search_requests, 1);
  assert.equal(report.requests_total, 1);
  guard.dispose();
});

test("two concurrent attempts cannot share the last durable request slot", async (t) => {
  const config = shadowConfig(t, { maxRequests: 1, pageSize: 1 });
  let invocations = 0;
  const result = await executeShadowCrawler({
    shadowConfig: config,
    normalizeItem: (item) => item,
    transportFactory: async ({ requestMeter }) => ({
      countsSearchRequests: true,
      async fetchPage() {
        const attempt = async (key) => {
          requestMeter.beforeRequest("search", key);
          invocations += 1;
          return { total: 1, files: [{ ident: key }] };
        };
        const outcomes = await Promise.allSettled([
          attempt("concurrent-a"),
          attempt("concurrent-b"),
        ]);
        return outcomes.find((entry) => entry.status === "fulfilled").value;
      },
    }),
  });
  const report = readShadowReport(config.paths.report);
  assert.equal(invocations, 1);
  assert.equal(report.requests_total, 1);
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_REQUESTS);
  assert.equal(result.run.status, "incomplete");
});

test("auth refresh cannot send login after consuming the last request slot", async (t) => {
  const config = shadowConfig(t, { maxRequests: 2 });
  let posts = 0;
  const client = {
    async post(url) {
      posts += 1;
      if (url.includes("/search/")) {
        return {
          data:
            "<response><status>FATAL</status><code>AUTH</code><message>token invalid</message></response>",
        };
      }
      if (url.includes("/salt/")) {
        return {
          data:
            "<response><status>OK</status><salt>fixture-salt</salt></response>",
        };
      }
      throw new Error("login transport must never be invoked");
    },
  };
  await executeShadowCrawler({
    shadowConfig: config,
    normalizeItem: (item) => item,
    transportFactory: async ({ requestMeter, signal }) => {
      const logger = { info() {}, warn() {}, error() {} };
      const session = new WebshareSession(
        { username: "fixture-user", password: "fixture-password" },
        logger,
        { requestMeter, apiClient: client }
      );
      session.cachedWst = "expired-fixture-wst";
      return createWebshareSearchTransport({
        client,
        session,
        fetchSearchPage,
        stats: null,
        algorithm: config.crawler.algorithm,
        requestMeter,
        signal,
      });
    },
  });
  const report = readShadowReport(config.paths.report);
  assert.equal(posts, 2, "search and salt only; login is never sent");
  assert.equal(report.requests_total, 2);
  assert.equal(report.search_requests, 1);
  assert.equal(report.login_requests, 1);
  assert.equal(report.shadow_stop_reason, SHADOW_STOP_REASONS.MAX_REQUESTS);
});

test("SIGTERM semantics remain aborted rather than a shadow limit", async (t) => {
  const config = shadowConfig(t);
  const shutdown = createShutdownController();
  shutdown.request("SIGTERM");
  const result = await executeShadowCrawler({
    shadowConfig: config,
    shutdown,
    transport: onePageTransport(),
  });
  const report = readShadowReport(config.paths.report);
  assert.equal(result.run.status, "aborted");
  assert.equal(report.shadow_stop_reason, null);
});

test("an aborted shadow run resumes in the same isolated directory", async (t) => {
  const config = shadowConfig(t);
  const shutdown = createShutdownController();
  shutdown.request("SIGTERM");
  await executeShadowCrawler({
    shadowConfig: config,
    shutdown,
    transport: onePageTransport(),
    exportJsonl: false,
  });
  const resumed = await executeShadowCrawler({
    command: "resume",
    shadowConfig: config,
    transport: onePageTransport(),
  });
  assert.equal(resumed.run.status, "incomplete");
  assert.equal(resumed.run.unique_items, 1);
});

test("resume refuses blocked, recovery-required and exhausted terminal work", async (t) => {
  const blockedConfig = shadowConfig(t);
  await executeShadowCrawler({
    shadowConfig: blockedConfig,
    exportJsonl: false,
    transport: {
      async fetchPage() {
        return { total: 1, files: null };
      },
    },
  });
  await assert.rejects(
    executeShadowCrawler({
      command: "resume",
      shadowConfig: blockedConfig,
      transport: onePageTransport(),
    }),
    /blocked/
  );

  const failedConfig = shadowConfig(t);
  await assert.rejects(
    executeShadowCrawler({
      shadowConfig: failedConfig,
      exportJsonl: false,
      transport: {
        async fetchPage() {
          throw new CrawlerInvariantError("technical invariant fixture");
        },
      },
    })
  );
  const failedStatus = inspectShadowState({ shadowConfig: failedConfig });
  assert.equal(failedStatus.run.status, "recovery_required");
  await assert.rejects(
    executeShadowCrawler({
      command: "resume",
      shadowConfig: failedConfig,
      transport: onePageTransport(),
    }),
    /recovery_required/
  );
});

test("resume rejects a mismatched algorithm fingerprint", (t) => {
  const config = shadowConfig(t);
  const report = {
    shadow_mode: true,
    shadow_root: config.paths.root,
    shadow_limits: config.limits,
    algorithm_fingerprint: "different",
  };
  assert.throws(
    () => validateShadowResume(config, report),
    /algorithm fingerprint/
  );
});

test("resume rejects higher limits and exhausted limited runs", (t) => {
  const base = shadowConfig(t, { maxRequests: 2 });
  const report = {
    shadow_mode: true,
    shadow_root: base.paths.root,
    shadow_limits: { ...base.limits, maxRequests: 1 },
    algorithm_fingerprint: base.crawler.algorithmFingerprint,
    shadow_stop_reason: SHADOW_STOP_REASONS.MAX_REQUESTS,
    requests_total: 1,
  };
  assert.throws(() => validateShadowResume(base, report), /zvýšiť limit/);
  const same = {
    ...base,
    limits: { ...base.limits, maxRequests: 1 },
  };
  assert.throws(
    () =>
      validateShadowResume(same, report, { resumeShadowLimited: true }),
    /vyčerpal limit/
  );
});

test("shadow export is atomic and permanently reconciliation-unsafe", async (t) => {
  const { result } = await runShadow(t);
  const manifest = JSON.parse(fs.readFileSync(result.export.manifestPath, "utf8"));
  const report = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(result.export.outputPath), "shadow-report.json"),
      "utf8"
    )
  );
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.shadow_mode, true);
  assert.equal(manifest.reconciliation_safe, false);
  assert.equal(manifest.partition_completeness_proven, false);
  assert.equal(report.shadow_mode, true);
});

test("shadow export fails atomically at JSONL, manifest, report and rename stages", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  for (const stage of [
    "before_export_jsonl_write",
    "before_export_manifest_write",
    "before_export_extra_write",
    "before_export_rename",
  ]) {
    await t.test(stage, async (t) => {
      const config = shadowConfig(t);
      await assert.rejects(
        executeShadowCrawler({
          shadowConfig: config,
          transport: onePageTransport(),
          normalizeItem: (item) => item,
          allowTestFaultInjection: true,
          faultHooks: {
            [stage]() {
              throw new Error(`fixture ${stage}`);
            },
          },
        }),
        new RegExp(stage)
      );
      const exports = fs.readdirSync(config.paths.exports);
      assert.deepEqual(
        exports.filter((name) => name.startsWith(".tmp-")),
        []
      );
      assert.deepEqual(
        exports.filter((name) => !name.startsWith(".tmp-")),
        []
      );
      const status = inspectShadowState({ shadowConfig: config });
      assert.equal(status.run.status, "recovery_required");
    });
  }
});

test("shadow export refuses an existing final generation", async (t) => {
  const config = shadowConfig(t);
  const runId = crypto.randomUUID();
  prepareShadowRoot(config);
  const finalDirectory = path.join(config.paths.exports, runId);
  fs.mkdirSync(finalDirectory);
  fs.writeFileSync(path.join(finalDirectory, "sentinel"), "keep");
  await assert.rejects(
    executeShadowCrawler({
      shadowConfig: config,
      runId,
      transport: onePageTransport(),
      normalizeItem: (item) => item,
    }),
    /už existuje/
  );
  assert.equal(fs.readFileSync(path.join(finalDirectory, "sentinel"), "utf8"), "keep");
});

test("SIGTERM immediately before export rename publishes no generation", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const config = shadowConfig(t);
  const shutdown = createShutdownController();
  await assert.rejects(
    executeShadowCrawler({
      shadowConfig: config,
      shutdown,
      transport: onePageTransport(),
      normalizeItem: (item) => item,
      allowTestFaultInjection: true,
      faultHooks: {
        before_export_rename() {
          shutdown.request("SIGTERM");
        },
      },
    }),
    /shutdown|publikovaný|rename/i
  );
  assert.deepEqual(
    fs.readdirSync(config.paths.exports).filter((name) => name.startsWith(".tmp-")),
    []
  );
  const status = inspectShadowState({ shadowConfig: config });
  assert.equal(status.run.status, "aborted");
});

test("catalog import guard rejects shadow deactivation even with all opt-ins", () => {
  const manifest = {
    shadow_mode: true,
    run_status: "complete",
    reconciliation_safe: true,
    is_full: true,
    failed_prefixes: 0,
  };
  assert.equal(
    canRunFullReconciliation(manifest, {
      CATALOG_ALLOW_FULL_RECONCILIATION: "true",
    }),
    false
  );
  assert.throws(
    () =>
      assertFullReconciliationAllowed(
        {
          allowDeactivation: true,
          env: { CATALOG_ALLOW_FULL_RECONCILIATION: "true" },
        },
        manifest,
        "shadow-manifest.json"
      ),
    /Shadow manifest/
  );
  assert.equal(
    canRunFullReconciliation(
      { ...manifest, shadow_mode: "true" },
      { CATALOG_ALLOW_FULL_RECONCILIATION: "true" }
    ),
    false
  );
});

test("real import and manifest-regeneration CLIs reject shadow with every full opt-in", async (t) => {
  const { result } = await runShadow(t);
  const environment = {
    ...process.env,
    CATALOG_ALLOW_FULL_RECONCILIATION: "true",
  };
  const importResult = childProcess.spawnSync(
    process.execPath,
    [
      "scripts/import-catalog-jsonl.js",
      "--input",
      result.export.outputPath,
      "--manifest",
      result.export.manifestPath,
      "--database",
      path.join(path.dirname(result.export.outputPath), "must-not-open.sqlite"),
      "--full",
      "--allow-deactivation",
    ],
    { cwd: path.resolve(__dirname, ".."), env: environment, encoding: "utf8" }
  );
  assert.notEqual(importResult.status, 0);
  assert.match(
    `${importResult.stdout}${importResult.stderr}`,
    /Shadow (?:manifest|JSONL)/
  );
  assert.equal(
    fs.existsSync(
      path.join(path.dirname(result.export.outputPath), "must-not-open.sqlite")
    ),
    false
  );

  const regeneration = childProcess.spawnSync(
    process.execPath,
    [
      "scripts/create-catalog-manifest.js",
      "--confirmed-full",
      "--allow-deactivation",
      "--items",
      "1",
      "--input",
      result.export.outputPath,
      "--output",
      path.join(path.dirname(result.export.outputPath), "regenerated.json"),
    ],
    { cwd: path.resolve(__dirname, ".."), env: environment, encoding: "utf8" }
  );
  assert.notEqual(regeneration.status, 0);
  assert.match(`${regeneration.stdout}${regeneration.stderr}`, /Shadow JSONL/);
});

test("comparison tool streams inputs and labels absence as non-reconciliation", async (t) => {
  const root = temporaryProject(t);
  const shadow = path.join(root, "shadow.jsonl");
  const legacy = path.join(root, "legacy.jsonl");
  const output = path.join(root, "comparison.json");
  fs.writeFileSync(
    shadow,
    [
      JSON.stringify({ ident: "a", name: "Alpha.mkv", extension: "mkv", category: "video" }),
      JSON.stringify({ ident: "a", name: "Alpha duplicate.mkv" }),
      "{bad",
      JSON.stringify({ ident: "b", name: "Beta.mp4", extension: "mp4" }),
    ].join("\n")
  );
  fs.writeFileSync(
    legacy,
    [
      JSON.stringify({ ident: "a", name: "Alpha.mkv", extension: "mkv" }),
      JSON.stringify({ ident: "c", name: "Cinema.avi", extension: "avi" }),
    ].join("\n")
  );
  const report = await compareShadowCrawl({
    shadowJsonl: shadow,
    legacyJsonl: legacy,
    outputReport: output,
  });
  assert.equal(report.comparison_is_not_reconciliation, true);
  assert.equal(report.legacy_only_is_not_deletion, true);
  assert.equal(report.shadow_unique_idents, 2);
  assert.equal(report.overlap, 1);
  assert.equal(report.shadow.duplicate_lines, 1);
  assert.equal(report.shadow.invalid_lines, 1);
  assert.equal(report.comparable_scope_status, "unknown");
  assert.equal(report.proven_comparable_overlap, null);
  assert.equal(report.legacy_unique_idents_in_comparable_scope, null);
  assert.equal(report.legacy_only_in_comparable_scope, null);
  assert.equal(report.name_initial_distribution_is_not_search_scope, true);
  assert.equal(Object.hasOwn(report, "comparable_prefixes"), false);
  assert.deepEqual(report.sample_overlap, {
    sample_unique_idents: 2,
    matched_in_legacy: 1,
    sample_only: 1,
    match_percent: 50,
  });
});

test("comparison never derives query scope from filename initials", async (t) => {
  const root = temporaryProject(t);
  const shadow = path.join(root, "shadow.jsonl");
  const legacy = path.join(root, "legacy.jsonl");
  const output = path.join(root, "comparison.json");
  fs.writeFileSync(
    shadow,
    `${JSON.stringify({ ident: "new", name: "Alpha from query zero.mkv" })}\n`
  );
  fs.writeFileSync(
    legacy,
    `${JSON.stringify({ ident: "old", name: "Another alpha.mkv" })}\n`
  );
  const report = await compareShadowCrawl({
    shadowJsonl: shadow,
    legacyJsonl: legacy,
    outputReport: output,
  });
  assert.equal(report.comparable_scope_status, "unknown");
  assert.equal(report.overlap, 0);
  assert.equal(report.shadow_only, 1);
  assert.equal(report.legacy_only, 1);
  assert.equal(report.proven_comparable_overlap, null);
  assert.equal(report.legacy_unique_idents_in_comparable_scope, null);
  assert.equal(report.legacy_only_in_comparable_scope, null);
  assert.equal(Object.hasOwn(report, "comparable_prefixes"), false);
  assert.deepEqual(report.shadow.name_initial_distribution, { a: 1 });
  assert.deepEqual(report.legacy.name_initial_distribution, { a: 1 });
});

test("comparison rejects input/output aliases and bounds hostile distributions/lines", async (t) => {
  const root = temporaryProject(t);
  const shadow = path.join(root, "shadow.jsonl");
  const legacy = path.join(root, "legacy.jsonl");
  fs.writeFileSync(shadow, `${JSON.stringify({ ident: "a", name: "Alpha" })}\n`);
  fs.writeFileSync(legacy, `${JSON.stringify({ ident: "b", name: "Beta" })}\n`);
  await assert.rejects(
    compareShadowCrawl({
      shadowJsonl: shadow,
      legacyJsonl: shadow,
      outputReport: path.join(root, "same-input.json"),
    }),
    /rovnaký súbor/
  );
  await assert.rejects(
    compareShadowCrawl({
      shadowJsonl: shadow,
      legacyJsonl: legacy,
      outputReport: shadow,
    }),
    /prepísať/
  );

  const many = [];
  for (let index = 0; index < MAX_DISTRIBUTION_KEYS + 50; index += 1) {
    many.push(
      JSON.stringify({
        ident: `many-${index}`,
        name: `Alpha-${index}`,
        extension: `extension-${index}`,
        category: `category-${index}`,
      })
    );
  }
  many.push(`{"ident":"too-long","name":"${"x".repeat(2048)}"}`);
  fs.writeFileSync(shadow, `${many.join("\n")}\n`);
  const output = path.join(root, "bounded-report.json");
  const report = await compareShadowCrawl({
    shadowJsonl: shadow,
    legacyJsonl: legacy,
    outputReport: output,
    maxLineBytes: 1024,
  });
  assert.equal(report.shadow.oversized_lines, 1);
  assert.ok(
    Object.keys(report.shadow.extension_distribution).length <=
      MAX_DISTRIBUTION_KEYS + 1
  );
  assert.ok(
    Object.keys(report.shadow.category_distribution).length <=
      MAX_DISTRIBUTION_KEYS + 1
  );
  assert.equal(report.comparison_is_not_reconciliation, true);
  assert.equal(report.legacy_only_is_not_deletion, true);
});

test("shadow execution creates no production crawler artifacts", async (t) => {
  const projectRoot = temporaryProject(t);
  const config = shadowConfig(t, {}, { projectRoot });
  await executeShadowCrawler({
    shadowConfig: config,
    transport: onePageTransport(),
  });
  const runtime = path.join(projectRoot, "runtime");
  for (const relative of [
    "crawler-state.sqlite",
    "catalog-items.jsonl",
    "catalog-items.manifest.json",
    "checkpoint.json",
    "seen-idents",
    "failed-prefixes.json",
    "crawler-runs",
  ]) {
    assert.equal(fs.existsSync(path.join(runtime, relative)), false, relative);
  }
  assert.equal(fs.existsSync(path.join(projectRoot, "data", "catalog.sqlite")), false);
});

test("shadow code exposes no import or publish execution option", () => {
  assert.match(
    parseMainCommand(["--shadow-crawl", "--publish"]).error,
    /nebezpečný/
  );
  assert.match(
    parseMainCommand(["--shadow-crawl", "--allow-deactivation"]).error,
    /nebezpečný/
  );
  assert.match(
    parseMainCommand(["--shadow-crawl", "--confirmed-full"]).error,
    /nebezpečný/
  );
});

test("shadow status is read-only and reports isolated lock namespace", async (t) => {
  const { config } = await runShadow(t);
  assert.equal(config.paths.lock, path.join(config.paths.root, "shadow.lock"));
  const walKeeper = new Database(config.paths.stateDb);
  walKeeper.pragma("journal_mode = WAL");
  walKeeper
    .prepare(
      "UPDATE shadow_run_budget SET peak_disk_bytes = peak_disk_bytes WHERE run_id = (SELECT run_id FROM shadow_run_budget LIMIT 1)"
    )
    .run();
  assert.equal(fs.existsSync(`${config.paths.stateDb}-wal`), true);
  assert.equal(fs.existsSync(`${config.paths.stateDb}-shm`), true);
  const before = fileTreeSnapshot(config.paths.root);
  const status = inspectShadowState({ shadowConfig: config });
  const afterStatus = fileTreeSnapshot(config.paths.root);
  const validation = require("../lib/crawler/shadow-runner").validateShadowState({
    shadowConfig: config,
  });
  const afterValidation = fileTreeSnapshot(config.paths.root);
  const cliStatus = childProcess.spawnSync(
    process.execPath,
    ["main.js", "--status", "--shadow-dir", config.paths.root],
    { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }
  );
  const afterCliStatus = fileTreeSnapshot(config.paths.root);
  const cliValidation = childProcess.spawnSync(
    process.execPath,
    ["main.js", "--validate-crawl", "--shadow-dir", config.paths.root],
    { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }
  );
  const afterCliValidation = fileTreeSnapshot(config.paths.root);
  walKeeper.close();
  assert.equal(cliStatus.status, 0, cliStatus.stderr);
  assert.equal(cliValidation.status, 0, cliValidation.stderr);
  assert.equal(status.shadow_mode, true);
  assert.equal(status.reconciliation_safe, false);
  assert.equal(validation.valid, true);
  assert.deepEqual(afterStatus, before);
  assert.deepEqual(afterValidation, before);
  assert.deepEqual(afterCliStatus, before);
  assert.deepEqual(afterCliValidation, before);
});

test("shadow artifact secret scan finds no password or WST in DB/report/export/log", async (t) => {
  const config = shadowConfig(t);
  prepareShadowRoot(config);
  const password = "fixture-password-never-persist";
  const wst = "fixture-wst-never-persist";
  const logger = createLogger(config.paths.log, {
    maxBytes: 64 * 1024,
    secrets: [password, wst],
    pathGuard: createShadowPathGuard(config.paths.root),
  });
  logger.error(`request failed ?wst=${wst}`, {
    password,
    token: wst,
  });
  await logger.close();
  let calls = 0;
  await executeShadowCrawler({
    shadowConfig: config,
    transport: {
      async fetchPage() {
        calls += 1;
        if (calls === 1) {
          const error = new Error(
            `network failed ?wst=${wst}&x=1 password=${password}`
          );
          error.code = "ECONNRESET";
          throw error;
        }
        return { total: 1, files: [{ ident: "safe-export-item" }] };
      },
    },
    normalizeItem: (item) => item,
  });
  for (const [relative, metadata] of Object.entries(
    fileTreeSnapshot(config.paths.root)
  )) {
    if (metadata.type !== "file") continue;
    const content = fs.readFileSync(path.join(config.paths.root, relative));
    assert.equal(content.includes(Buffer.from(password)), false, relative);
    assert.equal(content.includes(Buffer.from(wst)), false, relative);
  }
});
