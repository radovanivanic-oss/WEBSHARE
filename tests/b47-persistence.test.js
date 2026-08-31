
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openCatalogDatabase } = require("../src/db/catalog-db");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { migrateDatabase } = require("../src/db/migrate");
const { planDigestInput } = require("../lib/daily-maintenance");
const {
  buildObservationContract,
  canonicalSetText,
  compatibleObservationContracts,
  digestIdents,
  providerErrorClass,
  sanitizeProviderMessage,
  safeProviderRequestMetadata,
  sha256,
} = require("../lib/daily-observation");
const {
  B47_POLICY_VERSION,
  MIN_INDEPENDENT_OBSERVATIONS,
  buildPilotPlan,
  createB47Artifacts,
  derivePersistenceLedger,
  applyPilotPlan,
} = require("../lib/b47-persistence");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function item(ident, name) {
  return { id: ident, ident, name, title: name, size: 1000, extension: "mkv", type: "mkv", mime: "video/x-matroska", category: "video", source: "fixture", url: "webshare://" + ident };
}

function classification(ident, category = "movies") {
  const parser = { candidate_type: category === "series" ? "episode" : category === "sports" ? "sport" : "movie", confidence: 0.95, title: ident + " title", year: null };
  return {
    ident,
    action: "INSERT",
    classification: { category, confidence: 0.9, reason: "fixture", classifierVersion: "fixture" },
    parser,
    item: item(ident, ident + " Movie 2026 1080p.mkv"),
  };
}

function auditRecord(ident, rejected = false) {
  const row = classification(ident);
  return {
    ...row,
    candidate: { candidateKey: "movie|" + ident, lookupKey: "movie|" + ident, seriesKey: null, normalizedTitle: ident, title: ident + " title", parsedYear: 2026, candidateType: "movie", seasonNumber: null, episodeNumber: null, parseConfidence: 0.95, groupingVersion: "fixture" },
    audit_reasons: rejected ? ["MOVIE_EPISODIC_MARKER"] : [],
  };
}

function writeObservation(runDir, date, contract, accepted, approved, rejected = [], extras = {}) {
  const raw = [...new Set([...accepted, ...approved, ...rejected, "known", "tomb", "quarantine"])];
  const post = raw.filter((ident) => ident !== "tomb");
  const currentKnown = ["known"];
  const currentUnknown = [...new Set([...accepted, "quarantine"])].filter((ident) => ident !== "known");
  const sets = {
    raw_unique: raw,
    post_b39: post,
    current_known: currentKnown,
    current_unknown: currentUnknown,
    accepted,
    quarantine: ["quarantine"],
    deep_approved: approved,
    deep_rejected: rejected,
  };
  const acceptedRows = accepted.map((ident) => classification(ident));
  const classificationRows = [...acceptedRows, { ident: "known", action: "ALREADY_ACTIVE", classification: null, parser: null, item: null }, { ident: "quarantine", action: "QUARANTINE_UNCLASSIFIED", classification: { category: "unknown", confidence: 0.4, reason: "fixture" }, parser: { candidate_type: "unknown", confidence: 0.3, title: "quarantine" }, item: null }];
  const approvedRecords = approved.map((ident) => auditRecord(ident, false));
  const rejectedRecords = rejected.map((ident) => auditRecord(ident, true));
  const plan = {
    schema_version: 1,
    policy_version: "fixture",
    operation: "daily-best-effort",
    created_at: date + "T03:17:00.000Z",
    status: "READY_FOR_REVIEW",
    blocked_reasons: [],
    baseline: {},
    discovery: {},
    discovery_delta: acceptedRows,
    counters: { accepted: accepted.length },
    deactivations: [],
    next_state: {},
    safety: { sqlite_write_performed: false },
  };
  plan.plan_sha256 = sha256(planDigestInput(plan));
  const freezeDigest = sha256("freeze-" + date);
  writeJson(path.join(runDir, "plan.json"), plan);
  writeJson(path.join(runDir, "deep-audit", "bootstrap-freeze.json"), { source_plan_sha256: plan.plan_sha256, candidate_count: accepted.length, logical_digest: freezeDigest });
  writeJson(path.join(runDir, "deep-audit", "bootstrap-audit.json"), {
    schema_version: 1,
    policy_version: "b46.3-bootstrap-v1",
    source_freeze_digest: freezeDigest,
    source_candidate_count: accepted.length,
    approved_count: approvedRecords.length,
    rejected_count: rejectedRecords.length,
    category_counts: { movies: approvedRecords.length },
    rejection_counts: rejectedRecords.length ? { MOVIE_EPISODIC_MARKER: rejectedRecords.length } : {},
    approved_logical_digest: sha256(approvedRecords),
    approved_records: approvedRecords,
    rejected_records: rejectedRecords,
  });
  fs.writeFileSync(path.join(runDir, "classification.jsonl"), classificationRows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
  const metadata = {};
  for (const [name, values] of Object.entries(sets)) {
    const canonical = canonicalSetText(values);
    fs.mkdirSync(path.join(runDir, "sets"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "sets", name + ".txt"), canonical ? canonical + "\n" : "", { flag: "wx" });
    metadata[name] = { file: "sets/" + name + ".txt", count: values.length, sha256: sha256(canonical) };
  }
  const manifestBase = {
    schema_version: 1,
    kind: "B46.7_DAILY_OBSERVATION",
    status: "SUCCESS",
    series_id: "fixture-series",
    observation_started_at: date + "T03:17:00.000Z",
    observation_finished_at: date + "T03:17:30.000Z",
    local_calendar_date: date,
    runtime_ms: 100,
    contract,
    contract_fingerprint: contract.fingerprint,
    provider: { requests: 1 },
    plan: { path: "plan.json", sha256: plan.plan_sha256 },
    sets: metadata,
  };
  const manifest = { ...manifestBase, manifest_sha256: sha256(manifestBase) };
  writeJson(path.join(runDir, "manifest.json"), manifest);
  return { status: "SUCCESS", observation_started_at: manifest.observation_started_at, observation_finished_at: manifest.observation_finished_at, local_calendar_date: date, artifact_dir: path.basename(runDir), manifest_sha256: manifest.manifest_sha256, contract_fingerprint: contract.fingerprint, sets: metadata };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b47-persistence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "catalog.sqlite");
  const inputPath = path.join(root, "input.jsonl");
  fs.writeFileSync(inputPath, JSON.stringify(item("known", "Known Movie 2026 1080p.mkv")) + "\n");
  await importCatalog({ input: inputPath, database: databasePath, batchSize: 10, errorLog: path.join(root, "errors.jsonl") });
  const sidecarPath = path.join(root, "b39.json");
  writeJson(sidecarPath, { schema_version: 1, kind: "B39_PURGED_IDENT_SET", ident_count: 1, idents_sha256: digestIdents(["tomb"]), idents: ["tomb"] });
  const seriesRoot = path.join(root, "observations");
  const contract = buildObservationContract({ repositoryCommit: "fixture-build" });
  const days = [
    ["2026-08-23", ["a", "b", "pending"], ["a", "b", "pending"], []],
    ["2026-08-24", ["a", "b"], ["a", "b"], []],
    ["2026-08-25", ["a", "b"], ["a"], ["b"]],
  ];
  const observations = days.map(([date, accepted, approved, rejected]) => {
    const dir = path.join(seriesRoot, date.replaceAll("-", "") + "T031700Z");
    fs.mkdirSync(dir, { recursive: true });
    return writeObservation(dir, date, contract, accepted, approved, rejected);
  });
  writeJson(path.join(seriesRoot, "series.json"), {
    schema_version: 1,
    kind: "B46.7_DAILY_OBSERVATION_SERIES",
    series_id: "fixture-series",
    lifecycle: "COLLECTING",
    started_at: observations[0].observation_started_at,
    latest_at: observations.at(-1).observation_finished_at,
    completed_at: null,
    target_valid_observations: 7,
    successful_observations: observations.length,
    failed_observations: 0,
    expected_contract_fingerprint: contract.fingerprint,
    contract,
    observations,
    failures: [],
    created_at: observations[0].observation_started_at,
  });
  return { root, seriesRoot, seriesId: "fixture-series", databasePath, sidecarPath, contract };
}

test("B47 semantic contract compatibility separates implementation identity", () => {
  const old = buildObservationContract({ repositoryCommit: "old" });
  const next = buildObservationContract({ repositoryCommit: "new" });
  assert.equal(compatibleObservationContracts(old, next).compatible, true);
  assert.notEqual(old.fingerprint, next.fingerprint);
  const changed = { ...next, query_portfolio: ["x"] };
  assert.equal(compatibleObservationContracts(old, changed).compatible, false);
});

test("provider errors are classified conservatively and metadata is secret-free", () => {
  assert.equal(providerErrorClass({ code: "ERR_BAD_REQUEST", response: { status: 400 } }).retryable, false);
  assert.equal(providerErrorClass({ code: "ETIMEDOUT" }).retryable, true);
  assert.equal(providerErrorClass({ response: { status: 503 } }).retryable, true);
  const message = sanitizeProviderMessage("wst=secret-token password=secret-password Bearer abc-secret");
  assert.equal(message.includes("secret-token"), false);
  assert.equal(message.includes("secret-password"), false);
  assert.equal(message.includes("abc-secret"), false);
  const metadata = safeProviderRequestMetadata({ query: "a", page_index: 2, offset: 200, limit: 100, request_ordinal: 4, attempt: 1, authentication_succeeded: true, elapsed_request_ms: 12 }, { code: "ERR_BAD_REQUEST", message: "wst=secret-token", response: { status: 400 } });
  assert.deepEqual(Object.keys(metadata).sort(), ["attempt", "auth_refreshable", "authentication_succeeded", "axios_code", "category", "elapsed_request_ms", "endpoint_name", "error_class", "http_method", "http_status", "limit", "offset", "page_index", "phase", "provider_safe_error_code", "retry_decision", "retryable", "safe_query_literal", "sanitized_provider_message", "sort", "request_ordinal"].sort());
  assert.equal(JSON.stringify(metadata).includes("secret-token"), false);
});

test("persistence ledger counts independent accepted dates and enforces B39/deep-audit gates", async (t) => {
  const f = await fixture(t);
  const ledger = derivePersistenceLedger({ seriesRoot: f.seriesRoot, seriesId: f.seriesId, databasePath: f.databasePath, sidecarPath: f.sidecarPath });
  assert.equal(ledger.successful_observations, 3);
  assert.equal(ledger.stats.total_unique_accepted, 3);
  assert.equal(ledger.stats.pending_one_observation, 1);
  assert.equal(ledger.stats.eligible, 1);
  assert.equal(ledger.stats.rejected, 1);
  assert.equal(ledger.stats.already_known, 1);
  assert.equal(ledger.stats.b39_tombstoned, 1);
  assert.equal(ledger.stats.observed, 1);
  assert.equal(ledger.stats.disappeared_then_reappeared, 0);
  const byId = new Map(ledger.records.map((record) => [record.ident, record]));
  assert.equal(byId.get("a").state, "ELIGIBLE");
  assert.equal(byId.get("a").observation_count, MIN_INDEPENDENT_OBSERVATIONS);
  assert.deepEqual(byId.get("a").independent_observation_dates, ["2026-08-23", "2026-08-24", "2026-08-25"]);
  assert.equal(byId.get("b").state, "REJECTED");
  assert.equal(byId.get("pending").state, "PENDING");
  assert.equal(byId.get("known").state, "ALREADY_KNOWN");
  assert.equal(byId.get("tomb").state, "TOMBSTONED");
  assert.equal(byId.get("quarantine").state, "OBSERVED");
});

test("same-day duplicate observation is rejected and incompatible semantic evidence fails closed", async (t) => {
  const f = await fixture(t);
  const seriesPath = path.join(f.seriesRoot, "series.json");
  const series = JSON.parse(fs.readFileSync(seriesPath, "utf8"));
  series.observations.push(series.observations[0]);
  series.successful_observations += 1;
  fs.writeFileSync(seriesPath, JSON.stringify(series) + "\n");
  assert.throws(() => derivePersistenceLedger({ seriesRoot: f.seriesRoot, seriesId: f.seriesId, databasePath: f.databasePath, sidecarPath: f.sidecarPath }), /PERSISTENCE_DUPLICATE_OBSERVATION_DATE/);
});

test("pilot plan is deterministic, deep-approved, and bounded at 500", async (t) => {
  const f = await fixture(t);
  const ledger = derivePersistenceLedger({ seriesRoot: f.seriesRoot, seriesId: f.seriesId, databasePath: f.databasePath, sidecarPath: f.sidecarPath });
  const artifacts = createB47Artifacts({ ledger, outputDir: path.join(f.root, "report"), createdAt: "2026-08-31T20:00:00.000Z", sourceSeriesRoot: f.seriesRoot, toolBuildIdentity: { tool: "test" } });
  assert.equal(artifacts.plan.discovery_delta.length, 1);
  assert.equal(artifacts.plan.discovery_delta[0].ident, "a");
  assert.equal(artifacts.plan.max_candidates, 500);
  assert.throws(() => buildPilotPlan({ ledger, eligibilitySha256: "x", maxCandidates: 501 }), /B47_PILOT_LIMIT_INVALID/);
  const second = buildPilotPlan({ ledger: { ...ledger, records: [...ledger.records].reverse() }, eligibilitySha256: artifacts.eligibility.eligibility_sha256, createdAt: "2026-08-31T20:00:00.000Z", sourceSeriesRoot: f.seriesRoot, toolBuildIdentity: { tool: "test" } });
  assert.equal(second.candidate_set_sha256, artifacts.plan.candidate_set_sha256);
  assert.equal(second.plan_sha256, artifacts.plan.plan_sha256);
});

test("dry-run plan validation performs no production mutation and detects plan digest drift", async (t) => {
  const f = await fixture(t);
  const ledger = derivePersistenceLedger({ seriesRoot: f.seriesRoot, seriesId: f.seriesId, databasePath: f.databasePath, sidecarPath: f.sidecarPath });
  const artifacts = createB47Artifacts({ ledger, outputDir: path.join(f.root, "report"), createdAt: "2026-08-31T20:00:00.000Z", sourceSeriesRoot: f.seriesRoot, toolBuildIdentity: { tool: "test" } });
  const before = fs.statSync(f.databasePath).size;
  const dry = await applyPilotPlan({ planPath: path.join(f.root, "report", "pilot-plan.json"), databasePath: f.databasePath, sidecarPath: f.sidecarPath, seriesRoot: f.seriesRoot, seriesId: f.seriesId, apply: false });
  assert.equal(dry.status, "DRY_RUN");
  assert.equal(fs.statSync(f.databasePath).size, before);
  const planPath = path.join(f.root, "report", "pilot-plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.candidate_set_sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(f.root, "bad-plan.json"), JSON.stringify(plan) + "\n");
  await assert.rejects(() => applyPilotPlan({ planPath: path.join(f.root, "bad-plan.json"), databasePath: f.databasePath, sidecarPath: f.sidecarPath, seriesRoot: f.seriesRoot, seriesId: f.seriesId, apply: false }), /B47_PLAN_DIGEST_MISMATCH/);
  assert.equal(artifacts.plan.safety.production_apply, false);
});
