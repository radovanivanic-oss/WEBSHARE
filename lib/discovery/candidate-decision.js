"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  acquireLock,
  appendLog,
  atomicWriteJson,
  createPathGuard,
  readJson,
  releaseLock,
  MAX_LOG_BYTES,
} = require("./staging-store");

const CANDIDATE_DECISION_VERSION = 1;
const CHECKPOINT_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const DECISIONS_SCHEMA_VERSION = 1;
const HARD_LIMITS = Object.freeze({ maxCandidates: 10_000, maxDurationMs: 10 * 60_000 });
const DEFAULT_LIMITS = Object.freeze({ maxCandidates: 2_000, maxDurationMs: 2 * 60_000 });
const RESUMABLE_REASONS = new Set(["operator_aborted", "technical_error", "limit_reached"]);
const DECISIONS = Object.freeze([
  "ELIGIBLE",
  "NOT_FOUND",
  "TRANSPORT_ERROR",
  "RETRY_LATER",
  "INVALID_INPUT",
  "LIMIT_REACHED",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function validateInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} musí byť celé číslo v rozsahu ${minimum}..${maximum}.`);
  }
  return value;
}

function validIdent(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedEvidence(record) {
  if (!record || typeof record !== "object") return null;
  const ident = record.ident;
  if (!validIdent(ident) || typeof record.exists !== "boolean") return null;
  if (!(record.transport_error === null || typeof record.transport_error === "string")) {
    return null;
  }
  if (typeof record.retryable !== "boolean" || typeof record.checked_at !== "string") {
    return null;
  }
  const responseStatus =
    record.response_status === null ||
    typeof record.response_status === "string" ||
    (Number.isSafeInteger(record.response_status) && record.response_status >= 0)
      ? record.response_status
      : null;
  return {
    ident,
    exists: record.exists,
    checked_at: record.checked_at.slice(0, 128),
    response_status: responseStatus,
    transport_error:
      record.transport_error === null ? null : String(record.transport_error).slice(0, 256),
    retryable: record.retryable,
  };
}

function evidenceDigest(record) {
  return digest(boundedEvidence(record));
}

function createCandidateDecisionPaths(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new TypeError("candidate decision root musí byť neprázdna cesta bez NUL.");
  }
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("candidate decision root musí byť reálny adresár.");
  }
  return Object.freeze({
    root: resolved,
    checkpoint: path.join(resolved, "candidate-decision.checkpoint.json"),
    decisions: path.join(resolved, "candidate-decision.records.json"),
    manifest: path.join(resolved, "candidate-decision.manifest.json"),
    log: path.join(resolved, "candidate-decision.log"),
    lock: path.join(resolved, "candidate-decision.lock"),
  });
}

function createCandidateDecisionConfig(options = {}) {
  const limits = Object.freeze({
    maxCandidates: validateInteger(
      options.limits?.maxCandidates ?? DEFAULT_LIMITS.maxCandidates,
      "maxCandidates",
      1,
      HARD_LIMITS.maxCandidates
    ),
    maxDurationMs: validateInteger(
      options.limits?.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs,
      "maxDurationMs",
      1,
      HARD_LIMITS.maxDurationMs
    ),
  });
  const idents = Array.isArray(options.discoverySummary?.idents)
    ? [...options.discoverySummary.idents]
    : [];
  if (idents.length > HARD_LIMITS.maxCandidates) {
    throw new Error("Candidate decision prekračuje hard limit kandidátov.");
  }
  const evidenceRecords = Array.isArray(options.filesExistEvidence?.records)
    ? options.filesExistEvidence.records.map(boundedEvidence)
    : [];
  const paths = createCandidateDecisionPaths(options.root);
  const inputDigest = digest({ idents, evidence: evidenceRecords });
  return Object.freeze({
    version: CANDIDATE_DECISION_VERSION,
    paths,
    idents: Object.freeze(idents),
    evidenceRecords: Object.freeze(evidenceRecords),
    inputDigest,
    configDigest: digest({ limits }),
    limits,
    requestCounters: Object.freeze({
      reserved: Number(options.filesExistEvidence?.requests_reserved || 0),
      completed: Number(options.filesExistEvidence?.requests_completed || 0),
    }),
  });
}

function sanitizeReason(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
}

function createInitialState(config, now) {
  return {
    runId: crypto.randomUUID(),
    status: "running",
    started: now,
    finished: null,
    durationMs: 0,
    nextIndex: 0,
    records: [],
    counters: Object.fromEntries(DECISIONS.map((decision) => [decision, 0])),
    requestsReserved: config.requestCounters.reserved,
    requestsCompleted: config.requestCounters.completed,
    finishedReason: null,
  };
}

function checkpointDocument(state, config, elapsedMs) {
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    evidence_only: true,
    run_id: state.runId,
    status: state.status,
    started: state.started,
    finished: state.finished,
    duration_ms: elapsedMs,
    processed_candidates: state.records.length,
    remaining_candidates: config.idents.length - state.nextIndex,
    decision_counters: state.counters,
    request_counters: {
      reserved: state.requestsReserved,
      completed: state.requestsCompleted,
    },
    input_digest: config.inputDigest,
    configuration_digest: config.configDigest,
    finished_reason: state.finishedReason,
  };
}

function decisionsDocument(state) {
  return {
    schema_version: DECISIONS_SCHEMA_VERSION,
    evidence_only: true,
    run_id: state.runId,
    records: state.records,
  };
}

function manifestDocument(state, config, elapsedMs) {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    evidence_only: true,
    import_performed: false,
    publication_performed: false,
    reconciliation_performed: false,
    deactivation_allowed: false,
    run_id: state.runId,
    status: state.status,
    started: state.started,
    finished: state.finished,
    duration_ms: elapsedMs,
    processing_duration_ms: elapsedMs,
    eligible: state.counters.ELIGIBLE,
    not_found: state.counters.NOT_FOUND,
    retry_later: state.counters.RETRY_LATER,
    transport_error: state.counters.TRANSPORT_ERROR,
    invalid: state.counters.INVALID_INPUT,
    limit_reached: state.counters.LIMIT_REACHED,
    processed_candidates: state.records.length,
    remaining_candidates: config.idents.length - state.nextIndex,
    request_counters: {
      reserved: state.requestsReserved,
      completed: state.requestsCompleted,
    },
    decision_counters: state.counters,
    input_digest: config.inputDigest,
    configuration_digest: config.configDigest,
    finished_reason: state.finishedReason,
  };
}

function validateResume(config, checkpoint, decisions, manifest) {
  if (
    checkpoint?.schema_version !== CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.evidence_only !== true ||
    !UUID_PATTERN.test(String(checkpoint.run_id || "")) ||
    !RESUMABLE_REASONS.has(checkpoint.finished_reason) ||
    checkpoint.input_digest !== config.inputDigest ||
    checkpoint.configuration_digest !== config.configDigest
  ) {
    throw new Error("Candidate decision checkpoint nie je bezpečne resumovateľný.");
  }
  if (
    manifest?.schema_version !== MANIFEST_SCHEMA_VERSION ||
    manifest.evidence_only !== true ||
    manifest.run_id !== checkpoint.run_id ||
    manifest.finished_reason !== checkpoint.finished_reason ||
    manifest.input_digest !== config.inputDigest ||
    manifest.configuration_digest !== config.configDigest ||
    !sameJson(manifest.decision_counters, checkpoint.decision_counters) ||
    !sameJson(manifest.request_counters, checkpoint.request_counters)
  ) {
    throw new Error("Candidate decision manifest nie je kompatibilný.");
  }
  if (
    decisions?.schema_version !== DECISIONS_SCHEMA_VERSION ||
    decisions.evidence_only !== true ||
    decisions.run_id !== checkpoint.run_id ||
    !Array.isArray(decisions.records) ||
    decisions.records.length !== checkpoint.processed_candidates
  ) {
    throw new Error("Candidate decision records sú neplatné.");
  }
  for (const record of decisions.records) {
    if (
      !record ||
      !DECISIONS.includes(record.decision) ||
      !(validIdent(record.ident) || (record.ident === null && record.decision === "INVALID_INPUT")) ||
      typeof record.reason !== "string" ||
      typeof record.decision_timestamp !== "string" ||
      (record.evidence_digest !== null &&
        !/^[0-9a-f]{64}$/u.test(String(record.evidence_digest)))
    ) {
      throw new Error("Candidate decision record porušuje invariant.");
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runCandidateDecision(config, options = {}) {
  const resume = options.resume === true;
  const guard = createPathGuard(config.paths.root);
  const wallNow = options.wallNow || (() => new Date());
  const monotonicNowMs =
    options.monotonicNowMs || (() => Number(process.hrtime.bigint()) / 1e6);
  const invocationStarted = monotonicNowMs();
  let state;
  if (resume) {
    const checkpoint = readJson(config.paths.checkpoint, guard, "candidate checkpoint");
    const decisions = readJson(config.paths.decisions, guard, "candidate decisions");
    const manifest = readJson(config.paths.manifest, guard, "candidate manifest");
    validateResume(config, checkpoint, decisions, manifest);
    state = {
      runId: checkpoint.run_id,
      status: "running",
      started: checkpoint.started,
      finished: null,
      durationMs: checkpoint.duration_ms,
      nextIndex: checkpoint.processed_candidates,
      records: decisions.records,
      counters: checkpoint.decision_counters,
      requestsReserved: checkpoint.request_counters.reserved,
      requestsCompleted: checkpoint.request_counters.completed,
      finishedReason: null,
    };
  } else {
    state = createInitialState(config, wallNow().toISOString());
  }
  const ownership = acquireLock(config.paths.lock, state.runId, guard);
  const externalSignal = options.signal;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason || new Error("operator_aborted"));
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  let timer = null;
  let primaryError = null;
  let frozenDurationMs = null;
  function elapsedMs() {
    if (frozenDurationMs !== null) return frozenDurationMs;
    return Math.max(0, Math.trunc(state.durationMs + monotonicNowMs() - invocationStarted));
  }
  function persistCheckpoint() {
    atomicWriteJson(config.paths.checkpoint, checkpointDocument(state, config, elapsedMs()), guard);
  }
  function persistDecisions() {
    atomicWriteJson(config.paths.decisions, decisionsDocument(state), guard);
  }
  function log(message, fields = {}) {
    appendLog(
      config.paths.log,
      JSON.stringify({ at: wallNow().toISOString(), message, ...fields }),
      guard
    );
  }
  function assertAvailable() {
    if (controller.signal.aborted) throw controller.signal.reason || new Error("operator_aborted");
    if (elapsedMs() >= config.limits.maxDurationMs) throw new Error("limit_reached");
  }
  function finalize(reason, status) {
    state.finishedReason = reason;
    state.status = status;
    state.finished = wallNow().toISOString();
    frozenDurationMs = elapsedMs();
    state.durationMs = frozenDurationMs;
    persistDecisions();
    persistCheckpoint();
    const manifest = manifestDocument(state, config, frozenDurationMs);
    atomicWriteJson(config.paths.manifest, manifest, guard);
    log("candidate decision skončil", { finished_reason: reason });
    return { checkpoint: checkpointDocument(state, config, frozenDurationMs), manifest, paths: config.paths };
  }
  try {
    persistDecisions();
    persistCheckpoint();
    log(resume ? "candidate decision resume" : "candidate decision start");
    timer = setTimeout(() => controller.abort(new Error("limit_reached")), config.limits.maxDurationMs);
    timer.unref?.();
    while (state.nextIndex < config.idents.length) {
      assertAvailable();
      const index = state.nextIndex;
      options.testHook?.("before_candidate", index);
      assertAvailable();
      let decision;
      let reason;
      let recordEvidence = null;
      const ident = config.idents[index];
      const matches = config.evidenceRecords.filter((record) => record?.ident === ident);
      if (index >= config.limits.maxCandidates) {
        decision = "LIMIT_REACHED";
        reason = "max_candidates";
      } else if (!validIdent(ident)) {
        decision = "INVALID_INPUT";
        reason = "invalid_ident";
      } else if (matches.length !== 1 || !matches[0]) {
        decision = "INVALID_INPUT";
        reason = matches.length === 0 ? "missing_evidence" : "duplicate_evidence";
      } else {
        recordEvidence = matches[0];
        if (recordEvidence.transport_error) {
          decision = recordEvidence.retryable ? "RETRY_LATER" : "TRANSPORT_ERROR";
          reason = recordEvidence.retryable ? "retryable_transport_error" : "transport_error";
        } else {
          decision = recordEvidence.exists ? "ELIGIBLE" : "NOT_FOUND";
          reason = recordEvidence.exists ? "exists" : "not_found";
        }
      }
      const decisionRecord = {
        ident: validIdent(ident) ? ident : null,
        decision,
        reason: sanitizeReason(reason),
        decision_timestamp: wallNow().toISOString(),
        evidence_digest: recordEvidence ? evidenceDigest(recordEvidence) : null,
      };
      state.records.push(decisionRecord);
      state.counters[decision] += 1;
      state.nextIndex += 1;
      persistDecisions();
      persistCheckpoint();
      log("candidate decision", { ident, decision, evidence_digest: decisionRecord.evidence_digest });
    }
    return finalize("complete", "completed");
  } catch (error) {
    primaryError = error;
    const reason = controller.signal.aborted
      ? "operator_aborted"
      : error?.message === "limit_reached"
        ? "limit_reached"
        : "technical_error";
    return finalize(reason, reason === "operator_aborted" ? "interrupted" : "failed");
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
    try {
      releaseLock(config.paths.lock, ownership, guard);
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}

module.exports = {
  CANDIDATE_DECISION_VERSION,
  CHECKPOINT_SCHEMA_VERSION,
  DECISIONS,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  MAX_LOG_BYTES,
  RESUMABLE_REASONS,
  boundedEvidence,
  createCandidateDecisionConfig,
  createCandidateDecisionPaths,
  decisionEvidenceDigest: evidenceDigest,
  runCandidateDecision,
  stableStringify,
};
