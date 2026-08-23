"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeFile, fetchSearchPage, createApiClient, loginAndGetWst, WebshareSession } = require("../main");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { acquireCrawlerLock, inspectLock } = require("./crawler/lock");
const {
  B46_DEFAULT_POLICY,
  B46_POLICY_VERSION,
  B46_QUERY_PORTFOLIO,
  buildDailyPlan,
  discoverBestEffortPortfolio,
  snapshotDatabase,
} = require("./daily-maintenance");
const { filterPurgedDiscoveryItems, readAndValidatePurgedSidecar } = require("./daily-candidate-provenance");
const { auditFrozenRecords, freezeAcceptedPlan } = require("./bootstrap-backlog");

const OBSERVATION_SCHEMA_VERSION = 1;
const SERIES_SCHEMA_VERSION = 1;
const OBSERVATION_RUNNER_VERSION = "b46.7-daily-observation-v1";
const OBSERVATION_MODE = "BEST_EFFORT_RECENT_DISCOVERY";
const COVERAGE_DECLARATION = "BEST_EFFORT";
const TIME_ZONE = "Europe/Bratislava";
const SET_NAMES = Object.freeze([
  "raw_unique",
  "post_b39",
  "current_known",
  "current_unknown",
  "accepted",
  "quarantine",
  "deep_approved",
  "deep_rejected",
]);
const SET_FILE_NAMES = Object.freeze(Object.fromEntries(SET_NAMES.map((name) => [name, `${name}.txt`])));

class ObservationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ObservationError";
    this.code = code;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function normalizeIdents(idents) {
  if (!Array.isArray(idents)) throw new ObservationError("IDENT_SET_NOT_ARRAY");
  const unique = [...new Set(idents)];
  if (unique.some((ident) => typeof ident !== "string" || ident.length === 0 || /[\u0000-\u001f\u007f]/u.test(ident))) throw new ObservationError("IDENT_SET_INVALID");
  return unique.sort((left, right) => left.localeCompare(right));
}

function canonicalSetText(idents) {
  const sorted = normalizeIdents(idents);
  return sorted.join("\n");
}

function digestIdents(idents) {
  return sha256(canonicalSetText(idents));
}

function writeNewFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  fs.writeFileSync(filePath, content, { flag: "wx", mode: 0o640 });
}

function writeJsonNew(filePath, value) {
  writeNewFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonReplace(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, filePath);
}

function localCalendarDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timestampDirectoryName(timestamp) {
  return new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
}

function comparison(oldSet, newSet) {
  const oldValues = normalizeIdents([...oldSet]);
  const newValues = normalizeIdents([...newSet]);
  const oldLookup = new Set(oldValues);
  const newLookup = new Set(newValues);
  const intersection = oldValues.filter((ident) => newLookup.has(ident));
  const oldOnly = oldValues.filter((ident) => !newLookup.has(ident));
  const newOnly = newValues.filter((ident) => !oldLookup.has(ident));
  const union = [...new Set([...oldValues, ...newValues])];
  return {
    old: oldValues.length,
    new: newValues.length,
    intersection: intersection.length,
    old_only: oldOnly.length,
    new_only: newOnly.length,
    union: union.length,
    jaccard: union.length ? intersection.length / union.length : 1,
    persistence: oldValues.length ? intersection.length / oldValues.length : 1,
    replacement: newValues.length ? newOnly.length / newValues.length : 0,
    disappearance: oldValues.length ? oldOnly.length / oldValues.length : 0,
  };
}

function setHealth(database, sidecar) {
  const quickCheck = database.pragma("quick_check", { simple: true });
  const foreignKeys = database.pragma("foreign_key_check");
  const duplicateIdents = database.prepare("SELECT COUNT(*) AS count FROM (SELECT ident FROM files GROUP BY ident HAVING COUNT(*) > 1)").get().count;
  const duplicateOwnership = database.prepare("SELECT COUNT(*) AS count FROM (SELECT ident, media_id FROM files GROUP BY ident, media_id HAVING COUNT(*) > 1)").get().count;
  const unclassified = database.prepare("SELECT COUNT(*) AS count FROM media WHERE category IN ('unknown', 'unclassified')").get().count;
  const b39 = new Set(sidecar.idents);
  let b39Leakage = 0;
  for (const row of database.prepare("SELECT ident FROM files").iterate()) if (b39.has(row.ident)) b39Leakage += 1;
  const snapshot = snapshotDatabase(database);
  const result = {
    ...snapshot,
    quick_check: quickCheck,
    foreign_key_check: foreignKeys.length,
    duplicate_idents: Number(duplicateIdents),
    duplicate_ownership: Number(duplicateOwnership),
    b39_purged_ident_leakage: b39Leakage,
  };
  if (quickCheck !== "ok" || foreignKeys.length || duplicateIdents || duplicateOwnership || unclassified || b39Leakage) throw new ObservationError("DATABASE_HEALTH_FAILED");
  return result;
}

function buildObservationContract({ repositoryCommit }) {
  const contract = {
    schema_version: 1,
    runner_version: OBSERVATION_RUNNER_VERSION,
    repository_commit: repositoryCommit,
    mode: OBSERVATION_MODE,
    coverage_declaration: COVERAGE_DECLARATION,
    query_portfolio: [...B46_QUERY_PORTFOLIO],
    category: "video",
    sort: "recent",
    page_size: B46_DEFAULT_POLICY.pageSize,
    max_pages_per_query: B46_DEFAULT_POLICY.maxPagesPerQuery,
    max_requests: B46_DEFAULT_POLICY.maxRequests,
    max_discovered_items: B46_DEFAULT_POLICY.maxDiscoveredItems,
    b39_sidecar: "B39_PURGED_IDENT_SET",
    classifier_policy_version: B46_POLICY_VERSION,
    deep_audit_policy_version: "b46.3-bootstrap-v1",
    production_apply: false,
    state_advancement: false,
  };
  return { ...contract, fingerprint: sha256(contract) };
}

function defaultSeries(seriesId, contract, now) {
  return {
    schema_version: SERIES_SCHEMA_VERSION,
    kind: "B46.7_DAILY_OBSERVATION_SERIES",
    series_id: seriesId,
    lifecycle: "INITIALIZED",
    started_at: null,
    latest_at: null,
    completed_at: null,
    target_valid_observations: 7,
    successful_observations: 0,
    failed_observations: 0,
    expected_contract_fingerprint: contract.fingerprint,
    contract: contract,
    observations: [],
    failures: [],
    created_at: now,
  };
}

function validateSeries(series, seriesId, contract) {
  if (!series || series.schema_version !== SERIES_SCHEMA_VERSION || series.kind !== "B46.7_DAILY_OBSERVATION_SERIES") throw new ObservationError("SERIES_STATE_INVALID");
  if (series.series_id !== seriesId) throw new ObservationError("SERIES_ID_MISMATCH");
  if (series.expected_contract_fingerprint !== contract.fingerprint) throw new ObservationError("CONTRACT_FINGERPRINT_MISMATCH");
  if (!Array.isArray(series.observations) || !Array.isArray(series.failures)) throw new ObservationError("SERIES_STATE_INVALID");
  const dates = new Set();
  for (const observation of series.observations) {
    if (observation.status !== "SUCCESS" || dates.has(observation.local_calendar_date)) throw new ObservationError("SERIES_OBSERVATION_INDEX_INVALID");
    dates.add(observation.local_calendar_date);
  }
  if (series.successful_observations !== series.observations.length || series.failed_observations !== series.failures.length) throw new ObservationError("SERIES_COUNT_MISMATCH");
  return series;
}

function readOrCreateSeries(seriesPath, seriesId, contract, now) {
  if (!fs.existsSync(seriesPath)) return defaultSeries(seriesId, contract, now);
  let series;
  try { series = JSON.parse(fs.readFileSync(seriesPath, "utf8")); } catch { throw new ObservationError("SERIES_STATE_MALFORMED"); }
  return validateSeries(series, seriesId, contract);
}

function updateSeries(seriesPath, series) {
  writeJsonReplace(seriesPath, series);
}

function safeErrorCode(error) {
  return String(error?.code || "OBSERVATION_FAILED").replace(/[^A-Z0-9_:-]/giu, "_").slice(0, 120);
}

function validateResponse(response) {
  if (!response || !Array.isArray(response.files)) throw new ObservationError("MALFORMED_PROVIDER_RESPONSE");
}

function classifySets(plan, audit) {
  const currentKnown = [];
  const currentUnknown = [];
  const accepted = [];
  const quarantine = [];
  for (const record of plan.discovery_delta) {
    if (record.action === "INSERT") {
      accepted.push(record.ident);
      currentUnknown.push(record.ident);
    } else if (record.action === "QUARANTINE_UNCLASSIFIED") {
      quarantine.push(record.ident);
      currentUnknown.push(record.ident);
    } else {
      currentKnown.push(record.ident);
    }
  }
  return {
    current_known: normalizeIdents(currentKnown),
    current_unknown: normalizeIdents(currentUnknown),
    accepted: normalizeIdents(accepted),
    quarantine: normalizeIdents(quarantine),
    deep_approved: normalizeIdents((audit.approved_records || []).map((record) => record.ident)),
    deep_rejected: normalizeIdents((audit.rejected_records || []).map((record) => record.ident)),
  };
}

function writeSetArtifact(runDir, name, idents) {
  const sorted = normalizeIdents(idents);
  const canonical = canonicalSetText(sorted);
  const fileName = SET_FILE_NAMES[name];
  writeNewFile(path.join(runDir, "sets", fileName), canonical ? `${canonical}\n` : "");
  return { file: path.join("sets", fileName), count: sorted.length, sha256: sha256(canonical) };
}

function readSetArtifact(runDir, name, expectedHash = null) {
  const filePath = path.join(runDir, "sets", SET_FILE_NAMES[name]);
  if (!fs.existsSync(filePath)) throw new ObservationError("OBSERVATION_SET_MISSING");
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw === "" ? [] : raw.split(/\r?\n/u).filter((line) => line !== "");
  const idents = normalizeIdents(lines);
  const actual = sha256(canonicalSetText(idents));
  if (expectedHash && actual !== expectedHash) throw new ObservationError("OBSERVATION_SET_DIGEST_MISMATCH");
  return idents;
}

function readManifest(runDir) {
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema_version !== OBSERVATION_SCHEMA_VERSION || manifest.status !== "SUCCESS") throw new ObservationError("OBSERVATION_MANIFEST_INVALID");
  const copy = { ...manifest };
  delete copy.manifest_sha256;
  if (sha256(copy) !== manifest.manifest_sha256) throw new ObservationError("OBSERVATION_MANIFEST_DIGEST_MISMATCH");
  for (const name of SET_NAMES) readSetArtifact(runDir, name, manifest.sets?.[name]?.sha256);
  return manifest;
}

function ensureNoProductionApplyArgs(argv) {
  const forbidden = new Set(["--apply", "--advance-state", "--publication-verified", "--verify-stale", "--backup-path", "--expected-plan-sha256"]);
  for (const arg of argv) if (forbidden.has(arg) || arg.startsWith("--apply=") || arg.startsWith("--backup-path=")) throw new ObservationError("OBSERVATION_APPLY_OPTION_FORBIDDEN");
}

async function createLiveObservationDependencies() {
  const username = process.env.WEBSHARE_USERNAME;
  const password = process.env.WEBSHARE_PASSWORD;
  if (!username || !password) throw new ObservationError("CREDENTIALS_UNAVAILABLE");
  const client = createApiClient();
  const meter = {
    state: { authentication_requests: 0, search_requests: 0 },
    beforeRequest(kind) { if (kind === "login") this.state.authentication_requests += 1; },
    afterRequest() {},
  };
  const token = await loginAndGetWst({ username, password, client, requestMeter: meter });
  const session = new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { apiClient: client, login: async () => token, requestMeter: meter });
  return {
    meter,
    async fetchPage({ query, offset, limit }) {
      meter.state.search_requests += 1;
      const response = await fetchSearchPage(client, session, { prefix: query, wildcardSuffix: "", sort: "recent", category: "video", offset, limit, requestMeter: meter });
      validateResponse(response);
      return response;
    },
  };
}

function assertNoConflictingLocks(runtimeDir) {
  for (const name of ["webshare-crawler.lock", "webshare-daily-maintenance.lock"]) {
    const inspection = inspectLock(path.join(runtimeDir, name));
    if (inspection.exists) throw new ObservationError("CONCURRENT_MAINTENANCE");
  }
}

function makeFailure(runDir, seriesId, contract, startedAt, error) {
  const failure = {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    kind: "B46.7_DAILY_OBSERVATION_FAILURE",
    status: "FAILED",
    series_id: seriesId,
    observation_started_at: startedAt,
    observation_finished_at: new Date().toISOString(),
    local_calendar_date: localCalendarDate(startedAt),
    contract_fingerprint: contract.fingerprint,
    error_code: safeErrorCode(error),
  };
  writeJsonNew(path.join(runDir, "failure.json"), failure);
  return failure;
}

async function runObservation(options = {}) {
  const now = options.now || new Date().toISOString();
  const repositoryCommit = options.repositoryCommit || "unknown";
  const contract = options.contract || buildObservationContract({ repositoryCommit });
  const root = path.resolve(options.seriesRoot || path.join("runtime", "daily-observation"));
  const seriesId = options.seriesId || "b46.7-7day-observation";
  const databasePath = path.resolve(options.database || path.join("data", "catalog.sqlite"));
  const sidecarPath = path.resolve(options.sidecar || path.join("runtime", "maintenance", "history", "b39-purged-idents.json"));
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const seriesPath = path.join(root, "series.json");
  let series = readOrCreateSeries(seriesPath, seriesId, contract, now);
  if (series.lifecycle === "COMPLETE" && !options.diagnostic) throw new ObservationError("SERIES_ALREADY_COMPLETE");
  const localDate = localCalendarDate(now);
  if (!options.diagnostic && series.observations.some((observation) => observation.local_calendar_date === localDate)) throw new ObservationError("OBSERVATION_ALREADY_COMPLETED_FOR_LOCAL_DATE");
  if (!fs.existsSync(sidecarPath)) throw new ObservationError("B39_SIDECAR_MISSING");
  const sidecar = readAndValidatePurgedSidecar(sidecarPath);
  assertNoConflictingLocks(path.dirname(root));
  const lock = acquireCrawlerLock(path.join(root, ".observation.lock"), `observation-${seriesId}-${process.pid}`);
  const startedAt = now;
  const runName = `${timestampDirectoryName(startedAt)}${options.diagnostic ? `-diagnostic-${process.pid}` : ""}`;
  const runDir = path.join(root, runName);
  let database = null;
  try {
    fs.mkdirSync(runDir, { recursive: false, mode: 0o750 });
    const deps = options.dependencies || await createLiveObservationDependencies();
    database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
    const before = setHealth(database, sidecar);
    const policy = { ...B46_DEFAULT_POLICY };
    const queries = [...B46_QUERY_PORTFOLIO];
    const startedMono = process.hrtime.bigint();
    const discovery = await discoverBestEffortPortfolio({
      queries,
      fetchPage: ({ query, offset, limit }) => deps.fetchPage({ query, offset, limit }),
      normalize: normalizeFile,
      policy,
    });
    const runtimeMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
    if (discovery.raw_records === 0 || discovery.unique_idents === 0 || discovery.nonempty_queries === 0) throw new ObservationError("EMPTY_PROVIDER_RESULT");
    const rawUnique = discovery.items.map((item) => item.ident);
    const provenance = filterPurgedDiscoveryItems(discovery.items, sidecar);
    const plan = buildDailyPlan({ database, items: provenance.items, policy, discovery: { ...discovery, items: undefined, coverage_declaration: COVERAGE_DECLARATION }, operation: "daily-best-effort", now: new Date().toISOString() });
    const deepDir = path.join(runDir, "deep-audit");
    const freeze = freezeAcceptedPlan({ plan, database, purgedIdents: new Set(sidecar.idents), sourcePlanSha256: plan.plan_sha256, outputDir: deepDir });
    const audit = auditFrozenRecords({ freeze, database, purgedIdents: new Set(sidecar.idents), outputDir: deepDir });
    const sets = {
      raw_unique: rawUnique,
      post_b39: provenance.items.map((item) => item.ident),
      ...classifySets(plan, audit),
    };
    const setMetadata = Object.fromEntries(SET_NAMES.map((name) => [name, writeSetArtifact(runDir, name, sets[name])]));
    const classificationRecords = plan.discovery_delta.map((record) => ({ ident: record.ident, action: record.action, classification: record.classification, parser: record.parser, item: record.item }));
    writeNewFile(path.join(runDir, "classification.jsonl"), classificationRecords.map((record) => JSON.stringify(record)).join("\n") + (classificationRecords.length ? "\n" : ""));
    writeJsonNew(path.join(runDir, "plan.json"), plan);
    const after = setHealth(database, sidecar);
    if (stableJson(before) !== stableJson(after)) throw new ObservationError("DATABASE_DRIFT_DURING_OBSERVATION");
    const finishedAt = new Date().toISOString();
    const meter = deps.meter?.state || {};
    const manifestBase = {
      schema_version: OBSERVATION_SCHEMA_VERSION,
      kind: "B46.7_DAILY_OBSERVATION",
      status: "SUCCESS",
      series_id: seriesId,
      observation_started_at: startedAt,
      observation_finished_at: finishedAt,
      local_calendar_date: localCalendarDate(startedAt),
      runtime_ms: runtimeMs,
      runner_host: os.hostname(),
      runner_pid: process.pid,
      contract,
      contract_fingerprint: contract.fingerprint,
      repository_commit: repositoryCommit,
      provider: { authentication_requests: meter.authentication_requests ?? null, search_requests: meter.search_requests ?? discovery.requests, requests: (meter.authentication_requests ?? 0) + (meter.search_requests ?? discovery.requests) },
      discovery: { mode: discovery.mode, coverage_declaration: discovery.coverage_declaration, complete: discovery.complete, stop_reason: discovery.stop_reason, queries: queries.length, requests: discovery.requests, raw_records: discovery.raw_records, unique_idents: discovery.unique_idents, raw_duplicates: discovery.raw_records - discovery.unique_idents, b39_matches: provenance.filtered_count, post_b39: provenance.items.length, nonempty_queries: discovery.nonempty_queries, empty_queries: discovery.empty_queries },
      database: { before, after, path: databasePath, readonly: true },
      plan: { path: "plan.json", sha256: plan.plan_sha256, status: plan.status, blocked_reasons: plan.blocked_reasons, counters: plan.counters },
      deep_audit: { path: "deep-audit/bootstrap-audit.json", raw_accepted: plan.counters.accepted, approved: audit.approved_count, rejected: audit.rejected_count, category_counts: audit.category_counts, rejection_counts: audit.rejection_counts },
      classification: { accepted_categories: Object.fromEntries(Object.entries(plan.discovery_delta.filter((row) => row.action === "INSERT").reduce((counts, row) => { const key = row.classification?.category || "UNKNOWN"; counts[key] = (counts[key] || 0) + 1; return counts; }, {}))), deep_approved_categories: Object.fromEntries(Object.entries(audit.category_counts || {})), accepted_evidence: Object.fromEntries(Object.entries(plan.discovery_delta.filter((row) => row.action === "INSERT").reduce((counts, row) => { const key = row.classification?.reason || "UNKNOWN"; counts[key] = (counts[key] || 0) + 1; return counts; }, {}))), accepted_confidence: Object.fromEntries(Object.entries(plan.discovery_delta.filter((row) => row.action === "INSERT").reduce((counts, row) => { const key = String(row.classification?.confidence ?? "UNKNOWN"); counts[key] = (counts[key] || 0) + 1; return counts; }, {})) ) },
      sets: setMetadata,
      safety: { sqlite_write_performed: false, candidate_insertion: false, media_creation: false, deactivation: false, deletion: false, reconciliation: false, publication: false, pointer_switched: false, apply_path_available: false, production_state_advanced: false },
    };
    const manifest = { ...manifestBase, manifest_sha256: sha256(manifestBase) };
    writeJsonNew(path.join(runDir, "manifest.json"), manifest);
    const prior = [...series.observations].sort((a, b) => a.observation_finished_at.localeCompare(b.observation_finished_at)).at(-1);
    const summary = { status: "SUCCESS", timestamp: finishedAt, local_calendar_date: localCalendarDate(startedAt), contract_fingerprint: contract.fingerprint, raw_unique: sets.raw_unique.length, post_b39: sets.post_b39.length, current_known: sets.current_known.length, current_unknown: sets.current_unknown.length, accepted: sets.accepted.length, deep_approved: sets.deep_approved.length, deep_rejected: sets.deep_rejected.length, quarantine: sets.quarantine.length, provider_requests: manifest.provider.requests, runtime_ms: runtimeMs };
    if (prior) {
      const priorDir = path.resolve(root, prior.artifact_dir);
      for (const name of ["raw_unique", "post_b39", "current_unknown", "accepted", "deep_approved", "quarantine"]) summary[`comparison_${name}`] = comparison(new Set(readSetArtifact(priorDir, name, prior.sets[name].sha256)), new Set(sets[name]));
    }
    writeJsonNew(path.join(runDir, "summary.json"), summary);
    if (!options.diagnostic) {
      const observationRef = { status: "SUCCESS", observation_started_at: startedAt, observation_finished_at: finishedAt, local_calendar_date: localCalendarDate(startedAt), artifact_dir: path.relative(root, runDir).replaceAll(path.sep, "/"), manifest_sha256: manifest.manifest_sha256, contract_fingerprint: contract.fingerprint, sets: setMetadata };
      series = { ...series, lifecycle: series.successful_observations + 1 >= series.target_valid_observations ? "COMPLETE" : "COLLECTING", started_at: series.started_at || startedAt, latest_at: finishedAt, completed_at: series.successful_observations + 1 >= series.target_valid_observations ? finishedAt : null, successful_observations: series.successful_observations + 1, observations: [...series.observations, observationRef] };
      updateSeries(seriesPath, series);
    }
    return { manifest, summary, runDir, series };
  } catch (error) {
    const safe = error instanceof ObservationError ? error : new ObservationError(error?.code || "OBSERVATION_FAILED");
    try { fs.mkdirSync(runDir, { recursive: true, mode: 0o750 }); makeFailure(runDir, seriesId, contract, startedAt, safe); } catch {}
    if (!options.diagnostic) {
      const failureRef = { status: "FAILED", observation_started_at: startedAt, observation_finished_at: new Date().toISOString(), local_calendar_date: localCalendarDate(startedAt), artifact_dir: path.relative(root, runDir).replaceAll(path.sep, "/"), error_code: safeErrorCode(safe), contract_fingerprint: contract.fingerprint };
      series = { ...series, lifecycle: series.successful_observations ? "COLLECTING" : "INITIALIZED", failed_observations: series.failed_observations + 1, failures: [...series.failures, failureRef] };
      updateSeries(seriesPath, series);
    }
    throw safe;
  } finally {
    if (database) database.close();
    try { lock.release(); } catch {}
  }
}

module.exports = {
  COVERAGE_DECLARATION,
  OBSERVATION_MODE,
  OBSERVATION_RUNNER_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  SERIES_SCHEMA_VERSION,
  SET_NAMES,
  TIME_ZONE,
  ObservationError,
  buildObservationContract,
  canonicalSetText,
  comparison,
  createLiveObservationDependencies,
  digestIdents,
  localCalendarDate,
  normalizeIdents,
  readManifest,
  readSetArtifact,
  runObservation,
  sha256,
  stableJson,
  timestampDirectoryName,
};
