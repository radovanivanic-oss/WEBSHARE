"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { acquireCrawlerLock } = require("./crawler/lock");

const STALE_CONTRACT_VERSION = "webshare-stale-verification/v1";
const BUCKET_CONTRACT_VERSION = "webshare-stale-buckets/v1";
const RESULT_TAXONOMY_VERSION = "webshare-stale-result/v1";
const BUCKET_COUNT = 52;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_OUTPUT_ROOT = "runtime/stale-verification";
const DEFAULT_DATABASE = "data/catalog.sqlite";
const DEFAULT_SIDECAR = "runtime/maintenance/history/b39-purged-idents.json";
const GLOBAL_MAINTENANCE_LOCK = "runtime/maintenance-cycles/.maintenance-cycle.lock";
const STATUS = Object.freeze({
  PRESENT: "PRESENT",
  DEFINITIVE_MISSING: "DEFINITIVE_MISSING",
  TRANSIENT_FAILURE: "TRANSIENT_FAILURE",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  NOT_CHECKED: "NOT_CHECKED",
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function digestIdents(idents) {
  return sha256((idents || []).join("\n"));
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function writeImmutableJson(filePath, value) {
  if (fs.existsSync(filePath)) throw new Error(`STALE_IMMUTABLE_ARTIFACT_EXISTS:${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(filePath, "wx", 0o640);
  try {
    fs.writeSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return filePath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeId(value, label = "id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value.includes("..")) {
    throw new Error(`STALE_${label.toUpperCase()}_INVALID`);
  }
  return value;
}

function validateIdent(ident) {
  if (typeof ident !== "string" || ident.length === 0 || Buffer.byteLength(ident, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(ident)) {
    throw new Error("STALE_IDENT_INVALID");
  }
  return ident;
}

function bucketForIdent(ident, bucketCount = BUCKET_COUNT) {
  validateIdent(ident);
  if (!Number.isSafeInteger(bucketCount) || bucketCount !== BUCKET_COUNT) throw new Error("STALE_BUCKET_COUNT_INVALID");
  return parseInt(crypto.createHash("sha256").update(ident).digest("hex").slice(0, 8), 16) % bucketCount;
}

function assignBuckets(rows, bucketCount = BUCKET_COUNT) {
  const buckets = Array.from({ length: bucketCount }, () => []);
  const seen = new Set();
  for (const row of rows || []) {
    const ident = validateIdent(typeof row === "string" ? row : row.ident);
    if (seen.has(ident)) throw new Error(`STALE_DUPLICATE_IDENT:${ident}`);
    seen.add(ident);
    buckets[bucketForIdent(ident, bucketCount)].push(typeof row === "string" ? { ident } : row);
  }
  for (const bucket of buckets) bucket.sort((a, b) => a.ident.localeCompare(b.ident));
  return buckets;
}

function splitBatches(rows, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error("STALE_BATCH_SIZE_INVALID");
  const batches = [];
  for (let index = 0; index < rows.length; index += batchSize) batches.push(rows.slice(index, index + batchSize));
  return batches;
}

function localDateParts(value = new Date(), timeZone = "Europe/Bratislava") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), date: `${map.year}-${map.month}-${map.day}` };
}

function isoWeekNumber(dateParts) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function selectBucketForDate(value = new Date(), timeZone = "Europe/Bratislava") {
  const parts = localDateParts(value, timeZone);
  const isoWeek = isoWeekNumber(parts);
  return { ...parts, iso_week: isoWeek, bucket: (isoWeek - 1) % BUCKET_COUNT, time_zone: timeZone };
}

function redactText(value) {
  let text = String(value?.message || value || "provider_error");
  text = text.replace(/(wst|token|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
  text = text.replace(/<response[\s\S]*$/iu, "[REDACTED_XML]");
  return text.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
}

function safeErrorCode(error) {
  const code = String(error?.code || "PROVIDER_ERROR");
  return /^[A-Z0-9_.-]{1,64}$/u.test(code) ? code : "PROVIDER_ERROR";
}

function classifyRequestError(error) {
  const status = Number(error?.status || error?.response?.status || 0) || null;
  const code = safeErrorCode(error);
  const invalid = new Set(["MALFORMED_RESPONSE", "UNSUPPORTED_RESPONSE", "CLIENT_REQUEST_ERROR", "INVALID_RESPONSE"]);
  const retryable = error?.retryable === true || [408, 425, 429, 500, 502, 503, 504].includes(status) || ["TIMEOUT", "NETWORK_ERROR", "RATE_LIMITED", "SERVER_ERROR"].includes(code);
  return { code, status, retryable, result_status: invalid.has(code) || !retryable ? STATUS.INVALID_RESPONSE : STATUS.TRANSIENT_FAILURE };
}

function normalizeBatchResponse(requestedIdents, response) {
  const requested = [...new Set(requestedIdents)];
  if (!Array.isArray(response?.files) || response.files.length !== requested.length) {
    throw Object.assign(new Error("Incomplete files_exist response"), { code: "INVALID_RESPONSE", retryable: false, status: response?.status || null });
  }
  const requestedSet = new Set(requested);
  const seen = new Set();
  const rows = response.files.map((row) => {
    if (!row || typeof row.ident !== "string" || !requestedSet.has(row.ident) || seen.has(row.ident) || typeof row.exists !== "boolean") {
      throw Object.assign(new Error("Invalid files_exist item response"), { code: "INVALID_RESPONSE", retryable: false, status: response?.status || null });
    }
    seen.add(row.ident);
    return { ident: row.ident, exists: row.exists, downloadable: typeof row.downloadable === "boolean" ? row.downloadable : null };
  });
  if (seen.size !== requested.length) throw Object.assign(new Error("Incomplete files_exist response"), { code: "INVALID_RESPONSE", retryable: false });
  return { status: Number(response.status) || 200, files: rows };
}

function dailyResult(records, date) {
  const rows = records.filter((record) => record.local_calendar_date === date);
  if (rows.some((record) => record.status === STATUS.PRESENT)) return { status: STATUS.PRESENT, records: rows };
  if (rows.some((record) => record.status === STATUS.DEFINITIVE_MISSING)) return { status: STATUS.DEFINITIVE_MISSING, records: rows };
  if (rows.some((record) => record.status === STATUS.INVALID_RESPONSE)) return { status: STATUS.INVALID_RESPONSE, records: rows };
  if (rows.some((record) => record.status === STATUS.TRANSIENT_FAILURE)) return { status: STATUS.TRANSIENT_FAILURE, records: rows };
  return { status: STATUS.NOT_CHECKED, records: rows };
}

function buildStaleLedger(observations, productionRows = []) {
  const production = new Map((productionRows || []).map((row) => [row.ident, row]));
  const byIdent = new Map();
  for (const observation of observations || []) {
    if (observation.contract_version && observation.contract_version !== STALE_CONTRACT_VERSION) continue;
    const records = Array.isArray(observation.records) ? observation.records : [];
    for (const raw of records) {
      const ident = validateIdent(raw.ident);
      const record = { ...raw, ident, run_id: observation.run_id || raw.run_id, local_calendar_date: observation.local_calendar_date || raw.local_calendar_date || String(raw.observed_at || "").slice(0, 10) };
      const list = byIdent.get(ident) || [];
      list.push(record);
      byIdent.set(ident, list);
    }
  }
  const output = [];
  for (const ident of [...byIdent.keys()].sort((a, b) => a.localeCompare(b))) {
    const records = byIdent.get(ident).sort((a, b) => String(a.observed_at || "").localeCompare(String(b.observed_at || "")) || String(a.run_id || "").localeCompare(String(b.run_id || "")));
    const dates = [...new Set(records.map((record) => record.local_calendar_date).filter(Boolean))].sort();
    const daily = dates.map((date) => ({ date, ...dailyResult(records, date) }));
    let missingSincePresent = 0;
    let firstMissing = null;
    let latestMissing = null;
    let missingCount = 0;
    let lastPresent = null;
    const missingRuns = [];
    for (const item of daily) {
      if (item.status === STATUS.PRESENT) {
        missingSincePresent = 0;
        lastPresent = item.date;
      } else if (item.status === STATUS.DEFINITIVE_MISSING) {
        missingSincePresent += 1;
        missingCount += 1;
        firstMissing ||= item.date;
        latestMissing = item.date;
        missingRuns.push(...item.records.map((record) => record.run_id).filter(Boolean));
      }
    }
    const latest = daily.at(-1);
    const state = missingSincePresent >= 2 ? "WOULD_DEACTIVATE" : missingSincePresent === 1 ? "SUSPECT" : latest?.status || STATUS.NOT_CHECKED;
    const row = production.get(ident) || null;
    output.push({
      ident,
      bucket: bucketForIdent(ident),
      first_observed_at: records[0]?.observed_at || null,
      last_observed_at: records.at(-1)?.observed_at || null,
      independent_observation_dates: dates,
      independent_observation_count: dates.length,
      observation_count: records.length,
      consecutive_observation_count: consecutiveDates(dates),
      contract_versions: [...new Set(records.map((record) => record.contract_version || STALE_CONTRACT_VERSION))].sort(),
      last_present_at: lastPresent,
      first_definitive_missing_at: firstMissing,
      latest_definitive_missing_at: latestMissing,
      definitive_missing_observation_count: missingCount,
      transient_failure_count: records.filter((record) => record.status === STATUS.TRANSIENT_FAILURE).length,
      invalid_response_count: records.filter((record) => record.status === STATUS.INVALID_RESPONSE).length,
      state,
      current_production_active: Boolean(row?.is_active),
      current_production_playable: Boolean(row?.is_playable_video),
      media_id: row?.media_id ?? null,
      media_type: row?.media_type ?? null,
      category: row?.category ?? null,
      evidence_run_ids: [...new Set(records.map((record) => record.run_id).filter(Boolean))].sort(),
      missing_evidence_run_ids: [...new Set(missingRuns)].sort(),
      daily_statuses: daily.map((item) => ({ date: item.date, status: item.status, evidence_run_ids: [...new Set(item.records.map((record) => record.run_id).filter(Boolean))].sort() })),
    });
  }
  return output;
}

function consecutiveDates(dates) {
  if (!dates.length) return 0;
  let count = 1;
  for (let i = dates.length - 1; i > 0; i -= 1) {
    const previous = Date.parse(`${dates[i - 1]}T00:00:00Z`);
    const current = Date.parse(`${dates[i]}T00:00:00Z`);
    if (current - previous !== 86400000) break;
    count += 1;
  }
  return count;
}

function lifecyclePreview(ledger, productionRows = []) {
  const active = new Map((productionRows || []).map((row) => [row.ident, row]));
  const current = ledger.filter((row) => active.has(row.ident) && active.get(row.ident).is_active === 1);
  const count = (state) => current.filter((row) => row.state === state).length;
  return {
    schema_version: 1,
    result_taxonomy_version: RESULT_TAXONOMY_VERSION,
    lifecycle_policy: "first independent definitive missing = SUSPECT; second independent definitive missing = WOULD_DEACTIVATE; PRESENT resets pending progression",
    counts: Object.fromEntries(Object.values(STATUS).map((state) => [state, count(state)]).concat([["SUSPECT", count("SUSPECT")], ["WOULD_DEACTIVATE", count("WOULD_DEACTIVATE")]])),
    suspect_idents: current.filter((row) => row.state === "SUSPECT").map((row) => row.ident),
    would_deactivate_idents: current.filter((row) => row.state === "WOULD_DEACTIVATE").map((row) => row.ident),
  };
}

function impactPreview(ledger, productionRows = []) {
  const selected = ledger.filter((row) => ["SUSPECT", "WOULD_DEACTIVATE"].includes(row.state));
  const byCategory = {};
  for (const row of selected) byCategory[row.category || row.media_type || "other"] = (byCategory[row.category || row.media_type || "other"] || 0) + 1;
  const mediaIds = new Set(selected.map((row) => row.media_id).filter((id) => id !== null && id !== undefined));
  const rowsByMedia = new Map();
  const selectedByMedia = new Map();
  for (const row of selected) {
    const list = selectedByMedia.get(row.media_id) || [];
    list.push(row);
    selectedByMedia.set(row.media_id, list);
  }
  for (const row of productionRows) {
    if (!mediaIds.has(row.media_id)) continue;
    const list = rowsByMedia.get(row.media_id) || [];
    list.push(row);
    rowsByMedia.set(row.media_id, list);
  }
  let remaining = 0;
  let lastPlayable = 0;
  for (const rows of rowsByMedia.values()) {
    const playable = rows.filter((row) => row.is_active === 1 && row.is_playable_video === 1).length;
    const selectedForMedia = selectedByMedia.get(rows[0]?.media_id) || [];
    const wouldDeactivate = selectedForMedia.filter((item) => item.state === "WOULD_DEACTIVATE").length;
    if (playable > wouldDeactivate) remaining += 1;
    if (playable > 0 && playable <= wouldDeactivate) lastPlayable += 1;
  }
  return {
    candidate_files: selected.length,
    suspect_files: selected.filter((row) => row.state === "SUSPECT").length,
    would_deactivate_files: selected.filter((row) => row.state === "WOULD_DEACTIVATE").length,
    affected_media_entities: mediaIds.size,
    media_with_remaining_active_variants: remaining,
    media_losing_last_active_playable_variant: lastPlayable,
    by_category: byCategory,
    series_episodes: selected.filter((row) => row.media_type === "episode" || row.category === "series").length,
    movies: selected.filter((row) => row.media_type === "movie" || row.category === "movies").length,
    sports: selected.filter((row) => row.category === "sports").length,
    concerts: selected.filter((row) => row.category === "concerts").length,
    other: selected.filter((row) => !["movie", "episode"].includes(row.media_type) && !["movies", "series", "sports", "concerts"].includes(row.category)).length,
  };
}

function loadEligibleRows(database, tombstones = new Set()) {
  const rows = database.prepare(`
    SELECT f.ident, f.media_id, f.is_active, f.is_playable_video,
           m.media_type, m.category
    FROM files f LEFT JOIN media m ON m.id = f.media_id
    WHERE f.is_active = 1 AND f.is_playable_video = 1 AND f.webshare_category = 'video'
      AND f.ident IS NOT NULL AND length(f.ident) > 0
    ORDER BY f.ident, f.id
  `).all();
  const seen = new Set();
  const eligible = [];
  let b39Hits = 0;
  for (const row of rows) {
    validateIdent(row.ident);
    if (seen.has(row.ident)) throw new Error(`STALE_DUPLICATE_PRODUCTION_IDENT:${row.ident}`);
    seen.add(row.ident);
    if (tombstones.has(row.ident)) { b39Hits += 1; continue; }
    eligible.push(row);
  }
  return { rows: eligible, excluded: { b39_hits: b39Hits, source_rows: rows.length - eligible.length, active_non_playable: Number(database.prepare("SELECT COUNT(*) AS count FROM files WHERE is_active = 1 AND is_playable_video = 0").get().count) } };
}

function countStatuses(records) {
  return Object.fromEntries(Object.values(STATUS).map((status) => [status, records.filter((record) => record.status === status).length]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNoSecrets(value) {
  const encoded = JSON.stringify(value);
  if (/(?:password|wst|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]/iu.test(encoded)) throw new Error("STALE_SECRET_MATERIAL");
}

function auditHistoricalArtifacts(outputRoot) {
  const entries = [];
  if (!fs.existsSync(outputRoot)) return entries;
  for (const name of fs.readdirSync(outputRoot).sort()) {
    const root = path.join(outputRoot, name);
    if (!fs.statSync(root).isDirectory()) continue;
    const runPath = path.join(root, "run.json");
    const resultPath = path.join(root, "results.json");
    if (!fs.existsSync(runPath) || !fs.existsSync(resultPath)) continue;
    try {
      const run = readJson(runPath);
      const result = readJson(resultPath);
      entries.push({ run_id: run.run_id || name, status: run.contract_version === STALE_CONTRACT_VERSION && Array.isArray(result.records) ? "COMPATIBLE_TRUSTWORTHY" : "INCOMPATIBLE", contract_version: run.contract_version || null, result_path: resultPath, local_calendar_date: run.local_calendar_date || null, record_count: Array.isArray(result.records) ? result.records.length : 0 });
    } catch (error) {
      entries.push({ run_id: name, status: "INCOMPLETE", result_path: resultPath, error: redactText(error) });
    }
  }
  return entries;
}

async function buildArtifactIndex(root) {
  const names = ["run.json", "bucket-input.json", "request-log.json", "results.json", "stale-ledger.json", "lifecycle-preview.json", "would-deactivate.json"];
  const artifacts = {};
  for (const name of names) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) throw new Error(`STALE_ARTIFACT_MISSING:${name}`);
    const bytes = fs.readFileSync(file);
    artifacts[name] = { file_sha256: crypto.createHash("sha256").update(bytes).digest("hex"), canonical_sha256: sha256(readJson(file)), bytes: bytes.length };
  }
  const index = { schema_version: 1, kind: "B56_STALE_VERIFICATION_ARTIFACT_INDEX", contract_version: STALE_CONTRACT_VERSION, result_taxonomy_version: RESULT_TAXONOMY_VERSION, artifacts, safety: { sqlite_write_performed: false, source_status_mutation: false, deactivation_performed: false, deletion_performed: false, publication_performed: false, ag_repo_mutation: false } };
  assertNoSecrets(index);
  writeImmutableJson(path.join(root, "artifact-index.json"), index);
  return index;
}

async function runStaleVerification(options = {}) {
  const databasePath = path.resolve(options.databasePath || DEFAULT_DATABASE);
  const sidecarPath = path.resolve(options.sidecarPath || DEFAULT_SIDECAR);
  const outputRoot = path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("STALE_TIME_INVALID");
  const selection = selectBucketForDate(now);
  const bucket = options.bucket === undefined ? selection.bucket : Number(options.bucket);
  if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket >= BUCKET_COUNT) throw new Error("STALE_BUCKET_INVALID");
  const runId = safeId(options.runId || `b56-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z")}`, "run_id");
  const root = path.join(outputRoot, runId);
  if (fs.existsSync(root)) {
    if (fs.existsSync(path.join(root, "artifact-index.json"))) return { status: "ALREADY_COMPLETED", run_id: runId, root, lifecycle: readJson(path.join(root, "lifecycle-preview.json")) };
    throw new Error("STALE_INCOMPLETE_RUN_EXISTS");
  }
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o750 });
  const lock = acquireCrawlerLock(path.resolve(options.globalLockPath || GLOBAL_MAINTENANCE_LOCK), `stale-${runId}`, { recoverStale: true });
  let database;
  try {
    const { readAndValidatePurgedSidecar } = require("./daily-candidate-provenance");
    const sidecar = readAndValidatePurgedSidecar(sidecarPath);
    const sidecarBytes = fs.readFileSync(sidecarPath);
    database = require("../src/db/catalog-db").openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
    const health = require("./maintenance-cycle").productionHealth(databasePath, sidecarPath);
    const loaded = loadEligibleRows(database, new Set(sidecar.idents));
    const buckets = assignBuckets(loaded.rows);
    const selectedRows = buckets[bucket];
    const checkedIdents = selectedRows.map((row) => row.ident);
    const inputDigest = digestIdents(checkedIdents);
    const historical = auditHistoricalArtifacts(outputRoot);
    const startedAt = new Date().toISOString();
    const meter = { auth_reserved: 0, auth_completed: 0, files_exist_reserved: 0, files_exist_completed: 0, pending_kind: null, beforeRequest(kind) { this.pending_kind = kind; if (kind === "login") this.auth_reserved += 1; else if (kind === "files_exist") this.files_exist_reserved += 1; }, afterRequest() { if (this.pending_kind === "login") this.auth_completed += 1; else if (this.pending_kind === "files_exist") this.files_exist_completed += 1; this.pending_kind = null; } };
    const requestLog = [];
    const records = [];
    const username = options.username || process.env.WEBSHARE_USERNAME;
    const password = options.password || process.env.WEBSHARE_PASSWORD;
    let session = options.session || null;
    let authSuccess = false;
    if (!session) {
      if (!username || !password) throw new Error("STALE_WEBSHARE_CREDENTIALS_MISSING");
      const { createApiClient, loginAndGetWst, WebshareSession } = require("../main");
      const client = options.client || createApiClient();
      const login = async () => loginAndGetWst({ username, password, client, requestMeter: meter });
      const token = await login();
      session = new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { apiClient: client, login, requestMeter: meter });
      session.cachedWst = token;
      authSuccess = true;
    } else authSuccess = true;
    let requestOrdinal = 0;
    const batches = splitBatches(selectedRows, Number(options.batchSize || DEFAULT_BATCH_SIZE));
    for (const batch of batches) {
      const ids = batch.map((row) => row.ident);
      let finished = false;
      for (let attempt = 1; attempt <= Number(options.maxRetries || DEFAULT_MAX_RETRIES); attempt += 1) {
        const ordinal = ++requestOrdinal;
        const started = Date.now();
        let request;
        try {
          const result = await session.filesExistBatch(ids, { requestMeter: meter });
          const normalized = normalizeBatchResponse(ids, result);
          const ended = new Date().toISOString();
          const byIdent = new Map(normalized.files.map((row) => [row.ident, row]));
          request = { request_ordinal: ordinal, attempt, endpoint: "files_exist", method: "POST", safe_query: { fields: ["wst", "idents[]"], ident_count: ids.length, idents_sha256: digestIdents(ids) }, status: normalized.status, requested_count: ids.length, answered_count: normalized.files.length, present_count: normalized.files.filter((row) => row.exists).length, definitive_missing_count: normalized.files.filter((row) => !row.exists).length, started_at: new Date(started).toISOString(), finished_at: ended, elapsed_ms: Date.now() - started, retry_decision: "NONE" };
          requestLog.push(request);
          for (const ident of ids) {
            const row = byIdent.get(ident);
            records.push({ ident, bucket, status: row.exists ? STATUS.PRESENT : STATUS.DEFINITIVE_MISSING, observed_at: ended, local_calendar_date: selection.date, run_id: runId, request_ordinal: ordinal, attempt, downloadable: row.downloadable });
          }
          finished = true;
          break;
        } catch (error) {
          const classification = classifyRequestError(error);
          const canRetry = classification.retryable && attempt < Number(options.maxRetries || DEFAULT_MAX_RETRIES);
          request = { request_ordinal: ordinal, attempt, endpoint: "files_exist", method: "POST", safe_query: { fields: ["wst", "idents[]"], ident_count: ids.length, idents_sha256: digestIdents(ids) }, status: classification.status, requested_count: ids.length, answered_count: 0, present_count: 0, definitive_missing_count: 0, started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(), elapsed_ms: Date.now() - started, error_code: classification.code, provider_safe_error: redactText(error), retryable: classification.retryable, retry_decision: canRetry ? "RETRY_BOUNDED" : "FAIL_CLOSED" };
          requestLog.push(request);
          if (canRetry) { await sleep(Math.min(1000, 250 * (2 ** (attempt - 1)))); continue; }
          const status = classification.result_status;
          for (const ident of ids) records.push({ ident, bucket, status, observed_at: request.finished_at, local_calendar_date: selection.date, run_id: runId, request_ordinal: ordinal, attempt, error_code: classification.code });
          finished = true;
          break;
        }
      }
      if (!finished) throw new Error("STALE_BATCH_NOT_FINISHED");
    }
    records.sort((a, b) => a.ident.localeCompare(b.ident));
    if (records.length !== checkedIdents.length || new Set(records.map((record) => record.ident)).size !== checkedIdents.length) throw new Error("STALE_RESULT_ACCOUNTING_MISMATCH");
    const observation = { contract_version: STALE_CONTRACT_VERSION, run_id: runId, local_calendar_date: selection.date, finished_at: new Date().toISOString(), records };
    const priorObservations = [];
    for (const entry of historical.filter((item) => item.status === "COMPATIBLE_TRUSTWORTHY")) {
      const run = readJson(path.join(outputRoot, entry.run_id, "run.json"));
      const result = readJson(path.join(outputRoot, entry.run_id, "results.json"));
      priorObservations.push({ contract_version: run.contract_version, run_id: run.run_id, local_calendar_date: run.local_calendar_date, finished_at: run.finished_at, records: result.records });
    }
    const ledger = buildStaleLedger([...priorObservations, observation], loaded.rows);
    const lifecycle = lifecyclePreview(ledger, loaded.rows);
    const impact = impactPreview(ledger, loaded.rows);
    const run = { schema_version: 1, kind: "B56_STALE_VERIFICATION_RUN", contract_version: STALE_CONTRACT_VERSION, bucket_contract_version: BUCKET_CONTRACT_VERSION, result_taxonomy_version: RESULT_TAXONOMY_VERSION, run_id: runId, started_at: startedAt, finished_at: observation.finished_at, local_calendar_date: selection.date, time_zone: selection.time_zone, selection, bucket, batch_size: Number(options.batchSize || DEFAULT_BATCH_SIZE), bucket_count: BUCKET_COUNT, eligible_population: loaded.rows.length, checked_count: checkedIdents.length, checked_idents_sha256: inputDigest, production_baseline_sha256: health.production_baseline_sha256, production_snapshot: health.snapshot, production_integrity: { quick_check: health.quick_check, foreign_key_check: health.foreign_key_check, duplicate_idents: health.duplicate_idents, duplicate_ownership: health.duplicate_ownership, unclassified: health.unclassified, b39_purged_ident_leakage: health.b39_purged_ident_leakage }, b39_sidecar_sha256: sidecar.idents_sha256, b39_sidecar_file_sha256: crypto.createHash("sha256").update(sidecarBytes).digest("hex"), stale_population_exclusions: loaded.excluded, historical_evidence_audit: historical, authentication: { attempted: true, succeeded: authSuccess, credentials_persisted: false }, request_accounting: { auth_requests: meter.auth_reserved, files_exist_requests: requestLog.length, successful_files_exist_requests: requestLog.filter((request) => request.status === 200).length, retries: requestLog.filter((request) => request.attempt > 1).length, rate_limit_events: requestLog.filter((request) => request.status === 429 || request.error_code === "RATE_LIMITED").length, transport_failures: requestLog.filter((request) => request.retryable === true).length, malformed_or_partial_responses: requestLog.filter((request) => request.error_code === "INVALID_RESPONSE" || request.error_code === "MALFORMED_RESPONSE").length }, result_counts: countStatuses(records), lifecycle, impact, safety: { sqlite_write_performed: false, source_status_mutation: false, deactivation_performed: false, deletion_performed: false, publication_performed: false, ag_repo_mutation: false } };
    fs.mkdirSync(root, { recursive: true, mode: 0o750 });
    writeImmutableJson(path.join(root, "run.json"), run);
    writeImmutableJson(path.join(root, "bucket-input.json"), { schema_version: 1, contract_version: STALE_CONTRACT_VERSION, bucket_contract_version: BUCKET_CONTRACT_VERSION, bucket, count: checkedIdents.length, idents_sha256: inputDigest, idents: checkedIdents });
    writeImmutableJson(path.join(root, "request-log.json"), { schema_version: 1, contract_version: STALE_CONTRACT_VERSION, requests: requestLog });
    writeImmutableJson(path.join(root, "results.json"), { schema_version: 1, contract_version: STALE_CONTRACT_VERSION, result_taxonomy_version: RESULT_TAXONOMY_VERSION, run_id: runId, records });
    writeImmutableJson(path.join(root, "stale-ledger.json"), { schema_version: 1, contract_version: STALE_CONTRACT_VERSION, source_run_ids: [...new Set([...priorObservations.map((item) => item.run_id), runId])].sort(), production_baseline_sha256: health.production_baseline_sha256, records: ledger });
    writeImmutableJson(path.join(root, "lifecycle-preview.json"), { ...lifecycle, impact, run_id: runId, checked_ident_count: checkedIdents.length, result_counts: countStatuses(records) });
    writeImmutableJson(path.join(root, "would-deactivate.json"), { schema_version: 1, contract_version: STALE_CONTRACT_VERSION, mutation_enabled: false, records: ledger.filter((row) => row.state === "WOULD_DEACTIVATE" && row.current_production_active).map((row) => ({ ident: row.ident, bucket: row.bucket, media_id: row.media_id, first_definitive_missing_at: row.first_definitive_missing_at, latest_definitive_missing_at: row.latest_definitive_missing_at, evidence_run_ids: row.missing_evidence_run_ids, current_production_active: row.current_production_active })) });
    await buildArtifactIndex(root);
    return { status: "COMPLETED", run_id: runId, root, bucket, checked_count: checkedIdents.length, checked_idents_sha256: inputDigest, request_accounting: run.request_accounting, result_counts: run.result_counts, lifecycle, impact, production_baseline_sha256: health.production_baseline_sha256 };
  } finally {
    if (database) database.close();
    lock.release();
  }
}

function latestRun(outputRoot = DEFAULT_OUTPUT_ROOT) {
  if (!fs.existsSync(outputRoot)) return null;
  const runs = [];
  for (const name of fs.readdirSync(outputRoot).sort()) {
    const file = path.join(outputRoot, name, "run.json");
    if (!fs.existsSync(file)) continue;
    try { runs.push(readJson(file)); } catch {}
  }
  return runs.sort((a, b) => String(b.finished_at || b.started_at || "").localeCompare(String(a.finished_at || a.started_at || "")))[0] || null;
}

function statusReport(outputRoot = DEFAULT_OUTPUT_ROOT, now = new Date()) {
  const latest = latestRun(outputRoot);
  const selection = selectBucketForDate(now);
  if (!latest) return { status: "NO_RUNS", current_bucket: selection.bucket, next_bucket: (selection.bucket + 1) % BUCKET_COUNT, scheduler_state: "disabled/not installed", mutation_enabled: false, next_action: "run read-only stale pilot" };
  const root = path.join(outputRoot, latest.run_id);
  const lifecycle = fs.existsSync(path.join(root, "lifecycle-preview.json")) ? readJson(path.join(root, "lifecycle-preview.json")) : null;
  return { status: "OK", run_id: latest.run_id, state: latest.status || "COMPLETED", current_bucket: latest.bucket, last_run: latest.finished_at, last_successful_run: latest.finished_at, present: lifecycle?.result_counts?.PRESENT ?? null, suspect: lifecycle?.counts?.SUSPECT ?? null, would_deactivate: lifecycle?.counts?.WOULD_DEACTIVATE ?? null, unresolved: (lifecycle?.result_counts?.TRANSIENT_FAILURE || 0) + (lifecycle?.result_counts?.INVALID_RESPONSE || 0) + (lifecycle?.result_counts?.NOT_CHECKED || 0), next_bucket: (selection.bucket + 1) % BUCKET_COUNT, scheduler_state: "disabled/not installed", mutation_enabled: false, next_action: "wait for next independent weekly read-only opportunity" };
}

module.exports = { BUCKET_CONTRACT_VERSION, BUCKET_COUNT, DEFAULT_BATCH_SIZE, RESULT_TAXONOMY_VERSION, STALE_CONTRACT_VERSION, STATUS, assignBuckets, auditHistoricalArtifacts, buildStaleLedger, classifyRequestError, countStatuses, digestIdents, fileSha256, impactPreview, isoWeekNumber, lifecyclePreview, loadEligibleRows, localDateParts, normalizeBatchResponse, runStaleVerification, selectBucketForDate, sha256, splitBatches, stableJson, statusReport };
