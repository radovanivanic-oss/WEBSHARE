const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getCrawlerV2Config } = require("./config");

const GIB = 1024 * 1024 * 1024;
const MIN_SHADOW_DISK_BYTES = 2 * 1024 * 1024;
const MAX_SHADOW_ROOT_PREFIX_BYTES = 256;
const SHADOW_STOP_REASONS = Object.freeze({
  MAX_PREFIXES: "shadow_max_prefixes",
  MAX_PAGES: "shadow_max_pages",
  MAX_REQUESTS: "shadow_max_requests",
  MAX_ITEMS: "shadow_max_items",
  MAX_DURATION: "shadow_max_duration",
  MAX_DISK: "shadow_max_disk",
  OPERATOR_ABORT: "shadow_operator_abort",
});
const SHADOW_HARD_LIMITS = Object.freeze({
  rootPrefixes: 1,
  concurrency: 1,
  maxPrefixes: 100,
  maxPages: 300,
  maxRequests: 350,
  maxItems: 25_000,
  maxDurationMinutes: 20,
  maxDiskBytes: GIB,
  pageSize: 100,
});
const SHADOW_DEFAULT_LIMITS = Object.freeze({
  ...SHADOW_HARD_LIMITS,
  rootPrefixes: 1,
});
const SHADOW_LIMIT_FIELDS = Object.freeze([
  "maxPrefixes",
  "maxPages",
  "maxRequests",
  "maxItems",
  "maxDurationMinutes",
  "maxDiskBytes",
  "concurrency",
  "pageSize",
]);
const SHADOW_LIMIT_STOP_REASONS = new Set([
  SHADOW_STOP_REASONS.MAX_PREFIXES,
  SHADOW_STOP_REASONS.MAX_PAGES,
  SHADOW_STOP_REASONS.MAX_REQUESTS,
  SHADOW_STOP_REASONS.MAX_ITEMS,
  SHADOW_STOP_REASONS.MAX_DURATION,
  SHADOW_STOP_REASONS.MAX_DISK,
]);
const WINDOWS_DRIVE_RELATIVE = /^[a-zA-Z]:[^\\/]/;
const WINDOWS_UNC_OR_DEVICE = /^(?:[\\/]{2}|[\\/]{2}[?.][\\/])/;

class ShadowLimitError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "ShadowLimitError";
    this.code = reason;
    this.shadowStopReason = reason;
  }
}

function pathComparisonKey(value) {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(resolved)
    ? resolved.toLowerCase()
    : resolved;
}

function canonicalExistingPath(value) {
  const resolved = path.resolve(value);
  return fs.existsSync(resolved)
    ? fs.realpathSync.native(resolved)
    : resolved;
}

function isWithin(root, target) {
  const relative = path.relative(
    pathComparisonKey(root),
    pathComparisonKey(target)
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateShadowDirInput(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("Shadow cesta musí byť neprázdny reťazec bez NUL.");
  }
  if (WINDOWS_DRIVE_RELATIVE.test(value)) {
    throw new Error("Windows drive-relative shadow cesta je zakázaná.");
  }
  if (WINDOWS_UNC_OR_DEVICE.test(value)) {
    throw new Error("UNC/device shadow cesta je zakázaná.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new Error("Shadow cesta nesmie obsahovať .. traversal segment.");
  }
}

function assertNoSymlinkComponents(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Shadow cesta nesmie obsahovať symlink: ${current}`);
    }
  }
}

function assertSafeShadowPath(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error(`${label} smeruje mimo shadow root: ${resolvedTarget}`);
  }
  assertNoSymlinkComponents(resolvedTarget);
  if (fs.existsSync(resolvedRoot)) {
    const realRoot = fs.realpathSync.native(resolvedRoot);
    let existing = resolvedTarget;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const existingTarget = fs.realpathSync.native(existing);
    if (!isWithin(realRoot, existingTarget)) {
      throw new Error(`${label} realpath smeruje mimo shadow root.`);
    }
  }
  return resolvedTarget;
}

function createShadowPathGuard(root) {
  const resolvedRoot = path.resolve(root);
  assertNoSymlinkComponents(resolvedRoot);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Shadow root neexistuje: ${resolvedRoot}`);
  }
  const initialLstat = fs.lstatSync(resolvedRoot);
  if (!initialLstat.isDirectory() || initialLstat.isSymbolicLink()) {
    throw new Error("Shadow root musí byť reálny adresár, nie symlink/junction.");
  }
  const initialRealpath = fs.realpathSync.native(resolvedRoot);
  const identity = {
    dev: initialLstat.dev,
    ino: initialLstat.ino,
    realpath: pathComparisonKey(initialRealpath),
  };
  function verify(target = resolvedRoot, label = "shadow path") {
    assertSafeShadowPath(resolvedRoot, target, label);
    const current = fs.lstatSync(resolvedRoot);
    const currentRealpath = fs.realpathSync.native(resolvedRoot);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      pathComparisonKey(currentRealpath) !== identity.realpath
    ) {
      throw new Error("Shadow root identity sa zmenila (symlink swap/rename race).");
    }
    return path.resolve(target);
  }
  return Object.freeze({ root: resolvedRoot, identity: Object.freeze(identity), verify });
}

function forbiddenProductionPaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const runtime = path.join(root, "runtime");
  const stateDb = path.join(runtime, "crawler-state.sqlite");
  return [
    runtime,
    stateDb,
    `${stateDb}-wal`,
    `${stateDb}-shm`,
    path.join(runtime, "catalog-items.jsonl"),
    path.join(runtime, "catalog-items.manifest.json"),
    path.join(runtime, "checkpoint.json"),
    path.join(runtime, "webshare-crawler.checkpoint.json"),
    path.join(runtime, "seen-idents"),
    path.join(runtime, "failed-prefixes.json"),
    path.join(runtime, "crawler-runs"),
    path.join(root, "data", "catalog.sqlite"),
    path.resolve("/var/www/html"),
    path.resolve("/var/www/html/videos_all.json"),
    path.resolve("/var/www/html/videos_all.json.gz"),
  ].map((entry) => path.resolve(entry));
}

function validateLimits(input = {}) {
  const limits = {};
  for (const field of SHADOW_LIMIT_FIELDS) {
    const value = input[field] ?? SHADOW_DEFAULT_LIMITS[field];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${field} musí byť kladné celé číslo.`);
    }
    if (field === "maxDiskBytes" && value < MIN_SHADOW_DISK_BYTES) {
      throw new Error(
        `maxDiskBytes musí byť aspoň ${MIN_SHADOW_DISK_BYTES}, aby sa vošli atómové DB/report operácie.`
      );
    }
    if (value > SHADOW_HARD_LIMITS[field]) {
      throw new Error(
        `${field}=${value} prekračuje shadow hard limit ${SHADOW_HARD_LIMITS[field]}.`
      );
    }
    limits[field] = value;
  }
  return Object.freeze(limits);
}

function createShadowConfig(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const productionRuntime = path.join(projectRoot, "runtime");
  validateShadowDirInput(options.shadowDir);
  const shadowRoot = path.resolve(
    options.shadowDir || path.join(productionRuntime, "shadow-phase-b")
  );
  const limits = validateLimits(options.limits);
  const roots = options.rootPrefixes || ["a"];
  if (
    !Array.isArray(roots) ||
    roots.length < 1 ||
    roots.length > SHADOW_HARD_LIMITS.rootPrefixes ||
    roots.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        Buffer.byteLength(value) > MAX_SHADOW_ROOT_PREFIX_BYTES ||
        /[\u0000-\u001f\u007f]/u.test(value)
    )
  ) {
    throw new Error(
      `Shadow režim vyžaduje presne jeden bezpečný root prefix do ${MAX_SHADOW_ROOT_PREFIX_BYTES} UTF-8 bajtov.`
    );
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error("Shadow root prefixy nesmú byť duplicitné.");
  }
  assertNoSymlinkComponents(shadowRoot);
  if (
    pathComparisonKey(shadowRoot) === pathComparisonKey(productionRuntime)
  ) {
    throw new Error("Shadow root nesmie byť produkčný runtime adresár.");
  }

  const paths = {
    root: shadowRoot,
    stateDb: path.join(shadowRoot, "crawler-state.sqlite"),
    lock: path.join(shadowRoot, "shadow.lock"),
    exports: path.join(shadowRoot, "exports"),
    logs: path.join(shadowRoot, "logs"),
    log: path.join(shadowRoot, "logs", "shadow-crawl.log"),
    report: path.join(shadowRoot, "report.json"),
    exportPath: path.join(
      shadowRoot,
      "exports",
      "{run_id}",
      "catalog-items.jsonl"
    ),
    manifestPath: path.join(
      shadowRoot,
      "exports",
      "{run_id}",
      "catalog-items.manifest.json"
    ),
  };
  for (const [label, target] of Object.entries(paths)) {
    paths[label] = assertSafeShadowPath(shadowRoot, target, label);
  }
  const forbidden = forbiddenProductionPaths(projectRoot);
  const productionRuntimePath = path.resolve(productionRuntime);
  const canonicalShadowRoot = canonicalExistingPath(shadowRoot);
  const canonicalProductionRuntime = canonicalExistingPath(productionRuntime);
  if (
    pathComparisonKey(canonicalShadowRoot) ===
    pathComparisonKey(canonicalProductionRuntime)
  ) {
    throw new Error("Shadow root canonical realpath je produkčný runtime.");
  }
  const canonicalForbidden = forbidden.map(canonicalExistingPath);
  if (
    canonicalForbidden.some(
      (entry, index) =>
        index !== 0 && isWithin(canonicalShadowRoot, entry)
    )
  ) {
    throw new Error(
      "Shadow root canonical realpath obsahuje zakázanú produkčnú cestu."
    );
  }
  if (forbidden.some((entry) => isWithin(shadowRoot, entry))) {
    throw new Error(
      "Shadow root nesmie obsahovať žiadnu zakázanú produkčnú cestu."
    );
  }
  for (const [label, target] of Object.entries(paths)) {
    const resolvedTarget = path.resolve(target);
    const collides = forbidden.some(
      (entry) =>
        resolvedTarget === entry ||
        (entry !== productionRuntimePath && isWithin(entry, resolvedTarget))
    );
    if (collides) {
      throw new Error(`${label} koliduje so zakázanou produkčnou cestou.`);
    }
  }

  const crawler = getCrawlerV2Config({
    runtimeDir: shadowRoot,
    stateDbPath: paths.stateDb,
    lockPath: paths.lock,
    legacyCheckpointPaths: [],
    exportPath: paths.exportPath,
    manifestPath: paths.manifestPath,
    workerConcurrency: limits.concurrency,
    algorithm: {
      roots,
      pageSize: limits.pageSize,
      maxPagesPerPrefix: SHADOW_HARD_LIMITS.maxPages,
      partitionCompletenessProven: false,
    },
  });
  return Object.freeze({
    shadowMode: true,
    projectRoot,
    paths: Object.freeze(paths),
    limits,
    crawler,
  });
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      const error = new Error(`Shadow disk scan odmietol symlink: ${current}`);
      error.code = "shadow_path_symlink_detected";
      error.shadowFatal = true;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

function atomicWriteJson(targetPath, value, options = {}) {
  options.pathGuard?.verify(targetPath, "atomic JSON target");
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  options.pathGuard?.verify(targetPath, "atomic JSON target");
  const temporary = path.join(
    directory,
    `.tmp-${path.basename(targetPath)}-${process.pid}-${crypto.randomUUID()}`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o640,
    });
    const descriptor = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    options.pathGuard?.verify(targetPath, "atomic JSON target");
    fs.renameSync(temporary, targetPath);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function createShadowGuard(options) {
  const { shadowConfig, shutdown, logger = null } = options;
  const previous = options.previousReport || {};
  const startedAt = previous.shadow_started_at || new Date().toISOString();
  const monotonicNow = options.monotonicNow || (() => process.hrtime.bigint());
  const startedMonotonic = monotonicNow();
  let previousDurationMs = Number(previous.duration_ms || 0);
  const counters = {
    requestsTotal: Number(previous.requests_total || 0),
    loginRequests: Number(previous.login_requests || 0),
    searchRequests: Number(previous.search_requests || 0),
    retryRequests: Number(previous.retry_requests || 0),
    itemsUnique: Number(previous.items_unique || 0),
    pagesCommitted: Number(previous.pages_committed || 0),
    prefixesLeased: Number(previous.prefixes_leased || 0),
    prefixesComplete: Number(previous.prefixes_complete || 0),
    prefixesFailed: Number(previous.prefixes_failed || 0),
    prefixesBlocked: Number(previous.prefixes_blocked || 0),
  };
  const attempts = new Map();
  let peakDiskBytes = Number(previous.peak_disk_bytes || 0);
  let stopReason = null;
  let warnedDisk = false;
  let disposed = false;
  let database = null;
  let runId = null;
  let reserveRequestTransaction = null;
  let updateBudgetTransaction = null;

  function persist() {
    try {
      options.onUpdate?.(snapshot({ finished: false }));
    } catch (error) {
      error.shadowFatal = true;
      error.code ||= "shadow_report_persist_failed";
      throw error;
    }
  }

  function durationMs() {
    return (
      previousDurationMs +
      Number(monotonicNow() - startedMonotonic) / 1_000_000
    );
  }

  function durableDurationMs() {
    return Math.max(0, Math.trunc(durationMs()));
  }

  function updateBudget(fields = {}) {
    if (!database || !runId || !updateBudgetTransaction) return;
    updateBudgetTransaction({
      durationMs: durableDurationMs(),
      peakDiskBytes,
      stopReason,
      ...fields,
    });
  }

  function markStop(reason) {
    if (!stopReason && (!shutdown.requested || shutdown.priority < 20)) {
      stopReason = reason;
      shutdown.request(reason, { status: "incomplete", priority: 20 });
      updateBudget({ stopReason: reason });
      try {
        persist();
      } catch (error) {
        logger?.error("Shadow stop report sa nepodarilo zapísať.", {
          error: error.message,
        });
      }
    }
  }

  function stop(reason, message) {
    markStop(reason);
    throw new ShadowLimitError(reason, message);
  }

  function checkDisk(additionalBytes = 0) {
    options.pathGuard?.verify(shadowConfig.paths.root, "disk root");
    const usage = directorySize(shadowConfig.paths.root);
    peakDiskBytes = Math.max(peakDiskBytes, usage);
    if (!warnedDisk && usage >= shadowConfig.limits.maxDiskBytes * 0.9) {
      warnedDisk = true;
      logger?.warn("Shadow disk usage dosiahlo 90 % limitu.", {
        usage,
        limit: shadowConfig.limits.maxDiskBytes,
      });
    }
    if (
      usage >= shadowConfig.limits.maxDiskBytes ||
      usage + Math.max(0, additionalBytes) > shadowConfig.limits.maxDiskBytes
    ) {
      stop(SHADOW_STOP_REASONS.MAX_DISK, "Shadow disk limit bol dosiahnutý.");
    }
    return usage;
  }

  function check(stage) {
    if (shutdown.requested) {
      const error = new Error(`Shadow operácia ${stage} bola zastavená.`);
      error.code = "shutdown_requested";
      throw error;
    }
    if (durationMs() >= shadowConfig.limits.maxDurationMinutes * 60_000) {
      stop(
        SHADOW_STOP_REASONS.MAX_DURATION,
        `Shadow časový limit bol dosiahnutý pred ${stage}.`
      );
    }
    checkDisk(64 * 1024);
    if (
      stage === "after_page_commit" &&
      counters.pagesCommitted >= shadowConfig.limits.maxPages
    ) {
      stop(SHADOW_STOP_REASONS.MAX_PAGES);
    }
    if (
      stage === "after_page_commit" &&
      counters.itemsUnique >= shadowConfig.limits.maxItems
    ) {
      stop(SHADOW_STOP_REASONS.MAX_ITEMS);
    }
  }

  function beforeRequest(kind, operationKey, isRetry = false) {
    check("before_request");
    const dbBytes = fs.existsSync(shadowConfig.paths.stateDb)
      ? fs.statSync(shadowConfig.paths.stateDb).size
      : 0;
    const walPath = `${shadowConfig.paths.stateDb}-wal`;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    checkDisk(Math.max(dbBytes, walBytes) + 512 * 1024);
    const key = `${kind}:${operationKey || "unknown"}`;
    if (reserveRequestTransaction) {
      const result = reserveRequestTransaction({
        kind,
        operationKey: String(operationKey || "unknown").slice(0, 500),
        forcedRetry: isRetry === true,
        durationMs: durableDurationMs(),
        peakDiskBytes,
        maxRequests: shadowConfig.limits.maxRequests,
      });
      if (!result.reserved) {
        stop(
          SHADOW_STOP_REASONS.MAX_REQUESTS,
          "Shadow request limit bol vyčerpaný pred HTTP transport invocation."
        );
      }
      counters.requestsTotal = result.requestsTotal;
      counters.loginRequests = result.loginRequests;
      counters.searchRequests = result.searchRequests;
      counters.retryRequests = result.retryRequests;
    } else {
      const count = attempts.get(key) || 0;
      if (counters.requestsTotal >= shadowConfig.limits.maxRequests) {
        stop(SHADOW_STOP_REASONS.MAX_REQUESTS);
      }
      attempts.set(key, count + 1);
      counters.requestsTotal += 1;
      if (kind === "login") counters.loginRequests += 1;
      else counters.searchRequests += 1;
      if (isRetry || count > 0) counters.retryRequests += 1;
    }
    persist();
  }

  function afterRequest() {
    check("after_request");
  }

  function recordLease() {
    counters.prefixesLeased += 1;
    persist();
  }

  function beforePageCommit(candidateItems) {
    check("before_page_commit");
    const candidateList = Array.isArray(candidateItems) ? candidateItems : null;
    const candidateCount = candidateList
      ? candidateList.length
      : Math.max(0, Number(candidateItems) || 0);
    if (counters.pagesCommitted >= shadowConfig.limits.maxPages) {
      stop(SHADOW_STOP_REASONS.MAX_PAGES);
    }
    if (
      counters.itemsUnique + candidateCount >
      shadowConfig.limits.maxItems
    ) {
      stop(SHADOW_STOP_REASONS.MAX_ITEMS);
    }
    const serializedBytes = candidateList
      ? candidateList.reduce(
          (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
          0
        )
      : candidateCount * 4096;
    const stateDbBytes = fs.existsSync(shadowConfig.paths.stateDb)
      ? fs.statSync(shadowConfig.paths.stateDb).size
      : 0;
    const walPath = `${shadowConfig.paths.stateDb}-wal`;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    checkDisk(
      Math.max(stateDbBytes, walBytes) +
        serializedBytes * 4 +
        1024 * 1024
    );
  }

  function beforeSplit({ frontierStore, runId: selectedRunId, childPrefixes }) {
    check("before_split");
    const existing = frontierStore.countFrontier(selectedRunId);
    const uniqueChildren = new Set(childPrefixes).size;
    if (existing + uniqueChildren > shadowConfig.limits.maxPrefixes) {
      stop(
        SHADOW_STOP_REASONS.MAX_PREFIXES,
        "Shadow maxPrefixes by bol prekročený splitom; parent page nebola commitnutá."
      );
    }
  }

  function recordPage(commitResult) {
    counters.pagesCommitted += 1;
    counters.itemsUnique += Number(commitResult?.insertedItems || 0);
    persist();
    check("after_page_commit");
  }

  function recordPrefix(result) {
    if (result === "complete" || result === "split") {
      counters.prefixesComplete += 1;
    } else if (result === "failed") {
      counters.prefixesFailed += 1;
    } else if (result === "blocked") {
      counters.prefixesBlocked += 1;
    }
    persist();
  }

  function snapshot(extra = {}) {
    const { finished = false, ...metadata } = extra;
    let diskUsageBytes = peakDiskBytes;
    try {
      diskUsageBytes = directorySize(shadowConfig.paths.root);
      peakDiskBytes = Math.max(peakDiskBytes, diskUsageBytes);
    } catch {
      // The primary error/status remains authoritative.
    }
    return {
      ...metadata,
      shadow_mode: true,
      shadow_root: shadowConfig.paths.root,
      shadow_limits: shadowConfig.limits,
      shadow_stop_reason:
        shutdown.stopStatus === "incomplete" &&
        SHADOW_LIMIT_STOP_REASONS.has(shutdown.signal)
          ? shutdown.signal
          : null,
      shadow_started_at: startedAt,
      shadow_finished_at: finished ? new Date().toISOString() : null,
      requests_total: counters.requestsTotal,
      login_requests: counters.loginRequests,
      search_requests: counters.searchRequests,
      retry_requests: counters.retryRequests,
      items_unique: counters.itemsUnique,
      pages_committed: counters.pagesCommitted,
      prefixes_leased: counters.prefixesLeased,
      prefixes_complete: counters.prefixesComplete,
      prefixes_failed: counters.prefixesFailed,
      prefixes_blocked: counters.prefixesBlocked,
      peak_disk_bytes: peakDiskBytes,
      disk_usage_bytes: diskUsageBytes,
      duration_ms: Math.trunc(durationMs()),
      reconciliation_safe: false,
      partition_completeness_proven: false,
    };
  }

  let durationTimer = null;
  function scheduleDurationTimer() {
    if (durationTimer) clearTimeout(durationTimer);
    const remainingDurationMs = Math.max(
      1,
      shadowConfig.limits.maxDurationMinutes * 60_000 - durationMs()
    );
    durationTimer = setTimeout(() => {
      if (!disposed) markStop(SHADOW_STOP_REASONS.MAX_DURATION);
    }, remainingDurationMs);
    durationTimer.unref?.();
  }
  scheduleDurationTimer();

  return {
    attachDatabase(attachedDatabase, selectedRunId, attachOptions = {}) {
      if (database) throw new Error("Shadow budget DB už bola pripojená.");
      database = attachedDatabase;
      runId = selectedRunId;
      database.pragma("busy_timeout = 0");
      database.pragma("temp_store = MEMORY");
      database.exec(`
        CREATE TABLE IF NOT EXISTS shadow_run_budget (
          run_id TEXT PRIMARY KEY REFERENCES crawl_runs(run_id) ON DELETE RESTRICT,
          shadow_root TEXT NOT NULL,
          limits_json TEXT NOT NULL,
          requests_total INTEGER NOT NULL DEFAULT 0 CHECK (requests_total >= 0),
          login_requests INTEGER NOT NULL DEFAULT 0 CHECK (login_requests >= 0),
          search_requests INTEGER NOT NULL DEFAULT 0 CHECK (search_requests >= 0),
          retry_requests INTEGER NOT NULL DEFAULT 0 CHECK (retry_requests >= 0),
          duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
          peak_disk_bytes INTEGER NOT NULL DEFAULT 0 CHECK (peak_disk_bytes >= 0),
          stop_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shadow_request_attempts (
          run_id TEXT NOT NULL REFERENCES shadow_run_budget(run_id) ON DELETE RESTRICT,
          kind TEXT NOT NULL,
          operation_key TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          PRIMARY KEY(run_id, kind, operation_key)
        ) WITHOUT ROWID;
      `);
      const now = new Date().toISOString();
      const existing = database
        .prepare("SELECT * FROM shadow_run_budget WHERE run_id = ?")
        .get(runId);
      if (attachOptions.command === "crawl") {
        if (existing) throw new Error("Shadow budget pre nový run už existuje.");
        database
          .prepare(`
            INSERT INTO shadow_run_budget(
              run_id, shadow_root, limits_json, duration_ms, peak_disk_bytes,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            runId,
            pathComparisonKey(shadowConfig.paths.root),
            JSON.stringify(shadowConfig.limits),
            durableDurationMs(),
            peakDiskBytes,
            now,
            now
          );
      } else {
        if (!existing) {
          throw new Error("Shadow resume nemá transakčný budget záznam.");
        }
        if (
          existing.shadow_root !== pathComparisonKey(shadowConfig.paths.root)
        ) {
          throw new Error("Shadow budget patrí inému canonical rootu.");
        }
        const originalLimits = JSON.parse(existing.limits_json);
        for (const field of SHADOW_LIMIT_FIELDS) {
          if (shadowConfig.limits[field] > originalLimits[field]) {
            throw new Error(`Shadow resume zvýšil pôvodný limit ${field}.`);
          }
        }
        counters.requestsTotal = Number(existing.requests_total);
        counters.loginRequests = Number(existing.login_requests);
        counters.searchRequests = Number(existing.search_requests);
        counters.retryRequests = Number(existing.retry_requests);
        previousDurationMs = Math.max(
          previousDurationMs,
          Number(existing.duration_ms)
        );
        scheduleDurationTimer();
        const durableCounts = database
          .prepare(`
            SELECT
              (SELECT COUNT(*) FROM crawl_pages WHERE run_id = ?) AS pages,
              (SELECT unique_items FROM crawl_runs WHERE run_id = ?) AS items,
              (SELECT COALESCE(SUM(attempt_count), 0)
                 FROM crawl_frontier WHERE run_id = ?) AS leases
          `)
          .get(runId, runId, runId);
        counters.pagesCommitted = Math.max(
          counters.pagesCommitted,
          Number(durableCounts.pages)
        );
        counters.itemsUnique = Math.max(
          counters.itemsUnique,
          Number(durableCounts.items)
        );
        counters.prefixesLeased = Math.max(
          counters.prefixesLeased,
          Number(durableCounts.leases)
        );
        peakDiskBytes = Math.max(
          peakDiskBytes,
          Number(existing.peak_disk_bytes)
        );
      }
      const reserve = database.transaction((input) => {
        const row = database
          .prepare("SELECT * FROM shadow_run_budget WHERE run_id = ?")
          .get(runId);
        if (Number(row.requests_total) >= input.maxRequests) {
          return { reserved: false };
        }
        const attempt = database
          .prepare(`
            SELECT attempt_count FROM shadow_request_attempts
            WHERE run_id = ? AND kind = ? AND operation_key = ?
          `)
          .get(runId, input.kind, input.operationKey);
        const retry = input.forcedRetry || Number(attempt?.attempt_count || 0) > 0;
        database
          .prepare(`
            INSERT INTO shadow_request_attempts(run_id, kind, operation_key, attempt_count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(run_id, kind, operation_key)
            DO UPDATE SET attempt_count = attempt_count + 1
          `)
          .run(runId, input.kind, input.operationKey);
        database
          .prepare(`
            UPDATE shadow_run_budget
            SET requests_total = requests_total + 1,
                login_requests = login_requests + ?,
                search_requests = search_requests + ?,
                retry_requests = retry_requests + ?,
                duration_ms = MAX(duration_ms, ?),
                peak_disk_bytes = MAX(peak_disk_bytes, ?),
                updated_at = ?
            WHERE run_id = ?
          `)
          .run(
            input.kind === "login" ? 1 : 0,
            input.kind === "login" ? 0 : 1,
            retry ? 1 : 0,
            input.durationMs,
            input.peakDiskBytes,
            new Date().toISOString(),
            runId
          );
        const updated = database
          .prepare("SELECT * FROM shadow_run_budget WHERE run_id = ?")
          .get(runId);
        return {
          reserved: true,
          requestsTotal: Number(updated.requests_total),
          loginRequests: Number(updated.login_requests),
          searchRequests: Number(updated.search_requests),
          retryRequests: Number(updated.retry_requests),
        };
      });
      reserveRequestTransaction = (input) => reserve.immediate(input);
      const update = database.transaction((input) => {
        database
          .prepare(`
            UPDATE shadow_run_budget
            SET duration_ms = MAX(duration_ms, ?),
                peak_disk_bytes = MAX(peak_disk_bytes, ?),
                stop_reason = COALESCE(?, stop_reason),
                updated_at = ?
            WHERE run_id = ?
          `)
          .run(
            input.durationMs,
            input.peakDiskBytes,
            input.stopReason || null,
            new Date().toISOString(),
            runId
          );
      });
      updateBudgetTransaction = (input) => update.immediate(input);
    },
    afterRequest,
    beforePageCommit,
    beforeRequest,
    beforeSplit,
    check,
    recordLease,
    recordPage,
    recordPrefix,
    snapshot,
    stop,
    dispose() {
      if (database?.open) updateBudget();
      disposed = true;
      clearTimeout(durationTimer);
    },
    beforeDatabaseClose() {
      updateBudget();
      database = null;
      reserveRequestTransaction = null;
      updateBudgetTransaction = null;
    },
    get stopReason() {
      return stopReason;
    },
    get limits() {
      return shadowConfig.limits;
    },
  };
}

function readShadowReport(reportPath) {
  const resolved = path.resolve(reportPath);
  if (!fs.existsSync(resolved)) return null;
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (value?.shadow_mode !== true || value?.reconciliation_safe !== false) {
    throw new Error(`Neplatný shadow report: ${resolved}`);
  }
  return value;
}

function validateShadowResume(shadowConfig, report, options = {}) {
  if (!report || report.shadow_mode !== true) {
    throw new Error("Shadow resume vyžaduje existujúci shadow report.");
  }
  if (
    pathComparisonKey(report.shadow_root) !==
    pathComparisonKey(shadowConfig.paths.root)
  ) {
    throw new Error("Shadow resume root sa nezhoduje s pôvodným runom.");
  }
  if (
    report.algorithm_fingerprint &&
    report.algorithm_fingerprint !== shadowConfig.crawler.algorithmFingerprint
  ) {
    throw new Error("Shadow resume má odlišný algorithm fingerprint.");
  }
  for (const field of SHADOW_LIMIT_FIELDS) {
    if (
      Number(shadowConfig.limits[field]) >
      Number(report.shadow_limits?.[field])
    ) {
      throw new Error(`Shadow resume nesmie zvýšiť limit ${field}.`);
    }
  }
  if (
    SHADOW_LIMIT_STOP_REASONS.has(report.shadow_stop_reason) &&
    options.resumeShadowLimited !== true
  ) {
    throw new Error(
      "Run zastavený limitom vyžaduje --resume-shadow-limited."
    );
  }
  const consumed = {
    maxPages: report.pages_committed,
    maxRequests: report.requests_total,
    maxItems: report.items_unique,
  };
  if (
    Number(report.frontier_rows || 0) >
    Number(shadowConfig.limits.maxPrefixes)
  ) {
    throw new Error("Shadow resume state prekračuje maxPrefixes frontier limit.");
  }
  for (const [field, value] of Object.entries(consumed)) {
    if (Number(value || 0) >= Number(shadowConfig.limits[field])) {
      throw new Error(`Shadow resume už vyčerpal limit ${field}.`);
    }
  }
  if (
    Number(report.duration_ms || 0) >=
    Number(shadowConfig.limits.maxDurationMinutes) * 60_000
  ) {
    throw new Error("Shadow resume už vyčerpal limit maxDurationMinutes.");
  }
  if (
    Number(report.peak_disk_bytes || 0) >=
    Number(shadowConfig.limits.maxDiskBytes)
  ) {
    throw new Error("Shadow resume už vyčerpal limit maxDiskBytes.");
  }
  return true;
}

module.exports = {
  SHADOW_DEFAULT_LIMITS,
  SHADOW_HARD_LIMITS,
  SHADOW_LIMIT_FIELDS,
  SHADOW_STOP_REASONS,
  ShadowLimitError,
  MIN_SHADOW_DISK_BYTES,
  MAX_SHADOW_ROOT_PREFIX_BYTES,
  assertSafeShadowPath,
  atomicWriteJson,
  createShadowConfig,
  createShadowGuard,
  createShadowPathGuard,
  directorySize,
  isWithin,
  canonicalExistingPath,
  pathComparisonKey,
  readShadowReport,
  validateLimits,
  validateShadowDirInput,
  validateShadowResume,
};
