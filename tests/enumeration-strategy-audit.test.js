const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { sanitizeLogValue } = require("../main");
const {
  buildSearchPlan,
  createRequestBudget,
  parseArguments,
  prepareOutputDirectory,
  runAudit,
} = require("../scripts/audit-webshare-enumeration");

function diagnosticOutput(t) {
  const output = path.join(
    os.tmpdir(),
    `webshare-enumeration-audit-test-${crypto.randomUUID()}`
  );
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  return output;
}

function fullArguments(output) {
  return [
    "--query",
    "test",
    "--offset",
    "0",
    "--offset",
    "100",
    "--offset",
    "900",
    "--offset",
    "1000",
    "--offset",
    "1100",
    "--sort",
    "recent",
    "--sort",
    "rating",
    "--sort",
    "largest",
    "--sort",
    "smallest",
    "--repeat-offset-zero",
    "1",
    "--detail-samples",
    "1",
    "--max-api-requests",
    "12",
    "--page-size",
    "20",
    "--timeout-ms",
    "15000",
    "--output-dir",
    output,
  ];
}

test("enumeration CLI fixes a twelve-request bounded probe plan under OS temp", (t) => {
  const output = diagnosticOutput(t);
  const parsed = parseArguments(fullArguments(output));
  assert.equal(parsed.plannedSearchRequests, 9);
  assert.equal(parsed.plannedTotalRequests, 12);
  assert.deepEqual(parsed.offsets, [0, 100, 900, 1000, 1100]);
  assert.deepEqual(parsed.sorts, [
    "recent",
    "rating",
    "largest",
    "smallest",
  ]);
  assert.deepEqual(
    buildSearchPlan(parsed).map(({ kind, sort, offset }) => ({
      kind,
      sort,
      offset,
    })),
    [
      { kind: "offset", sort: "recent", offset: 0 },
      { kind: "offset", sort: "recent", offset: 100 },
      { kind: "offset", sort: "recent", offset: 900 },
      { kind: "offset", sort: "recent", offset: 1000 },
      { kind: "offset", sort: "recent", offset: 1100 },
      { kind: "repeat_offset_zero", sort: "recent", offset: 0 },
      { kind: "sort", sort: "rating", offset: 0 },
      { kind: "sort", sort: "largest", offset: 0 },
      { kind: "sort", sort: "smallest", offset: 0 },
    ]
  );
  assert.throws(
    () =>
      parseArguments(
        fullArguments(output).map((value) =>
          value === "smallest" ? "unsupported" : value
        )
      ),
    /dokumentovaných hodnôt/
  );
  const tooManyOffsets = fullArguments(output);
  tooManyOffsets.splice(12, 0, "--offset", "1200");
  assert.throws(() => parseArguments(tooManyOffsets), /maximum 5/);
  assert.throws(
    () =>
      parseArguments(
        fullArguments(output).map((value) => (value === "20" ? "21" : value))
      ),
    /--page-size musí byť v rozsahu 1\.\.20/
  );
  assert.throws(
    () =>
      parseArguments(
        fullArguments(output).map((value) => (value === "12" ? "11" : value))
      ),
    /Plán vyžaduje 12 requestov/
  );
  const outsideParent = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-enumeration-outside-")
  );
  t.after(() => fs.rmSync(outsideParent, { recursive: true, force: true }));
  const outside = path.join(
    outsideParent,
    "webshare-enumeration-audit-forbidden"
  );
  assert.throws(() => prepareOutputDirectory(outside), /OS temp/);
  assert.equal(fs.existsSync(outside), false);
});

test("enumeration request budget reserves before send and cannot exceed twelve", () => {
  assert.throws(() => createRequestBudget(13), /rozsahu 1\.\.12/);
  const budget = createRequestBudget(12);
  budget.beforeRequest("login", "salt");
  budget.afterRequest();
  budget.beforeRequest("login", "login");
  budget.afterRequest();
  for (let index = 0; index < 9; index += 1) {
    budget.beforeRequest("search", `search:${index}`);
    budget.afterRequest();
  }
  budget.beforeRequest("detail", "file_info:sample");
  budget.afterRequest();
  assert.throws(
    () => budget.beforeRequest("search", "search:overflow"),
    /celkový enumeration audit request budget/i
  );
  assert.equal(budget.snapshot().total, 12);
  assert.equal(budget.snapshot().completed, 12);
  assert.equal(budget.snapshot().search, 9);
  assert.equal(budget.snapshot().detail, 1);
});

test("redactor preserves analytical token fields and removes credential values", () => {
  const secret = "credential-value-123";
  const sanitized = sanitizeLogValue(
    {
      token_match_count: 7,
      tokenization_result: "substring",
      password_occurrences: 0,
      access_token: secret,
      githubExportToken: secret,
      authorization_header: secret,
      password_hash: secret,
      wst_value: secret,
      token: secret,
      nested: {
        authorization: `Bearer ${secret}`,
        wst: secret,
      },
      message: `token_match_count=7 Authorization: Bearer ${secret} wst=${secret}`,
    },
    [secret]
  );
  assert.equal(sanitized.token_match_count, 7);
  assert.equal(sanitized.tokenization_result, "substring");
  assert.equal(sanitized.password_occurrences, 0);
  assert.equal(sanitized.access_token, "[REDACTED]");
  assert.equal(sanitized.githubExportToken, "[REDACTED]");
  assert.equal(sanitized.authorization_header, "[REDACTED]");
  assert.equal(sanitized.password_hash, "[REDACTED]");
  assert.equal(sanitized.wst_value, "[REDACTED]");
  assert.equal(sanitized.token, "[REDACTED]");
  assert.equal(sanitized.nested.authorization, "[REDACTED]");
  assert.equal(sanitized.nested.wst, "[REDACTED]");
  assert.match(sanitized.message, /token_match_count=7/);
  assert.equal(sanitized.message.includes(secret), false);
});

test("enumeration audit sends exact offsets sequentially and persists bounded sanitized evidence", async (t) => {
  const outputDir = diagnosticOutput(t);
  const sentinelRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-enumeration-sentinel-")
  );
  t.after(() => fs.rmSync(sentinelRoot, { recursive: true, force: true }));
  const sentinel = path.join(sentinelRoot, "catalog.sqlite");
  fs.writeFileSync(sentinel, "unchanged");
  const username = "enumeration-user-secret";
  const password = "enumeration-password-secret";
  const wst = "enumeration-wst-secret";
  const rawBodyMarker = "RAW-BODY-MUST-NOT-BE-PERSISTED";
  const options = parseArguments(fullArguments(outputDir));
  const seenSearches = [];
  let active = 0;
  let maxActive = 0;
  const telemetry = { records: [], maxInFlight: 1 };
  const result = await runAudit(options, {
    config: { username, password, githubExportToken: null },
    client: {},
    telemetry,
    async authenticate({ requestMeter, logger }) {
      logger.info(`auth ${username} ${password}`);
      requestMeter.beforeRequest("login", "salt");
      requestMeter.afterRequest();
      requestMeter.beforeRequest("login", "login");
      requestMeter.afterRequest();
      logger.info(`Authorization: Bearer ${wst}`);
      return wst;
    },
    async fetchSearchPage(client, session, request) {
      return session.withWst(async (token) => {
        assert.equal(token, wst);
        active += 1;
        maxActive = Math.max(maxActive, active);
        seenSearches.push({
          query: request.prefix,
          wildcardSuffix: request.wildcardSuffix,
          sort: request.sort,
          offset: request.offset,
          limit: request.limit,
        });
        request.requestMeter.beforeRequest(
          "search",
          `search:${request.sort}:${request.offset}`
        );
        await new Promise((resolve) => setImmediate(resolve));
        request.requestMeter.afterRequest();
        telemetry.records.push({
          endpoint: "/api/search/",
          status: 200,
          latency_ms: 1,
          retry_after: null,
        });
        active -= 1;
        return {
          total: "1000",
          files: Array.from({ length: 25 }, (_, index) => ({
            ident: [`${request.sort}-${request.offset}-${index}`],
            name: [`test ${request.sort} ${request.offset} ${index}.mkv`],
            size: [String(1000 + index)],
            type: ["video"],
            unbounded_payload: [rawBodyMarker.repeat(100)],
          })),
        };
      });
    },
    async fetchFileInfo({ ident, requestMeter }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      requestMeter.beforeRequest("detail", `file_info:${ident}`);
      await new Promise((resolve) => setImmediate(resolve));
      requestMeter.afterRequest();
      telemetry.records.push({
        endpoint: "/api/file_info/",
        status: 200,
        latency_ms: 1,
        retry_after: null,
      });
      active -= 1;
      return {
        status: ["OK"],
        name: ["bounded detail.mkv"],
        size: ["1000"],
        type: ["mkv"],
        created: ["2026-07-30T12:00:00Z"],
        removed: ["0"],
        description: [rawBodyMarker.repeat(100)],
      };
    },
  });
  assert.deepEqual(
    seenSearches.map(({ sort, offset }) => ({ sort, offset })),
    [
      { sort: "recent", offset: 0 },
      { sort: "recent", offset: 100 },
      { sort: "recent", offset: 900 },
      { sort: "recent", offset: 1000 },
      { sort: "recent", offset: 1100 },
      { sort: "recent", offset: 0 },
      { sort: "rating", offset: 0 },
      { sort: "largest", offset: 0 },
      { sort: "smallest", offset: 0 },
    ]
  );
  assert.ok(
    seenSearches.every(
      (entry) =>
        entry.query === "test" &&
        entry.wildcardSuffix === "" &&
        entry.limit === 20
    )
  );
  assert.equal(maxActive, 1);
  assert.equal(result.report.max_observed_concurrency, 1);
  assert.equal(result.report.request_budget.total, 12);
  assert.equal(result.report.request_budget.completed, 12);
  assert.equal(result.report.search_probes.length, 9);
  assert.equal(result.report.detail_probes.length, 1);
  assert.equal(result.report.search_probes[0].samples.length, 20);
  assert.equal(
    result.report.bounded_output.raw_response_body_persisted,
    false
  );
  assert.equal(
    result.report.detail_probes[0].timestamp_schema.created.present,
    true
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
  for (const [label, forbidden] of [
    ["username", username],
    ["password", password],
    ["wst", wst],
    ["raw body marker", rawBodyMarker],
  ]) {
    assert.equal(
      artifacts.includes(forbidden),
      false,
      `diagnostic artifact leaked forbidden fixture ${label}`
    );
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
  assert.equal(fs.existsSync(path.join(sentinelRoot, "runtime")), false);
});
