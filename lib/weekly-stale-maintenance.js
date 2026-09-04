"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquireCrawlerLock } = require("./crawler/lock");
const { LockActiveError } = require("./crawler/errors");
const stale = require("./stale-verification");
const daily = require("./daily-maintenance");
const maintenance = require("./maintenance-cycle");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { readAndValidatePurgedSidecar } = require("./daily-candidate-provenance");

const CONTRACT_VERSION = "webshare-weekly-stale-maintenance/v1";
const BUCKET_CONTRACT_VERSION = stale.BUCKET_CONTRACT_VERSION;
const MIN_CONFIRMATION_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE_ROOT = "runtime/stale-weekly";
const DEFAULT_RUNS_ROOT = path.join(DEFAULT_STATE_ROOT, "runs");
const DEFAULT_DATABASE_PATH = "data/catalog.sqlite";
const DEFAULT_SIDECAR_PATH = "runtime/maintenance/history/b39-purged-idents.json";
const DEFAULT_OBSERVATION_ROOT = "runtime/daily-observation";
const DEFAULT_PUBLIC_REPOSITORY = "/home/radeco/ag";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const LOCK_PATH = "runtime/maintenance-cycles/.maintenance-cycle.lock";
const STATUS = Object.freeze({ PRESENT: "PRESENT", MISSING: "MISSING", UNRESOLVED: "UNRESOLVED" });
const SUSPECT = "SUSPECT";

function safeError(error) {
  const code = String(error?.code || "WEEKLY_STALE_FAILED").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64) || "WEEKLY_STALE_FAILED";
  const message = String(error?.message || "weekly stale maintenance failed")
    .replace(/(wst|token|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
  return { code, message, status: Number(error?.status || error?.response?.status || 0) || null, retryable: error?.retryable === true };
}

function safeIdent(ident) {
  if (typeof ident !== "string" || ident.length === 0 || Buffer.byteLength(ident, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(ident)) throw new Error("STALE_IDENT_INVALID");
  return ident;
}

function safeRunId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value.includes("..")) throw new Error("WEEKLY_RUN_ID_INVALID");
  return value;
}

function runId(now = new Date()) {
  return `stale-weekly-${now.toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, file);
}

function writeImmutable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const descriptor = fs.openSync(file, "wx", 0o640);
  try { fs.writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function emptyState() {
  return {
    schema_version: 1,
    contract_version: CONTRACT_VERSION,
    bucket_contract_version: BUCKET_CONTRACT_VERSION,
    minimum_confirmation_age_hours: 24,
    suspects: {},
    last_run: null,
    last_successful_run: null,
    last_cleanup: null,
    last_publication: null,
  };
}

function loadState(stateRoot = DEFAULT_STATE_ROOT) {
  const file = path.join(path.resolve(stateRoot), "state.json");
  const state = readJson(file, null);
  if (!state) return emptyState();
  if (state.schema_version !== 1 || state.contract_version !== CONTRACT_VERSION || state.bucket_contract_version !== BUCKET_CONTRACT_VERSION || !state.suspects || typeof state.suspects !== "object") throw new Error("WEEKLY_STATE_SCHEMA_MISMATCH");
  return { ...emptyState(), ...state, suspects: { ...state.suspects } };
}

function dueSuspects(state, now = new Date()) {
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(time)) throw new Error("WEEKLY_TIME_INVALID");
  return Object.values(state.suspects || {}).filter((row) => row && row.state === SUSPECT && safeIdent(row.ident) && Number.isFinite(Date.parse(row.first_missing_at)) && time - Date.parse(row.first_missing_at) >= MIN_CONFIRMATION_AGE_MS).sort((a, b) => a.ident.localeCompare(b.ident));
}

function pendingSuspects(state, now = new Date()) {
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Object.values(state.suspects || {}).filter((row) => row && row.state === SUSPECT && safeIdent(row.ident) && Number.isFinite(Date.parse(row.first_missing_at)) && time - Date.parse(row.first_missing_at) < MIN_CONFIRMATION_AGE_MS).sort((a, b) => a.ident.localeCompare(b.ident));
}

function makeSuspect(row, record, bucket, run) {
  return {
    ident: safeIdent(row.ident), bucket: Number(bucket), media_id: row.media_id === null ? null : Number(row.media_id), media_type: row.media_type || null, category: row.category || null,
    state: SUSPECT, first_missing_at: record.observed_at, first_missing_run_id: run.run_id,
    last_checked_at: record.observed_at, last_status: STATUS.MISSING, evidence_run_ids: [run.run_id],
  };
}

function mergeEvidence(state, records, rowsByIdent, bucket, run) {
  const next = { ...state, suspects: { ...(state.suspects || {}) } };
  const counts = { PRESENT: 0, MISSING: 0, UNRESOLVED: 0 };
  const newSuspects = [];
  for (const record of records) {
    const row = rowsByIdent.get(record.ident);
    if (!row) continue;
    counts[record.status] = (counts[record.status] || 0) + 1;
    const existing = next.suspects[record.ident];
    if (record.status === STATUS.PRESENT) {
      delete next.suspects[record.ident];
      continue;
    }
    if (record.status === STATUS.MISSING) {
      if (!existing || existing.state !== SUSPECT) {
        next.suspects[record.ident] = makeSuspect(row, record, bucket, run);
        newSuspects.push(record.ident);
      } else {
        next.suspects[record.ident] = { ...existing, last_checked_at: record.observed_at, last_status: STATUS.MISSING, evidence_run_ids: [...new Set([...(existing.evidence_run_ids || []), run.run_id])].slice(-16) };
      }
    } else if (existing && existing.state === SUSPECT) {
      next.suspects[record.ident] = { ...existing, last_checked_at: record.observed_at, last_status: STATUS.UNRESOLVED, evidence_run_ids: [...new Set([...(existing.evidence_run_ids || []), run.run_id])].slice(-16) };
    }
  }
  return { state: next, counts, newSuspects };
}

function currentRows(databasePath, idents = null) {
  const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    const sql = `SELECT f.id, f.ident, f.media_id, f.is_active, f.is_playable_video, f.webshare_category, m.media_type, m.category
      FROM files f LEFT JOIN media m ON m.id = f.media_id ${idents ? "WHERE f.ident IN (" + idents.map(() => "?").join(",") + ")" : ""} ORDER BY f.ident, f.id`;
    const rows = db.prepare(sql).all(...(idents || []));
    const byIdent = new Map();
    for (const row of rows) {
      if (byIdent.has(row.ident)) throw new Error(`WEEKLY_DUPLICATE_IDENT:${row.ident}`);
      byIdent.set(row.ident, row);
    }
    return { rows, byIdent };
  } finally { db.close(); }
}

function loadBucketRows(databasePath, sidecarPath, bucket, dependency = null) {
  if (dependency) return dependency;
  const sidecar = readAndValidatePurgedSidecar(path.resolve(sidecarPath));
  const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    const loaded = stale.loadEligibleRows(db, new Set(sidecar.idents));
    const selected = stale.assignBuckets(loaded.rows)[bucket] || [];
    return { rows: selected, excluded: loaded.excluded, sidecar_sha256: sidecar.idents_sha256, eligible_count: loaded.rows.length };
  } finally { db.close(); }
}

function meter() {
  return { auth_reserved: 0, auth_completed: 0, files_exist_reserved: 0, files_exist_completed: 0, pending_kind: null,
    beforeRequest(kind) { this.pending_kind = kind; if (kind === "login") this.auth_reserved += 1; if (kind === "files_exist") this.files_exist_reserved += 1; },
    afterRequest() { if (this.pending_kind === "login") this.auth_completed += 1; if (this.pending_kind === "files_exist") this.files_exist_completed += 1; this.pending_kind = null; } };
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function createAuthenticatedSession(options, requestMeter) {
  const username = options.username || process.env.WEBSHARE_USERNAME;
  const password = options.password || process.env.WEBSHARE_PASSWORD;
  if (!username || !password) throw new Error("STALE_WEBSHARE_CREDENTIALS_MISSING");
  const { createApiClient, loginAndGetWst, WebshareSession } = require("../main");
  const client = options.client || createApiClient();
  const login = async () => loginAndGetWst({ username, password, client, requestMeter });
  const token = await login();
  const session = new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { apiClient: client, login, requestMeter });
  session.cachedWst = token;
  return session;
}

async function checkIdents({ idents, session, batchSize = DEFAULT_BATCH_SIZE, maxRetries = DEFAULT_MAX_RETRIES, sleepFn = pause, requestMeter = null }) {
  if (!session || typeof session.filesExistBatch !== "function") throw new Error("STALE_SESSION_REQUIRED");
  const meterValue = requestMeter || meter(), records = new Map(), requestLog = [];
  const batches = stale.splitBatches(idents, batchSize);
  let ordinal = 0;
  for (const batch of batches) {
    let done = false;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const started = Date.now(), requestOrdinal = ++ordinal;
      try {
        const normalized = stale.normalizeBatchResponse(batch, await session.filesExistBatch(batch, { requestMeter: meterValue }));
        const answered = new Map(normalized.files.map((row) => [row.ident, row]));
        const observedAt = new Date().toISOString();
        requestLog.push({ request_ordinal: requestOrdinal, attempt, endpoint: "files_exist", method: "POST", requested_count: batch.length, answered_count: normalized.files.length, present_count: normalized.files.filter((row) => row.exists).length, missing_count: normalized.files.filter((row) => !row.exists).length, status: normalized.status, idents_sha256: stale.digestIdents(batch), started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started, retry_decision: "NONE" });
        for (const ident of batch) { const row = answered.get(ident); records.set(ident, { ident, status: row.exists ? STATUS.PRESENT : STATUS.MISSING, downloadable: row.downloadable, observed_at: observedAt, request_ordinal: requestOrdinal, attempt }); }
        done = true; break;
      } catch (error) {
        const classification = stale.classifyRequestError(error), retry = classification.retryable && attempt < maxRetries;
        requestLog.push({ request_ordinal: requestOrdinal, attempt, endpoint: "files_exist", method: "POST", requested_count: batch.length, answered_count: 0, present_count: 0, missing_count: 0, status: classification.status, idents_sha256: stale.digestIdents(batch), started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started, error_code: classification.code, retryable: classification.retryable, retry_decision: retry ? "RETRY_BOUNDED" : "KEEP_ACTIVE_UNRESOLVED" });
        if (retry) { await sleepFn(Math.min(1000, 250 * (2 ** (attempt - 1)))); continue; }
        const observedAt = new Date().toISOString();
        for (const ident of batch) records.set(ident, { ident, status: STATUS.UNRESOLVED, observed_at: observedAt, request_ordinal: requestOrdinal, attempt, error_code: classification.code });
        done = true; break;
      }
    }
    if (!done) throw new Error("WEEKLY_BATCH_NOT_FINISHED");
  }
  if (records.size !== idents.length) throw new Error("WEEKLY_RESULT_ACCOUNTING_MISMATCH");
  return { records: idents.map((ident) => records.get(ident)), requestLog, meter: meterValue };
}

function buildPlan(before, deactivations, createdAt) {
  const plan = { schema_version: 1, kind: "ISOLATED_STALE_CLEANUP_PLAN", operation: "weekly-stale-isolated", status: "READY_FOR_REVIEW", created_at: createdAt, baseline: before, discovery_delta: [], deactivations, blocked_reasons: [] };
  plan.plan_sha256 = daily.sha256(daily.planDigestInput(plan));
  return plan;
}

function transitionThroughApply(cycleRoot) {
  for (const state of [maintenance.STATES.OBSERVATIONS_SELECTED, maintenance.STATES.PERSISTENCE_REFRESHED, maintenance.STATES.ELIGIBILITY_READY, maintenance.STATES.PLAN_READY, maintenance.STATES.APPLY_AUTHORIZATION_REQUIRED, maintenance.STATES.APPLY_AUTHORIZED, maintenance.STATES.APPLY_RUNNING]) maintenance.transition(cycleRoot, state, { next_action: state.toLowerCase().replaceAll("_", "-") });
}

function countCategories(rows) {
  const result = {};
  for (const row of rows) { const key = row.category || row.media_type || "unknown"; result[key] = (result[key] || 0) + 1; }
  return result;
}

function mediaCounts(databasePath, ids) {
  const unique = [...new Set(ids.filter((id) => id !== null && id !== undefined).map(Number).filter(Number.isSafeInteger))];
  if (!unique.length) return {};
  const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try { const placeholders = unique.map(() => "?").join(","); const rows = db.prepare(`SELECT media_id, COUNT(*) AS count FROM files WHERE media_id IN (${placeholders}) AND is_active = 1 AND is_playable_video = 1 GROUP BY media_id`).all(...unique); return Object.fromEntries(unique.map((id) => [String(id), 0]).concat(rows.map((row) => [String(row.media_id), Number(row.count)]))); } finally { db.close(); }
}

function mediaImpact(before, after, ids) {
  const affected = [...new Set(ids.filter((id) => id !== null && id !== undefined).map(Number).filter(Number.isSafeInteger))];
  return { affected_media: affected, media_retaining_another_playable_source: affected.filter((id) => before[String(id)] > 0 && after[String(id)] > 0), media_losing_final_playable_source: affected.filter((id) => before[String(id)] > 0 && !after[String(id)]) };
}

async function publishChanged({ runId: cleanupRunId, cycleRoot, cycleId, options }) {
  const prepared = await maintenance.preparePublication({ cycleId, cycleRoot, generationId: options.generationId });
  const planSha = maintenance.digest(prepared.publicationPlan);
  maintenance.authorizePublication({ cycleId, cycleRoot, planSha, confirmation: `AUTHORIZE PUBLICATION ${cycleId} ${planSha}`, identity: "weekly-stale-maintenance", automatic: true });
  const published = await maintenance.publish({ cycleId, cycleRoot });
  return { stale_run_id: cleanupRunId, generation_id: published.publicationResult?.result?.generation_id || published.publicationResult?.result?.remote_pointer?.generation_id || prepared.publicationPlan.generation_id, publication_plan_sha256: planSha, result: published.publicationResult?.result || null };
}

function logEvent(logger, event) { try { if (typeof logger === "function") logger({ at: new Date().toISOString(), ...event }); } catch {} }

async function runWeeklyStaleMaintenance(options = {}, dependencies = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("WEEKLY_TIME_INVALID");
  const id = safeRunId(options.runId || runId(now));
  const stateRoot = path.resolve(options.stateRoot || DEFAULT_STATE_ROOT), runsRoot = path.resolve(options.runsRoot || path.join(stateRoot, "runs"));
  const config = { databasePath: path.resolve(options.databasePath || DEFAULT_DATABASE_PATH), sidecarPath: path.resolve(options.sidecarPath || DEFAULT_SIDECAR_PATH), observationRoot: path.resolve(options.observationRoot || DEFAULT_OBSERVATION_ROOT), publicRepository: path.resolve(options.publicRepository || DEFAULT_PUBLIC_REPOSITORY), batchSize: Number(options.batchSize || DEFAULT_BATCH_SIZE), maxRetries: Number(options.maxRetries || DEFAULT_MAX_RETRIES), generationId: options.generationId };
  const root = path.join(runsRoot, id), log = dependencies.logger;
  logEvent(log, { event: "run_start", run_id: id });
  if (options.resumePending !== false && !dependencies.skipPendingResume) {
    const resume = dependencies.resumePendingPublication
      ? await dependencies.resumePendingPublication(runsRoot)
      : await require("./stale-cleanup").resumePendingPublication(runsRoot);
    if (resume) return { status: "PUBLICATION_RESUMED", run_id: id, publication: resume.publication || null, source_run_id: resume.run_id || null };
  }
  let lock;
  try { lock = (dependencies.acquireLock || acquireCrawlerLock)(path.resolve(options.lockPath || LOCK_PATH), `stale-weekly-${id}`, { recoverStale: false }); }
  catch (error) { if (error instanceof LockActiveError || ["lock_active", "lock_acquisition_in_progress", "stale_lock_requires_resume"].includes(error?.code)) { logEvent(log, { event: "run_skipped_lock_busy", run_id: id }); return { status: "LOCKED", run_id: id, skipped: true, error: safeError(error) }; } throw error; }
  try {
    const state = loadState(stateRoot), selection = stale.selectBucketForDate(now), bucket = options.bucket === undefined ? selection.bucket : Number(options.bucket);
    if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket >= stale.BUCKET_COUNT) throw new Error("WEEKLY_BUCKET_INVALID");
    fs.mkdirSync(root, { recursive: true, mode: 0o750 });
    writeImmutable(path.join(root, "run.json"), { schema_version: 1, contract_version: CONTRACT_VERSION, bucket_contract_version: BUCKET_CONTRACT_VERSION, run_id: id, started_at: new Date().toISOString(), selection, bucket, minimum_confirmation_age_hours: 24 });
    const readRows = dependencies.currentRows || currentRows;
    const health = dependencies.productionHealth || maintenance.productionHealth;
    const countMedia = dependencies.mediaCounts || mediaCounts;
    const due = dueSuspects(state, now), dueIdents = due.map((row) => row.ident), currentDue = readRows(config.databasePath, dueIdents), dueActive = due.filter((row) => currentDue.byIdent.get(row.ident)?.is_active === 1);
    for (const suspect of due) if (!currentDue.byIdent.get(suspect.ident) || currentDue.byIdent.get(suspect.ident).is_active !== 1) delete state.suspects[suspect.ident];
    const bucketInput = (dependencies.loadBucketRows || loadBucketRows)(config.databasePath, config.sidecarPath, bucket);
    const bucketRows = bucketInput.rows || [], bucketIdents = bucketRows.map((row) => row.ident), checkedIdents = [...new Set([...dueActive.map((row) => row.ident), ...bucketIdents])];
    const rowsLookup = readRows(config.databasePath, checkedIdents).byIdent;
    const meterValue = meter();
    let checked = { records: [], requestLog: [], meter: meterValue };
    if (checkedIdents.length) {
      if (dependencies.checkIdents) checked = await dependencies.checkIdents({ idents: checkedIdents, batchSize: config.batchSize, maxRetries: config.maxRetries, sleepFn: dependencies.sleepFn || pause, requestMeter: meterValue });
      else checked = await checkIdents({ idents: checkedIdents, session: dependencies.session || await createAuthenticatedSession(options, meterValue), batchSize: config.batchSize, maxRetries: config.maxRetries, sleepFn: dependencies.sleepFn || pause, requestMeter: meterValue });
    }
    const checkedMap = new Map(checked.records.map((record) => [record.ident, record]));
    const dueRecords = dueActive.map((suspect) => checkedMap.get(suspect.ident)).filter(Boolean);
    const nextState = { ...state, suspects: { ...(state.suspects || {}) } };
    const dueCounts = { PRESENT: 0, MISSING: 0, UNRESOLVED: 0 };
    const deactivations = [];
    for (const suspect of dueActive) {
      const record = checkedMap.get(suspect.ident), row = rowsLookup.get(suspect.ident);
      if (!record) continue;
      dueCounts[record.status] += 1;
      if (record.status === STATUS.PRESENT) delete nextState.suspects[suspect.ident];
      else if (record.status === STATUS.UNRESOLVED) nextState.suspects[suspect.ident] = { ...suspect, last_checked_at: record.observed_at, last_status: STATUS.UNRESOLVED, evidence_run_ids: [...new Set([...(suspect.evidence_run_ids || []), id])].slice(-16) };
      else if (record.status === STATUS.MISSING && row?.is_active === 1 && Date.parse(record.observed_at) - Date.parse(suspect.first_missing_at) >= MIN_CONFIRMATION_AGE_MS) deactivations.push({ id: Number(row.id), ident: suspect.ident, media_id: row.media_id === null ? null : Number(row.media_id), media_type: row.media_type || null, category: row.category || null, reason: "STALE_SUSPECT_CONFIRMED_MISSING" });
    }
    const newRows = new Map(bucketRows.filter((row) => !dueIdents.includes(row.ident)).map((row) => [row.ident, rowsLookup.get(row.ident) || row]));
    const newRecords = checkedIdents.filter((ident) => !dueIdents.includes(ident)).map((ident) => checkedMap.get(ident)).filter(Boolean);
    const merged = mergeEvidence(nextState, newRecords, newRows, bucket, { run_id: id });
    const finalState = merged.state;
    for (const row of deactivations) delete finalState.suspects[row.ident];
    const before = health(config.databasePath, config.sidecarPath), beforeMedia = countMedia(config.databasePath, deactivations.map((row) => row.media_id));
    let applyResult = null, publication = null, backup = null, impact = { affected_media: [], media_retaining_another_playable_source: [], media_losing_final_playable_source: [] }, cycleRoot = null;
    if (deactivations.length) {
      const plan = buildPlan(before.snapshot, deactivations, new Date().toISOString());
      writeImmutable(path.join(root, "plan.json"), plan);
      const cycleId = `stale-${id}`; cycleRoot = path.join(root, "publication-cycle");
      const cycle = (dependencies.createCycle || maintenance.createCycle)({ cycleId, cycleRoot, databasePath: config.databasePath, observationRoot: config.observationRoot, sidecarPath: config.sidecarPath, publicRepository: config.publicRepository, createdAt: new Date().toISOString(), cutoff: new Date().toISOString(), maxCandidates: 0 });
      writeImmutable(path.join(cycleRoot, "candidate-set.json"), { schema_version: 1, kind: "ISOLATED_STALE_CLEANUP_SET", cycle_id: cycleId, identifiers: deactivations.map((row) => row.ident), count: deactivations.length, candidate_set_sha256: stale.digestIdents(deactivations.map((row) => row.ident)) });
      writeImmutable(path.join(cycleRoot, "plan.json"), plan); transitionThroughApply(cycleRoot);
      const backupPath = path.join(root, "production-before-cleanup.sqlite");
      applyResult = await (dependencies.apply || daily.applyDailyPlan)({ databasePath: config.databasePath, plan, backupPath, runId: id, policy: { ...daily.B46_DEFAULT_POLICY, maxAcceptedItems: 0, maxDeactivations: deactivations.length } });
      backup = applyResult.backup;
      const after = health(config.databasePath, config.sidecarPath), afterMedia = countMedia(config.databasePath, deactivations.map((row) => row.media_id));
      impact = mediaImpact(beforeMedia, afterMedia, deactivations.map((row) => row.media_id));
      const applyArtifact = { schema_version: 1, kind: "B54_APPLY_RESULT", cycle_id: cycleId, plan_sha256: plan.plan_sha256, candidate_set_sha256: stale.digestIdents(deactivations.map((row) => row.ident)), attempted: deactivations.length, inserted_files: 0, updated_files: 0, deactivated: applyResult.result.deactivated, deleted: 0, skipped: 0, rejected: 0, conflicts: 0, backup: applyResult.backup, preflight: before, postflight: after, safety: { additive_only: false, sqlite_write_performed: true, deletion: false, deactivation: true, reconciliation: false, publication: false, automatic_apply: true }, created_at: new Date().toISOString() };
      writeImmutable(path.join(cycleRoot, "apply-result.json"), applyArtifact); maintenance.transition(cycleRoot, maintenance.STATES.APPLY_VERIFIED, { next_action: "prepare-publication", post_apply_digest: after.production_baseline_sha256 });
      lock.release(); lock = null;
      publication = await (dependencies.publish || publishChanged)({ runId: id, cycleRoot, cycleId, options: { ...config, generationId: config.generationId || `b54-${new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z")}` } });
    }
    const afterHealth = deactivations.length ? health(config.databasePath, config.sidecarPath) : before;
    const result = { status: deactivations.length ? "COMPLETED" : "NO_CHANGES", run_id: id, bucket, selection, checked_count: checkedIdents.length, checked_idents_sha256: stale.digestIdents(checkedIdents), request_accounting: { auth_requests: checked.meter.auth_reserved, files_exist_requests: checked.requestLog.length, successful_files_exist_requests: checked.requestLog.filter((row) => row.status === 200).length, retries: checked.requestLog.filter((row) => row.attempt > 1).length, unresolved: checked.records.filter((row) => row.status === STATUS.UNRESOLVED).length }, confirmations: { due: due.length, processed: dueRecords.length, pending: pendingSuspects(finalState, now).length, result_counts: dueCounts }, sweep: { bucket, eligible_population: bucketInput.eligible_count || null, checked: newRecords.length, result_counts: merged.counts, new_suspects: merged.newSuspects.length, b39_excluded: bucketInput.excluded?.b39_hits || 0 }, deactivated: deactivations.length, deactivation_idents: deactivations.map((row) => row.ident), categories: countCategories(deactivations), media_impact: impact, before: before, after: afterHealth, backup, publication, safety: { sqlite_write_performed: deactivations.length > 0, deletion_performed: false, deactivation_performed: deactivations.length > 0, publication_performed: Boolean(publication), pointer_switched: Boolean(publication) } };
    writeImmutable(path.join(root, "request-log.json"), { schema_version: 1, contract_version: CONTRACT_VERSION, requests: checked.requestLog });
    writeImmutable(path.join(root, "results.json"), { schema_version: 1, contract_version: CONTRACT_VERSION, records: checked.records });
    writeImmutable(path.join(root, "decisions.json"), { schema_version: 1, contract_version: CONTRACT_VERSION, confirmations: dueCounts, sweep: merged.counts, new_suspects: merged.newSuspects, deactivations, media_impact: impact });
    writeImmutable(path.join(root, "result.json"), result);
    finalState.last_run = { run_id: id, finished_at: new Date().toISOString(), status: result.status, bucket, checked_count: checkedIdents.length, new_suspects: merged.newSuspects.length, deactivated: deactivations.length, unresolved: result.request_accounting.unresolved };
    finalState.last_successful_run = finalState.last_run;
    finalState.last_cleanup = { run_id: id, deactivated: deactivations.length, media_retaining_another_playable_source: impact.media_retaining_another_playable_source.length, media_losing_final_playable_source: impact.media_losing_final_playable_source.length, categories: result.categories };
    finalState.last_publication = publication ? { run_id: id, generation_id: publication.generation_id, published_at: new Date().toISOString() } : finalState.last_publication;
    writeAtomic(path.join(stateRoot, "state.json"), finalState);
    logEvent(log, { event: "run_end", run_id: id, bucket, checked: checkedIdents.length, confirmations: dueRecords.length, new_suspects: merged.newSuspects.length, deactivated: deactivations.length, publication_generation: publication?.generation_id || null });
    return result;
  } catch (error) {
    const failure = { status: "FAILED", run_id: id, error: safeError(error), safe: true };
    try { fs.mkdirSync(root, { recursive: true, mode: 0o750 }); writeImmutable(path.join(root, "failure.json"), failure); } catch {}
    logEvent(log, { event: "run_failed", run_id: id, error: failure.error });
    throw error;
  } finally { if (lock) lock.release(); }
}

function statusReport(stateRoot = DEFAULT_STATE_ROOT, now = new Date()) {
  const state = loadState(stateRoot), selection = stale.selectBucketForDate(now), last = state.last_run;
  const due = dueSuspects(state, now), pending = pendingSuspects(state, now);
  return { status: last ? "OK" : "NO_RUNS", contract_version: CONTRACT_VERSION, scheduler_cadence: "Sunday 05:00 Europe/Bratislava", last_weekly_run: last?.finished_at || null, last_successful_weekly_run: state.last_successful_run?.finished_at || null, last_bucket: last?.bucket ?? null, next_bucket: (selection.bucket + 1) % stale.BUCKET_COUNT, current_suspect_count: Object.values(state.suspects || {}).filter((row) => row?.state === SUSPECT).length, confirmations_due: due.length, confirmations_pending: pending.length, last_cleanup_deactivated_count: Number(state.last_cleanup?.deactivated || 0), last_publication_from_stale_cleanup: state.last_publication?.generation_id || null, mutation_enabled: Boolean(last?.deactivated > 0), current_bucket: selection.bucket };
}

module.exports = { BUCKET_CONTRACT_VERSION, CONTRACT_VERSION, DEFAULT_BATCH_SIZE, DEFAULT_RUNS_ROOT, DEFAULT_STATE_ROOT, LOCK_PATH, MIN_CONFIRMATION_AGE_MS, STATUS, SUSPECT, buildPlan, checkIdents, dueSuspects, emptyState, loadBucketRows, loadState, mediaImpact, mergeEvidence, pendingSuspects, runWeeklyStaleMaintenance, safeError, selectBucketForDate: stale.selectBucketForDate, statusReport };
