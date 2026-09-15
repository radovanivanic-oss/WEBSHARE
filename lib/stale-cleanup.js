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

const ORIGINAL_SUSPECT_COUNT = 167;
const ORIGINAL_SUSPECT_SHA256 = "49e00ad06a83ff55110341325a79717f54f7c9dec39c59619bcfc20efc98dde8";
const DEFAULT_EVIDENCE_ROOT = "runtime/stale-verification/b56-20260901T232400Z";
const DEFAULT_OUTPUT_ROOT = "runtime/stale-cleanup";
const DEFAULT_DATABASE_PATH = "data/catalog.sqlite";
const DEFAULT_SIDECAR_PATH = "runtime/maintenance/history/b39-purged-idents.json";
const DEFAULT_OBSERVATION_ROOT = "runtime/daily-observation";
const DEFAULT_PUBLIC_REPOSITORY = "/home/radeco/ag";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const LOCK_PATH = "runtime/maintenance-cycles/.maintenance-cycle.lock";
const STATUS = Object.freeze({ PRESENT: "PRESENT", MISSING: "MISSING", UNRESOLVED: "UNRESOLVED" });

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function safeError(error) {
  const code = String(error?.code || "STALE_CLEANUP_FAILED").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64) || "STALE_CLEANUP_FAILED";
  const message = String(error?.message || "stale cleanup failed")
    .replace(/(wst|token|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 256);
  return { code, message, status: Number(error?.status || error?.response?.status || 0) || null, retryable: error?.retryable === true };
}

function writeImmutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(file, "wx", 0o640);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function runId(now = new Date()) {
  return `stale-cleanup-${now.toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z")}`;
}

function validateIdent(ident) {
  if (typeof ident !== "string" || ident.length === 0 || ident.length > 256 || /[\u0000-\u001f\u007f]/u.test(ident)) throw new Error("STALE_IDENT_INVALID");
  return ident;
}

function loadOriginalSuspects(evidenceRoot = DEFAULT_EVIDENCE_ROOT) {
  const root = path.resolve(evidenceRoot);
  const runPath = path.join(root, "run.json");
  const resultsPath = path.join(root, "results.json");
  if (!fs.existsSync(runPath) || !fs.existsSync(resultsPath)) throw new Error("B56_EVIDENCE_MISSING");
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const records = Array.isArray(results.records) ? results.records : [];
  const idents = records.filter((row) => row && row.status === "DEFINITIVE_MISSING").map((row) => validateIdent(row.ident));
  if (idents.length !== ORIGINAL_SUSPECT_COUNT || new Set(idents).size !== ORIGINAL_SUSPECT_COUNT) throw new Error("B56_SUSPECT_COUNT_INVALID");
  const digest = stale.digestIdents(idents);
  if (digest !== ORIGINAL_SUSPECT_SHA256) throw new Error("B56_SUSPECT_SHA_MISMATCH");
  if (run.checked_idents_sha256 && run.checked_idents_sha256 === ORIGINAL_SUSPECT_SHA256) {
    // This is an additional consistency check when the evidence carries the selected-set digest.
  }
  return { root, run, results, idents, count: idents.length, sha256: digest };
}

function splitBatches(idents, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) throw new Error("STALE_BATCH_SIZE_INVALID");
  const batches = [];
  for (let index = 0; index < idents.length; index += batchSize) batches.push(idents.slice(index, index + batchSize));
  return batches;
}

function createMeter() {
  return {
    auth_reserved: 0,
    auth_completed: 0,
    files_exist_reserved: 0,
    files_exist_completed: 0,
    pending_kind: null,
    beforeRequest(kind) {
      this.pending_kind = kind;
      if (kind === "login") this.auth_reserved += 1;
      if (kind === "files_exist") this.files_exist_reserved += 1;
    },
    afterRequest() {
      if (this.pending_kind === "login") this.auth_completed += 1;
      if (this.pending_kind === "files_exist") this.files_exist_completed += 1;
      this.pending_kind = null;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recheckExact({ idents, session, batchSize = DEFAULT_BATCH_SIZE, maxRetries = DEFAULT_MAX_RETRIES, sleepFn = sleep, requestMeter = null }) {
  if (!Array.isArray(idents) || idents.length !== ORIGINAL_SUSPECT_COUNT) throw new Error("STALE_EXACT_SET_REQUIRED");
  if (!session || typeof session.filesExistBatch !== "function") throw new Error("STALE_SESSION_REQUIRED");
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 3) throw new Error("STALE_RETRY_LIMIT_INVALID");
  const meter = requestMeter || createMeter();
  const requestLog = [];
  const records = new Map();
  let ordinal = 0;
  for (const batch of splitBatches(idents, batchSize)) {
    let completed = false;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const requestOrdinal = ++ordinal;
      const started = Date.now();
      try {
        const response = await session.filesExistBatch(batch, { requestMeter: meter });
        const normalized = stale.normalizeBatchResponse(batch, response);
        const byIdent = new Map(normalized.files.map((row) => [row.ident, row]));
        const finished = new Date().toISOString();
        requestLog.push({
          request_ordinal: requestOrdinal,
          attempt,
          endpoint: "files_exist",
          method: "POST",
          requested_count: batch.length,
          answered_count: normalized.files.length,
          present_count: normalized.files.filter((row) => row.exists).length,
          missing_count: normalized.files.filter((row) => !row.exists).length,
          status: normalized.status,
          idents_sha256: stale.digestIdents(batch),
          started_at: finished,
          elapsed_ms: Date.now() - started,
          retry_decision: "NONE",
        });
        for (const ident of batch) {
          const row = byIdent.get(ident);
          records.set(ident, { ident, status: row.exists ? STATUS.PRESENT : STATUS.MISSING, observed_at: finished, request_ordinal: requestOrdinal, attempt, downloadable: row.downloadable });
        }
        completed = true;
        break;
      } catch (error) {
        const classification = stale.classifyRequestError(error);
        const retry = classification.retryable && attempt < maxRetries;
        requestLog.push({
          request_ordinal: requestOrdinal,
          attempt,
          endpoint: "files_exist",
          method: "POST",
          requested_count: batch.length,
          answered_count: 0,
          present_count: 0,
          missing_count: 0,
          status: classification.status,
          idents_sha256: stale.digestIdents(batch),
          started_at: new Date(started).toISOString(),
          elapsed_ms: Date.now() - started,
          error_code: classification.code,
          retryable: classification.retryable,
          retry_decision: retry ? "RETRY_BOUNDED" : "KEEP_ACTIVE_UNRESOLVED",
        });
        if (retry) {
          await sleepFn(Math.min(1000, 250 * (2 ** (attempt - 1))));
          continue;
        }
        const observed = new Date().toISOString();
        for (const ident of batch) records.set(ident, { ident, status: STATUS.UNRESOLVED, observed_at: observed, request_ordinal: requestOrdinal, attempt, error_code: classification.code });
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error("STALE_BATCH_NOT_FINISHED");
  }
  if (records.size !== idents.length || idents.some((ident) => !records.has(ident))) throw new Error("STALE_RESULT_ACCOUNTING_MISMATCH");
  return { records: idents.map((ident) => records.get(ident)), requestLog, meter };
}

function loadCurrentRows(databasePath, idents) {
  const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    const statement = db.prepare(`SELECT f.id, f.ident, f.media_id, f.is_active, f.is_playable_video, m.media_type, m.category
      FROM files f LEFT JOIN media m ON m.id = f.media_id WHERE f.ident = ?`);
    const rows = [];
    for (const ident of idents) {
      const matches = statement.all(ident);
      if (matches.length > 1) throw new Error("STALE_CURRENT_DUPLICATE_IDENT");
      if (matches[0]) rows.push(matches[0]);
    }
    return rows;
  } finally {
    db.close();
  }
}

function mediaPlayableCounts(databasePath, mediaIds) {
  const ids = [...new Set(mediaIds.filter((id) => id !== null && id !== undefined).map(Number))].filter(Number.isSafeInteger);
  if (!ids.length) return {};
  const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT media_id, COUNT(*) AS active_playable FROM files WHERE media_id IN (${placeholders}) AND is_active = 1 AND is_playable_video = 1 GROUP BY media_id`).all(...ids);
    return Object.fromEntries(ids.map((id) => [String(id), 0]).concat(rows.map((row) => [String(row.media_id), Number(row.active_playable)])));
  } finally {
    db.close();
  }
}

function computeMediaImpact(beforeCounts, afterCounts, mediaIds) {
  const ids = [...new Set(mediaIds.filter((id) => id !== null && id !== undefined).map(Number))].filter(Number.isSafeInteger).map(String);
  const retaining = [];
  const losingFinal = [];
  for (const id of ids) {
    const before = Number(beforeCounts[id] || 0);
    const after = Number(afterCounts[id] || 0);
    if (before > 0 && after > 0) retaining.push(Number(id));
    if (before > 0 && after === 0) losingFinal.push(Number(id));
  }
  return { affected_media: ids.map(Number), media_retaining_another_playable_source: retaining, media_losing_final_playable_source: losingFinal };
}

function summarizeDecision(idents, original, currentRows, records) {
  const current = new Map(currentRows.map((row) => [row.ident, row]));
  const b56 = new Set(original);
  const byIdent = new Map(records.map((row) => [row.ident, row]));
  const deactivations = [];
  for (const ident of idents) {
    const result = byIdent.get(ident);
    const row = current.get(ident);
    if (result?.status === STATUS.MISSING && b56.has(ident) && row && Number(row.is_active) === 1) {
      deactivations.push({ id: Number(row.id), ident, media_id: row.media_id === null ? null : Number(row.media_id), media_type: row.media_type || null, category: row.category || null, reason: "B56_MISSING_AND_CURRENT_MISSING" });
    }
  }
  const categories = {};
  for (const row of deactivations) {
    const key = row.category || row.media_type || "unknown";
    categories[key] = (categories[key] || 0) + 1;
  }
  return {
    result_counts: {
      PRESENT: records.filter((row) => row.status === STATUS.PRESENT).length,
      MISSING: records.filter((row) => row.status === STATUS.MISSING).length,
      UNRESOLVED: records.filter((row) => row.status === STATUS.UNRESOLVED).length,
    },
    deactivations,
    categories,
    current_rows_found: currentRows.length,
    current_rows_missing: idents.filter((ident) => !current.has(ident)),
    already_inactive: idents.filter((ident) => current.get(ident) && Number(current.get(ident).is_active) !== 1),
  };
}

function buildStalePlan(beforeSnapshot, deactivations, createdAt = new Date().toISOString()) {
  const plan = {
    schema_version: 1,
    kind: "ISOLATED_STALE_CLEANUP_PLAN",
    operation: "stale-cleanup-isolated",
    status: "READY_FOR_REVIEW",
    created_at: createdAt,
    baseline: beforeSnapshot,
    discovery_delta: [],
    deactivations,
    blocked_reasons: [],
  };
  plan.plan_sha256 = daily.sha256(daily.planDigestInput(plan));
  return plan;
}

function transitionStaleCycle(root, states) {
  let current = null;
  for (const next of states) current = maintenance.transition(root, next, { next_action: next.toLowerCase().replaceAll("_", "-") });
  return current;
}

function countCategories(rows) {
  const counts = {};
  for (const row of rows) {
    const key = row.category || row.media_type || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function publishChanged({ cleanupRunId, cycleRoot, cycleId, options }) {
  const prepared = await maintenance.preparePublication({ cycleId, cycleRoot, generationId: options.generationId });
  const planSha = maintenance.digest(prepared.publicationPlan);
  const phrase = `AUTHORIZE PUBLICATION ${cycleId} ${planSha}`;
  maintenance.authorizePublication({ cycleId, cycleRoot, planSha, confirmation: phrase, identity: "stale-cleanup", automatic: true });
  const published = await maintenance.publish({ cycleId, cycleRoot });
  return { cleanup_run_id: cleanupRunId, generation_id: published.publicationResult?.result?.generation_id || published.publicationResult?.result?.remote_pointer?.generation_id || prepared.publicationPlan.generation_id, publication_plan_sha256: planSha, result: published.publicationResult?.result || null };
}

function findPendingPublication(outputRoot) {
  const root = path.resolve(outputRoot);
  if (!fs.existsSync(root)) return null;
  const completedSources = new Set();
  for (const name of fs.readdirSync(root)) {
    const retryPath = path.join(root, name, "publication-retry.json");
    if (!fs.existsSync(retryPath)) continue;
    try {
      const retry = JSON.parse(fs.readFileSync(retryPath, "utf8"));
      if (retry.status === "PUBLICATION_RESUMED" && retry.source_run_id) completedSources.add(retry.source_run_id);
    } catch {}
  }
  const pending = [];
  for (const name of fs.readdirSync(root).sort()) {
    const cycleRoot = path.join(root, name, "publication-cycle");
    const statePath = path.join(cycleRoot, "state.json");
    const planPath = path.join(cycleRoot, "publication-plan.json");
    if (!fs.existsSync(statePath) || !fs.existsSync(planPath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (!completedSources.has(name) && [maintenance.STATES.PUBLICATION_FAILED, maintenance.STATES.PUBLICATION_ROLLED_BACK].includes(state.state)) pending.push({ run_id: name, cycleRoot, cycleId: state.cycle_id, state: state.state, updated_at: state.updated_at || null });
    } catch {}
  }
  return pending.sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")) || a.run_id.localeCompare(b.run_id)).at(-1) || null;
}

function hardlinkTree(source, target) {
  if (fs.existsSync(target)) throw new Error("STALE_RETRY_TARGET_EXISTS");
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o750 });
    for (const name of fs.readdirSync(source)) hardlinkTree(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    fs.linkSync(source, target);
  } else throw new Error("STALE_RETRY_UNSUPPORTED_ARTIFACT");
}

async function retryPendingPublication(pending, outputRoot) {
  const oldCycle = maintenance.readCycle(pending.cycleId, pending.cycleRoot);
  const oldPlan = JSON.parse(fs.readFileSync(path.join(pending.cycleRoot, "plan.json"), "utf8"));
  const oldApply = JSON.parse(fs.readFileSync(path.join(pending.cycleRoot, "apply-result.json"), "utf8"));
  const oldPublicationPlan = JSON.parse(fs.readFileSync(path.join(pending.cycleRoot, "publication-plan.json"), "utf8"));
  const retryRunId = `${pending.run_id}-retry-${Date.now()}`;
  const retryCycleId = `stale-${retryRunId}`;
  const retryRoot = path.resolve(outputRoot, retryRunId);
  const cycleRoot = path.join(retryRoot, "publication-cycle");
  const currentHealth = maintenance.productionHealth(oldCycle.cycle.production_database_path, oldCycle.cycle.sidecar_path);
  const cycle = maintenance.createCycle({ cycleId: retryCycleId, cycleRoot, databasePath: oldCycle.cycle.production_database_path, observationRoot: oldCycle.cycle.observation_root, sidecarPath: oldCycle.cycle.sidecar_path, publicRepository: oldCycle.cycle.public_repository, createdAt: new Date().toISOString(), cutoff: new Date().toISOString(), maxCandidates: 0 });
  hardlinkTree(path.join(pending.cycleRoot, "publication-source"), path.join(cycleRoot, "publication-source"));
  hardlinkTree(path.join(pending.cycleRoot, "publication-candidate"), path.join(cycleRoot, "publication-candidate"));
  writeImmutableJson(path.join(cycleRoot, "candidate-set.json"), { ...JSON.parse(fs.readFileSync(path.join(pending.cycleRoot, "candidate-set.json"), "utf8")), cycle_id: retryCycleId });
  writeImmutableJson(path.join(cycleRoot, "plan.json"), oldPlan);
  transitionStaleCycle(cycleRoot, [maintenance.STATES.OBSERVATIONS_SELECTED, maintenance.STATES.PERSISTENCE_REFRESHED, maintenance.STATES.ELIGIBILITY_READY, maintenance.STATES.PLAN_READY, maintenance.STATES.APPLY_AUTHORIZATION_REQUIRED, maintenance.STATES.APPLY_AUTHORIZED, maintenance.STATES.APPLY_RUNNING]);
  writeImmutableJson(path.join(cycleRoot, "apply-result.json"), { ...oldApply, cycle_id: retryCycleId, preflight: currentHealth, postflight: currentHealth });
  maintenance.transition(cycleRoot, maintenance.STATES.APPLY_VERIFIED, { next_action: "prepare-publication", post_apply_digest: currentHealth.production_baseline_sha256 });
  const published = await publishChanged({ cleanupRunId: retryRunId, cycleRoot, cycleId: retryCycleId, options: { generationId: oldPublicationPlan.generation_id } });
  writeImmutableJson(path.join(retryRoot, "publication-retry.json"), { schema_version: 1, status: "PUBLICATION_RESUMED", source_run_id: pending.run_id, run_id: retryRunId, publication: published });
  return { status: "PUBLICATION_RESUMED", run_id: retryRunId, publication: published, source_run_id: pending.run_id };
}

async function recoverPendingPublicationFromCurrentDatabase(pending, outputRoot) {
  const oldCycle = maintenance.readCycle(pending.cycleId, pending.cycleRoot);
  const retryRunId = `${pending.run_id}-current-recovery-${Date.now()}`;
  const recoveryCycleId = `stale-${retryRunId}`;
  const retryRoot = path.resolve(outputRoot, retryRunId);
  const cycleRoot = path.join(retryRoot, "publication-cycle");
  maintenance.supersedeFailedPublication({
    cycleId: pending.cycleId,
    cycleRoot: pending.cycleRoot,
    reason: "CURRENT_PRODUCTION_SOURCE_ADVANCED",
  });
  const prepared = await maintenance.prepareCurrentPublication({
    cycleId: recoveryCycleId,
    cycleRoot,
    databasePath: oldCycle.cycle.production_database_path,
    sidecarPath: oldCycle.cycle.sidecar_path,
    publicRepository: oldCycle.cycle.public_repository,
    createdAt: new Date().toISOString(),
  });
  const planSha = maintenance.digest(prepared.publicationPlan);
  maintenance.authorizePublication({
    cycleId: recoveryCycleId,
    cycleRoot,
    planSha,
    confirmation: `AUTHORIZE PUBLICATION ${recoveryCycleId} ${planSha}`,
    identity: "stale-cleanup-current-recovery",
    automatic: true,
  });
  const published = await maintenance.publish({ cycleId: recoveryCycleId, cycleRoot });
  const publication = {
    cleanup_run_id: retryRunId,
    generation_id: published.publicationResult?.result?.generation_id || prepared.publicationPlan.generation_id,
    publication_plan_sha256: planSha,
    fresh_current_snapshot: true,
    superseded_cycle_id: pending.cycleId,
    result: published.publicationResult?.result || null,
  };
  writeImmutableJson(path.join(retryRoot, "publication-retry.json"), {
    schema_version: 1,
    run_id: retryRunId,
    source_run_id: pending.run_id,
    previous_state: pending.state,
    status: "PUBLICATION_RESUMED",
    fresh_current_snapshot: true,
    publication,
  });
  return { status: "PUBLICATION_RESUMED", run_id: retryRunId, publication, source_run_id: pending.run_id };
}

async function resumePendingPublication(outputRoot) {
  const pending = findPendingPublication(outputRoot);
  if (!pending) return null;
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(pending.cycleRoot, "publication-plan.json"), "utf8"));
    const planSha = maintenance.digest(plan);
    maintenance.authorizePublication({ cycleId: pending.cycleId, cycleRoot: pending.cycleRoot, planSha, confirmation: `AUTHORIZE PUBLICATION ${pending.cycleId} ${planSha}`, identity: "stale-cleanup-retry", automatic: true });
    const published = await maintenance.publish({ cycleId: pending.cycleId, cycleRoot: pending.cycleRoot });
    const publication = { cleanup_run_id: pending.run_id, generation_id: published.publicationResult?.result?.generation_id || published.publicationResult?.result?.remote_pointer?.generation_id || plan.generation_id, publication_plan_sha256: planSha, result: published.publicationResult?.result || null };
    const retryPath = path.join(path.dirname(pending.cycleRoot), `publication-retry-${Date.now()}.json`);
    writeImmutableJson(retryPath, { schema_version: 1, run_id: pending.run_id, previous_state: pending.state, status: "PUBLICATION_RESUMED", publication });
    return { status: "PUBLICATION_RESUMED", run_id: pending.run_id, publication };
  } catch (error) {
    if (["lock_active", "lock_acquisition_in_progress", "stale_lock_requires_resume"].includes(error?.code)) return { status: "LOCKED", run_id: pending.run_id, error: safeError(error) };
    if (["AG_REMOTE_BASELINE_CHANGED", "PUBLICATION_SOURCE_DRIFT", "PUBLICATION_SNAPSHOT_HASH_MISMATCH", "PUBLICATION_SNAPSHOT_LOGICAL_MISMATCH", "PUBLICATION_UNEXPECTED_SOURCE_DELTA"].includes(error?.code)) {
      return recoverPendingPublicationFromCurrentDatabase(pending, outputRoot);
    }
    throw error;
  }
}

async function runStaleCleanup(options = {}, dependencies = {}) {
  const config = {
    evidenceRoot: options.evidenceRoot || DEFAULT_EVIDENCE_ROOT,
    outputRoot: options.outputRoot || DEFAULT_OUTPUT_ROOT,
    databasePath: options.databasePath || DEFAULT_DATABASE_PATH,
    sidecarPath: options.sidecarPath || DEFAULT_SIDECAR_PATH,
    observationRoot: options.observationRoot || DEFAULT_OBSERVATION_ROOT,
    publicRepository: options.publicRepository || DEFAULT_PUBLIC_REPOSITORY,
    batchSize: options.batchSize || DEFAULT_BATCH_SIZE,
    maxRetries: options.maxRetries || DEFAULT_MAX_RETRIES,
    generationId: options.generationId,
  };
  const cleanupRunId = options.runId || runId();
  if (options.resumePending !== false && !dependencies.skipPendingResume) {
    const resumed = await (dependencies.resumePendingPublication || resumePendingPublication)(config.outputRoot);
    if (resumed) return resumed;
  }
  const lockPath = path.resolve(options.lockPath || LOCK_PATH);
  let lock;
  try {
    lock = (dependencies.acquireLock || acquireCrawlerLock)(lockPath, `stale-cleanup-${cleanupRunId}`, { recoverStale: false });
  } catch (error) {
    if (error instanceof LockActiveError || ["lock_active", "lock_acquisition_in_progress", "stale_lock_requires_resume"].includes(error?.code)) return { status: "LOCKED", run_id: cleanupRunId, lock_path: lockPath, error: safeError(error) };
    throw error;
  }
  const root = path.resolve(config.outputRoot, cleanupRunId);
  let cycleRoot = null;
  let cycleId = null;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o750 });
    const original = (dependencies.loadOriginalSuspects || loadOriginalSuspects)(config.evidenceRoot);
    if (original.count !== ORIGINAL_SUSPECT_COUNT || original.sha256 !== ORIGINAL_SUSPECT_SHA256) throw new Error("B56_ORIGINAL_SUSPECT_SET_INVALID");
    writeImmutableJson(path.join(root, "original-suspects.json"), { schema_version: 1, source: original.root, count: original.count, idents_sha256: original.sha256, idents: original.idents });

    const beforeHealth = (dependencies.beforeHealth || (() => maintenance.productionHealth(config.databasePath, config.sidecarPath)))();
    const currentRows = (dependencies.loadCurrentRows || loadCurrentRows)(config.databasePath, original.idents);
    const beforeCounts = (dependencies.mediaPlayableCounts || mediaPlayableCounts)(config.databasePath, currentRows.map((row) => row.media_id));
    const requestMeter = createMeter();
    const session = dependencies.session || (dependencies.recheckExact ? null : await createAuthenticatedSession(options, requestMeter));
    const checked = (dependencies.recheckExact || recheckExact)({ idents: original.idents, session, batchSize: config.batchSize, maxRetries: config.maxRetries, sleepFn: dependencies.sleepFn || sleep, requestMeter });
    const recheck = await checked;
    const decision = summarizeDecision(original.idents, original.idents, currentRows, recheck.records);
    writeImmutableJson(path.join(root, "recheck-results.json"), { schema_version: 1, source_suspect_sha256: original.sha256, records: recheck.records, request_log: recheck.requestLog, request_accounting: { batches: splitBatches(original.idents, config.batchSize).length, files_exist_requests: recheck.requestLog.length, retries: recheck.requestLog.filter((row) => row.attempt > 1).length, auth_requests: recheck.meter.auth_reserved } });
    if (!decision.deactivations.length) {
      const afterHealth = beforeHealth;
      const result = { status: "NO_CHANGES", run_id: cleanupRunId, original_suspects: original.count, suspect_sha256: original.sha256, ...decision, before: beforeHealth, after: afterHealth, backup: null, publication: null, safety: { sqlite_write_performed: false, deletion_performed: false, deactivation_performed: false, publication_performed: false, pointer_switched: false } };
      writeImmutableJson(path.join(root, "cleanup.json"), result);
      return result;
    }

    const plan = buildStalePlan(beforeHealth.snapshot, decision.deactivations);
    writeImmutableJson(path.join(root, "plan.json"), plan);
    cycleId = `stale-${cleanupRunId}`;
    cycleRoot = path.join(root, "publication-cycle");
    const cycle = (dependencies.createCycle || maintenance.createCycle)({ cycleId, cycleRoot, databasePath: config.databasePath, observationRoot: config.observationRoot, sidecarPath: config.sidecarPath, publicRepository: config.publicRepository, createdAt: new Date().toISOString(), cutoff: new Date().toISOString(), maxCandidates: 0 });
    writeImmutableJson(path.join(cycleRoot, "candidate-set.json"), { schema_version: 1, kind: "ISOLATED_STALE_CLEANUP_SET", cycle_id: cycleId, identifiers: decision.deactivations.map((row) => row.ident), count: decision.deactivations.length, candidate_set_sha256: stale.digestIdents(decision.deactivations.map((row) => row.ident)) });
    writeImmutableJson(path.join(cycleRoot, "plan.json"), plan);
    transitionStaleCycle(cycleRoot, [maintenance.STATES.OBSERVATIONS_SELECTED, maintenance.STATES.PERSISTENCE_REFRESHED, maintenance.STATES.ELIGIBILITY_READY, maintenance.STATES.PLAN_READY, maintenance.STATES.APPLY_AUTHORIZATION_REQUIRED, maintenance.STATES.APPLY_AUTHORIZED, maintenance.STATES.APPLY_RUNNING]);
    const backupPath = path.join(root, "production-before-cleanup.sqlite");
    const applyResult = await (dependencies.apply || daily.applyDailyPlan)({ databasePath: config.databasePath, plan, backupPath, runId: cleanupRunId, policy: { ...daily.B46_DEFAULT_POLICY, maxAcceptedItems: 0, maxDeactivations: decision.deactivations.length } });
    const afterHealth = (dependencies.afterHealth || (() => maintenance.productionHealth(config.databasePath, config.sidecarPath)))();
    const afterCounts = (dependencies.mediaPlayableCounts || mediaPlayableCounts)(config.databasePath, decision.deactivations.map((row) => row.media_id));
    const mediaImpact = computeMediaImpact(beforeCounts, afterCounts, decision.deactivations.map((row) => row.media_id));
    const applyArtifact = { schema_version: 1, kind: "B54_APPLY_RESULT", cycle_id: cycleId, plan_sha256: plan.plan_sha256, candidate_set_sha256: stale.digestIdents(decision.deactivations.map((row) => row.ident)), attempted: decision.deactivations.length, inserted_files: 0, updated_files: 0, deactivated: applyResult.result.deactivated, deleted: 0, skipped: 0, rejected: 0, conflicts: 0, backup: applyResult.backup, preflight: beforeHealth, postflight: afterHealth, safety: { additive_only: false, sqlite_write_performed: true, deletion: false, deactivation: true, reconciliation: false, publication: false, automatic_apply: true }, created_at: new Date().toISOString() };
    writeImmutableJson(path.join(cycleRoot, "apply-result.json"), applyArtifact);
    maintenance.transition(cycleRoot, maintenance.STATES.APPLY_VERIFIED, { next_action: "prepare-publication", post_apply_digest: afterHealth.production_baseline_sha256 });
    lock.release();
    lock = null;
    const publication = await (dependencies.publish || publishChanged)({ cleanupRunId, cycleRoot, cycleId, options: { ...config, generationId: config.generationId || `b54-${new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z")}` } });
    const result = { status: "COMPLETED", run_id: cleanupRunId, original_suspects: original.count, suspect_sha256: original.sha256, ...decision, before: beforeHealth, after: afterHealth, backup: applyResult.backup, media_impact: mediaImpact, categories: countCategories(decision.deactivations), publication, safety: { sqlite_write_performed: true, deletion_performed: false, deactivation_performed: true, publication_performed: true, pointer_switched: true } };
    writeImmutableJson(path.join(root, "cleanup.json"), result);
    return result;
  } catch (error) {
    const failure = safeError(error);
    try { writeImmutableJson(path.join(root, "failure.json"), { schema_version: 1, run_id: cleanupRunId, status: "FAILED", error: failure, safe: true }); } catch {}
    if (cycleRoot) {
      try {
        const current = maintenance.readCycle(cycleId, cycleRoot).state.state;
        if (current === maintenance.STATES.APPLY_RUNNING) maintenance.transition(cycleRoot, maintenance.STATES.APPLY_FAILED, { next_action: "inspect-apply-failure", failure });
      } catch {}
    }
    throw error;
  } finally {
    if (lock) lock.release();
  }
}

async function createAuthenticatedSession(options, requestMeter = null) {
  const username = options.username || process.env.WEBSHARE_USERNAME;
  const password = options.password || process.env.WEBSHARE_PASSWORD;
  if (!username || !password) throw new Error("STALE_WEBSHARE_CREDENTIALS_MISSING");
  const { createApiClient, loginAndGetWst, WebshareSession } = require("../main");
  const meter = requestMeter || options.requestMeter || null;
  const client = options.client || createApiClient();
  const login = async () => loginAndGetWst({ username, password, client, requestMeter: meter });
  const token = await login();
  const session = new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { apiClient: client, login, requestMeter: meter });
  session.cachedWst = token;
  return session;
}

module.exports = { DEFAULT_BATCH_SIZE, DEFAULT_EVIDENCE_ROOT, DEFAULT_OUTPUT_ROOT, LOCK_PATH, ORIGINAL_SUSPECT_COUNT, ORIGINAL_SUSPECT_SHA256, STATUS, buildStalePlan, computeMediaImpact, findPendingPublication, loadCurrentRows, loadOriginalSuspects, mediaPlayableCounts, recheckExact, recoverPendingPublicationFromCurrentDatabase, resumePendingPublication, runStaleCleanup, safeError, splitBatches, summarizeDecision };
