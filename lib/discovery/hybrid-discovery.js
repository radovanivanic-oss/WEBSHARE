"use strict";

const crypto = require("node:crypto");
const { classifyMedia, CLASSIFIER_VERSION } = require("../media-classifier");
const { parseMediaName, PARSER_VERSION } = require("../media-name-parser");
const { POLICY_VERSION, emptyQualityCounts, qualityGate, qualityRates, validateCounts } = require("./representative-query-policy");
const {
  acquireLock,
  appendLog,
  atomicWriteJson,
  buildStagingPaths,
  prepareStagingRoot,
  readJson,
  releaseLock,
} = require("./staging-store");

const CHECKPOINT_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const IDENT_SNAPSHOT_SCHEMA_VERSION = 1;
const HARD_LIMITS = Object.freeze({
  maxPages: 100,
  maxRequests: 102,
  maxDurationMs: 10 * 60_000,
  maxNewIdents: 10_000,
  pageSize: 100,
});
const DEFAULT_LIMITS = Object.freeze({
  maxPages: 20,
  maxRequests: 22,
  maxDurationMs: 2 * 60_000,
  maxNewIdents: 2_000,
  pageSize: 100,
});
const LIMIT_FIELDS = Object.freeze(Object.keys(HARD_LIMITS));
const TERMINAL_LIMIT_REASONS = new Set([
  "max_pages",
  "max_requests",
  "max_duration",
  "max_new_idents",
  "source_exhausted",
]);
const RESUMABLE_REASONS = new Set(["operator_aborted", "technical_error"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function qualitySummary(state) {
  if (!state.qualityEvidenceComplete) return { verdict: "NOT_EVALUABLE", reasons: ["LEGACY_QUALITY_EVIDENCE_UNAVAILABLE"], counters: state.qualityCounters, rates: qualityRates(state.qualityCounters) };
  const gate = qualityGate(state.qualityCounters);
  return { verdict: gate.verdict, reasons: gate.failures.slice(0, 5), counters: gate.counts, rates: gate.rates };
}
function addQualityCounters(target, source) { for (const field of Object.keys(target)) target[field] += source[field]; }
function extractQualityName(file) {
  // fetchSearchPage returns xml2js explicitArray data: the verified live name is file.name[0].
  // Existing unit fixtures may supply the equivalent scalar. No alternate field names are accepted.
  const value = file?.name;
  const name = typeof value === "string" ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : null;
  if (!name || Buffer.byteLength(name, "utf8") > 1024 || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}
function evaluateQualityItem(file) {
  const counters = emptyQualityCounts(); counters.items_evaluated = 1;
  const name = extractQualityName(file);
  if (!name) { counters.invalid_quality_input_count = 1; return counters; }
  const parsed = parseMediaName(name, { extension: file?.extension || file?.type });
  const classification = classifyMedia({ candidate: { candidateType: parsed.candidateType, parseConfidence: parsed.confidence, title: parsed.title }, sampleName: name });
  if (parsed.isVideoExtension) counters.valid_video_count = 1;
  if (/\btest(?:ing|ed)?\b/iu.test(name)) counters.test_like_count = 1;
  if (parsed.confidence < 0.6) counters.parser_low_confidence_count = 1;
  if (!parsed.isVideoExtension || parsed.candidateType === "unknown" || classification.category === "unknown") counters.unsupported_media_count = 1;
  return counters;
}

class DiscoveryLimitError extends Error {
  constructor(reason) {
    super(`Hybrid discovery limit: ${reason}`);
    this.name = "DiscoveryLimitError";
    this.reason = reason;
  }
}

function validateInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${label} musí byť celé číslo v rozsahu ${minimum}..${maximum}.`
    );
  }
  return value;
}

function validateLimits(input = {}) {
  const limits = {};
  for (const field of LIMIT_FIELDS) {
    const value = input[field] ?? DEFAULT_LIMITS[field];
    limits[field] = validateInteger(
      value,
      field,
      1,
      HARD_LIMITS[field]
    );
  }
  return Object.freeze(limits);
}

function validateWhat(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      "Discovery what musí byť neprázdne, do 256 UTF-8 bajtov a bez control znakov."
    );
  }
  if (value.includes("*")) {
    throw new Error("Hybrid discovery nepovoľuje wildcard v parametri what.");
  }
  return value;
}

function createDiscoveryConfig(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const limits = validateLimits(options.limits);
  const what = validateWhat(options.what);
  const startOffset = validateInteger(
    options.startOffset ?? 0,
    "startOffset",
    0,
    1_000_000_000
  );
  if (options.sort !== undefined && options.sort !== "recent") {
    throw new Error("Hybrid discovery povoľuje iba sort=recent.");
  }
  if (options.category !== undefined && options.category !== "video") {
    throw new Error("Hybrid discovery povoľuje iba category=video.");
  }
  const layout = buildStagingPaths(projectRoot, options.stagingDir);
  return Object.freeze({
    discoveryOnly: true,
    enumerationComplete: false,
    projectRoot: layout.projectRoot,
    paths: layout.paths,
    runtimeRoot: layout.runtimeRoot,
    query: Object.freeze({
      what,
      sort: "recent",
      category: "video",
      pageSize: limits.pageSize,
      startOffset,
    }),
    limits,
  });
}

function redactText(value, secrets = []) {
  let text = String(value ?? "")
    .replace(/([?&]wst=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(
      /(\b(?:authorization|password|passwd|wst|token|digest)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s;}]+)/giu,
      "$1[REDACTED]"
    )
    .replace(
      /(\bbearer\s+)[a-z0-9._~+/=-]+/giu,
      "$1[REDACTED]"
    );
  for (const secret of secrets
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  return text.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 2000);
}

function extractIdent(file) {
  const raw = Array.isArray(file?.ident) ? file.ident[0] : file?.ident;
  if (raw === undefined || raw === null) return null;
  const ident = String(raw).trim();
  if (
    ident.length === 0 ||
    Buffer.byteLength(ident, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(ident)
  ) {
    return null;
  }
  return ident;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedReportedTotal(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.length <= 64) return value;
  return null;
}

function responseSchemaFingerprint(page) {
  const keys = Object.keys(page).sort();
  return {
    response_keys: keys,
    response_schema_fingerprint: crypto
      .createHash("sha256")
      .update(JSON.stringify(keys))
      .digest("hex"),
    response_version:
      typeof page.response_version === "string" ||
      (typeof page.response_version === "number" &&
        Number.isSafeInteger(page.response_version))
        ? page.response_version
        : typeof page.version === "string" ||
            (typeof page.version === "number" &&
              Number.isSafeInteger(page.version))
          ? page.version
          : null,
  };
}

function snapshotState(state, elapsedMs) {
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    discovery_only: true,
    enumeration_complete: false,
    run_id: state.runId,
    staging_root: state.stagingRoot,
    status: state.status,
    started: state.started,
    finished: state.finished,
    duration_ms: elapsedMs,
    what: state.what,
    sort: "recent",
    category: "video",
    page_size: state.pageSize,
    start_offset: state.startOffset,
    next_offset: state.nextOffset,
    partial_page_offset: state.partialPageOffset,
    pages_scanned: state.pagesScanned,
    requests_used: state.requestsUsed,
    requests_completed: state.requestsCompleted,
    login_requests: state.loginRequests,
    search_requests: state.searchRequests,
    new_idents: state.newIdents,
    duplicate_idents: state.duplicateIdents,
    invalid_idents: state.invalidIdents,
    page_metrics: state.pageMetrics,
    previous_page_idents: state.previousPageIdents,
    quality_evidence_complete: state.qualityEvidenceComplete,
    quality_counters: state.qualityCounters,
    quality_rates: qualityRates(state.qualityCounters),
    quality_policy_version: POLICY_VERSION,
    parser_version: PARSER_VERSION,
    classification_policy_version: CLASSIFIER_VERSION,
    limits: state.limits,
    finished_reason: state.finishedReason,
  };
}

function identSnapshot(state, idents) {
  return {
    schema_version: IDENT_SNAPSHOT_SCHEMA_VERSION,
    discovery_only: true,
    enumeration_complete: false,
    run_id: state.runId,
    idents: [...idents],
  };
}

function buildManifest(state, elapsedMs, errorMessage = null) {
  const quality = qualitySummary(state);
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    discovery_only: true,
    enumeration_complete: false,
    catalog_complete: false,
    historical_complete: false,
    reconciliation_safe: false,
    deactivation_allowed: false,
    import_performed: false,
    reconciliation_performed: false,
    publication_performed: false,
    run_id: state.runId,
    started: state.started,
    finished: state.finished,
    duration_ms: elapsedMs,
    pages_scanned: state.pagesScanned,
    requests_used: state.requestsUsed,
    requests_completed: state.requestsCompleted,
    new_idents: state.newIdents,
    duplicate_idents: state.duplicateIdents,
    invalid_idents: state.invalidIdents,
    page_metrics: state.pageMetrics,
    observability: {
      pages_processed: state.pagesScanned,
      requests_performed: state.requestsUsed,
      unique_idents: state.newIdents,
      duplicates: state.duplicateIdents,
      overlap: state.pageMetrics.reduce(
        (total, page) => total + page.overlap_with_previous_page,
        0
      ),
      average_page_duration_ms:
        state.pageMetrics.length === 0
          ? null
          : state.pageMetrics.reduce(
              (total, page) => total + page.total_processing_duration_ms,
              0
            ) / state.pageMetrics.length,
      total_duration_ms: elapsedMs,
    },
    quality_policy_version: POLICY_VERSION,
    parser_version: PARSER_VERSION,
    classification_policy_version: CLASSIFIER_VERSION,
    quality_evidence_complete: state.qualityEvidenceComplete,
    quality_gate_verdict: quality.verdict,
    quality_gate_reasons: quality.reasons,
    quality_counters: quality.counters,
    quality_rates: quality.rates,
    limits: state.limits,
    finished_reason: state.finishedReason,
    status: state.status,
    query: {
      what: state.what,
      sort: "recent",
      category: "video",
      page_size: state.pageSize,
      start_offset: state.startOffset,
    },
    checkpoint: "checkpoint.json",
    ident_snapshot: "discovered-idents.json",
    error: errorMessage,
  };
}

function createFreshState(config, nowIso) {
  return {
    runId: crypto.randomUUID(),
    stagingRoot: config.paths.root,
    status: "running",
    started: nowIso,
    finished: null,
    durationMs: 0,
    what: config.query.what,
    pageSize: config.query.pageSize,
    startOffset: config.query.startOffset,
    nextOffset: config.query.startOffset,
    partialPageOffset: null,
    pagesScanned: 0,
    requestsUsed: 0,
    requestsCompleted: 0,
    loginRequests: 0,
    searchRequests: 0,
    newIdents: 0,
    duplicateIdents: 0,
    invalidIdents: 0,
    limits: config.limits,
    finishedReason: null,
    pageMetrics: [],
    previousPageIdents: [],
    qualityEvidenceComplete: true,
    qualityCounters: emptyQualityCounts(),
  };
}

function loadResumeState(config, checkpoint, identsDocument, manifest) {
  if (
    checkpoint?.schema_version !== CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.discovery_only !== true ||
    checkpoint.enumeration_complete !== false ||
    !UUID_PATTERN.test(String(checkpoint.run_id || ""))
  ) {
    throw new Error("Discovery checkpoint nemá bezpečný podporovaný formát.");
  }
  const legacyQuality = checkpoint.quality_evidence_complete === undefined || checkpoint.quality_counters === undefined;
  const qualityCounters = legacyQuality ? emptyQualityCounts() : validateCounts(checkpoint.quality_counters);
  if (!legacyQuality && (checkpoint.quality_evidence_complete !== true || checkpoint.quality_policy_version !== POLICY_VERSION || checkpoint.parser_version !== PARSER_VERSION || checkpoint.classification_policy_version !== CLASSIFIER_VERSION || manifest?.quality_evidence_complete !== true || !sameJson(manifest.quality_counters, qualityCounters) || manifest.quality_policy_version !== POLICY_VERSION || manifest.parser_version !== PARSER_VERSION || manifest.classification_policy_version !== CLASSIFIER_VERSION)) throw new Error("Discovery quality evidence checkpoint alebo manifest nie je kompatibilný.");
  if (
    checkpoint.staging_root !== config.paths.root ||
    checkpoint.what !== config.query.what ||
    checkpoint.sort !== "recent" ||
    checkpoint.category !== "video" ||
    checkpoint.page_size !== config.query.pageSize ||
    checkpoint.start_offset !== config.query.startOffset ||
    !sameJson(checkpoint.limits, config.limits)
  ) {
    throw new Error("Discovery resume konfigurácia sa nezhoduje s checkpointom.");
  }
  if (!RESUMABLE_REASONS.has(checkpoint.finished_reason)) {
    throw new Error(
      "Discovery resume je povolený iba po operator_aborted alebo technical_error."
    );
  }
  if (
    manifest?.schema_version !== MANIFEST_SCHEMA_VERSION ||
    manifest.discovery_only !== true ||
    manifest.enumeration_complete !== false ||
    manifest.catalog_complete !== false ||
    manifest.historical_complete !== false ||
    manifest.reconciliation_safe !== false ||
    manifest.deactivation_allowed !== false ||
    manifest.import_performed !== false ||
    manifest.reconciliation_performed !== false ||
    manifest.publication_performed !== false ||
    manifest.run_id !== checkpoint.run_id ||
    manifest.finished_reason !== checkpoint.finished_reason ||
    manifest.pages_scanned !== checkpoint.pages_scanned ||
    manifest.requests_used !== checkpoint.requests_used ||
    manifest.requests_completed !== checkpoint.requests_completed ||
    manifest.new_idents !== checkpoint.new_idents ||
    manifest.duplicate_idents !== checkpoint.duplicate_idents ||
    manifest.invalid_idents !== checkpoint.invalid_idents ||
    manifest.query?.what !== config.query.what ||
    manifest.query?.sort !== "recent" ||
    manifest.query?.category !== "video" ||
    manifest.query?.page_size !== config.query.pageSize ||
    manifest.query?.start_offset !== config.query.startOffset ||
    !sameJson(manifest.limits, config.limits)
  ) {
    throw new Error("Discovery manifest nemá bezpečný kompatibilný formát.");
  }
  if (
    identsDocument?.schema_version !== IDENT_SNAPSHOT_SCHEMA_VERSION ||
    identsDocument.discovery_only !== true ||
    identsDocument.enumeration_complete !== false ||
    identsDocument.run_id !== checkpoint.run_id ||
    !Array.isArray(identsDocument.idents)
  ) {
    throw new Error("Discovery ident snapshot sa nezhoduje s checkpointom.");
  }
  const idents = identsDocument.idents.map((ident) => extractIdent({ ident }));
  if (
    idents.some((ident) => ident === null) ||
    new Set(idents).size !== idents.length ||
    idents.length > config.limits.maxNewIdents ||
    Number(checkpoint.new_idents) > idents.length
  ) {
    throw new Error("Discovery ident snapshot porušuje dedup/limit invariant.");
  }
  const previousPageIdents =
    checkpoint.previous_page_idents === undefined ||
    !Array.isArray(checkpoint.previous_page_idents)
      ? []
      : checkpoint.previous_page_idents.map((ident) =>
          extractIdent({ ident })
        );
  if (
    (checkpoint.page_metrics !== undefined &&
      (!Array.isArray(checkpoint.page_metrics) ||
        checkpoint.page_metrics.length > config.limits.maxPages)) ||
    (checkpoint.previous_page_idents !== undefined &&
      (!Array.isArray(checkpoint.previous_page_idents) ||
        checkpoint.previous_page_idents.length > config.query.pageSize)) ||
    previousPageIdents.some((ident) => ident === null) ||
    new Set(previousPageIdents).size !== previousPageIdents.length
  ) {
    throw new Error("Discovery observability checkpoint je neplatný alebo príliš veľký.");
  }
  for (const field of [
    "duration_ms",
    "pages_scanned",
    "requests_used",
    "requests_completed",
    "login_requests",
    "search_requests",
    "duplicate_idents",
    "invalid_idents",
    "next_offset",
  ]) {
    if (!Number.isSafeInteger(checkpoint[field]) || checkpoint[field] < 0) {
      throw new Error(`Discovery checkpoint má neplatný counter ${field}.`);
    }
  }
  if (
    checkpoint.pages_scanned > config.limits.maxPages ||
    checkpoint.requests_used > config.limits.maxRequests ||
    checkpoint.duration_ms > config.limits.maxDurationMs ||
    checkpoint.requests_completed > checkpoint.requests_used ||
    checkpoint.login_requests + checkpoint.search_requests !==
      checkpoint.requests_used
  ) {
    throw new Error("Discovery checkpoint prekračuje nakonfigurované limity.");
  }
  return {
    state: {
      runId: checkpoint.run_id,
      stagingRoot: config.paths.root,
      status: "running",
      started: checkpoint.started,
      finished: null,
      durationMs: checkpoint.duration_ms,
      what: checkpoint.what,
      pageSize: checkpoint.page_size,
      startOffset: checkpoint.start_offset,
      nextOffset: checkpoint.next_offset,
      partialPageOffset: checkpoint.partial_page_offset ?? null,
      pagesScanned: checkpoint.pages_scanned,
      requestsUsed: checkpoint.requests_used,
      requestsCompleted: checkpoint.requests_completed,
      loginRequests: checkpoint.login_requests,
      searchRequests: checkpoint.search_requests,
      newIdents: idents.length,
      duplicateIdents: checkpoint.duplicate_idents,
      invalidIdents: checkpoint.invalid_idents,
      limits: config.limits,
      finishedReason: null,
      pageMetrics: Array.isArray(checkpoint.page_metrics)
        ? checkpoint.page_metrics
        : [],
      previousPageIdents,
      qualityEvidenceComplete: !legacyQuality,
      qualityCounters,
    },
    idents,
  };
}

function validateDependencies(dependencies) {
  if (typeof dependencies?.authenticate !== "function") {
    throw new TypeError("Hybrid discovery vyžaduje authenticate dependency.");
  }
  if (typeof dependencies?.fetchSearchPage !== "function") {
    throw new TypeError("Hybrid discovery vyžaduje fetchSearchPage dependency.");
  }
}

async function runHybridDiscovery(config, dependencies, options = {}) {
  validateDependencies(dependencies);
  const resume = options.resume === true;
  const guard = prepareStagingRoot(
    {
      projectRoot: config.projectRoot,
      runtimeRoot: config.runtimeRoot,
      paths: config.paths,
    },
    { resume }
  );
  const wallNow = options.wallNow || (() => new Date());
  const monotonicNowMs =
    options.monotonicNowMs || (() => Number(process.hrtime.bigint()) / 1e6);
  const secrets = options.secrets || [];
  const testHooks = options.testHooks || {};
  const invocationStarted = monotonicNowMs();

  function invokeTestHook(stage) {
    if (typeof testHooks[stage] === "function") testHooks[stage]();
  }

  let state;
  let orderedIdents;
  if (resume) {
    const checkpoint = readJson(
      config.paths.checkpoint,
      guard,
      "discovery checkpoint"
    );
    const identsDocument = readJson(
      config.paths.idents,
      guard,
      "discovery ident snapshot"
    );
    const manifest = readJson(
      config.paths.manifest,
      guard,
      "discovery manifest"
    );
    ({ state, idents: orderedIdents } = loadResumeState(
      config,
      checkpoint,
      identsDocument,
      manifest
    ));
  } else {
    state = createFreshState(config, wallNow().toISOString());
    orderedIdents = [];
  }

  const ownership = acquireLock(config.paths.lock, state.runId, guard);
  const identSet = new Set(orderedIdents);
  const previousDurationMs = state.durationMs;
  let primaryError = null;
  let timer = null;
  let frozenDurationMs = null;
  const controller = new AbortController();
  const externalSignal = options.signal;
  const forwardAbort = () =>
    controller.abort(externalSignal?.reason || new Error("operator_aborted"));
  if (externalSignal?.aborted) {
    forwardAbort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  function elapsedMs() {
    if (frozenDurationMs !== null) return frozenDurationMs;
    return Math.max(
      0,
      Math.trunc(previousDurationMs + monotonicNowMs() - invocationStarted)
    );
  }

  function persistCheckpoint() {
    invokeTestHook("before_checkpoint_write");
    atomicWriteJson(
      config.paths.checkpoint,
      snapshotState(state, elapsedMs()),
      guard
    );
    invokeTestHook("after_checkpoint_write");
  }

  function persistIdents() {
    invokeTestHook("before_snapshot_write");
    atomicWriteJson(
      config.paths.idents,
      identSnapshot(state, orderedIdents),
      guard
    );
    invokeTestHook("after_snapshot_write");
  }

  function log(level, message, fields = {}) {
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        redactText(value, secrets),
      ])
    );
    invokeTestHook("before_log_write");
    appendLog(
      config.paths.log,
      JSON.stringify({
        at: wallNow().toISOString(),
        level,
        message: redactText(message, secrets),
        ...safeFields,
      }),
      guard
    );
    invokeTestHook("after_log_write");
  }

  function assertDurationAvailable() {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error(String(reason || "operator_aborted"));
    }
    if (elapsedMs() >= config.limits.maxDurationMs) {
      throw new DiscoveryLimitError("max_duration");
    }
  }

  const transportAttempts = [];
  const requestMeter = {
    beforeRequest(kind, operationKey) {
      assertDurationAvailable();
      if (state.requestsUsed >= config.limits.maxRequests) {
        throw new DiscoveryLimitError("max_requests");
      }
      const operation = String(operationKey || kind);
      if (kind === "login") {
        if (!["salt", "login"].includes(operation)) {
          throw new Error(`Nepovolený discovery auth transport: ${operation}`);
        }
        state.loginRequests += 1;
      } else if (kind === "search") {
        state.searchRequests += 1;
      } else {
        throw new Error(`Nepovolený discovery transport kind: ${kind}`);
      }
      state.requestsUsed += 1;
      transportAttempts.push({ kind, operation });
      persistCheckpoint();
    },
    afterRequest() {
      if (state.requestsCompleted >= state.requestsUsed) {
        throw new Error(
          "Discovery request completion nemá rezervovaný transport slot."
        );
      }
      state.requestsCompleted += 1;
      persistCheckpoint();
    },
  };

  function finalize(reason, status, errorMessage = null) {
    state.status = status;
    state.finishedReason = reason;
    state.finished = wallNow().toISOString();
    const duration = elapsedMs();
    frozenDurationMs = duration;
    state.durationMs = duration;
    persistCheckpoint();
    const manifest = buildManifest(state, duration, errorMessage);
    invokeTestHook("before_manifest_write");
    atomicWriteJson(config.paths.manifest, manifest, guard);
    invokeTestHook("after_manifest_write");
    log("info", "Hybrid discovery skončilo.", {
      finished_reason: reason,
      pages_scanned: state.pagesScanned,
      requests_used: state.requestsUsed,
      new_idents: state.newIdents,
      duplicate_idents: state.duplicateIdents,
    });
    return {
      checkpoint: snapshotState(state, duration),
      manifest,
      paths: config.paths,
    };
  }

  try {
    if (!resume) {
      persistIdents();
      persistCheckpoint();
    } else {
      persistCheckpoint();
    }
    log("info", resume ? "Hybrid discovery resume." : "Hybrid discovery start.", {
      run_id: state.runId,
      what: state.what,
    });

    const remainingDuration = Math.max(
      1,
      config.limits.maxDurationMs - elapsedMs()
    );
    timer = setTimeout(
      () => controller.abort(new DiscoveryLimitError("max_duration")),
      remainingDuration
    );
    timer.unref?.();

    assertDurationAvailable();
    const authBefore = state.requestsUsed;
    const authCompletedBefore = state.requestsCompleted;
    const authAttemptsBefore = transportAttempts.length;
    const token = await dependencies.authenticate({
      requestMeter,
      signal: controller.signal,
    });
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      state.requestsUsed - authBefore !== 2 ||
      state.requestsCompleted - authCompletedBefore !== 2 ||
      !sameJson(
        transportAttempts.slice(authAttemptsBefore),
        [
          { kind: "login", operation: "salt" },
          { kind: "login", operation: "login" },
        ]
      )
    ) {
      throw new Error(
        "Discovery authenticate musí vykonať presne salt + login cez request meter."
      );
    }

    while (true) {
      assertDurationAvailable();
      if (state.pagesScanned >= config.limits.maxPages) {
        return finalize("max_pages", "stopped");
      }
      if (state.requestsUsed >= config.limits.maxRequests) {
        return finalize("max_requests", "stopped");
      }
      if (state.newIdents >= config.limits.maxNewIdents) {
        return finalize("max_new_idents", "stopped");
      }

      const currentOffset = state.nextOffset;
      const pageIndex = state.pagesScanned + 1;
      const pageStartedAt = monotonicNowMs();
      const requestBefore = state.requestsUsed;
      const completedBefore = state.requestsCompleted;
      const attemptsBefore = transportAttempts.length;
      const page = await dependencies.fetchSearchPage({
        token,
        what: state.what,
        sort: "recent",
        category: "video",
        offset: currentOffset,
        limit: state.pageSize,
        signal: controller.signal,
        requestMeter,
      });
      const requestDurationMs = Math.max(
        0,
        Math.trunc(monotonicNowMs() - pageStartedAt)
      );
      const searchAttempts = transportAttempts.slice(attemptsBefore);
      if (
        state.requestsUsed - requestBefore !== 1 ||
        state.requestsCompleted - completedBefore !== 1 ||
        searchAttempts.length !== 1 ||
        searchAttempts[0].kind !== "search"
      ) {
        throw new Error(
          "Discovery search adapter musí vykonať presne jeden metered transport."
        );
      }
      assertDurationAvailable();
      if (!page || !Array.isArray(page.files)) {
        throw new Error("Discovery search odpoveď nemá files array.");
      }

      let pageDuplicates = 0;
      let pageInvalid = 0;
      const pageQuality = emptyQualityCounts();
      let hitNewIdentLimit = false;
      const pageIdents = new Set();
      let overlapWithPreviousPage = 0;
      for (const file of page.files) {
        addQualityCounters(pageQuality, evaluateQualityItem(file));
        const ident = extractIdent(file);
        if (!ident) {
          pageInvalid += 1;
          continue;
        }
        if (pageIdents.has(ident)) {
          pageDuplicates += 1;
          continue;
        }
        pageIdents.add(ident);
        if (state.previousPageIdents.includes(ident)) {
          overlapWithPreviousPage += 1;
        }
        if (identSet.has(ident)) {
          pageDuplicates += 1;
          continue;
        }
        if (identSet.size >= config.limits.maxNewIdents) {
          hitNewIdentLimit = true;
          break;
        }
        identSet.add(ident);
        orderedIdents.push(ident);
      }

      state.pagesScanned += 1;
      state.newIdents = identSet.size;
      state.duplicateIdents += pageDuplicates;
      state.invalidIdents += pageInvalid;
      addQualityCounters(state.qualityCounters, pageQuality);
      state.partialPageOffset = hitNewIdentLimit ? currentOffset : null;
      if (!hitNewIdentLimit) {
        state.nextOffset = currentOffset + state.pageSize;
      }
      const schema = responseSchemaFingerprint(page);
      const totalProcessingDurationMs = Math.max(
        requestDurationMs,
        Math.trunc(monotonicNowMs() - pageStartedAt)
      );
      state.pageMetrics.push({
        offset: currentOffset,
        page_index: pageIndex,
        returned: page.files.length,
        unique_idents_on_page: pageIdents.size,
        duplicate_idents_on_page: pageDuplicates,
        cumulative_unique_idents: state.newIdents,
        request_sequence: state.requestsUsed,
        request_duration_ms: requestDurationMs,
        decode_duration_ms: null,
        total_processing_duration_ms: totalProcessingDurationMs,
        timestamp: wallNow().toISOString(),
        reported_total: boundedReportedTotal(page.total),
        overlap_with_previous_page: overlapWithPreviousPage,
        overlap_percentage:
          pageIdents.size === 0
            ? 0
            : (overlapWithPreviousPage / pageIdents.size) * 100,
        cumulative_duplicates: state.duplicateIdents,
        quality_counters: pageQuality,
        quality_rates: qualityRates(pageQuality),
        ...schema,
      });
      state.previousPageIdents = [...pageIdents];
      persistIdents();
      persistCheckpoint();
      log("info", "Discovery stránka uložená.", {
        offset: currentOffset,
        returned: page.files.length,
        new_idents: state.newIdents,
        page_duplicates: pageDuplicates,
        page_invalid: pageInvalid,
        page_index: pageIndex,
        request_sequence: state.requestsUsed,
        request_duration_ms: requestDurationMs,
        overlap_with_previous_page: overlapWithPreviousPage,
        overlap_percentage:
          pageIdents.size === 0
            ? 0
            : (overlapWithPreviousPage / pageIdents.size) * 100,
        response_schema_fingerprint: schema.response_schema_fingerprint,
      });

      if (hitNewIdentLimit || state.newIdents >= config.limits.maxNewIdents) {
        return finalize("max_new_idents", "stopped");
      }
      if (page.files.length < state.pageSize) {
        return finalize("source_exhausted", "stopped");
      }
    }
  } catch (error) {
    const abortReason = controller.signal.aborted
      ? controller.signal.reason
      : null;
    const limitReason =
      error instanceof DiscoveryLimitError
        ? error.reason
        : abortReason instanceof DiscoveryLimitError
          ? abortReason.reason
          : null;
    if (limitReason) {
      return finalize(limitReason, "stopped");
    }
    if (externalSignal?.aborted) {
      return finalize("operator_aborted", "interrupted");
    }
    primaryError = error;
    const safeError = redactText(error?.message || error, secrets);
    finalize("technical_error", "failed", safeError);
    throw error;
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
  DiscoveryLimitError,
  HARD_LIMITS,
  LIMIT_FIELDS,
  RESUMABLE_REASONS,
  TERMINAL_LIMIT_REASONS,
  buildManifest,
  createDiscoveryConfig,
  extractIdent,
  extractQualityName,
  redactText,
  runHybridDiscovery,
  validateLimits,
  validateWhat,
};
