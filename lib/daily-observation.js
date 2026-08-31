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
const OBSERVATION_DIAGNOSTIC_POLICY_VERSION = "b47-safe-provider-errors-v1";
const OBSERVATION_RETRY_POLICY_VERSION = "b47-bounded-search-retry-v1";
const OBSERVATION_MAX_ATTEMPTS_PER_REQUEST = 2;
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
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "ObservationError";
    this.code = code;
    this.details = details;
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

const SEMANTIC_CONTRACT_FIELDS = Object.freeze([
  "schema_version",
  "mode",
  "coverage_declaration",
  "query_portfolio",
  "category",
  "sort",
  "page_size",
  "max_pages_per_query",
  "max_requests",
  "max_discovered_items",
  "b39_sidecar",
  "classifier_policy_version",
  "deep_audit_policy_version",
  "production_apply",
  "state_advancement",
]);

function semanticContractProjection(contract) {
  if (!contract || typeof contract !== "object") throw new ObservationError("OBSERVATION_CONTRACT_INVALID");
  const projection = {};
  for (const field of SEMANTIC_CONTRACT_FIELDS) {
    if (contract[field] !== undefined) projection[field] = contract[field];
  }
  return projection;
}

function semanticContractId(contract) {
  return sha256(semanticContractProjection(contract));
}

function compatibleObservationContracts(left, right) {
  const leftId = semanticContractId(left);
  const rightId = semanticContractId(right);
  return {
    compatible: leftId === rightId,
    semantic_contract_id: leftId,
    other_semantic_contract_id: rightId,
    reason: leftId === rightId ? "SEMANTIC_CONTRACT_MATCH" : "SEMANTIC_CONTRACT_MISMATCH",
  };
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
  const semantic = {
    schema_version: 1,
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
  const contract = {
    ...semantic,
    runner_version: OBSERVATION_RUNNER_VERSION,
    repository_commit: repositoryCommit,
    implementation_build_id: OBSERVATION_RUNNER_VERSION + "@" + repositoryCommit,
    semantic_contract_id: semanticContractId(semantic),
    diagnostic_policy_version: OBSERVATION_DIAGNOSTIC_POLICY_VERSION,
    retry_policy_version: OBSERVATION_RETRY_POLICY_VERSION,
    max_attempts_per_request: OBSERVATION_MAX_ATTEMPTS_PER_REQUEST,
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
  if (series.expected_contract_fingerprint !== series.contract?.fingerprint) throw new ObservationError("SERIES_CONTRACT_REFERENCE_INVALID");
  if (!compatibleObservationContracts(series.contract, contract).compatible) throw new ObservationError("CONTRACT_SEMANTIC_MISMATCH");
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

function sanitizeProviderMessage(value) {
  let message = String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  message = message.replace(/(?:wst|token|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)(?:\s+|\s*[:=]\s*)[^\s,;]+/giu, "[REDACTED]");
  message = message.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/=._-]+\b/giu, "[REDACTED]");
  return message.slice(0, 512) || null;
}

function providerErrorClass(error) {
  const status = Number(error?.response?.status || error?.http_status || (Number.isFinite(Number(error?.status)) ? error.status : 0)) || null;
  const code = String(error?.code || "").toUpperCase();
  if (["ECONNABORTED", "ETIMEDOUT", "TIMEOUT"].includes(code)) return { class: "TIMEOUT", retryable: true, auth_refreshable: false, status };
  if (["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "NETWORK_ERROR"].includes(code)) return { class: "NETWORK", retryable: true, auth_refreshable: false, status };
  if (status === 429 || ["429", "RATE_LIMITED"].includes(code)) return { class: "RATE_LIMITED", retryable: true, auth_refreshable: false, status };
  if (status >= 500 || ["SERVER_ERROR", "HTTP_500", "TEMPORARY_HTTP"].includes(code)) return { class: "SERVER_ERROR", retryable: true, auth_refreshable: false, status };
  if (status === 401 || status === 403 || /AUTH|TOKEN|ACCESS_DENIED/iu.test(code)) return { class: "AUTHENTICATION", retryable: false, auth_refreshable: true, status };
  if (status >= 400 || code === "ERR_BAD_REQUEST" || code === "CLIENT_REQUEST_ERROR") return { class: "CLIENT_REQUEST", retryable: false, auth_refreshable: false, status };
  return { class: "UNKNOWN_PROVIDER_ERROR", retryable: Boolean(error?.retryable), auth_refreshable: false, status };
}

function safeProviderRequestMetadata(context, error, retryDecision = "FAIL_CLOSED") {
  const classification = providerErrorClass(error);
  const safeQuery = /^[a-z0-9]$/iu.test(String(context?.query || "")) ? String(context.query) : null;
  return {
    phase: context?.phase || "discovery",
    endpoint_name: context?.endpoint_name || "webshare.search",
    http_method: "POST",
    safe_query_literal: safeQuery,
    page_index: Number.isInteger(context?.page_index) ? context.page_index : null,
    offset: Number.isInteger(context?.offset) ? context.offset : null,
    limit: Number.isInteger(context?.limit) ? context.limit : null,
    sort: context?.sort || "recent",
    category: context?.category || "video",
    request_ordinal: Number.isInteger(context?.request_ordinal) ? context.request_ordinal : null,
    http_status: classification.status,
    axios_code: typeof error?.code === "string" ? error.code.replace(/[^A-Z0-9_:-]/giu, "_").slice(0, 80) : null,
    provider_safe_error_code: typeof error?.code === "string" ? error.code.replace(/[^A-Z0-9_:-]/giu, "_").slice(0, 120) : null,
    sanitized_provider_message: sanitizeProviderMessage(error?.message),
    attempt: Number.isInteger(context?.attempt) ? context.attempt : null,
    authentication_succeeded: context?.authentication_succeeded === true,
    elapsed_request_ms: Number.isFinite(context?.elapsed_request_ms) ? Math.max(0, Math.round(context.elapsed_request_ms)) : null,
    retry_decision: retryDecision,
    error_class: classification.class,
    retryable: classification.retryable,
    auth_refreshable: classification.auth_refreshable,
  };
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
    state: { authentication_requests: 0, search_requests: 0, request_attempts: [], auth_succeeded: false },
    beforeRequest(kind) { if (kind === "login") this.state.authentication_requests += 1; },
    afterRequest() {},
  };
  let token;
  const authStarted = Date.now();
  try {
    token = await loginAndGetWst({ username, password, client, requestMeter: meter });
    meter.state.auth_succeeded = true;
  } catch (error) {
    const metadata = safeProviderRequestMetadata({
      phase: "authentication",
      endpoint_name: "webshare.authentication",
      request_ordinal: 1,
      attempt: 1,
      authentication_succeeded: false,
      elapsed_request_ms: Date.now() - authStarted,
    }, error);
    throw new ObservationError(safeErrorCode(error), "Provider authentication failed", { request_attempts: [metadata], final_failure_reason: safeErrorCode(error) });
  }
  const session = new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { apiClient: client, login: async () => token, requestMeter: meter });
  return {
    meter,
    async fetchPage({ query, offset, limit }) {
      const pageIndex = Math.floor(offset / limit);
      const attempts = [];
      for (let attempt = 1; attempt <= OBSERVATION_MAX_ATTEMPTS_PER_REQUEST; attempt += 1) {
        if (meter.state.search_requests >= B46_DEFAULT_POLICY.maxRequests) {
          const budgetError = new ObservationError("OBSERVATION_REQUEST_BUDGET_EXHAUSTED", "Observation request budget exhausted");
          const metadata = safeProviderRequestMetadata({ phase: "discovery", query, page_index: pageIndex, offset, limit, request_ordinal: meter.state.search_requests + 1, attempt, authentication_succeeded: meter.state.auth_succeeded, elapsed_request_ms: 0 }, budgetError);
          attempts.push(metadata);
          throw new ObservationError(budgetError.code, budgetError.message, { request_attempts: attempts, final_failure_reason: budgetError.code });
        }
        const started = Date.now();
        const requestOrdinal = meter.state.search_requests + 1;
        meter.state.search_requests += 1;
        try {
          const response = await fetchSearchPage(client, session, { prefix: query, wildcardSuffix: "", sort: "recent", category: "video", offset, limit, requestMeter: meter });
          validateResponse(response);
          meter.state.request_attempts.push({ phase: "discovery", endpoint_name: "webshare.search", request_ordinal: requestOrdinal, attempt, outcome: "SUCCESS", elapsed_request_ms: Date.now() - started });
          return response;
        } catch (error) {
          const classification = providerErrorClass(error);
          const retry = classification.retryable && attempt < OBSERVATION_MAX_ATTEMPTS_PER_REQUEST;
          const metadata = safeProviderRequestMetadata({ phase: "discovery", endpoint_name: "webshare.search", query, page_index: pageIndex, offset, limit, request_ordinal: requestOrdinal, attempt, authentication_succeeded: meter.state.auth_succeeded, elapsed_request_ms: Date.now() - started }, error, retry ? "RETRY_BOUNDED" : "FAIL_CLOSED");
          attempts.push(metadata);
          meter.state.request_attempts.push(metadata);
          if (retry) {
            await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
            continue;
          }
          throw new ObservationError(safeErrorCode(error), "Provider search request failed", { request_attempts: attempts, final_failure_reason: safeErrorCode(error) });
        }
      }
      throw new ObservationError("OBSERVATION_RETRY_EXHAUSTED");
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
    retry_policy_version: OBSERVATION_RETRY_POLICY_VERSION,
    failure_metadata: error?.details || null,
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
      provider: { authentication_requests: meter.authentication_requests ?? null, search_requests: meter.search_requests ?? discovery.requests, requests: (meter.authentication_requests ?? 0) + (meter.search_requests ?? discovery.requests), retry_policy_version: OBSERVATION_RETRY_POLICY_VERSION, request_attempts: meter.request_attempts?.length ?? null },
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
    const safe = error instanceof ObservationError ? error : new ObservationError(error?.code || "OBSERVATION_FAILED", error?.message || "OBSERVATION_FAILED", error?.details || null);
    try { fs.mkdirSync(runDir, { recursive: true, mode: 0o750 }); makeFailure(runDir, seriesId, contract, startedAt, safe); } catch {}
    if (!options.diagnostic) {
      const failureRef = { status: "FAILED", observation_started_at: startedAt, observation_finished_at: new Date().toISOString(), local_calendar_date: localCalendarDate(startedAt), artifact_dir: path.relative(root, runDir).replaceAll(path.sep, "/"), error_code: safeErrorCode(safe), contract_fingerprint: contract.fingerprint, failure_metadata: safe.details || null };
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
  OBSERVATION_DIAGNOSTIC_POLICY_VERSION,
  OBSERVATION_RETRY_POLICY_VERSION,
  OBSERVATION_MAX_ATTEMPTS_PER_REQUEST,
  OBSERVATION_SCHEMA_VERSION,
  SERIES_SCHEMA_VERSION,
  SET_NAMES,
  TIME_ZONE,
  ObservationError,
  buildObservationContract,
  semanticContractProjection,
  semanticContractId,
  compatibleObservationContracts,
  canonicalSetText,
  comparison,
  createLiveObservationDependencies,
  digestIdents,
  localCalendarDate,
  normalizeIdents,
  readManifest,
  readSetArtifact,
  runObservation,
  providerErrorClass,
  sanitizeProviderMessage,
  safeProviderRequestMetadata,
  sha256,
  stableJson,
  timestampDirectoryName,
};
