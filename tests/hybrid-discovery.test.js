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
