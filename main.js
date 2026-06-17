const axios = require("axios");
const crypto = require("crypto");
const { execFile } = require("child_process");
const fs = require("fs");
const fsPromises = fs.promises;
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const readline = require("readline");
const util = require("util");
const { parseStringPromise } = require("xml2js");
const zlib = require("zlib");

const execFileAsync = util.promisify(execFile);

const BASE_URL = "https://webshare.cz";
const LOGIN_URL = `${BASE_URL}/`;
const SEARCH_URL = `${BASE_URL}/api/search/`;
const FILE_LINK_URL = `${BASE_URL}/api/file_link/`;
const SEARCH_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const MIN_VIDEO_SIZE = 1610612736;
const MAX_VIDEO_SIZE = 10737418240;
const PAGE_LIMIT = 100;
const SEARCH_SPLIT_SENTINEL = 1000;
const MAX_PREFIX_DEPTH = 5;
const REQUEST_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 45000;
const RETRY_COUNT = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;
const DEFAULT_OUTPUT_PATH = "/var/www/html/videos_all.json";
const CHECKPOINT_SAVE_INTERVAL = 10;
const PREFIX_CONCURRENCY = 3;
const FILE_LINK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SEEN_BUCKET_CACHE_LIMIT = 16;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class WebshareApiError extends Error {
  constructor(endpoint, code, message, status) {
    super(`${endpoint} failed: ${message || "Unknown error"}`);
    this.name = "WebshareApiError";
    this.endpoint = endpoint;
    this.code = code || null;
    this.status = status || null;
  }
}

function getConfig() {
  const username = process.env.WEBSHARE_USERNAME;
  const password = process.env.WEBSHARE_PASSWORD;
  const outputPath = process.env.OUTPUT_JSON_PATH || DEFAULT_OUTPUT_PATH;
  const githubExportEnabled = process.env.GITHUB_EXPORT_ENABLED === "true";
  const githubExportBranch = process.env.GITHUB_EXPORT_BRANCH || "data";
  const githubExportRepoUrl = process.env.GITHUB_EXPORT_REPO_URL || null;
  const githubExportToken = process.env.GITHUB_EXPORT_TOKEN || null;
  const githubExportName =
    process.env.GITHUB_EXPORT_NAME || "webshare-crawler-bot";
  const githubExportEmail =
    process.env.GITHUB_EXPORT_EMAIL || "webshare-crawler@example.invalid";

  if (!username || !password) {
    throw new Error("Chýba WEBSHARE_USERNAME alebo WEBSHARE_PASSWORD.");
  }

  const runtimeDir = path.resolve(process.cwd(), "runtime");

  return {
    username,
    password,
    outputPath,
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

function createLogger(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  function write(level, message, extra) {
    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${level}] ${message}`;
    const suffix =
      extra === undefined ? "" : ` ${JSON.stringify(extra, null, 2)}`;
    const line = `${base}${suffix}`;

    console.log(line);
    stream.write(`${line}\n`);
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
      await new Promise((resolve) => stream.end(resolve));
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

function normalizeFile(file) {
  const ident = file.ident?.[0];
  const name = file.name?.[0] || "";
  const size = Number.parseInt(file.size?.[0] || "0", 10);
  const extension = path.extname(name).replace(/^\./, "").toLowerCase() || null;

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
    mime: file.mime?.[0] || null,
    type: file.type?.[0] || "video",
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

async function writeToStream(stream, chunk) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };

    stream.on("error", onError);

    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.on("drain", onDrain);
    }
  });
}

async function closeWritableStream(stream) {
  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
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

function isValidFinalItem(item) {
  return Boolean(
    item &&
      item.id &&
      item.name &&
      Number.isFinite(item.size) &&
      item.size > 0 &&
      (item.url || item.direct_url)
  );
}

function buildHealthReport({ success, videos, durationSeconds }) {
  return {
    success,
    generated_at: new Date().toISOString(),
    videos,
    duration_seconds: durationSeconds,
    memory: getMemoryUsage(),
  };
}

async function loginAndGetWst({ username, password }) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(LOGIN_URL, {
      waitUntil: "networkidle2",
      timeout: LOGIN_TIMEOUT_MS,
    });

    await page.click("a.login");
    await page.waitForSelector('input[name="username"]', {
      timeout: LOGIN_TIMEOUT_MS,
    });
    await page.type('input[name="username"]', username, { delay: 20 });
    await page.type('input[name="password"]', password, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: LOGIN_TIMEOUT_MS,
      }).catch(() => null),
      page.click('input.ws-small-button.green.ws-margin-bottom-10[type="submit"]'),
    ]);

    await sleep(1500);

    const cookies = await page.cookies();
    const wstCookie = cookies.find((cookie) => cookie.name === "wst");

    if (!wstCookie?.value) {
      throw new Error("Cookie wst po prihlásení nebola nájdená.");
    }

    return wstCookie.value;
  } finally {
    await browser.close();
  }
}

class WebshareSession {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.cachedWst = null;
  }

  invalidate() {
    this.cachedWst = null;
  }

  async getWst(forceRefresh = false) {
    if (!forceRefresh && this.cachedWst) {
      return this.cachedWst;
    }

    this.logger.info("Obnovujem WST token.");
    this.cachedWst = await retry(
      () =>
        loginAndGetWst({
          username: this.config.username,
          password: this.config.password,
        }),
      "Puppeteer login",
      this.logger
    );
    return this.cachedWst;
  }

  async withWst(task) {
    let refreshed = false;

    while (true) {
      const wst = await this.getWst(refreshed);

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

async function postXml(client, url, params, endpointName, stats) {
  if (stats) {
    stats.apiRequests += 1;
  }

  const response = await client.post(url, params.toString());
  const parsed = await parseStringPromise(response.data, {
    explicitArray: true,
    trim: true,
  });

  return parseStatus(parsed, endpointName);
}

async function fetchSearchPage(client, session, { prefix, offset, limit }, stats) {
  return session.withWst(async (wst) => {
    const params = new URLSearchParams({
      what: `${prefix}*`,
      limit: String(limit),
      offset: String(offset),
      sort: "recent",
      category: "video",
      wst,
    });

    const response = await postXml(client, SEARCH_URL, params, "search", stats);

    return {
      total: Number.parseInt(response.total?.[0] || "0", 10),
      files: Array.isArray(response.file) ? response.file : [],
    };
  });
}

async function resolveFileLink(client, ident, logger, stats) {
  return retry(
    async () => {
      const params = new URLSearchParams({
        ident,
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

async function streamCatalogToOutput(catalogJsonlPath, outputPath, stats) {
  const jsonTempPath = `${outputPath}.tmp`;
  const gzipOutputPath = `${outputPath}.gz`;
  const gzipTempPath = `${gzipOutputPath}.tmp`;

  await ensureDirectory(outputPath);
  await ensureDirectory(gzipOutputPath);

  const jsonStream = fs.createWriteStream(jsonTempPath, { encoding: "utf8" });
  const gzipStream = zlib.createGzip();
  const gzipFileStream = fs.createWriteStream(gzipTempPath);
  gzipStream.pipe(gzipFileStream);

  const input = readline.createInterface({
    input: fs.createReadStream(catalogJsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let validCount = 0;

  await writeToStream(jsonStream, "[\n");
  await writeToStream(gzipStream, "[\n");

  for await (const line of input) {
    if (!line.trim()) {
      continue;
    }

    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      stats.invalidItems += 1;
      continue;
    }

    if (!isValidFinalItem(item)) {
      stats.invalidItems += 1;
      continue;
    }

    const prefix = validCount === 0 ? "  " : ",\n  ";
    const chunk = `${prefix}${JSON.stringify(item)}`;
    await writeToStream(jsonStream, chunk);
    await writeToStream(gzipStream, chunk);
    validCount += 1;
  }

  await writeToStream(jsonStream, "\n]\n");
  await writeToStream(gzipStream, "\n]\n");
  await closeWritableStream(jsonStream);
  await closeWritableStream(gzipStream);
  await closeWritableStream(gzipFileStream);

  await fsPromises.rename(jsonTempPath, outputPath);
  await fsPromises.rename(gzipTempPath, gzipOutputPath);

  return validCount;
}

async function prepareRuntime(config) {
  await fsPromises.mkdir(config.runtimeDir, { recursive: true });
  await ensureDirectory(config.outputPath);
}

async function cleanupIntermediateArtifacts(config, logger) {
  await removePathIfExists(config.catalogJsonlPath);
  await removePathIfExists(config.seenIndexDir);
  logger.info("Dočasné crawl artefakty boli odstránené.");
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

    await copyFile(
      config.outputPath,
      path.join(exportDir, path.basename(config.outputPath))
    );
    await copyFile(
      `${config.outputPath}.gz`,
      path.join(exportDir, `${path.basename(config.outputPath)}.gz`)
    );
    await copyFile(
      config.healthPath,
      path.join(exportDir, path.basename(config.healthPath))
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
    });

    return {
      branch: config.githubExportBranch,
      repoUrl,
    };
  } finally {
    await removePathIfExists(tempRoot);
  }
}

function buildSummary(stats, finalCount) {
  return {
    found_videos: stats.foundVideos,
    filtered_videos_1_5gb_to_10gb: stats.filteredVideos,
    duplicates_removed: stats.duplicateVideos,
    api_requests: stats.apiRequests,
    duration_seconds: getDurationSeconds(stats),
    final_videos: finalCount,
    memory: getMemoryUsage(),
  };
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
  const finalCount = await streamCatalogToOutput(
    config.catalogJsonlPath,
    config.outputPath,
    stats
  );

  await writeHealthReport(
    config,
    buildHealthReport({
      success: true,
      videos: finalCount,
      durationSeconds: getDurationSeconds(stats),
    })
  );
  const githubExport = await publishExportsToGithub(config, logger);
  await clearCheckpoint(config.checkpointPath, logger);
  await cleanupIntermediateArtifacts(config, logger);

  return {
    count: finalCount,
    outputPath: config.outputPath,
    logPath: config.logPath,
    healthPath: config.healthPath,
    githubExport,
    summary: buildSummary(stats, finalCount),
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
  const resolvedUrl = await session.withWst(() =>
    resolveFileLink(client, ident, logger, stats)
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

async function main() {
  const config = getConfig();
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
      seenIndexDir: config.seenIndexDir,
    });

    const result = await crawlAllVideos(config, logger, stats);
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
  createWebshareResolver,
  getConfig,
  resolveIdentToStreamUrl,
};
