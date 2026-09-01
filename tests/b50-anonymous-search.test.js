"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  aggregateComparisons,
  buildAbaAnalysis,
  classifyError,
  compareResults,
  createRequestBudget,
  parseArguments,
  parseSearchXml,
  performSearch,
  redactText,
  requestShape,
} = require("../scripts/b50-audit-anonymous-search");
const { fetchAnonymousSearchPage } = require("../main");
const {
  buildObservationContract,
  compatibleObservationContracts,
  createLiveObservationDependencies,
} = require("../lib/daily-observation");

test("B50 defaults to a bounded representative portfolio and five pages", () => {
  const options = parseArguments([]);
  assert.deepEqual(options.queries, ["a", "e", "m", "q", "z", "0", "5", "9"]);
  assert.equal(options.pages, 5);
  assert.equal(options.pageSize, 100);
  assert.equal(options.maxAttempts, 2);
  assert.equal(options.noRepeat, false);
});

test("B50 request shapes distinguish transport auth without exposing a token", () => {
  assert.deepEqual(requestShape("anonymous"), {
    endpoint: "/api/search/",
    method: "POST",
    content_type: "application/x-www-form-urlencoded",
    form_fields: ["what", "limit", "offset", "sort", "category"],
    authentication_field_present: false,
  });
  const authenticated = requestShape("authenticated");
  assert.equal(authenticated.authentication_field_present, true);
  assert.equal(authenticated.form_fields.includes("wst"), false);
  assert.equal(authenticated.form_fields.includes("wst[REDACTED]"), true);
});

test("B50 redacts credential-bearing text and keeps safe query literals", () => {
  const secret = "wst-secret-value";
  const value = redactText(`wst=${secret} Authorization: Bearer abc123 password=${secret}`, [secret]);
  assert.equal(value.includes(secret), false);
  assert.equal(value.includes("Bearer abc123"), false);
  assert.equal(redactText("a", [secret]), "a");
});

test("B50 parses a safe search response without persisting raw provider fields", async () => {
  const page = await parseSearchXml(`<?xml version="1.0"?><response><status>OK</status><total>2</total><file><ident>aa</ident><name>one.mkv</name><size>10</size><password>secret-like</password></file><file><ident>bb</ident><name>two.mkv</name><size>20</size></file></response>`);
  assert.equal(page.total, "2");
  assert.deepEqual(page.records.map((record) => record.ident), ["aa", "bb"]);
  assert.equal(Object.hasOwn(page.records[0], "name"), false);
  assert.deepEqual(page.records[0].metadata_fields, ["name", "size"]);
  await assert.rejects(() => parseSearchXml("<response><status>FATAL</status><code>ACCESS_DENIED</code><message>no</message></response>"), (error) => error.code === "ACCESS_DENIED");
});

test("B50 compares stable idents, rank displacement and metadata fingerprints", () => {
  const anonymous = { status: "SUCCESS", idents: ["a", "b", "c"], records: [{ ident: "a", metadata_fingerprint: "1", metadata_fields: ["name"] }, { ident: "b", metadata_fingerprint: "2", metadata_fields: ["name"] }, { ident: "c", metadata_fingerprint: "3", metadata_fields: ["name"] }], full_page: false, reported_total: "3" };
  const authenticated = { status: "SUCCESS", idents: ["b", "a", "d"], records: [{ ident: "b", metadata_fingerprint: "changed", metadata_fields: ["name", "size"] }, { ident: "a", metadata_fingerprint: "1", metadata_fields: ["name"] }, { ident: "d", metadata_fingerprint: "4", metadata_fields: ["name"] }], full_page: false, reported_total: "3" };
  const comparison = compareResults(anonymous, authenticated);
  assert.equal(comparison.ordered_ident_equal, false);
  assert.equal(comparison.unordered_ident_equal, false);
  assert.equal(comparison.intersection, 2);
  assert.deepEqual(comparison.anonymous_only, ["c"]);
  assert.deepEqual(comparison.authenticated_only, ["d"]);
  assert.equal(comparison.jaccard, 0.5);
  assert.equal(comparison.rank_displacement.changed_rank_count, 2);
  assert.equal(comparison.metadata_differences, 1);
  assert.deepEqual(comparison.metadata_difference_fields, ["name", "size"]);
});

test("B50 A/B/A analysis separates within-mode rotation from auth-effect pairs", () => {
  const base = (mode, idents) => ({ mode, status: "SUCCESS", query: "a", page_index: 0, idents, records: idents.map((ident) => ({ ident, metadata_fingerprint: ident, metadata_fields: ["name"] })), full_page: false, reported_total: String(idents.length) });
  const result = buildAbaAnalysis([
    { label: "anonymous_a", mode: "anonymous", result: base("anonymous", ["a", "b"]) },
    { label: "authenticated_a", mode: "authenticated", result: base("authenticated", ["a", "b"]) },
    { label: "anonymous_b", mode: "anonymous", result: base("anonymous", ["b", "c"]) },
    { label: "authenticated_b", mode: "authenticated", result: base("authenticated", ["b", "c"]) },
  ]);
  assert.deepEqual(result.comparisons.map((entry) => entry.reason), ["anonymous_rotation", "authenticated_rotation", "auth_effect_a", "auth_effect_b"]);
  assert.equal(result.comparisons[0].comparison.jaccard, 1 / 3);
  assert.equal(result.comparisons[2].comparison.jaccard, 1);
});

test("B50 aggregates wrapped portfolio comparison records", () => {
  const comparison = compareResults(
    { status: "SUCCESS", idents: ["a"], records: [{ ident: "a", metadata_fingerprint: "a", metadata_fields: ["name"] }], full_page: false, reported_total: "1" },
    { status: "SUCCESS", idents: ["a"], records: [{ ident: "a", metadata_fingerprint: "a", metadata_fields: ["name"] }], full_page: false, reported_total: "1" },
  );
  const aggregate = aggregateComparisons([{ query: "a", page_index: 0, comparison }]);
  assert.equal(aggregate.usable_compared_requests, 1);
  assert.equal(aggregate.ordered_exact_match_percent, 100);
});

test("B50 search request formation is anonymous or authenticated and retries stay bounded", async () => {
  const bodies = [];
  let calls = 0;
  const client = { async post(endpoint, body) { bodies.push({ endpoint, body }); calls += 1; if (calls === 1) { const error = new Error("temporary"); error.code = "ETIMEDOUT"; throw error; } return { status: 200, headers: { "content-type": "text/xml" }, data: "<response><status>OK</status><total>1</total><file><ident>x1</ident><name>safe.mkv</name></file></response>" }; } };
  const meter = createRequestBudget(2);
  const result = await performSearch({ client, wst: "secret-wst", mode: "anonymous", query: "a", pageIndex: 0, pageSize: 100, timeoutMs: 1000, maxAttempts: 2, requestMeter: meter, secrets: ["secret-wst"] });
  assert.equal(result.status, "SUCCESS");
  assert.equal(calls, 2);
  assert.equal(bodies[0].endpoint, "https://webshare.cz/api/search/");
  assert.equal(bodies[0].body.includes("wst="), false);
  assert.equal(result.attempts[0].retry_decision, "RETRY_BOUNDED");
  assert.equal(meter.snapshot().search, 2);
  const authenticatedBodyClient = { async post(endpoint, body) { return { status: 200, headers: { "content-type": "text/xml" }, data: "<response><status>OK</status><total>0</total></response>" }; } };
  const authResult = await performSearch({ client: authenticatedBodyClient, wst: "secret-wst", mode: "authenticated", query: "a", pageIndex: 0, pageSize: 100, timeoutMs: 1000, maxAttempts: 1, requestMeter: createRequestBudget(1), secrets: ["secret-wst"] });
  assert.equal(authResult.status, "SUCCESS");
});

test("B50 provider classification does not retry deterministic 4xx", () => {
  assert.deepEqual(classifyError({ response: { status: 400 }, code: "ERR_BAD_REQUEST" }), { class: "CLIENT_REQUEST", retryable: false, status: 400 });
  assert.equal(classifyError({ response: { status: 429 } }).retryable, true);
});

test("daily discovery can fetch anonymous search without requiring credentials", async () => {
  let body = null;
  const meter = { beforeRequest(kind, operation) { assert.equal(kind, "search"); assert.match(operation, /^anonymous-search:/u); }, afterRequest() {} };
  const page = await fetchAnonymousSearchPage(
    { async post(endpoint, requestBody) { assert.equal(endpoint, "https://webshare.cz/api/search/"); body = requestBody; return { data: "<response><status>OK</status><total>1</total><file><ident>abc</ident></file></response>" }; } },
    { prefix: "a", offset: 100, limit: 100, sort: "recent", category: "video", requestMeter: meter },
    { apiRequests: 0 },
  );
  assert.equal(page.files.length, 1);
  assert.equal(body.includes("wst="), false);
  assert.match(body, /what=a/);
  assert.match(body, /offset=100/);
});

test("anonymous transport changes implementation identity but preserves B47 semantic identity", async () => {
  const contract = buildObservationContract({ repositoryCommit: "b50-test-commit" });
  assert.equal(contract.discovery_authentication_mode, "anonymous");
  assert.equal(contract.semantic_contract_id, "d8069a78dd25ebb424610e2db6db85e7661731050952df85fe1d21846952f70f");
  assert.match(contract.implementation_build_id, /^b50-anonymous-discovery-v1@/u);
  const old = { ...contract, discovery_authentication_mode: "authenticated", implementation_build_id: "b46.7-daily-observation-v1@old", fingerprint: "old" };
  assert.equal(compatibleObservationContracts(contract, old).compatible, true);
  const dependencies = await createLiveObservationDependencies();
  assert.equal(dependencies.meter.state.authentication_attempted, false);
  assert.equal(dependencies.meter.state.authentication_succeeded, false);
  assert.equal(dependencies.meter.state.discovery_authentication_mode, "anonymous");
});
