"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  HARD_LIMITS,
  createDiscoveryConfig,
  runHybridDiscovery,
} = require("../lib/discovery/hybrid-discovery");
const { MAX_LOG_BYTES } = require("../lib/discovery/staging-store");
const {
  parseArguments,
} = require("../scripts/run-hybrid-discovery");

function fixture(t, suffix = "") {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `webshare-hybrid-discovery-${suffix}`)
  );
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtime = path.join(projectRoot, "runtime");
  const data = path.join(projectRoot, "data");
  fs.mkdirSync(runtime);
  fs.mkdirSync(data);
  const production = {
    sqlite: path.join(data, "catalog.sqlite"),
    jsonl: path.join(runtime, "catalog-items.jsonl"),
    manifest: path.join(runtime, "catalog-items.manifest.json"),
  };
  fs.writeFileSync(production.sqlite, "production-sqlite-sentinel");
  fs.writeFileSync(production.jsonl, "production-jsonl-sentinel\n");
  fs.writeFileSync(production.manifest, '{"production":true}\n');
  const before = Object.fromEntries(
    Object.entries(production).map(([key, file]) => [
      key,
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    ])
  );
  const stagingDir = path.join(
    runtime,
    `hybrid-discovery${suffix ? `-${suffix}` : ""}`
  );
  return {
    before,
    data,
    production,
    projectRoot,
    runtime,
    stagingDir,
  };
}

function assertProductionUnchanged(current) {
  for (const [key, file] of Object.entries(current.production)) {
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    assert.equal(digest, current.before[key], `${key} changed`);
  }
  for (const forbidden of [
    "crawler-state.sqlite",
    "checkpoint.json",
    "webshare-crawler.checkpoint.json",
    "failed-prefixes.json",
    "crawler-runs",
    "seen-idents",
  ]) {
    assert.equal(
      fs.existsSync(path.join(current.runtime, forbidden)),
      false,
      `production artifact ${forbidden} was created`
    );
  }
}

function configFor(current, limits = {}, options = {}) {
  return createDiscoveryConfig({
    projectRoot: current.projectRoot,
    stagingDir: current.stagingDir,
    what: options.what || "test",
    startOffset: options.startOffset || 0,
    limits: {
      maxPages: 10,
      maxRequests: 20,
      maxDurationMs: 10_000,
      maxNewIdents: 100,
      pageSize: 3,
      ...limits,
    },
  });
}

function dependenciesFor(pages, observations = {}) {
  let active = 0;
  return {
    async authenticate({ requestMeter }) {
      requestMeter.beforeRequest("login", "salt");
      requestMeter.afterRequest();
      requestMeter.beforeRequest("login", "login");
      requestMeter.afterRequest();
      return "fixture-wst";
    },
    async fetchSearchPage(request) {
      assert.equal(request.token, "fixture-wst");
      assert.equal(request.sort, "recent");
      assert.equal(request.category, "video");
      assert.equal(request.what.includes("*"), false);
      active += 1;
      observations.maxActive = Math.max(
        observations.maxActive || 0,
        active
      );
      observations.requests ||= [];
      observations.requests.push({
        what: request.what,
        sort: request.sort,
        category: request.category,
        offset: request.offset,
        limit: request.limit,
      });
      request.requestMeter.beforeRequest(
        "search",
        `search:${request.offset}`
      );
      observations.onReserved?.(request);
      await new Promise((resolve) => setImmediate(resolve));
      request.requestMeter.afterRequest();
      active -= 1;
      const files = pages.get(request.offset) || [];
      return { total: "1000", files };
    },
  };
}

test("hybrid discovery creates only isolated staging with manifest, checkpoint and global ident dedup", async (t) => {
  const current = fixture(t, "core");
  const config = configFor(current);
  const observations = {};
  const pages = new Map([
    [
      0,
      [
        { ident: ["alpha"] },
        { ident: ["beta"] },
        { ident: ["alpha"] },
      ],
    ],
    [3, [{ ident: ["beta"] }, { ident: ["gamma"] }]],
  ]);
  const result = await runHybridDiscovery(
    config,
    dependenciesFor(pages, observations)
  );

  assert.equal(observations.maxActive, 1);
  assert.deepEqual(observations.requests, [
    {
      what: "test",
      sort: "recent",
      category: "video",
      offset: 0,
      limit: 3,
    },
    {
      what: "test",
      sort: "recent",
      category: "video",
      offset: 3,
      limit: 3,
    },
  ]);
  assert.deepEqual(fs.readdirSync(current.stagingDir).sort(), [
    "checkpoint.json",
    "discovered-idents.json",
    "discovery.log",
    "manifest.json",
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(config.paths.manifest, "utf8")
  );
  const checkpoint = JSON.parse(
    fs.readFileSync(config.paths.checkpoint, "utf8")
  );
  const idents = JSON.parse(fs.readFileSync(config.paths.idents, "utf8"));
  assert.match(manifest.run_id, /^[0-9a-f-]{36}$/u);
  assert.equal(manifest.enumeration_complete, false);
  assert.equal(manifest.catalog_complete, false);
  assert.equal(manifest.historical_complete, false);
  assert.equal(manifest.reconciliation_safe, false);
  assert.equal(manifest.deactivation_allowed, false);
  assert.equal(manifest.import_performed, false);
  assert.equal(manifest.reconciliation_performed, false);
  assert.equal(manifest.publication_performed, false);
  assert.equal(manifest.finished_reason, "source_exhausted");
  assert.equal(manifest.pages_scanned, 2);
  assert.equal(manifest.requests_used, 4);
  assert.equal(manifest.new_idents, 3);
  assert.equal(manifest.duplicate_idents, 2);
  assert.equal(checkpoint.enumeration_complete, false);
  assert.equal(checkpoint.status, "stopped");
  assert.equal(checkpoint.next_offset, 6);
  assert.equal(checkpoint.run_id, manifest.run_id);
  assert.deepEqual(idents.idents, ["alpha", "beta", "gamma"]);
  assert.equal(new Set(idents.idents).size, idents.idents.length);
  assert.equal(result.manifest.enumeration_complete, false);
  assert.equal(fs.existsSync(config.paths.lock), false);
  assert.equal(
    fs.readdirSync(current.stagingDir).some((name) => name.startsWith(".tmp-")),
    false
  );
  assertProductionUnchanged(current);
});

test("hybrid discovery persists bounded page observability without raw payloads", async (t) => {
  const current = fixture(t, "observability");
  const config = configFor(current, { pageSize: 3, maxPages: 3 });
  let calls = 0;
  const result = await runHybridDiscovery(config, {
    async authenticate({ requestMeter }) {
      requestMeter.beforeRequest("login", "salt");
      requestMeter.afterRequest();
      requestMeter.beforeRequest("login", "login");
      requestMeter.afterRequest();
      return "fixture-wst";
    },
    async fetchSearchPage(request) {
      request.requestMeter.beforeRequest("search", `search:${request.offset}`);
      request.requestMeter.afterRequest();
      calls += 1;
      return calls === 1
        ? {
            total: "42",
            files: [
              { ident: ["alpha"], name: "must-not-be-persisted.mkv" },
              { ident: ["beta"], description: "must-not-be-persisted" },
              { ident: ["alpha"] },
            ],
          }
        : {
            version: "v1",
            files: [{ ident: ["beta"] }, { ident: ["gamma"] }],
          };
    },
  });

  const manifest = JSON.parse(fs.readFileSync(config.paths.manifest, "utf8"));
  const checkpoint = JSON.parse(
    fs.readFileSync(config.paths.checkpoint, "utf8")
  );
  const log = fs.readFileSync(config.paths.log, "utf8");
  assert.equal(result.manifest.finished_reason, "source_exhausted");
  assert.equal(manifest.page_metrics.length, 2);
  assert.deepEqual(
    manifest.page_metrics.map((page) => ({
      offset: page.offset,
      page_index: page.page_index,
      returned: page.returned,
      unique_idents_on_page: page.unique_idents_on_page,
      duplicate_idents_on_page: page.duplicate_idents_on_page,
      cumulative_unique_idents: page.cumulative_unique_idents,
      request_sequence: page.request_sequence,
      reported_total: page.reported_total,
      overlap_with_previous_page: page.overlap_with_previous_page,
      overlap_percentage: page.overlap_percentage,
      cumulative_duplicates: page.cumulative_duplicates,
    })),
    [
      {
        offset: 0,
        page_index: 1,
        returned: 3,
        unique_idents_on_page: 2,
        duplicate_idents_on_page: 1,
        cumulative_unique_idents: 2,
        request_sequence: 3,
        reported_total: "42",
        overlap_with_previous_page: 0,
        overlap_percentage: 0,
        cumulative_duplicates: 1,
      },
      {
        offset: 3,
        page_index: 2,
        returned: 2,
        unique_idents_on_page: 2,
        duplicate_idents_on_page: 1,
        cumulative_unique_idents: 3,
        request_sequence: 4,
        reported_total: null,
        overlap_with_previous_page: 1,
        overlap_percentage: 50,
        cumulative_duplicates: 2,
      },
    ]
  );
  for (const page of manifest.page_metrics) {
    assert.match(page.timestamp, /^2026|^20/u);
    assert.equal(page.decode_duration_ms, null);
    assert.equal(typeof page.request_duration_ms, "number");
    assert.equal(typeof page.total_processing_duration_ms, "number");
    assert.equal(page.response_keys.includes("files"), true);
    assert.equal(typeof page.response_schema_fingerprint, "string");
    assert.equal(page.response_schema_fingerprint.length, 64);
  }
  assert.equal(manifest.page_metrics[0].response_version, null);
  assert.equal(manifest.page_metrics[1].response_version, "v1");
  assert.deepEqual(checkpoint.page_metrics, manifest.page_metrics);
  assert.equal(manifest.observability.pages_processed, 2);
  assert.equal(manifest.observability.requests_performed, 4);
  assert.equal(manifest.observability.unique_idents, 3);
  assert.equal(manifest.observability.duplicates, 2);
  assert.equal(manifest.observability.overlap, 1);
  assert.equal(typeof manifest.observability.average_page_duration_ms, "number");
  assert.equal(typeof manifest.observability.total_duration_ms, "number");
  assert.equal(log.includes("must-not-be-persisted"), false);
  assert.equal(fs.statSync(config.paths.log).size <= MAX_LOG_BYTES, true);
  assertProductionUnchanged(current);
});

test("hybrid discovery resumes a legacy checkpoint without observability fields", async (t) => {
  const current = fixture(t, "observability-compat");
  const config = configFor(current, { pageSize: 2 });
  const controller = new AbortController();
  const dependencies = dependenciesFor(
    new Map([
      [0, [{ ident: ["one"] }]],
      [2, [{ ident: ["two"] }]],
    ])
  );
  const originalFetch = dependencies.fetchSearchPage;
  dependencies.fetchSearchPage = async (request) => {
    const page = await originalFetch(request);
    if (request.offset === 0) controller.abort(new Error("legacy stop"));
    return page;
  };
  await runHybridDiscovery(config, dependencies, { signal: controller.signal });
  const checkpoint = JSON.parse(fs.readFileSync(config.paths.checkpoint, "utf8"));
  delete checkpoint.page_metrics;
  delete checkpoint.previous_page_idents;
  fs.writeFileSync(config.paths.checkpoint, `${JSON.stringify(checkpoint)}\n`);
  const resumed = await runHybridDiscovery(
    config,
    dependenciesFor(new Map([[2, [{ ident: ["two"] }]]])),
    { resume: true }
  );
  assert.equal(resumed.manifest.enumeration_complete, false);
  assert.equal(Array.isArray(resumed.checkpoint.page_metrics), true);
  assertProductionUnchanged(current);
});

test("hybrid discovery reserves request budget durably before transport", async (t) => {
  const current = fixture(t, "meter");
  const config = configFor(current, { maxPages: 1, pageSize: 1 });
  let durableRequestsAtTransport = null;
  const observations = {
    onReserved() {
      durableRequestsAtTransport = JSON.parse(
        fs.readFileSync(config.paths.checkpoint, "utf8")
      ).requests_used;
    },
  };
  const result = await runHybridDiscovery(
    config,
    dependenciesFor(new Map([[0, [{ ident: ["one"] }]]]), observations)
  );
  assert.equal(durableRequestsAtTransport, 3);
  assert.equal(result.manifest.requests_used, 3);
  assert.equal(result.manifest.finished_reason, "max_pages");
  assertProductionUnchanged(current);
});

test("hybrid discovery hard limits stop without overshoot", async (t) => {
  await t.test("max pages", async (t) => {
    const current = fixture(t, "max-pages");
    const config = configFor(current, { maxPages: 1, pageSize: 2 });
    const result = await runHybridDiscovery(
      config,
      dependenciesFor(
        new Map([[0, [{ ident: ["one"] }, { ident: ["two"] }]]])
      )
    );
    assert.equal(result.manifest.finished_reason, "max_pages");
    assert.equal(result.manifest.pages_scanned, 1);
    assert.equal(result.manifest.requests_used, 3);
    assertProductionUnchanged(current);
  });

  await t.test("max requests", async (t) => {
    const current = fixture(t, "max-requests");
    const config = configFor(current, {
      maxRequests: 2,
      pageSize: 2,
    });
    let searches = 0;
    const dependencies = dependenciesFor(new Map());
    const original = dependencies.fetchSearchPage;
    dependencies.fetchSearchPage = async (request) => {
      searches += 1;
      return original(request);
    };
    const result = await runHybridDiscovery(config, dependencies);
    assert.equal(result.manifest.finished_reason, "max_requests");
    assert.equal(result.manifest.requests_used, 2);
    assert.equal(result.manifest.pages_scanned, 0);
    assert.equal(searches, 0);
    assertProductionUnchanged(current);
  });

  await t.test("max new idents", async (t) => {
    const current = fixture(t, "max-idents");
    const config = configFor(current, {
      maxNewIdents: 2,
      pageSize: 3,
    });
    const result = await runHybridDiscovery(
      config,
      dependenciesFor(
        new Map([
          [
            0,
            [
              { ident: ["one"] },
              { ident: ["two"] },
              { ident: ["three"] },
            ],
          ],
        ])
      )
    );
    const idents = JSON.parse(
      fs.readFileSync(config.paths.idents, "utf8")
    ).idents;
    assert.equal(result.manifest.finished_reason, "max_new_idents");
    assert.equal(result.manifest.new_idents, 2);
    assert.equal(result.checkpoint.partial_page_offset, 0);
    assert.equal(result.checkpoint.next_offset, 0);
    assert.deepEqual(idents, ["one", "two"]);
    assertProductionUnchanged(current);
  });

  await t.test("max duration", async (t) => {
    const current = fixture(t, "max-duration");
    const config = configFor(current, {
      maxDurationMs: 10,
      pageSize: 2,
    });
    let clock = 0;
    const dependencies = dependenciesFor(new Map());
    const authenticate = dependencies.authenticate;
    dependencies.authenticate = async (context) => {
      const token = await authenticate(context);
      clock = 10;
      return token;
    };
    const result = await runHybridDiscovery(config, dependencies, {
      monotonicNowMs: () => clock,
      wallNow: () => new Date("2026-07-30T12:00:00.000Z"),
    });
    assert.equal(result.manifest.finished_reason, "max_duration");
    assert.equal(result.manifest.duration_ms, 10);
    assert.equal(result.manifest.pages_scanned, 0);
    assert.equal(result.manifest.requests_used, 2);
    assertProductionUnchanged(current);
  });
});

test("discovery checkpoint resumes only the same isolated run after operator abort", async (t) => {
  const current = fixture(t, "resume");
  const config = configFor(current, { pageSize: 2 });
  const controller = new AbortController();
  const firstDependencies = dependenciesFor(
    new Map([[0, [{ ident: ["one"] }, { ident: ["two"] }]]])
  );
  const firstFetch = firstDependencies.fetchSearchPage;
  firstDependencies.fetchSearchPage = async (request) => {
    if (request.offset === 2) {
      controller.abort(new Error("fixture operator stop"));
      throw controller.signal.reason;
    }
    return firstFetch(request);
  };
  const interrupted = await runHybridDiscovery(config, firstDependencies, {
    signal: controller.signal,
  });
  assert.equal(interrupted.manifest.status, "interrupted");
  assert.equal(interrupted.manifest.finished_reason, "operator_aborted");
  assert.equal(interrupted.manifest.pages_scanned, 1);

  const resumed = await runHybridDiscovery(
    config,
    dependenciesFor(new Map([[2, [{ ident: ["three"] }]]])),
    { resume: true }
  );
  assert.equal(resumed.manifest.run_id, interrupted.manifest.run_id);
  assert.equal(resumed.manifest.finished_reason, "source_exhausted");
  assert.equal(resumed.manifest.enumeration_complete, false);
  assert.equal(resumed.manifest.pages_scanned, 2);
  assert.equal(resumed.manifest.requests_used, 6);
  assert.equal(resumed.manifest.new_idents, 3);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(config.paths.idents, "utf8")).idents,
    ["one", "two", "three"]
  );
  assertProductionUnchanged(current);
});

test("resume rejects configuration drift, corrupt state, missing artifacts and locks", async (t) => {
  const current = fixture(t, "resume-rejections");
  const config = configFor(current, { pageSize: 2, maxPages: 4 });
  const controller = new AbortController();
  const dependencies = dependenciesFor(
    new Map([[0, [{ ident: ["one"] }]]])
  );
  const fetch = dependencies.fetchSearchPage;
  dependencies.fetchSearchPage = async (request) => {
    const page = await fetch(request);
    controller.abort(new Error("deterministic stop"));
    return page;
  };
  await runHybridDiscovery(config, dependencies, { signal: controller.signal });

  await assert.rejects(
    runHybridDiscovery(
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: current.stagingDir,
        what: "different",
        limits: config.limits,
      }),
      dependenciesFor(new Map()),
      { resume: true }
    ),
    /konfigurácia/
  );
  await assert.rejects(
    runHybridDiscovery(
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: current.stagingDir,
        what: "test",
        limits: { ...config.limits, maxPages: 3 },
      }),
      dependenciesFor(new Map()),
      { resume: true }
    ),
    /konfigurácia/
  );
  await assert.rejects(
    runHybridDiscovery(
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: path.join(current.runtime, "hybrid-discovery-other"),
        what: "test",
        limits: config.limits,
      }),
      dependenciesFor(new Map()),
      { resume: true }
    ),
    /existujúci staging root/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: current.stagingDir,
        what: "test",
        category: "audio",
      }),
    /iba category=video/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: current.stagingDir,
        what: "test",
        sort: "largest",
      }),
    /iba sort=recent/
  );

  const originalCheckpoint = fs.readFileSync(config.paths.checkpoint, "utf8");
  fs.writeFileSync(config.paths.checkpoint, "{corrupt");
  await assert.rejects(
    runHybridDiscovery(config, dependenciesFor(new Map()), { resume: true }),
    /JSON|checkpoint/i
  );
  fs.writeFileSync(config.paths.checkpoint, originalCheckpoint);

  const originalManifest = fs.readFileSync(config.paths.manifest, "utf8");
  fs.writeFileSync(config.paths.manifest, "{corrupt");
  await assert.rejects(
    runHybridDiscovery(config, dependenciesFor(new Map()), { resume: true }),
    /JSON|manifest/i
  );
  fs.writeFileSync(config.paths.manifest, originalManifest);

  const snapshot = fs.readFileSync(config.paths.idents, "utf8");
  fs.unlinkSync(config.paths.idents);
  await assert.rejects(
    runHybridDiscovery(config, dependenciesFor(new Map()), { resume: true }),
    /ident snapshot|ENOENT/i
  );
  fs.writeFileSync(config.paths.idents, snapshot);

  const checkpoint = fs.readFileSync(config.paths.checkpoint, "utf8");
  fs.unlinkSync(config.paths.checkpoint);
  await assert.rejects(
    runHybridDiscovery(config, dependenciesFor(new Map()), { resume: true }),
    /checkpoint|ENOENT/i
  );
  fs.writeFileSync(config.paths.checkpoint, checkpoint);

  fs.writeFileSync(config.paths.lock, "{\"run_id\":\"other\"}\n");
  await assert.rejects(
    runHybridDiscovery(config, dependenciesFor(new Map()), { resume: true }),
    /lock už existuje/
  );
  fs.unlinkSync(config.paths.lock);
  assertProductionUnchanged(current);
});

test("interrupted resume preserves offsets, counters, idents and bounded log continuity", async (t) => {
  const interruptedCurrent = fixture(t, "resume-deterministic");
  const uninterruptedCurrent = fixture(t, "resume-baseline");
  const limits = { pageSize: 2, maxPages: 3, maxRequests: 10 };
  const pages = new Map([
    [0, [{ ident: ["one"] }, { ident: ["two"] }]],
    [2, [{ ident: ["three"] }, { ident: ["four"] }]],
    [4, [{ ident: ["five"] }]],
  ]);
  const uninterruptedConfig = configFor(uninterruptedCurrent, limits);
  const uninterrupted = await runHybridDiscovery(
    uninterruptedConfig,
    dependenciesFor(pages)
  );

  const interruptedConfig = configFor(interruptedCurrent, limits);
  const controller = new AbortController();
  const firstObservations = {};
  firstObservations.onReserved = (request) => {
    firstObservations.reservedOffsets ||= [];
    firstObservations.reservedOffsets.push(request.offset);
  };
  const firstDependencies = dependenciesFor(pages, firstObservations);
  const firstFetch = firstDependencies.fetchSearchPage;
  firstDependencies.fetchSearchPage = async (request) => {
    if (request.offset === 2) {
      controller.abort(new Error("stop after page 1"));
    }
    const page = await firstFetch(request);
    return page;
  };
  const interrupted = await runHybridDiscovery(
    interruptedConfig,
    firstDependencies,
    { signal: controller.signal }
  );
  assert.equal(interrupted.manifest.finished_reason, "operator_aborted");
  const resumeObservations = {};
  resumeObservations.onReserved = (request) => {
    resumeObservations.reservedOffsets ||= [];
    resumeObservations.reservedOffsets.push(request.offset);
  };
  const resumed = await runHybridDiscovery(
    interruptedConfig,
    dependenciesFor(pages, resumeObservations),
    { resume: true }
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(interruptedConfig.paths.idents, "utf8")).idents,
    JSON.parse(fs.readFileSync(uninterruptedConfig.paths.idents, "utf8")).idents
  );
  assert.deepEqual(
    {
      pages: resumed.manifest.pages_scanned,
      idents: resumed.manifest.new_idents,
      duplicates: resumed.manifest.duplicate_idents,
      offsets: resumed.manifest.page_metrics.map((page) => page.offset),
    },
    {
      pages: uninterrupted.manifest.pages_scanned,
      idents: uninterrupted.manifest.new_idents,
      duplicates: uninterrupted.manifest.duplicate_idents,
      offsets: uninterrupted.manifest.page_metrics.map((page) => page.offset),
    }
  );
  assert.deepEqual(
    firstObservations.reservedOffsets,
    [0]
  );
  assert.deepEqual(
    resumeObservations.reservedOffsets,
    [2, 4]
  );
  assert.equal(
    resumed.manifest.requests_used,
    interrupted.manifest.requests_used + 4
  );
  assert.equal(resumed.manifest.requests_completed, resumed.manifest.requests_used);
  assert.equal(resumed.manifest.enumeration_complete, false);
  assert.equal(fs.statSync(interruptedConfig.paths.log).size <= MAX_LOG_BYTES, true);
  assertProductionUnchanged(interruptedCurrent);
  assertProductionUnchanged(uninterruptedCurrent);
});

test("deterministic interruption after one, two and three reserved requests is recoverable", async (t) => {
  for (const stopAfter of [1, 2, 3]) {
    await t.test(`after ${stopAfter} request(s)`, async (t) => {
      const current = fixture(t, `request-stop-${stopAfter}`);
      const config = configFor(current, { pageSize: 2, maxRequests: 10 });
      const controller = new AbortController();
      let reserved = 0;
      const dependencies = {
        async authenticate({ requestMeter }) {
          requestMeter.beforeRequest("login", "salt");
          requestMeter.afterRequest();
          reserved += 1;
          if (reserved === stopAfter) controller.abort(new Error("stop"));
          requestMeter.beforeRequest("login", "login");
          requestMeter.afterRequest();
          reserved += 1;
          if (reserved === stopAfter) controller.abort(new Error("stop"));
          return "fixture-wst";
        },
        async fetchSearchPage(request) {
          request.requestMeter.beforeRequest("search", "search");
          request.requestMeter.afterRequest();
          reserved += 1;
          if (reserved === stopAfter) controller.abort(new Error("stop"));
          return {
            total: "100",
            files: [{ ident: [request.offset === 0 ? "one" : "two"] }],
          };
        },
      };
      const interrupted = await runHybridDiscovery(config, dependencies, {
        signal: controller.signal,
      });
      assert.equal(interrupted.manifest.finished_reason, "operator_aborted");
      assert.equal(interrupted.checkpoint.requests_used, stopAfter);
      const resumed = await runHybridDiscovery(
        config,
        {
          authenticate: dependencies.authenticate,
          fetchSearchPage: async (request) => {
            request.requestMeter.beforeRequest("search", "search-resume");
            request.requestMeter.afterRequest();
            return {
              total: "100",
              files: [{ ident: [request.offset === 0 ? "one" : "two"] }],
            };
          },
        },
        { resume: true }
      );
      assert.equal(resumed.manifest.requests_completed, resumed.manifest.requests_used);
      assert.equal(resumed.manifest.enumeration_complete, false);
      const idents = JSON.parse(fs.readFileSync(config.paths.idents, "utf8"));
      assert.equal(new Set(idents.idents).size, idents.idents.length);
      assertProductionUnchanged(current);
    });
  }
});

test("atomic persistence hooks leave readable artifacts at each interruption boundary", async (t) => {
  for (const stage of [
    "before_snapshot_write",
    "after_snapshot_write",
    "before_checkpoint_write",
    "after_checkpoint_write",
    "before_manifest_write",
    "after_manifest_write",
    "before_log_write",
    "after_log_write",
  ]) {
    await t.test(stage, async (t) => {
      const current = fixture(t, `atomic-${stage}`);
      const config = configFor(current, { pageSize: 1, maxPages: 1 });
      const controller = new AbortController();
      let fired = false;
      const hooks = {
        [stage]() {
          if (!fired) {
            fired = true;
            controller.abort(new Error(`interrupt ${stage}`));
          }
        },
      };
      await runHybridDiscovery(
        config,
        dependenciesFor(new Map([[0, [{ ident: ["atomic"] }]]])),
        { signal: controller.signal, testHooks: hooks }
      );
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(config.paths.checkpoint, "utf8")));
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(config.paths.manifest, "utf8")));
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(config.paths.idents, "utf8")));
      for (const line of fs.readFileSync(config.paths.log, "utf8").trim().split("\n")) {
        assert.doesNotThrow(() => JSON.parse(line));
      }
      assertProductionUnchanged(current);
    });
  }
});

test("hybrid discovery CLI and staging guard reject unsafe or expanded behavior", (t) => {
  const current = fixture(t, "guard");
  const parsed = parseArguments([
    "--what",
    "test",
    "--staging-dir",
    current.stagingDir,
    "--start-offset",
    "100",
    "--page-size",
    "20",
    "--max-pages",
    "5",
    "--max-requests",
    "7",
    "--max-duration-ms",
    "15000",
    "--max-new-idents",
    "100",
  ]);
  assert.equal(parsed.what, "test");
  assert.equal(parsed.startOffset, 100);
  assert.deepEqual(parsed.limits, {
    maxPages: 5,
    maxRequests: 7,
    maxDurationMs: 15000,
    maxNewIdents: 100,
    pageSize: 20,
  });
  assert.throws(
    () => createDiscoveryConfig({ projectRoot: current.projectRoot, what: "a*" }),
    /wildcard/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: current.runtime,
        what: "test",
      }),
    /priamy runtime/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: current.data,
        what: "test",
      }),
    /priamy runtime/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        stagingDir: "runtime/../data/hybrid-discovery",
        what: "test",
      }),
    /traversal/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        what: "test",
        sort: "largest",
      }),
    /iba sort=recent/
  );
  assert.throws(
    () =>
      createDiscoveryConfig({
        projectRoot: current.projectRoot,
        what: "test",
        limits: { maxPages: HARD_LIMITS.maxPages + 1 },
      }),
    /maxPages/
  );
  assert.throws(
    () => parseArguments(["--what", "test", "--max-pages"]),
    /vyžaduje hodnotu/
  );
  assert.throws(
    () => parseArguments(["--what", "test", "--what", "again"]),
    /viackrát/
  );
  assert.equal(fs.existsSync(current.stagingDir), false);
  assertProductionUnchanged(current);
});

test("hybrid discovery rejects a symlink or junction staging root before any write", async (t) => {
  const current = fixture(t, "link");
  const outside = path.join(current.projectRoot, "outside");
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(
      outside,
      current.stagingDir,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`symlink/junction nie je v tomto prostredí povolený: ${error.code}`);
      return;
    }
    throw error;
  }
  const config = configFor(current);
  await assert.rejects(
    runHybridDiscovery(config, dependenciesFor(new Map()), { resume: true }),
    /symlink|junction/
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assertProductionUnchanged(current);
});

test("hybrid discovery source exposes no crawler, import, reconciliation or publication execution path", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "discovery", "hybrid-discovery.js"),
    "utf8"
  );
  const cliSource = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "run-hybrid-discovery.js"),
    "utf8"
  );
  for (const forbidden of [
    "executeCrawler",
    "executeShadowCrawler",
    "publishExportsToGithub",
    "importCatalog",
    "run-crawler-and-update",
    "catalog.sqlite",
    "catalog-items.jsonl",
  ]) {
    assert.equal(moduleSource.includes(forbidden), false, forbidden);
    assert.equal(cliSource.includes(forbidden), false, forbidden);
  }
  assert.match(cliSource, /wildcardSuffix:\s*""/u);
  assert.match(moduleSource, /enumeration_complete:\s*false/gu);
});

test("hybrid discovery persists bounded aggregate quality evidence without names or raw items", async (t) => {
  const current = fixture(t, "quality");
  const config = configFor(current, { maxPages: 1, maxRequests: 3, pageSize: 3 });
  const pages = new Map([[0, [
    { ident: ["quality-a"], name: "Example Movie 2025 1080p.mkv", extension: "mkv" },
    { ident: ["quality-b"], name: "Example Series S01E01 1080p.mkv", extension: "mkv" },
    { ident: ["quality-c"], name: "Another Movie 2024 1080p.mp4", extension: "mp4" },
  ]]]);
  const result = await runHybridDiscovery(config, dependenciesFor(pages));
  const manifest = result.manifest;
  assert.equal(manifest.quality_evidence_complete, true);
  assert.equal(manifest.quality_gate_verdict, "PASS");
  assert.deepEqual(manifest.quality_counters, { items_evaluated: 3, valid_video_count: 3, test_like_count: 0, parser_low_confidence_count: 0, unsupported_media_count: 0, invalid_quality_input_count: 0 });
  assert.deepEqual(manifest.page_metrics[0].quality_counters, manifest.quality_counters);
  const persisted = fs.readdirSync(current.stagingDir).map(name => fs.readFileSync(path.join(current.stagingDir, name), "utf8")).join("\n");
  assert.equal(persisted.includes("Example Movie"), false);
  assert.equal(persisted.includes("quality-a"), true);
});
