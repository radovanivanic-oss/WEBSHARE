const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  analyzePage,
  createRequestBudget,
  parseArguments,
  prepareOutputDirectory,
  runAudit,
} = require("../scripts/audit-webshare-search-semantics");

function diagnosticOutput(t) {
  const output = path.join(
    os.tmpdir(),
    `webshare-search-semantics-test-${crypto.randomUUID()}`
  );
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  return output;
}

test("search semantics CLI enforces bounded queries, requests, page size and temp output", (t) => {
  const output = diagnosticOutput(t);
  const parsed = parseArguments([
    "--query",
    "0",
    "--query",
    "0*",
    "--max-search-requests",
    "2",
    "--page-size",
    "20",
    "--timeout-ms",
    "15000",
    "--output-dir",
    output,
  ]);
  assert.deepEqual(parsed.queries, ["0", "0*"]);
  assert.equal(parsed.maxSearchRequests, 2);
  assert.equal(parsed.pageSize, 20);
  assert.equal(parsed.timeoutMs, 15000);
  assert.throws(
    () =>
      parseArguments([
        "--query",
        "a",
        "--max-search-requests",
        "9",
        "--output-dir",
        output,
      ]),
    /maximum 8/
  );
  assert.throws(
    () =>
      parseArguments([
        "--query",
        "a",
        "--page-size",
        "21",
        "--output-dir",
        output,
      ]),
    /maximum 20/
  );
  assert.throws(
    () =>
      parseArguments([
        "--query",
        "a",
        "--query",
        "b",
        "--max-search-requests",
        "1",
        "--output-dir",
        output,
      ]),
    /prekračuje --max-search-requests/
  );
  const outsideTemp = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-search-audit-parent-")
  );
  t.after(() => fs.rmSync(outsideTemp, { recursive: true, force: true }));
  const forbidden = path.join(
    outsideTemp,
    "webshare-search-semantics-forbidden"
  );
  assert.throws(() => prepareOutputDirectory(forbidden), /OS temp/);
  assert.equal(fs.existsSync(forbidden), false);
});

test("diagnostic request budget reserves one salt, one login and bounded searches", () => {
  const budget = createRequestBudget(2);
  budget.beforeRequest("login", "salt");
  budget.afterRequest();
  budget.beforeRequest("login", "login");
  budget.afterRequest();
  budget.beforeRequest("search", "search:a");
  budget.afterRequest();
  budget.beforeRequest("search", "search:a*");
  budget.afterRequest();
  assert.throws(
    () => budget.beforeRequest("search", "search:extra"),
    /search request budget/
  );
  assert.throws(
    () => budget.beforeRequest("login", "salt"),
    /iba jeden salt/
  );
  assert.deepEqual(budget.snapshot(), {
    total: 4,
    salt: 1,
    login: 1,
    search: 2,
    completed: 4,
    max_search_requests: 2,
    max_total_requests: 4,
    attempts: [
      { kind: "login", operation: "salt" },
      { kind: "login", operation: "login" },
      { kind: "search", operation: "search:a" },
      { kind: "search", operation: "search:a*" },
    ],
  });
});

test("diagnostic audit is sequential, preserves wildcard input and redacts credentials", async (t) => {
  const outputDir = diagnosticOutput(t);
  const sentinelRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-search-audit-sentinel-")
  );
  t.after(() => fs.rmSync(sentinelRoot, { recursive: true, force: true }));
  const sentinel = path.join(sentinelRoot, "catalog.sqlite");
  fs.writeFileSync(sentinel, "unchanged");
  const username = "audit-user-secret";
  const password = "audit-password-secret";
  const wst = "audit-wst-secret";
  const queries = ["0", "test", "test*"];
  const seenQueries = [];
  let active = 0;
  let maxActive = 0;
  const telemetry = { records: [], maxInFlight: 1 };
  const result = await runAudit(
    {
      queries,
      maxSearchRequests: 3,
      pageSize: 2,
      timeoutMs: 5000,
      outputDir,
    },
    {
      config: { username, password, githubExportToken: null },
      client: {},
      telemetry,
      async authenticate({ requestMeter, logger }) {
        logger.info(`credentials ${username} ${password}`);
        requestMeter.beforeRequest("login", "salt");
        requestMeter.afterRequest();
        requestMeter.beforeRequest("login", "login");
        requestMeter.afterRequest();
        logger.addSecret(wst);
        logger.info(`token ${wst}`);
        return wst;
      },
      async fetchSearchPage(client, session, options) {
        return session.withWst(async (token) => {
          assert.equal(token, wst);
          active += 1;
          maxActive = Math.max(maxActive, active);
          seenQueries.push(options.prefix);
          options.requestMeter.beforeRequest(
            "search",
            `search:${options.prefix}`
          );
          await new Promise((resolve) => setImmediate(resolve));
          options.requestMeter.afterRequest();
          telemetry.records.push({
            endpoint: "/api/search/",
            status: 200,
            latency_ms: 1,
            retry_after: null,
          });
          active -= 1;
          const base = options.prefix.replace(/\*$/u, "");
          return {
            total: "2",
            files: [
              {
                ident: [`${base}-1`],
                name: [`${base} first.mkv`],
                size: ["10"],
                uploaded_at: ["2026-07-30T12:00:00Z"],
              },
              {
                ident: [`${base}-2`],
                name: [`other ${base} token.mkv`],
                size: ["20"],
                uploaded_at: ["2026-07-30T12:01:00Z"],
              },
            ],
          };
        });
      },
    }
  );
  assert.deepEqual(seenQueries, queries);
  assert.equal(maxActive, 1);
  assert.equal(result.report.max_observed_search_concurrency, 1);
  assert.equal(result.report.request_budget.total, 5);
  assert.equal(result.report.request_budget.search, 3);
  assert.equal(result.report.results[2].query, "test*");
  assert.equal(result.report.results[2].request_url_shape.what, "test*");
  assert.equal(
    result.report.results[2].timestamp_schema.uploaded_at.present,
    true
  );
  assert.equal(
    result.report.overlap.wildcard_pairs[0].wildcard_observation,
    "asterisk-probably-does-not-change-results"
  );
  assert.deepEqual(fs.readdirSync(outputDir).sort(), [
    "report.json",
    "report.md",
    "sanitized.log",
  ]);
  const artifacts = fs
    .readdirSync(outputDir)
    .map((name) => fs.readFileSync(path.join(outputDir, name), "utf8"))
    .join("\n");
  for (const secret of [username, password, wst]) {
    assert.equal(artifacts.includes(secret), false);
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
  assert.equal(fs.existsSync(path.join(sentinelRoot, "runtime")), false);
});

test("page analysis sends and evaluates the literal query without adding a wildcard", () => {
  const result = analyzePage(
    "test*",
    {
      total: "2",
      files: [
        {
          ident: ["one"],
          name: ["test opening.mkv"],
          created: ["1722345678"],
        },
        {
          ident: ["two"],
          name: ["a test token.mkv"],
          created: ["1722345679"],
        },
      ],
    },
    2
  );
  assert.equal(result.request_url_shape.what, "test*");
  assert.equal(result.request_url_shape.encoded_what, "test*");
  assert.equal(result.match_counts.name_starts_with_literal_query, 0);
  assert.equal(
    result.match_counts.name_starts_with_query_without_trailing_wildcard,
    1
  );
  assert.equal(
    result.match_counts.name_contains_query_without_trailing_wildcard,
    2
  );
  assert.equal(result.timestamp_schema.created.present, true);
  assert.deepEqual(result.timestamp_schema.created.formats, [
    "epoch-seconds-string",
  ]);
});
