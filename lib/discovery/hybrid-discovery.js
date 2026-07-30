"use strict";

const crypto = require("node:crypto");
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
  };
}

function loadResumeState(config, checkpoint, identsDocument) {
  if (
    checkpoint?.schema_version !== CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.discovery_only !== true ||
    checkpoint.enumeration_complete !== false ||
    !UUID_PATTERN.test(String(checkpoint.run_id || ""))
  ) {
    throw new Error("Discovery checkpoint nemá bezpečný podporovaný formát.");
  }
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
  const invocationStarted = monotonicNowMs();

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
    ({ state, idents: orderedIdents } = loadResumeState(
      config,
      checkpoint,
      identsDocument
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
    atomicWriteJson(
      config.paths.checkpoint,
      snapshotState(state, elapsedMs()),
      guard
    );
  }

  function persistIdents() {
    atomicWriteJson(
      config.paths.idents,
      identSnapshot(state, orderedIdents),
      guard
    );
  }

  function log(level, message, fields = {}) {
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        redactText(value, secrets),
      ])
    );
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
    atomicWriteJson(config.paths.manifest, manifest, guard);
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
      let hitNewIdentLimit = false;
      for (const file of page.files) {
        const ident = extractIdent(file);
        if (!ident) {
          pageInvalid += 1;
          continue;
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
      state.partialPageOffset = hitNewIdentLimit ? currentOffset : null;
      if (!hitNewIdentLimit) {
        state.nextOffset = currentOffset + state.pageSize;
      }
      persistIdents();
      persistCheckpoint();
      log("info", "Discovery stránka uložená.", {
        offset: currentOffset,
        returned: page.files.length,
        new_idents: state.newIdents,
        page_duplicates: pageDuplicates,
        page_invalid: pageInvalid,
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
  redactText,
  runHybridDiscovery,
  validateLimits,
  validateWhat,
};
