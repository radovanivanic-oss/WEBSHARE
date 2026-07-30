const axios = require("axios");
const crypto = require("crypto");
const { execFile } = require("child_process");
const fs = require("fs");
const fsPromises = fs.promises;
const os = require("os");
const path = require("path");
const util = require("util");
const { parseStringPromise } = require("xml2js");
const {
  exportClassifiedCatalog,
  normalizeBoolean,
  normalizeChunkSize,
} = require("./lib/catalog-exporter");
const {
  RUN_STATUSES,
  buildUnverifiedCrawlerManifest,
} = require("./lib/catalog-safety");
const {
  getCrawlerV2Config,
  WEBSHARE_SEARCH_ENDPOINT,
} = require("./lib/crawler/config");
const {
  executeCrawler,
  inspectCrawlerState,
  validateCrawlerState,
} = require("./lib/crawler/orchestrator");
const {
  createWebshareSearchTransport,
} = require("./lib/crawler/search-client");
const {
  createShadowConfig,
  readShadowReport,
} = require("./lib/crawler/shadow");
const {
  executeShadowCrawler,
  inspectShadowState,
  prepareShadowRoot,
  validateShadowState,
} = require("./lib/crawler/shadow-runner");

const execFileAsync = util.promisify(execFile);

const BASE_URL = "https://webshare.cz";
const SALT_URL = `${BASE_URL}/api/salt/`;
const API_LOGIN_URL = `${BASE_URL}/api/login/`;
const SEARCH_URL = WEBSHARE_SEARCH_ENDPOINT;
const FILE_LINK_URL = `${BASE_URL}/api/file_link/`;
const SEARCH_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const MIN_VIDEO_SIZE = 1;
const MAX_VIDEO_SIZE = Number.MAX_SAFE_INTEGER;
const PAGE_LIMIT = 100;
const SEARCH_SPLIT_SENTINEL = 1000;
const MAX_PREFIX_DEPTH = 5;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_COUNT = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;
const DEFAULT_OUTPUT_PATH = "/var/www/html/videos_all.json";
const CHECKPOINT_SAVE_INTERVAL = 10;
const PREFIX_CONCURRENCY = 3;
const FILE_LINK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SEEN_BUCKET_CACHE_LIMIT = 16;
const GITHUB_MAX_EXPORT_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MD5_CRYPT_MAGIC = "$1$";
const MD5_CRYPT_ALPHABET =
  "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SENSITIVE_LOG_KEYS = new Set([
  "password",
  "passwd",
  "wst",
  "token",
  "digest",
  "authorization",
  "authorization_header",
  "auth_header",
  "bearer",
  "bearer_token",
  "bearer_value",
  "access_token",
  "refresh_token",
  "auth_token",
  "session_token",
  "token_value",
  "token_secret",
  "password_hash",
  "password_digest",
  "wst_value",
]);

class WebshareApiError extends Error {
  constructor(endpoint, code, message, status) {
    super(`${endpoint} failed: ${message || "Unknown error"}`);
    this.name = "WebshareApiError";
    this.endpoint = endpoint;
    this.code = code || null;
    this.status = status || null;
  }
}

function getConfig(options = {}) {
  const requireCredentials = options.requireCredentials !== false;
  const username = process.env.WEBSHARE_USERNAME;
  const password = process.env.WEBSHARE_PASSWORD;
  const outputPath = process.env.OUTPUT_JSON_PATH || DEFAULT_OUTPUT_PATH;
  const catalogChunkSize = normalizeChunkSize(process.env.CATALOG_CHUNK_SIZE);
  const exportLegacyAll = normalizeBoolean(process.env.EXPORT_LEGACY_ALL, true);
  const catalogRetainJsonl = normalizeBoolean(process.env.CATALOG_RETAIN_JSONL, true);
  const githubExportEnabled = process.env.GITHUB_EXPORT_ENABLED === "true";
  const githubExportBranch = process.env.GITHUB_EXPORT_BRANCH || "data";
  const githubExportRepoUrl = process.env.GITHUB_EXPORT_REPO_URL || null;
  const githubExportToken = process.env.GITHUB_EXPORT_TOKEN || null;
  const githubExportName =
    process.env.GITHUB_EXPORT_NAME || "webshare-crawler-bot";
  const githubExportEmail =
    process.env.GITHUB_EXPORT_EMAIL || "webshare-crawler@example.invalid";

  if (requireCredentials && (!username || !password)) {
    throw new Error("Chýba WEBSHARE_USERNAME alebo WEBSHARE_PASSWORD.");
  }

  const runtimeDir = path.resolve(process.cwd(), "runtime");

  return {
    username,
    password,
    outputPath,
    catalogOutputDir: path.join(path.dirname(outputPath), "catalog"),
    catalogChunkSize,
    exportLegacyAll,
    minSize: MIN_VIDEO_SIZE,
    maxSize: MAX_VIDEO_SIZE,
    runtimeDir,
    logPath: path.join(runtimeDir, "webshare-crawler.log"),
    checkpointPath: path.join(runtimeDir, "webshare-crawler.checkpoint.json"),
    lockPath: path.join(runtimeDir, "webshare-crawler.lock"),
    healthPath: path.join(runtimeDir, "health.json"),
    failedPrefixesPath: path.join(runtimeDir, "failed-prefixes.json"),
    resolverCachePath: path.join(runtimeDir, "webshare-file-link-cache.json"),
    catalogJsonlPath: path.join(runtimeDir, "catalog-items.jsonl"),
    catalogSourceManifestPath: path.join(runtimeDir, "catalog-items.manifest.json"),
    catalogRetainJsonl,
    seenIndexDir: path.join(runtimeDir, "seen-idents"),
    githubExportEnabled,
    githubExportBranch,
    githubExportRepoUrl,
    githubExportToken,
    githubExportName,
    githubExportEmail,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt) {
  const exponential = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  );
  const jitter = Math.floor(Math.random() * 300);
  return exponential + jitter;
}

function isSensitiveLogKey(key) {
  const normalized = String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!normalized) return false;
  if (SENSITIVE_LOG_KEYS.has(normalized)) {
    return true;
  }
  return /_(?:password|passwd|password_hash|password_digest|wst|wst_value|digest|authorization|authorization_header|auth_header|bearer|bearer_token|access_token|refresh_token|auth_token|session_token|token)$/u.test(
    normalized
  );
}

function sanitizeLogValue(value, secrets = []) {
  const secretValues = secrets
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length);
  const seen = new WeakSet();
  function visit(input, key = "") {
    if (isSensitiveLogKey(key)) {
      return "[REDACTED]";
    }
    if (typeof input === "string") {
      let result = input
        .replace(/([?&]wst=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(
          /(\b(?:wst|token|password|passwd|digest|access_token|refresh_token|auth_token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}&}]+)/gi,
          "$1[REDACTED]"
        )
        .replace(
          /(\bauthorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^,\s;}]+)/gi,
          "$1[REDACTED]"
        )
        .replace(
          /(\bbearer\s+)[a-z0-9._~+/=-]+/gi,
          "$1[REDACTED]"
        );
      for (const secret of secretValues) result = result.replaceAll(secret, "[REDACTED]");
      return result.slice(0, 2000);
    }
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 50).map((entry) => visit(entry));
    return Object.fromEntries(
      Object.entries(input)
        .slice(0, 50)
        .map(([childKey, child]) => [childKey, visit(child, childKey)])
    );
  }
  return visit(value);
}

function createLogger(logPath, options = {}) {
  options.pathGuard?.verify(logPath, "shadow log");
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(
    logPath,
    fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      fs.constants.O_WRONLY |
      noFollow,
    0o640
  );
  try {
    options.pathGuard?.verify(logPath, "shadow log");
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  const maxBytes = Number.isSafeInteger(options.maxBytes)
    ? options.maxBytes
    : Number.MAX_SAFE_INTEGER;
  let writtenBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  let capped = writtenBytes >= maxBytes;

  function write(level, message, extra) {
    const timestamp = new Date().toISOString();
    const safeMessage = sanitizeLogValue(message, options.secrets);
    const safeExtra = sanitizeLogValue(extra, options.secrets);
    const base = `[${timestamp}] [${level}] ${safeMessage}`;
    const suffix =
      safeExtra === undefined ? "" : ` ${JSON.stringify(safeExtra)}`;
    const line = `${base}${suffix}`.slice(0, 4096);

    console.log(line);
    const payload = `${line}\n`;
    const bytes = Buffer.byteLength(payload);
    if (!capped && writtenBytes + bytes <= maxBytes) {
      fs.writeSync(descriptor, payload);
      writtenBytes += bytes;
    } else {
      capped = true;
    }
  }

  return {
    info(message, extra) {
      write("INFO", message, extra);
    },
    warn(message, extra) {
      write("WARN", message, extra);
    },
    error(message, extra) {
      write("ERROR", message, extra);
    },
    async close() {
      fs.closeSync(descriptor);
    },
  };
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    async close() {},
  };
}

function createRunStats() {
  return {
    startedAtMs: Date.now(),
    apiRequests: 0,
    foundVideos: 0,
    filteredVideos: 0,
    duplicateVideos: 0,
    invalidItems: 0,
    uniqueItems: 0,
  };
}

function getDurationSeconds(stats) {
  return Math.round((Date.now() - stats.startedAtMs) / 1000);
}

function getMemoryUsage() {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  return { rss, heapUsed, heapTotal };
}

async function retry(fn, label, logger, options = {}) {
  const retries = options.retries || RETRY_COUNT;
  const shouldRetry = options.shouldRetry || (() => true);
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= retries || !shouldRetry(error)) {
        break;
      }

      const delayMs = computeBackoffMs(attempt);
      logger.warn(`${label} zlyhalo, čakám ${delayMs} ms`, {
        attempt,
        retries,
        error: error.message,
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function createApiClient() {
  return axios.create({
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Accept: "text/xml; charset=UTF-8",
    },
    timeout: REQUEST_TIMEOUT_MS,
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 300,
  });
}

function parseStatus(parsed, endpoint) {
  const status = parsed?.response?.status?.[0] || null;
  const code = parsed?.response?.code?.[0] || null;
  const message = parsed?.response?.message?.[0] || null;

  if (status !== "OK") {
    throw new WebshareApiError(endpoint, code, message, status);
  }

  return parsed.response;
}

function isAuthError(error) {
  if (!(error instanceof WebshareApiError)) {
    return false;
  }

  const message = `${error.message} ${error.code || ""}`.toLowerCase();
  return message.includes("access denied") || message.includes("token");
}

function isRetryableFileLinkError(error) {
  if (!(error instanceof WebshareApiError)) {
    return true;
  }

  return ["FILE_LINK_FATAL_4", "FILE_LINK_FATAL_5"].includes(error.code);
}

function isHttp500Error(error) {
  return error?.response?.status === 500;
}

function classifyTemporarySearchError(error) {
  const status = error?.response?.status || null;
  const code = error?.code || null;

  if (status === 500) {
    return "http_500";
  }

  if ([502, 503, 504].includes(status)) {
    return "temporary_http";
  }

  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return "timeout";
  }

  if (["ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return "network";
  }

  return null;
}

function isTemporarySearchError(error) {
  return Boolean(classifyTemporarySearchError(error));
}

function getXmlFieldValue(value) {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  const text = String(rawValue).trim();
  return text === "" ? null : text;
}

function normalizeOptionalString(value) {
  return getXmlFieldValue(value);
}

function normalizeNumber(value, fallback = 0) {
  const text = getXmlFieldValue(value);

  if (text === null) {
    return fallback;
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeFileType(value) {
  const text = getXmlFieldValue(value);
  return text ? text.replace(/^\./, "").toLowerCase() : null;
}

function normalizeFile(file) {
  const ident = normalizeOptionalString(file.ident);
  const name = normalizeOptionalString(file.name) || "";
  const size = normalizeNumber(file.size);
  const apiType = normalizeFileType(file.type);
  const nameExtension =
    path.extname(name).replace(/^\./, "").toLowerCase() || null;
  const extension = apiType || nameExtension;

  if (!ident || !Number.isFinite(size)) {
    return null;
  }

  return {
    id: ident,
    ident,
    name,
    title: name,
    size,
    extension,
    mime: normalizeOptionalString(file.mime),
    type: apiType || extension || "video",
    img: normalizeOptionalString(file.img),
    stripe: normalizeOptionalString(file.stripe),
    stripe_count: normalizeNumber(file.stripe_count),
    queued: normalizeNumber(file.queued),
    positive_votes: normalizeNumber(file.positive_votes),
    negative_votes: normalizeNumber(file.negative_votes),
    password_protected: normalizeNumber(file.password) === 1,
    category: "video",
    source: "webshare",
    needsFileLink: true,
    url: `webshare://${ident}`,
    direct_url: null,
  };
}

async function ensureDirectory(filePath) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJsonAtomically(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await ensureDirectory(filePath);
  await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await fsPromises.rename(tempPath, filePath);
}

async function copyFile(sourcePath, targetPath) {
  await ensureDirectory(targetPath);
  await fsPromises.copyFile(sourcePath, targetPath);
}

async function copyFileForGithub(sourcePath, targetPath, logger, publishStats) {
  try {
    const stat = await fsPromises.stat(sourcePath);

    if (stat.size > GITHUB_MAX_EXPORT_FILE_SIZE_BYTES) {
      logger.warn("Súbor presahuje GitHub limit a nebude publikovaný.", {
        sourcePath,
        size: stat.size,
        limit: GITHUB_MAX_EXPORT_FILE_SIZE_BYTES,
      });
      publishStats.skippedFiles.push({
        file: sourcePath,
        size: stat.size,
        reason: "github_file_size_limit",
      });
      return false;
    }

    if (stat.size > 50 * 1024 * 1024) {
      logger.warn("Súbor je veľký pre GitHub, ale je pod tvrdým limitom.", {
        sourcePath,
        size: stat.size,
      });
    }

    await copyFile(sourcePath, targetPath);
    publishStats.copiedFiles += 1;
    publishStats.copiedBytes += stat.size;
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.warn("Súbor na GitHub publish neexistuje, preskakujem.", {
        sourcePath,
      });
      publishStats.skippedFiles.push({
        file: sourcePath,
        size: 0,
        reason: "missing",
      });
      return false;
    }

    throw error;
  }
}

async function copyDirectoryForGithub(sourceDir, targetDir, logger, publishStats) {
  if (!(await pathExists(sourceDir))) {
    logger.warn("Adresár na GitHub publish neexistuje, preskakujem.", {
      sourceDir,
    });
    return false;
  }

  await fsPromises.mkdir(targetDir, { recursive: true });
  const entries = await fsPromises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryForGithub(sourcePath, targetPath, logger, publishStats);
    } else if (entry.isFile()) {
      await copyFileForGithub(sourcePath, targetPath, logger, publishStats);
    }
  }

  return true;
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function removePathIfExists(targetPath) {
  await fsPromises.rm(targetPath, { recursive: true, force: true });
}

async function runGitCommand(args, options = {}) {
  await execFileAsync("git", args, options);
}

class CatalogStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await ensureDirectory(this.filePath);
  }

  async appendMany(items) {
    if (items.length === 0) {
      return;
    }

    const payload = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
    this.writeChain = this.writeChain.then(() =>
      fsPromises.appendFile(this.filePath, payload, "utf8")
    );
    await this.writeChain;
  }

  async flush() {
    await this.writeChain;
  }
}

class SeenIdentIndex {
  constructor(directoryPath, logger) {
    this.directoryPath = directoryPath;
    this.logger = logger;
    this.cache = new Map();
  }

  async init() {
    await fsPromises.mkdir(this.directoryPath, { recursive: true });
  }

  getBucketName(ident) {
    return crypto.createHash("md5").update(ident).digest("hex").slice(0, 2);
  }

  getBucketPath(bucketName) {
    return path.join(this.directoryPath, `${bucketName}.jsonl`);
  }

  async ensureBucket(bucketName) {
    const cached = this.cache.get(bucketName);

    if (cached) {
      this.cache.delete(bucketName);
      this.cache.set(bucketName, cached);
      return cached;
    }

    const bucketPath = this.getBucketPath(bucketName);
    let set = new Set();

    try {
      const raw = await fsPromises.readFile(bucketPath, "utf8");
      for (const line of raw.split("\n")) {
        if (line) {
          set.add(line);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    this.cache.set(bucketName, { set });

    if (this.cache.size > SEEN_BUCKET_CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    return this.cache.get(bucketName);
  }

  async addIfNew(ident) {
    const bucketName = this.getBucketName(ident);
    const bucket = await this.ensureBucket(bucketName);

    if (bucket.set.has(ident)) {
      return false;
    }

    bucket.set.add(ident);
    await fsPromises.appendFile(this.getBucketPath(bucketName), `${ident}\n`, "utf8");
    return true;
  }
}

function createInitialCheckpoint() {
  return {
    version: 3,
    phase: "crawl",
    queue: SEARCH_CHARS.map((prefix) => ({ prefix, depth: 1 })),
    processedPrefixes: 0,
    uniqueItems: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function loadCheckpointState(config, logger) {
  try {
    const raw = await fsPromises.readFile(config.checkpointPath, "utf8");
    const parsed = JSON.parse(raw);
    logger.info("Našiel som checkpoint, pokračujem z neho.", {
      phase: parsed.phase,
      queued: parsed.queue?.length || 0,
      processedPrefixes: parsed.processedPrefixes || 0,
      uniqueItems: parsed.uniqueItems || 0,
    });
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Checkpoint sa nepodarilo načítať, idem odznova.", {
        error: error.message,
      });
    }

    await removePathIfExists(config.catalogJsonlPath);
    await removePathIfExists(config.seenIndexDir);
    await removePathIfExists(config.failedPrefixesPath);
    return createInitialCheckpoint();
  }
}

async function saveCheckpoint(checkpointPath, state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomically(checkpointPath, state);
}

function createCheckpointSaver(checkpointPath) {
  let writeChain = Promise.resolve();

  return async function save(state) {
    writeChain = writeChain.then(() => saveCheckpoint(checkpointPath, state));
    await writeChain;
  };
}

async function clearCheckpoint(checkpointPath, logger) {
  try {
    await fsPromises.unlink(checkpointPath);
    logger.info("Checkpoint bol odstránený po úspešnom dokončení.");
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Checkpoint sa nepodarilo odstrániť.", {
        error: error.message,
      });
    }
  }
}

async function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function acquireLock(lockPath, logger) {
  await ensureDirectory(lockPath);

  try {
    const existing = await fsPromises.readFile(lockPath, "utf8");
    const parsed = JSON.parse(existing);

    if (parsed?.pid && (await isProcessRunning(parsed.pid))) {
      logger.warn("crawler already running", {
        pid: parsed.pid,
        startedAt: parsed.startedAt || null,
      });
      const error = new Error("crawler already running");
      error.code = "CRAWLER_ALREADY_RUNNING";
      throw error;
    }
  } catch (error) {
    if (
      !["ENOENT"].includes(error.code) &&
      error.code !== "CRAWLER_ALREADY_RUNNING"
    ) {
      logger.warn("Lock file sa nepodarilo načítať, prepíšem ho.", {
        error: error.message,
      });
    } else if (error.code === "CRAWLER_ALREADY_RUNNING") {
      throw error;
    }
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await fsPromises.writeFile(lockPath, JSON.stringify(payload, null, 2), "utf8");
}

async function releaseLock(lockPath, logger) {
  try {
    await fsPromises.unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Lock file sa nepodarilo odstrániť.", {
        error: error.message,
      });
    }
  }
}

function buildHealthReport({
  success,
  videos,
  durationSeconds,
  phase = success ? "done" : "failed",
  operation = "crawl",
  runStatus = null,
  catalog = null,
  classification = null,
}) {
  const report = {
    success,
    phase,
    operation,
    run_status: runStatus,
    generated_at: new Date().toISOString(),
    videos,
    duration_seconds: durationSeconds,
    memory: getMemoryUsage(),
  };

  if (catalog) {
    report.catalog = catalog;
  }

  if (classification) {
    report.classification = classification;
  }

  return report;
}

function toMd5CryptBase64(value, length) {
  let result = "";
  let current = value;

  for (let index = 0; index < length; index += 1) {
    result += MD5_CRYPT_ALPHABET[current & 0x3f];
    current >>= 6;
  }

  return result;
}

function createMd5Digest(...parts) {
  const hash = crypto.createHash("md5");

  for (const part of parts) {
    hash.update(part);
  }

  return hash.digest();
}

function md5Crypt(password, salt) {
  const passwordBuffer = Buffer.from(password, "utf8");
  const saltText = String(salt || "").split("$")[0].slice(0, 8);
  const saltBuffer = Buffer.from(saltText, "utf8");
  const magicBuffer = Buffer.from(MD5_CRYPT_MAGIC, "ascii");

  const context = crypto.createHash("md5");
  context.update(passwordBuffer);
  context.update(magicBuffer);
  context.update(saltBuffer);

  const alternate = createMd5Digest(passwordBuffer, saltBuffer, passwordBuffer);
  let remaining = passwordBuffer.length;

  while (remaining > 0) {
    context.update(alternate.subarray(0, Math.min(16, remaining)));
    remaining -= 16;
  }

  for (let index = passwordBuffer.length; index > 0; index >>= 1) {
    context.update(
      index & 1 ? Buffer.from([0]) : passwordBuffer.subarray(0, 1)
    );
  }

  let finalDigest = context.digest();

  for (let index = 0; index < 1000; index += 1) {
    const loop = crypto.createHash("md5");

    if (index & 1) {
      loop.update(passwordBuffer);
    } else {
      loop.update(finalDigest);
    }

    if (index % 3) {
      loop.update(saltBuffer);
    }

    if (index % 7) {
      loop.update(passwordBuffer);
    }

    if (index & 1) {
      loop.update(finalDigest);
    } else {
      loop.update(passwordBuffer);
    }

    finalDigest = loop.digest();
  }

  let hash = "";
  hash += toMd5CryptBase64(
    (finalDigest[0] << 16) | (finalDigest[6] << 8) | finalDigest[12],
    4
  );
  hash += toMd5CryptBase64(
    (finalDigest[1] << 16) | (finalDigest[7] << 8) | finalDigest[13],
    4
  );
  hash += toMd5CryptBase64(
    (finalDigest[2] << 16) | (finalDigest[8] << 8) | finalDigest[14],
    4
  );
  hash += toMd5CryptBase64(
    (finalDigest[3] << 16) | (finalDigest[9] << 8) | finalDigest[15],
    4
  );
  hash += toMd5CryptBase64(
    (finalDigest[4] << 16) | (finalDigest[10] << 8) | finalDigest[5],
    4
  );
  hash += toMd5CryptBase64(finalDigest[11], 2);

  return `${MD5_CRYPT_MAGIC}${saltText}$${hash}`;
}

function createWebsharePasswordHash(password, salt) {
  return crypto
    .createHash("sha1")
    .update(md5Crypt(password, salt), "utf8")
    .digest("hex");
}

function createWebshareLoginDigest(username, passwordHash) {
  return crypto
    .createHash("md5")
    .update(`${username}:Webshare:${passwordHash}`, "utf8")
    .digest("hex");
}

async function postWebshareXml(
  client,
  url,
  params,
  endpointName,
  requestOptions = {}
) {
  const {
    requestMeter,
    requestOperationKey = endpointName,
    ...httpOptions
  } = requestOptions;
  requestMeter?.beforeRequest("login", requestOperationKey);
  const response = await client.post(url, params.toString(), httpOptions);
  requestMeter?.afterRequest();
  const parsed = await parseStringPromise(response.data, {
    explicitArray: true,
    trim: true,
  });

  return parseStatus(parsed, endpointName);
}

async function loginAndGetWst({
  username,
  password,
  signal = undefined,
  requestMeter = null,
  client = null,
}) {
  const apiClient = client || createApiClient();
  const saltResponse = await postWebshareXml(
    apiClient,
    SALT_URL,
    new URLSearchParams({ username_or_email: username }),
    "salt",
    {
      signal,
      requestMeter,
      requestOperationKey: "salt",
    }
  );
  const salt = saltResponse.salt?.[0];

  if (!salt) {
    throw new Error("Webshare API nevrátilo salt.");
  }

  const passwordHash = createWebsharePasswordHash(password, salt);
  const loginResponse = await postWebshareXml(
    apiClient,
    API_LOGIN_URL,
    new URLSearchParams({
      username_or_email: username,
      password: passwordHash,
      digest: createWebshareLoginDigest(username, passwordHash),
      keep_logged_in: "1",
    }),
    "login",
    {
      signal,
      requestMeter,
      requestOperationKey: "login",
    }
  );
  const token = loginResponse.token?.[0] || loginResponse.wst?.[0];

  if (!token) {
    throw new Error("Webshare API nevrátilo WST token.");
  }

  return token;
}

class WebshareSession {
  constructor(config, logger, options = {}) {
    this.config = config;
    this.logger = logger;
    this.cachedWst = null;
    this.requestMeter = options.requestMeter || null;
    this.login = options.login || loginAndGetWst;
    this.apiClient = options.apiClient || null;
  }

  invalidate() {
    this.cachedWst = null;
  }

  async getWst(forceRefresh = false, signal = undefined) {
    if (!forceRefresh && this.cachedWst) {
      return this.cachedWst;
    }

    this.logger.info("Obnovujem WST token.");
    this.cachedWst = await retry(
      () =>
        this.login({
          username: this.config.username,
          password: this.config.password,
          signal,
          requestMeter: this.requestMeter,
          client: this.apiClient,
        }),
      "Webshare API login",
      this.logger,
      { shouldRetry: () => !signal?.aborted }
    );
    return this.cachedWst;
  }

  async withWst(task, options = {}) {
    let refreshed = false;

    while (true) {
      const wst = await this.getWst(refreshed, options.signal);

      try {
        return await task(wst);
      } catch (error) {
        if (!refreshed && isAuthError(error)) {
          this.logger.warn("WST token vyzerá neplatný, idem ho obnoviť.");
          this.invalidate();
          refreshed = true;
          continue;
        }

        throw error;
      }
    }
  }
}

async function postXml(
  client,
  url,
  params,
  endpointName,
  stats,
  requestOptions = {}
) {
  if (stats) {
    stats.apiRequests += 1;
  }

  const {
    requestMeter,
    requestOperationKey = endpointName,
    ...httpOptions
  } = requestOptions;
  requestMeter?.beforeRequest(
    endpointName === "search" ? "search" : "login",
    requestOperationKey
  );
  const response = await client.post(url, params.toString(), httpOptions);
  requestMeter?.afterRequest();
  const parsed = await parseStringPromise(response.data, {
    explicitArray: true,
    trim: true,
  });

  return parseStatus(parsed, endpointName);
}

async function fetchSearchPage(
  client,
  session,
  {
    prefix,
    offset,
    limit,
    wildcardSuffix = "*",
    sort = "recent",
    category = "video",
    signal = undefined,
    requestMeter = null,
  },
  stats
) {
  return session.withWst(async (wst) => {
    const params = new URLSearchParams({
      what: `${prefix}${wildcardSuffix}`,
      limit: String(limit),
      offset: String(offset),
      sort,
      category,
      wst,
    });

    const response = await postXml(
      client,
      SEARCH_URL,
      params,
      "search",
      stats,
      {
        signal,
        requestMeter,
        requestOperationKey: `search:${prefix}:${offset}:${limit}`,
      }
    );

    return {
      total: response.total?.[0] ?? null,
      files: Array.isArray(response.file) ? response.file : [],
    };
  }, { signal });
}

async function resolveFileLink(client, ident, wst, logger, stats) {
  return retry(
    async () => {
      const params = new URLSearchParams({
        ident,
        wst,
        download_type: "video_stream",
        force_https: "1",
      });
      const response = await postXml(
        client,
        FILE_LINK_URL,
        params,
        "file_link",
        stats
      );
      return response.link?.[0] || null;
    },
    `file_link ${ident}`,
    logger,
    { shouldRetry: isRetryableFileLinkError }
  );
}

async function loadResolverCache(cachePath, logger) {
  try {
    const raw = await fsPromises.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Resolver cache sa nepodarilo načítať, vytváram novú.", {
        error: error.message,
      });
    }

    return {};
  }
}

async function saveResolverCache(cachePath, cache) {
  await writeJsonAtomically(cachePath, cache);
}

async function loadFailedPrefixes(failedPrefixesPath, logger) {
  try {
    const raw = await fsPromises.readFile(failedPrefixesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Failed prefixes sa nepodarilo načítať, vytváram nový zoznam.", {
        error: error.message,
      });
    }

    return [];
  }
}

async function recordFailedPrefix(failedPrefixesPath, prefixEntry, error, logger) {
  const failedPrefixes = await loadFailedPrefixes(failedPrefixesPath, logger);
  const kind = classifyTemporarySearchError(error) || "unknown";
  const entry = {
    prefix: prefixEntry.prefix,
    depth: prefixEntry.depth,
    status: error?.response?.status || null,
    code: error?.code || null,
    message: error.message,
    kind,
    recordedAt: new Date().toISOString(),
  };
  const existingIndex = failedPrefixes.findIndex(
    (item) => item.prefix === prefixEntry.prefix && item.depth === prefixEntry.depth
  );

  if (existingIndex >= 0) {
    failedPrefixes[existingIndex] = entry;
  } else {
    failedPrefixes.push(entry);
  }

  await writeJsonAtomically(failedPrefixesPath, failedPrefixes);
}

function getCachedResolvedUrl(cache, ident) {
  const entry = cache[ident];

  if (!entry?.url || !entry?.expiresAt) {
    return null;
  }

  if (Date.now() >= new Date(entry.expiresAt).getTime()) {
    delete cache[ident];
    return null;
  }

  return entry.url;
}

function setCachedResolvedUrl(cache, ident, url) {
  cache[ident] = {
    url,
    expiresAt: new Date(Date.now() + FILE_LINK_CACHE_TTL_MS).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function shouldSplitPrefix(total, depth) {
  return total >= SEARCH_SPLIT_SENTINEL && depth < MAX_PREFIX_DEPTH;
}

function appendChildren(queue, prefix, depth) {
  for (let index = SEARCH_CHARS.length - 1; index >= 0; index -= 1) {
    queue.unshift({
      prefix: `${prefix}${SEARCH_CHARS[index]}`,
      depth: depth + 1,
    });
  }
}

async function mergeItems(
  seenIndex,
  catalogStore,
  state,
  files,
  minSize,
  maxSize,
  stats
) {
  const newItems = [];

  for (const file of files) {
    const normalized = normalizeFile(file);

    if (normalized) {
      stats.foundVideos += 1;
    }

    if (!normalized || normalized.size < minSize || normalized.size > maxSize) {
      continue;
    }

    stats.filteredVideos += 1;

    if (!(await seenIndex.addIfNew(normalized.id))) {
      stats.duplicateVideos += 1;
      continue;
    }

    newItems.push(normalized);
    stats.uniqueItems += 1;
  }

  if (newItems.length > 0) {
    await catalogStore.appendMany(newItems);
    state.uniqueItems += newItems.length;
  }

  return newItems.length;
}

async function fetchAllPagesForPrefix(
  client,
  session,
  seenIndex,
  catalogStore,
  state,
  prefixEntry,
  firstPage,
  config,
  logger,
  stats
) {
  let offset = 0;
  let addedForPrefix = 0;
  let page = firstPage;

  while (true) {
    if (offset > 0) {
      page = await retry(
        () =>
          fetchSearchPage(
            client,
            session,
            {
              prefix: prefixEntry.prefix,
              offset,
              limit: PAGE_LIMIT,
            },
            stats
          ),
        `search ${prefixEntry.prefix}* offset=${offset}`,
        logger
      );
    }

    if (page.files.length === 0) {
      break;
    }

    addedForPrefix += await mergeItems(
      seenIndex,
      catalogStore,
      state,
      page.files,
      config.minSize,
      config.maxSize,
      stats
    );

    logger.info(`Prefix ${prefixEntry.prefix}* stránka ${offset / PAGE_LIMIT}`, {
      files: page.files.length,
      totalHint: page.total,
      uniqueItems: state.uniqueItems,
      addedForPrefix,
      memory: getMemoryUsage(),
    });

    if (page.files.length < PAGE_LIMIT) {
      break;
    }

    offset += PAGE_LIMIT;
  }
}

async function processPrefix(
  client,
  session,
  seenIndex,
  catalogStore,
  state,
  config,
  logger,
  stats,
  prefixEntry,
  saveCheckpointQueued
) {
  try {
    const firstPage = await retry(
      () =>
        fetchSearchPage(
          client,
          session,
          {
            prefix: prefixEntry.prefix,
            offset: 0,
            limit: PAGE_LIMIT,
          },
          stats
        ),
      `search ${prefixEntry.prefix}* metadata`,
      logger
    );

    logger.info(`Analyzujem prefix ${prefixEntry.prefix}*`, {
      depth: prefixEntry.depth,
      totalHint: firstPage.total,
      firstPageCount: firstPage.files.length,
      queueLeft: state.queue.length,
      memory: getMemoryUsage(),
    });

    if (firstPage.total === 0 || firstPage.files.length === 0) {
      return;
    }

    if (shouldSplitPrefix(firstPage.total, prefixEntry.depth)) {
      appendChildren(state.queue, prefixEntry.prefix, prefixEntry.depth);
      logger.info(`Prefix ${prefixEntry.prefix}* delím ďalej.`, {
        childCount: SEARCH_CHARS.length,
        newQueueSize: state.queue.length,
      });
    } else {
      await fetchAllPagesForPrefix(
        client,
        session,
        seenIndex,
        catalogStore,
        state,
        prefixEntry,
        firstPage,
        config,
        logger,
        stats
      );
    }
  } catch (error) {
    const kind = classifyTemporarySearchError(error);

    if (!kind) {
      throw error;
    }

    logger.error(`Prefix ${prefixEntry.prefix}* zlyhal dočasnou chybou, preskakujem ho.`, {
      depth: prefixEntry.depth,
      kind,
      status: error?.response?.status || null,
      code: error?.code || null,
      error: error.message,
    });
    await recordFailedPrefix(
      config.failedPrefixesPath,
      prefixEntry,
      error,
      logger
    );
    logger.warn(`Prefix ${prefixEntry.prefix}* bol zapísaný do failed-prefixes.json.`, {
      kind,
    });
  } finally {
    state.processedPrefixes += 1;

    if (state.processedPrefixes % CHECKPOINT_SAVE_INTERVAL === 0) {
      await saveCheckpointQueued(state);
    }
  }
}

async function crawlPrefixes(
  client,
  session,
  seenIndex,
  catalogStore,
  state,
  config,
  logger,
  stats
) {
  const saveCheckpointQueued = createCheckpointSaver(config.checkpointPath);

  async function worker(workerId) {
    while (state.queue.length > 0) {
      const prefixEntry = state.queue.shift();

      if (!prefixEntry) {
        return;
      }

      logger.info(`Worker ${workerId} spracúva prefix ${prefixEntry.prefix}*`);
      await processPrefix(
        client,
        session,
        seenIndex,
        catalogStore,
        state,
        config,
        logger,
        stats,
        prefixEntry,
        saveCheckpointQueued
      );
    }
  }

  await Promise.all(
    Array.from({ length: PREFIX_CONCURRENCY }, (_, index) => worker(index + 1))
  );

  await catalogStore.flush();
  state.phase = "finalize";
  await saveCheckpointQueued(state);
}

async function prepareRuntime(config) {
  await fsPromises.mkdir(config.runtimeDir, { recursive: true });
  await ensureDirectory(config.outputPath);
}

async function cleanupIntermediateArtifacts(config, logger) {
  if (config.catalogRetainJsonl) {
    logger.info("Surový JSONL katalóg ponechávam pre SQLite import.", {
      catalogJsonlPath: config.catalogJsonlPath,
      catalogSourceManifestPath: config.catalogSourceManifestPath,
      catalogRetainJsonl: config.catalogRetainJsonl,
    });
  } else {
    await removePathIfExists(config.catalogJsonlPath);
  }
  await removePathIfExists(config.seenIndexDir);
  logger.info("Dočasný seen-idents index bol odstránený.");
}

async function writeCatalogSourceManifest(config, finalCount, logger) {
  const failedPrefixes = await loadFailedPrefixes(config.failedPrefixesPath, logger);
  const stat = await fsPromises.stat(config.catalogJsonlPath);
  const manifest = buildUnverifiedCrawlerManifest({
    inputPath: config.catalogJsonlPath,
    stat,
    items: finalCount,
    failedPrefixes: failedPrefixes.length,
  });
  await writeJsonAtomically(config.catalogSourceManifestPath, manifest);
  logger.warn(
    "Zapísaný manifest surového katalógu. Full reconciliation zostáva bezpečnostne zablokovaný.",
    manifest
  );
  return manifest;
}

async function writeHealthReport(config, report) {
  await writeJsonAtomically(config.healthPath, report);
}

function buildAuthenticatedRepoUrl(config, repoUrl) {
  if (!repoUrl) {
    return null;
  }

  if (!config.githubExportToken) {
    return repoUrl;
  }

  if (!repoUrl.startsWith("https://")) {
    return repoUrl;
  }

  const escapedToken = encodeURIComponent(config.githubExportToken);
  return repoUrl.replace("https://", `https://${escapedToken}@`);
}

async function getCurrentRepoRemoteUrl(config, logger) {
  if (config.githubExportRepoUrl) {
    return config.githubExportRepoUrl;
  }

  try {
    const { stdout } = await runGitCommand(["remote", "get-url", "origin"], {
      cwd: process.cwd(),
    });
    return stdout.trim();
  } catch (error) {
    logger.warn("Nepodarilo sa zistiť git remote origin.", {
      error: error.message,
    });
    return null;
  }
}

async function publishExportsToGithub(config, logger) {
  if (!config.githubExportEnabled) {
    logger.info("GitHub export je vypnutý.");
    return null;
  }

  const repoUrl = await getCurrentRepoRemoteUrl(config, logger);

  if (!repoUrl) {
    throw new Error(
      "GitHub export je zapnutý, ale chýba GITHUB_EXPORT_REPO_URL a nepodarilo sa zistiť origin."
    );
  }

  const authenticatedRepoUrl = buildAuthenticatedRepoUrl(config, repoUrl);
  const tempRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "webshare-export-")
  );
  const exportDir = path.join(tempRoot, "repo");
  const publishStats = {
    copiedFiles: 0,
    copiedBytes: 0,
    skippedFiles: [],
  };

  try {
    await fsPromises.mkdir(exportDir, { recursive: true });
    await runGitCommand(["init", "-b", config.githubExportBranch], {
      cwd: exportDir,
    });
    await runGitCommand(["config", "user.name", config.githubExportName], {
      cwd: exportDir,
    });
    await runGitCommand(["config", "user.email", config.githubExportEmail], {
      cwd: exportDir,
    });

    await copyFileForGithub(
      config.outputPath,
      path.join(exportDir, path.basename(config.outputPath)),
      logger,
      publishStats
    );
    await copyFileForGithub(
      `${config.outputPath}.gz`,
      path.join(exportDir, `${path.basename(config.outputPath)}.gz`),
      logger,
      publishStats
    );
    await copyFileForGithub(
      config.healthPath,
      path.join(exportDir, path.basename(config.healthPath)),
      logger,
      publishStats
    );
    await copyDirectoryForGithub(
      config.catalogOutputDir,
      path.join(exportDir, "catalog"),
      logger,
      publishStats
    );
    await fsPromises.writeFile(path.join(exportDir, ".nojekyll"), "", "utf8");

    await runGitCommand(["add", "."], { cwd: exportDir });
    await runGitCommand(
      [
        "commit",
        "-m",
        `Update Webshare export ${new Date().toISOString()}`,
      ],
      { cwd: exportDir }
    );
    await runGitCommand(["remote", "add", "origin", authenticatedRepoUrl], {
      cwd: exportDir,
    });
    await runGitCommand(
      ["push", "--force", "origin", `HEAD:${config.githubExportBranch}`],
      { cwd: exportDir }
    );

    logger.info("GitHub export branch bola úspešne aktualizovaná.", {
      branch: config.githubExportBranch,
      repoUrl,
      copiedFiles: publishStats.copiedFiles,
      copiedBytes: publishStats.copiedBytes,
      skippedFiles: publishStats.skippedFiles,
    });

    return {
      branch: config.githubExportBranch,
      repoUrl,
      copiedFiles: publishStats.copiedFiles,
      copiedBytes: publishStats.copiedBytes,
      skippedFiles: publishStats.skippedFiles,
    };
  } finally {
    await removePathIfExists(tempRoot);
  }
}

function buildClassificationSummary(exportResult) {
  const counts = exportResult?.categoryCounts || {};

  return {
    total: exportResult?.total || 0,
    movies: counts.movies || 0,
    series: counts.series || 0,
    documentaries: counts.documentaries || 0,
    concerts: counts.concerts || 0,
    sports: counts.sports || 0,
    kids: counts.kids || 0,
    musicVideos: counts["music-videos"] || 0,
    other: counts.other || 0,
    unknown: counts.unknown || 0,
    chunksCreated: exportResult?.chunksCreated || 0,
    invalidJsonLines: exportResult?.invalidJsonLines || 0,
    invalidItems: exportResult?.invalidItems || 0,
    durationSeconds: exportResult?.durationSeconds || 0,
  };
}

function buildSummary(stats, finalCount, exportResult = null) {
  return {
    found_videos: stats.foundVideos,
    videos_after_size_validation: stats.filteredVideos,
    size_filter: {
      min_bytes: MIN_VIDEO_SIZE,
      max_bytes: null,
    },
    duplicates_removed: stats.duplicateVideos,
    api_requests: stats.apiRequests,
    duration_seconds: getDurationSeconds(stats),
    final_videos: finalCount,
    catalog: exportResult
      ? {
          manifestPath: exportResult.manifestPath,
          chunkSize: exportResult.chunkSize,
          exportLegacyAll: exportResult.exportLegacyAll,
        }
      : null,
    classification: exportResult ? buildClassificationSummary(exportResult) : null,
    memory: getMemoryUsage(),
  };
}

async function runCatalogExport(config, logger, stats) {
  logger.info("Začínam lokálnu klasifikáciu a chunkovaný export katalógu.", {
    catalogJsonlPath: config.catalogJsonlPath,
    catalogOutputDir: config.catalogOutputDir,
    outputPath: config.outputPath,
    chunkSize: config.catalogChunkSize,
    exportLegacyAll: config.exportLegacyAll,
    memory: getMemoryUsage(),
  });

  const exportResult = await exportClassifiedCatalog({
    catalogJsonlPath: config.catalogJsonlPath,
    outputPath: config.outputPath,
    chunkSize: config.catalogChunkSize,
    exportLegacyAll: config.exportLegacyAll,
    logger,
    getMemoryUsage,
  });

  stats.invalidItems += exportResult.invalidItems + exportResult.invalidJsonLines;

  logger.info("Klasifikovaný katalóg bol úspešne exportovaný.", {
    phase: "done",
    ...buildClassificationSummary(exportResult),
    manifestPath: exportResult.manifestPath,
    memory: getMemoryUsage(),
  });

  return exportResult;
}

async function crawlAllVideos(config, logger, stats) {
  await prepareRuntime(config);

  const client = createApiClient();
  const session = new WebshareSession(config, logger);
  const catalogStore = new CatalogStore(config.catalogJsonlPath);
  const seenIndex = new SeenIdentIndex(config.seenIndexDir, logger);
  const state = await loadCheckpointState(config, logger);

  await catalogStore.init();
  await seenIndex.init();

  if (state.phase === "crawl") {
    logger.info("Začínam crawl fázu.");
    await crawlPrefixes(
      client,
      session,
      seenIndex,
      catalogStore,
      state,
      config,
      logger,
      stats
    );
  }

  logger.info("Začínam finalize fázu zo streamovaného JSONL katalógu.");
  await writeHealthReport(
    config,
    buildHealthReport({
      success: null,
      videos: state.uniqueItems || stats.uniqueItems,
      durationSeconds: getDurationSeconds(stats),
      phase: "classify",
      runStatus: RUN_STATUSES.INCOMPLETE,
    })
  );
  const exportResult = await runCatalogExport(config, logger, stats);
  const finalCount = exportResult.total;
  const catalogSourceManifest = await writeCatalogSourceManifest(config, finalCount, logger);

  await writeHealthReport(
    config,
    buildHealthReport({
      success: true,
      videos: finalCount,
      durationSeconds: getDurationSeconds(stats),
      phase: "done",
      runStatus: catalogSourceManifest.run_status,
      catalog: {
        manifestPath: exportResult.manifestPath,
        chunkSize: exportResult.chunkSize,
        exportLegacyAll: exportResult.exportLegacyAll,
      },
      classification: buildClassificationSummary(exportResult),
    })
  );
  const githubExport = await publishExportsToGithub(config, logger);
  await clearCheckpoint(config.checkpointPath, logger);
  await cleanupIntermediateArtifacts(config, logger);

  return {
    count: finalCount,
    outputPath: config.outputPath,
    catalogManifestPath: exportResult.manifestPath,
    logPath: config.logPath,
    healthPath: config.healthPath,
    githubExport,
    catalogSourceManifest,
    summary: buildSummary(stats, finalCount, exportResult),
  };
}

async function exportExistingCatalogOnly(config, logger, stats) {
  await prepareRuntime(config);

  if (!(await pathExists(config.catalogJsonlPath))) {
    throw new Error(
      `Chýba ${config.catalogJsonlPath}. Klasifikáciu bez crawlu možno spustiť iba nad existujúcim catalog-items.jsonl.`
    );
  }

  await writeHealthReport(
    config,
    buildHealthReport({
      success: null,
      videos: 0,
      durationSeconds: getDurationSeconds(stats),
      phase: "classify",
      operation: "export_only",
    })
  );

  const exportResult = await runCatalogExport(config, logger, stats);
  const finalCount = exportResult.total;

  await writeHealthReport(
    config,
    buildHealthReport({
      success: true,
      videos: finalCount,
      durationSeconds: getDurationSeconds(stats),
      phase: "done",
      operation: "export_only",
      catalog: {
        manifestPath: exportResult.manifestPath,
        chunkSize: exportResult.chunkSize,
        exportLegacyAll: exportResult.exportLegacyAll,
      },
      classification: buildClassificationSummary(exportResult),
    })
  );

  const githubExport = await publishExportsToGithub(config, logger);

  return {
    count: finalCount,
    outputPath: config.outputPath,
    catalogManifestPath: exportResult.manifestPath,
    logPath: config.logPath,
    healthPath: config.healthPath,
    githubExport,
    summary: buildSummary(stats, finalCount, exportResult),
  };
}

async function resolveIdentToStreamUrl(ident, options = {}) {
  const config = options.config || getConfig();
  const logger = options.logger || createNoopLogger();
  const stats = options.stats || null;

  await prepareRuntime(config);

  const cache = await loadResolverCache(config.resolverCachePath, logger);
  const cachedUrl = getCachedResolvedUrl(cache, ident);

  if (cachedUrl) {
    logger.info(`Resolver cache hit pre ${ident}.`);
    return cachedUrl;
  }

  const client = createApiClient();
  const session = new WebshareSession(config, logger);
  const resolvedUrl = await session.withWst((wst) =>
    resolveFileLink(client, ident, wst, logger, stats)
  );

  if (!resolvedUrl) {
    throw new Error(`Pre ${ident} sa nepodarilo získať stream URL.`);
  }

  setCachedResolvedUrl(cache, ident, resolvedUrl);
  await saveResolverCache(config.resolverCachePath, cache);

  return resolvedUrl;
}

function createWebshareResolver(options = {}) {
  return {
    async resolve(ident) {
      return resolveIdentToStreamUrl(ident, options);
    },
  };
}

const MAIN_COMMANDS = new Map([
  ["--crawl", "crawl"],
  ["--shadow-crawl", "shadow-crawl"],
  ["--resume", "resume"],
  ["--retry-failed", "retry-failed"],
  ["--status", "status"],
  ["--validate-crawl", "validate"],
  ["--classify-only", "classify-only"],
]);
const SHADOW_VALUE_OPTIONS = new Map([
  ["--shadow-dir", "shadowDir"],
  ["--shadow-root-prefix", "shadowRootPrefix"],
  ["--shadow-root-prefixes", "shadowRootPrefixes"],
  ["--max-prefixes", "maxPrefixes"],
  ["--max-pages", "maxPages"],
  ["--max-items", "maxItems"],
  ["--max-requests", "maxRequests"],
  ["--max-duration-minutes", "maxDurationMinutes"],
  ["--max-disk-bytes", "maxDiskBytes"],
  ["--concurrency", "concurrency"],
  ["--page-size", "pageSize"],
]);
const SHADOW_BOOLEAN_OPTIONS = new Map([
  ["--resume-shadow-limited", "resumeShadowLimited"],
]);
const SHADOW_FORBIDDEN_OPTIONS = new Set([
  "--confirmed-full",
  "--import",
  "--publish",
  "--allow-deactivation",
]);

function mainUsage() {
  return [
    "Použitie:",
    "  node main.js --crawl",
    "  node main.js --shadow-crawl [--shadow-dir PATH] [bounded limits]",
    "  node main.js --resume",
    "  node main.js --retry-failed",
    "  node main.js --status [--shadow-dir PATH]",
    "  node main.js --validate-crawl [--shadow-dir PATH]",
    "  node main.js --classify-only",
  ].join("\n");
}

function parseMainCommand(args) {
  if (args.length === 1 && args[0] === "--help") {
    return { command: "help" };
  }
  if (args.length === 0) {
    return { error: "Crawler vyžaduje explicitný režim." };
  }
  const commandArguments = args.filter((argument) =>
    MAIN_COMMANDS.has(argument)
  );
  if (commandArguments.length === 0) {
    return { error: `Neznámy argument: ${args.join(", ")}` };
  }
  if (commandArguments.length > 1) {
    return { error: "Použi presne jeden crawler režim." };
  }
  const command = MAIN_COMMANDS.get(commandArguments[0]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (MAIN_COMMANDS.has(argument)) continue;
    if (SHADOW_FORBIDDEN_OPTIONS.has(argument)) {
      return {
        error: `Shadow režim nepodporuje nebezpečný argument: ${argument}`,
      };
    }
    if (SHADOW_BOOLEAN_OPTIONS.has(argument)) {
      const booleanName = SHADOW_BOOLEAN_OPTIONS.get(argument);
      if (Object.hasOwn(options, booleanName)) {
        return { error: `Argument ${argument} bol zadaný viackrát.` };
      }
      options[booleanName] = true;
      continue;
    }
    const optionName = SHADOW_VALUE_OPTIONS.get(argument);
    if (!optionName) {
      return { error: `Neznámy argument: ${argument}` };
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return { error: `Argument ${argument} vyžaduje hodnotu.` };
    }
    if (Object.hasOwn(options, optionName)) {
      return { error: `Argument ${argument} bol zadaný viackrát.` };
    }
    options[optionName] = value;
    index += 1;
  }
  const hasShadowOptions =
    Object.keys(options).length > 0 || command === "shadow-crawl";
  const shadowMode =
    command === "shadow-crawl" ||
    (["status", "resume", "retry-failed", "validate"].includes(command) &&
      Boolean(options.shadowDir));
  if (options.shadowRootPrefix && options.shadowRootPrefixes) {
    return {
      error: "Použi iba jeden z --shadow-root-prefix a --shadow-root-prefixes.",
    };
  }
  if (hasShadowOptions && !shadowMode) {
    return {
      error:
        "Shadow parametre vyžadujú --shadow-crawl alebo read-only/resume režim s --shadow-dir.",
    };
  }
  if (options.resumeShadowLimited && command !== "resume") {
    return {
      error: "--resume-shadow-limited je platný iba s --resume --shadow-dir.",
    };
  }
  return { command, options, shadowMode };
}

function shadowCliOptions(parsedCommand, previousReport = null) {
  const source = parsedCommand.options || {};
  const integerFields = [
    "maxPrefixes",
    "maxPages",
    "maxItems",
    "maxRequests",
    "maxDurationMinutes",
    "maxDiskBytes",
    "concurrency",
    "pageSize",
  ];
  const limits = {};
  for (const field of integerFields) {
    const value =
      source[field] === undefined
        ? previousReport?.shadow_limits?.[field]
        : parseStrictPositiveInteger(source[field], `--${field}`);
    if (value !== undefined) limits[field] = value;
  }
  const rootsValue =
    source.shadowRootPrefixes || source.shadowRootPrefix || null;
  const rootPrefixes = rootsValue
    ? String(rootsValue)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : previousReport?.root_prefixes;
  return {
    shadowDir: source.shadowDir,
    limits,
    rootPrefixes,
  };
}

function parseStrictPositiveInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${label} musí byť kladné celé číslo.`);
    }
    return value;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(
      `${label} musí byť desiatkové kladné celé číslo bez exponentu.`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${label} prekračuje bezpečný integer rozsah.`);
  }
  return parsed;
}

async function main() {
  const parsedCommand = parseMainCommand(process.argv.slice(2));
  if (parsedCommand.error) {
    console.error(`${parsedCommand.error}\n${mainUsage()}`);
    process.exitCode = 2;
    return;
  }
  if (parsedCommand.command === "help") {
    console.log(mainUsage());
    return;
  }

  const command = parsedCommand.command;
  if (parsedCommand.shadowMode) {
    let logger = null;
    try {
      let previousReport = null;
      if (["resume", "retry-failed", "status", "validate"].includes(command)) {
        const preliminaryConfig = createShadowConfig({
          shadowDir: parsedCommand.options.shadowDir,
        });
        previousReport = readShadowReport(preliminaryConfig.paths.report);
      }
      const shadowConfig = createShadowConfig(
        shadowCliOptions(parsedCommand, previousReport)
      );
      if (command === "status") {
        console.log(
          JSON.stringify(inspectShadowState({ shadowConfig }), null, 2)
        );
        return;
      }
      if (command === "validate") {
        console.log(
          JSON.stringify(validateShadowState({ shadowConfig }), null, 2)
        );
        return;
      }
      const shadowPathGuard = prepareShadowRoot(shadowConfig);
      logger = createLogger(shadowConfig.paths.log, {
        maxBytes: Math.min(
          4 * 1024 * 1024,
          Math.floor(shadowConfig.limits.maxDiskBytes / 100)
        ),
        secrets: [
          process.env.WEBSHARE_PASSWORD,
          process.env.WEBSHARE_USERNAME,
        ],
        pathGuard: shadowPathGuard,
      });
      const legacyConfig = getConfig();
      const stats = createRunStats();
      const result = await executeShadowCrawler({
        command: command === "shadow-crawl" ? "crawl" : command,
        shadowConfig,
        logger,
        resumeShadowLimited:
          parsedCommand.options.resumeShadowLimited === true,
        normalizeItem: normalizeFile,
        transportFactory: async ({ requestMeter }) => {
          const client = createApiClient();
          const session = new WebshareSession(legacyConfig, logger, {
            requestMeter,
          });
          return createWebshareSearchTransport({
            client,
            session,
            fetchSearchPage,
            stats,
            algorithm: shadowConfig.crawler.algorithm,
            requestMeter,
          });
        },
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        sanitizeLogValue(
          `Shadow crawler príkaz zlyhal${error.code ? ` [${error.code}]` : ""}: ${error.message}`,
          [process.env.WEBSHARE_PASSWORD, process.env.WEBSHARE_USERNAME]
        )
      );
      process.exitCode = 1;
    } finally {
      await logger?.close();
    }
    return;
  }
  if (["crawl", "resume", "retry-failed", "status", "validate"].includes(command)) {
    const config = getCrawlerV2Config();
    let logger = null;
    try {
      if (command === "status") {
        console.log(JSON.stringify(inspectCrawlerState({ config }), null, 2));
        return;
      }
      if (command === "validate") {
        console.log(JSON.stringify(validateCrawlerState({ config }), null, 2));
        return;
      }
      if (
        ["resume", "retry-failed"].includes(command) &&
        !fs.existsSync(config.stateDbPath)
      ) {
        throw new Error(`Crawler state DB neexistuje: ${config.stateDbPath}`);
      }
      const legacyConfig = getConfig();
      await prepareRuntime(legacyConfig);
      logger = createLogger(legacyConfig.logPath);
      const stats = createRunStats();
      const client = createApiClient();
      const session = new WebshareSession(legacyConfig, logger);
      const transport = createWebshareSearchTransport({
        client,
        session,
        fetchSearchPage,
        stats,
        algorithm: config.algorithm,
      });
      const result = await executeCrawler({
        command,
        config,
        transport,
        normalizeItem: normalizeFile,
        exportJsonl: true,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        `Crawler v2 príkaz zlyhal${error.code ? ` [${error.code}]` : ""}: ${error.message}`
      );
      process.exitCode = 1;
    } finally {
      await logger?.close();
    }
    return;
  }

  const classifyOnly = command === "classify-only";
  const config = getConfig({ requireCredentials: !classifyOnly });
  await prepareRuntime(config);
  const logger = createLogger(config.logPath);
  const stats = createRunStats();
  let lockAcquired = false;

  try {
    await acquireLock(config.lockPath, logger);
    lockAcquired = true;
    logger.info("Štartujem Webshare crawler.", {
      outputPath: config.outputPath,
      checkpointPath: config.checkpointPath,
      logPath: config.logPath,
      healthPath: config.healthPath,
      catalogJsonlPath: config.catalogJsonlPath,
      catalogSourceManifestPath: config.catalogSourceManifestPath,
      catalogRetainJsonl: config.catalogRetainJsonl,
      seenIndexDir: config.seenIndexDir,
      catalogOutputDir: config.catalogOutputDir,
      catalogChunkSize: config.catalogChunkSize,
      exportLegacyAll: config.exportLegacyAll,
      mode: classifyOnly ? "classify-only" : "crawl",
    });

    const result = classifyOnly
      ? await exportExistingCatalogOnly(config, logger, stats)
      : await crawlAllVideos(config, logger, stats);
    logger.info("Hotovo.", result);
    logger.info("Štatistiky behu.", result.summary);
  } catch (error) {
    logger.error("Crawler spadol.", {
      message: error.message,
      stack: error.stack,
      code: error.code || null,
      memory: getMemoryUsage(),
    });
    await writeHealthReport(
      config,
      buildHealthReport({
        success: false,
        videos: 0,
        durationSeconds: getDurationSeconds(stats),
        phase: "failed",
        runStatus: classifyOnly ? null : RUN_STATUSES.ABORTED,
        operation: classifyOnly ? "export_only" : "crawl",
      })
    );
    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      await releaseLock(config.lockPath, logger);
    }
    await logger.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  WebshareSession,
  createLogger,
  loginAndGetWst,
  createApiClient,
  createWebshareResolver,
  fetchSearchPage,
  getConfig,
  mainUsage,
  normalizeFile,
  parseMainCommand,
  parseStrictPositiveInteger,
  sanitizeLogValue,
  shadowCliOptions,
  publishExportsToGithub,
  resolveIdentToStreamUrl,
};
