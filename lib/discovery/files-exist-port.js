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

const FILES_EXIST_PORT_VERSION = 2;
const CHECKPOINT_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const EVIDENCE_SCHEMA_VERSION = 1;
const HARD_LIMITS = Object.freeze({
  maxIdents: 10_000,
  maxRequests: 10_002,
  maxDurationMs: 10 * 60_000,
});
const DEFAULT_LIMITS = Object.freeze({
  maxIdents: 2_000,
  maxRequests: 2_002,
  maxDurationMs: 2 * 60_000,
});
const RESUMABLE_REASONS = new Set([
  "operator_aborted",
  "technical_error",
  "max_requests",
  "max_duration",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validateInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} musí byť celé číslo v rozsahu ${minimum}..${maximum}.`);
  }
  return value;
}

function validateIdent(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("files_exist ident je neplatný.");
  }
  return value;
}

function normalizeIdents(input, maxIdents) {
  if (!Array.isArray(input)) throw new TypeError("files_exist vyžaduje pole identov.");
  const result = [];
  const seen = new Set();
  for (const value of input) {
    const ident = validateIdent(value);
    if (seen.has(ident)) continue;
    seen.add(ident);
    result.push(ident);
    if (result.length > maxIdents) {
      throw new Error(`files_exist prekračuje limit ${maxIdents} identov.`);
    }
  }
  return Object.freeze(result);
}

function validateLimits(input = {}) {
  return Object.freeze({
    maxIdents: validateInteger(
      input.maxIdents ?? DEFAULT_LIMITS.maxIdents,
      "maxIdents",
      1,
      HARD_LIMITS.maxIdents
    ),
    maxRequests: validateInteger(
      input.maxRequests ?? DEFAULT_LIMITS.maxRequests,
      "maxRequests",
      1,
      HARD_LIMITS.maxRequests
    ),
    maxDurationMs: validateInteger(
      input.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs,
      "maxDurationMs",
      1,
      HARD_LIMITS.maxDurationMs
    ),
  });
}

function createFilesExistPaths(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new TypeError("files_exist root musí byť neprázdna cesta bez NUL.");
  }
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("files_exist root musí byť reálny adresár.");
  }
  return Object.freeze({
    root: resolved,
    checkpoint: path.join(resolved, "files-exist.checkpoint.json"),
    evidence: path.join(resolved, "files-exist.evidence.json"),
    manifest: path.join(resolved, "files-exist.manifest.json"),
    log: path.join(resolved, "files-exist.log"),
    lock: path.join(resolved, "files-exist.lock"),
  });
}

function createFilesExistConfig(options = {}) {
  const limits = validateLimits(options.limits);
  const idents = normalizeIdents(options.idents, limits.maxIdents);
  const paths = createFilesExistPaths(options.root);
  return Object.freeze({
    version: FILES_EXIST_PORT_VERSION,
    paths,
    idents,
    limits,
  });
}

function sanitizeError(error, secrets = []) {
  let value = String(error?.message || error || "transport_error");
  for (const secret of secrets
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    value = value.replaceAll(secret, "[REDACTED]");
  }
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
}

function isRetryable(error, status) {
  return (
    error?.retryable === true ||
    [408, 425, 429, 500, 502, 503, 504].includes(Number(status))
  );
}

function responseStatus(response) {
  const status = response?.status ?? response?.response_status ?? null;
  if (status === null || status === undefined) return null;
  if (Number.isSafeInteger(status)) return status;
  if (typeof status === "string" && status.length <= 32) return status;
  return null;
}

function createInitialState(config, now) {
  return {
    runId: crypto.randomUUID(),
    status: "running",
    started: now,
    finished: null,
    durationMs: 0,
    nextIndex: 0,
    checked: [],
    requestsReserved: 0,
    requestsCompleted: 0,
    exists: 0,
    missing: 0,
    transportErrors: 0,
    retryableErrors: 0,
    totalRequestDurationMs: 0,
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
    next_index: state.nextIndex,
    checked_idents: state.checked.map((record) => record.ident),
    remaining_count: config.idents.length - state.nextIndex,
    requests_reserved: state.requestsReserved,
    requests_completed: state.requestsCompleted,
    exists: state.exists,
    missing: state.missing,
    transport_errors: state.transportErrors,
    retryable_errors: state.retryableErrors,
    total_request_duration_ms: state.totalRequestDurationMs,
    limits: config.limits,
    idents_sha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(config.idents))
      .digest("hex"),
    finished_reason: state.finishedReason,
  };
}

function evidenceDocument(state) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_only: true,
    run_id: state.runId,
    records: state.checked,
  };
}

function manifestDocument(state, config, elapsedMs) {
  const checked = state.checked.length;
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
    checked,
    exists: state.exists,
    missing: state.missing,
    transport_errors: state.transportErrors,
    retryable_errors: state.retryableErrors,
    average_request_duration_ms:
      checked === 0 ? null : state.totalRequestDurationMs / checked,
    total_duration_ms: elapsedMs,
    requests_reserved: state.requestsReserved,
    requests_completed: state.requestsCompleted,
    total_request_duration_ms: state.totalRequestDurationMs,
    remaining_count: config.idents.length - state.nextIndex,
    limits: config.limits,
    finished_reason: state.finishedReason,
  };
}

function validateResume(config, checkpoint, evidence) {
  if (
    checkpoint?.schema_version !== CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.evidence_only !== true ||
    !UUID_PATTERN.test(String(checkpoint.run_id || "")) ||
    !RESUMABLE_REASONS.has(checkpoint.finished_reason) ||
    !sameJson(checkpoint.limits, config.limits) ||
    checkpoint.idents_sha256 !==
      crypto.createHash("sha256").update(JSON.stringify(config.idents)).digest("hex")
  ) {
    throw new Error("files_exist checkpoint nie je bezpečne resumovateľný.");
  }
  if (
    evidence?.schema_version !== EVIDENCE_SCHEMA_VERSION ||
    evidence.evidence_only !== true ||
    evidence.run_id !== checkpoint.run_id ||
    !Array.isArray(evidence.records) ||
    evidence.records.length !== checkpoint.checked_idents?.length
  ) {
    throw new Error("files_exist evidence snapshot je neplatný.");
  }
  if (
    !Array.isArray(checkpoint.checked_idents) ||
    checkpoint.next_index !== checkpoint.checked_idents.length ||
    checkpoint.next_index > config.idents.length ||
    checkpoint.requests_completed > checkpoint.requests_reserved ||
    checkpoint.requests_reserved > config.limits.maxRequests
  ) {
    throw new Error("files_exist checkpoint counters sú neplatné.");
  }
  const ids = evidence.records.map((record) => record?.ident);
  if (
    ids.some((ident, index) => {
      try {
        validateIdent(ident);
      } catch {
        return true;
      }
      return ident !== checkpoint.checked_idents[index];
    }) ||
    new Set(ids).size !== ids.length ||
    evidence.records.some(
      (record) =>
        !record ||
        typeof record.ident !== "string" ||
        typeof record.exists !== "boolean" ||
        typeof record.retryable !== "boolean" ||
        typeof record.checked_at !== "string" ||
        !(record.transport_error === null || typeof record.transport_error === "string")
    )
  ) {
    throw new Error("files_exist evidence snapshot porušuje invariant.");
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runFilesExistEvidence(config, session, options = {}) {
  if (typeof session?.filesExist !== "function") {
    throw new TypeError("files_exist vyžaduje authenticated session.filesExist.");
  }
  const resume = options.resume === true;
  const guard = createPathGuard(config.paths.root);
  const wallNow = options.wallNow || (() => new Date());
  const monotonicNowMs =
    options.monotonicNowMs || (() => Number(process.hrtime.bigint()) / 1e6);
  const secrets = options.secrets || [];
  const invocationStarted = monotonicNowMs();
  let state;
  let evidence;
  if (resume) {
    const checkpoint = readJson(config.paths.checkpoint, guard, "files_exist checkpoint");
    evidence = readJson(config.paths.evidence, guard, "files_exist evidence");
    const manifest = readJson(config.paths.manifest, guard, "files_exist manifest");
    if (
      manifest?.run_id !== checkpoint?.run_id ||
      manifest?.finished_reason !== checkpoint?.finished_reason ||
      manifest?.evidence_only !== true ||
      manifest?.checked !== checkpoint?.checked_idents?.length ||
      manifest?.exists !== checkpoint?.exists ||
      manifest?.missing !== checkpoint?.missing ||
      manifest?.transport_errors !== checkpoint?.transport_errors ||
      manifest?.retryable_errors !== checkpoint?.retryable_errors ||
      manifest?.requests_reserved !== checkpoint?.requests_reserved ||
      manifest?.requests_completed !== checkpoint?.requests_completed ||
      manifest?.remaining_count !== checkpoint?.remaining_count ||
      !sameJson(manifest?.limits, config.limits)
    ) {
      throw new Error("files_exist manifest nie je kompatibilný s checkpointom.");
    }
    validateResume(config, checkpoint, evidence);
    state = {
      runId: checkpoint.run_id,
      status: "running",
      started: checkpoint.started,
      finished: null,
      durationMs: checkpoint.duration_ms,
      nextIndex: checkpoint.next_index,
      checked: evidence.records,
      requestsReserved: checkpoint.requests_reserved,
      requestsCompleted: checkpoint.requests_completed,
      exists: checkpoint.exists,
      missing: checkpoint.missing,
      transportErrors: checkpoint.transport_errors,
      retryableErrors: checkpoint.retryable_errors,
      totalRequestDurationMs: checkpoint.total_request_duration_ms,
      finishedReason: null,
    };
  } else {
    state = createInitialState(config, wallNow().toISOString());
    evidence = evidenceDocument(state);
  }
  const ownership = acquireLock(config.paths.lock, state.runId, guard);
  let timer = null;
  let primaryError = null;
  let frozenDurationMs = null;
  const controller = new AbortController();
  const externalSignal = options.signal;
  const forwardAbort = () =>
    controller.abort(externalSignal?.reason || new Error("operator_aborted"));
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });

  function elapsedMs() {
    if (frozenDurationMs !== null) return frozenDurationMs;
    return Math.max(0, Math.trunc(state.durationMs + monotonicNowMs() - invocationStarted));
  }
  function persistCheckpoint() {
    atomicWriteJson(config.paths.checkpoint, checkpointDocument(state, config, elapsedMs()), guard);
  }
  function persistEvidence() {
    atomicWriteJson(config.paths.evidence, evidenceDocument(state), guard);
  }
  function log(message, fields = {}) {
    appendLog(
      config.paths.log,
      JSON.stringify({
        at: wallNow().toISOString(),
        message,
        ...Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, sanitizeError(value, secrets)])
        ),
      }),
      guard
    );
  }
  function assertAvailable() {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("operator_aborted");
    }
    if (elapsedMs() >= config.limits.maxDurationMs) {
      throw new Error("max_duration");
    }
  }
  function finalize(reason, status, error = null) {
    state.finishedReason = reason;
    state.status = status;
    state.finished = wallNow().toISOString();
    frozenDurationMs = elapsedMs();
    state.durationMs = frozenDurationMs;
    persistEvidence();
    persistCheckpoint();
    const manifest = manifestDocument(state, config, frozenDurationMs);
    manifest.error = error ? sanitizeError(error, secrets) : null;
    atomicWriteJson(config.paths.manifest, manifest, guard);
    log("files_exist skončilo", {
      finished_reason: reason,
      checked: state.checked.length,
      requests_completed: state.requestsCompleted,
    });
    return { checkpoint: checkpointDocument(state, config, frozenDurationMs), manifest, paths: config.paths };
  }

  try {
    persistEvidence();
    persistCheckpoint();
    log(resume ? "files_exist resume" : "files_exist start", {
      run_id: state.runId,
      idents: config.idents.length,
    });
    timer = setTimeout(
      () => controller.abort(new Error("max_duration")),
      Math.max(1, config.limits.maxDurationMs - elapsedMs())
    );
    timer.unref?.();
    while (state.nextIndex < config.idents.length) {
      assertAvailable();
      if (state.requestsReserved >= config.limits.maxRequests) {
        return finalize("max_requests", "stopped");
      }
      const ident = config.idents[state.nextIndex];
      state.requestsReserved += 1;
      persistCheckpoint();
      const requestStarted = monotonicNowMs();
      let response;
      let transportError = null;
      let status = null;
      let retryable = false;
      try {
        response = await session.filesExist(ident, { signal: controller.signal });
        status = responseStatus(response);
        if (typeof response?.exists !== "boolean") {
          throw Object.assign(new Error("invalid_response"), { status });
        }
      } catch (error) {
        transportError = sanitizeError(error, secrets);
        status = responseStatus(error);
        retryable = isRetryable(error, status);
      } finally {
        state.requestsCompleted += 1;
        state.totalRequestDurationMs += Math.max(
          0,
          Math.trunc(monotonicNowMs() - requestStarted)
        );
        persistCheckpoint();
      }
      if (controller.signal.aborted) {
        return finalize("operator_aborted", "interrupted");
      }
      const record = {
        ident,
        exists: transportError === null ? response.exists : false,
        checked_at: wallNow().toISOString(),
        response_status: status,
        transport_error: transportError,
        retryable,
      };
      state.checked.push(record);
      state.nextIndex += 1;
      if (record.transport_error) {
        state.transportErrors += 1;
        if (record.retryable) state.retryableErrors += 1;
      } else if (record.exists) {
        state.exists += 1;
      } else {
        state.missing += 1;
      }
      persistEvidence();
      persistCheckpoint();
      log("files_exist ident checked", {
        ident,
        exists: record.exists,
        response_status: record.response_status,
        retryable: record.retryable,
      });
    }
    return finalize("complete", "completed");
  } catch (error) {
    primaryError = error;
    const reason = controller.signal.aborted
      ? "operator_aborted"
      : error?.message === "max_duration"
        ? "max_duration"
        : "technical_error";
    return finalize(reason, reason === "operator_aborted" ? "interrupted" : "failed", error);
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
    try {
      releaseLock(config.paths.lock, ownership, guard);
    } catch (lockError) {
      if (!primaryError) throw lockError;
    }
  }
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  DEFAULT_LIMITS,
  EVIDENCE_SCHEMA_VERSION,
  FILES_EXIST_PORT_VERSION,
  HARD_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  MAX_LOG_BYTES,
  RESUMABLE_REASONS,
  createFilesExistConfig,
  createFilesExistPaths,
  normalizeIdents,
  runFilesExistEvidence,
  sanitizeError,
  validateLimits,
  validateIdent,
};
