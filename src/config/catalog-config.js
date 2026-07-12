const path = require("path");

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsv(value, fallback = []) {
  const source = value === undefined || value === null || value === "" ? fallback : value;
  const values = Array.isArray(source) ? source : String(source).split(",");
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function getCatalogConfig(env = process.env) {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const runtimeDir = path.resolve(env.RUNTIME_DIR || path.join(projectRoot, "runtime"));
  const databasePath = path.resolve(
    env.CATALOG_DB_PATH || path.join(projectRoot, "data", "catalog.sqlite")
  );

  return {
    projectRoot,
    runtimeDir,
    databasePath,
    migrationsDir: path.resolve(env.CATALOG_MIGRATIONS_DIR || path.join(projectRoot, "migrations")),
    importBatchSize: parsePositiveInteger(env.CATALOG_IMPORT_BATCH_SIZE, 1000),
    apiHost: env.CATALOG_API_HOST || "127.0.0.1",
    apiPort: parsePositiveInteger(env.CATALOG_API_PORT, 8787),
    apiBasePath: `/${String(env.CATALOG_API_BASE_PATH || "api").replace(/^\/+|\/+$/g, "")}`,
    apiMaxPageSize: parsePositiveInteger(env.CATALOG_API_MAX_PAGE_SIZE, 100),
    tmdbApiKey: env.TMDB_API_KEY || "",
    tmdbLanguage: env.TMDB_LANGUAGE || "sk-SK",
    tmdbFallbackLanguages: parseCsv(env.TMDB_FALLBACK_LANGUAGES, ["cs-CZ", "en-US"]),
    tmdbMaxConcurrency: parsePositiveInteger(env.TMDB_MAX_CONCURRENCY, 2),
    tmdbRequestDelayMs: parsePositiveInteger(env.TMDB_REQUEST_DELAY_MS, 300),
    tmdbCacheTtlDays: parsePositiveInteger(env.TMDB_CACHE_TTL_DAYS, 30),
    tmdbLiveRequestTimeoutMs: parsePositiveInteger(env.TMDB_LIVE_REQUEST_TIMEOUT_MS, 2500),
    tmdbLiveTotalTimeoutMs: parsePositiveInteger(env.TMDB_LIVE_TOTAL_TIMEOUT_MS, 5000),
    tmdbLiveCacheTtlHours: parsePositiveInteger(env.TMDB_LIVE_CACHE_TTL_HOURS, 6),
    tmdbLiveStaleTtlHours: parsePositiveInteger(env.TMDB_LIVE_STALE_TTL_HOURS, 168),
    tmdbLiveErrorTtlMinutes: parsePositiveInteger(env.TMDB_LIVE_ERROR_TTL_MINUTES, 5),
    tmdbLiveRateLimitPerMinute: parsePositiveInteger(env.TMDB_LIVE_RATE_LIMIT_PER_MINUTE, 30),
    metadataAutoMatchThreshold: parseNumber(env.METADATA_AUTO_MATCH_THRESHOLD, 0.9),
    metadataAmbiguousThreshold: parseNumber(env.METADATA_AMBIGUOUS_THRESHOLD, 0.72),
  };
}

module.exports = {
  getCatalogConfig,
  parseCsv,
  parseNumber,
  parsePositiveInteger,
};
