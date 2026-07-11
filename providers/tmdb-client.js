const crypto = require("crypto");
const axios = require("axios");
const { nowIso } = require("../src/db/catalog-db");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cacheKey(endpoint, language, params) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ endpoint, language, params }))
    .digest("hex");
}

function isTemporaryError(error) {
  const status = error.response?.status;
  return status === 429 || status >= 500 || ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(error.code);
}

class TmdbClient {
  constructor(config, database, logger = console) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.client = axios.create({
      baseURL: TMDB_BASE_URL,
      timeout: 20000,
      headers: { Accept: "application/json", "User-Agent": "Webshare Media Server/1.0" },
    });
    this.getCache = database.prepare("SELECT * FROM metadata_cache WHERE cache_key = ? AND expires_at > ?");
    this.putCache = database.prepare(`
      INSERT INTO metadata_cache(
        cache_key, provider, endpoint, language, response_json, http_status,
        expires_at, created_at, updated_at
      ) VALUES (?, 'tmdb', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        http_status = excluded.http_status,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
  }

  enabled() {
    return Boolean(this.config.tmdbApiKey);
  }

  async request(endpoint, params = {}, language = this.config.tmdbLanguage) {
    const requestParams = { ...params, language };
    const key = cacheKey(endpoint, language, requestParams);
    const cached = this.getCache.get(key, nowIso());
    if (cached) {
      return JSON.parse(cached.response_json);
    }

    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        if (this.config.tmdbRequestDelayMs > 0) {
          await sleep(this.config.tmdbRequestDelayMs);
        }
        const response = await this.client.get(endpoint, {
          params: { ...requestParams, api_key: this.config.tmdbApiKey },
        });
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.config.tmdbCacheTtlDays * 86400000).toISOString();
        this.putCache.run(
          key,
          endpoint,
          language,
          JSON.stringify(response.data),
          response.status,
          expiresAt,
          now.toISOString(),
          now.toISOString()
        );
        return response.data;
      } catch (error) {
        lastError = error;
        if (!isTemporaryError(error) || attempt === 5) throw error;
        const retryAfterSeconds = Number.parseInt(error.response?.headers?.["retry-after"], 10);
        const delay = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(30000, 500 * 2 ** (attempt - 1));
        this.logger.warn?.(`TMDb request zlyhal, retry ${attempt}/5 za ${delay} ms.`, {
          endpoint,
          status: error.response?.status || null,
          code: error.code || null,
        });
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async search(candidate, type) {
    const endpoint = type === "tv" ? "/search/tv" : "/search/movie";
    const yearKey = type === "tv" ? "first_air_date_year" : "year";
    const params = { query: candidate.title, include_adult: false };
    if (candidate.parsedYear) params[yearKey] = candidate.parsedYear;
    const languages = [this.config.tmdbLanguage, ...this.config.tmdbFallbackLanguages]
      .filter((value, index, list) => value && list.indexOf(value) === index);
    const combined = new Map();
    for (const language of languages) {
      const response = await this.request(endpoint, params, language);
      for (const result of response.results || []) {
        combined.set(String(result.id), result);
      }
      if (combined.size >= 10) break;
    }
    return [...combined.values()];
  }

  async details(type, id) {
    const endpoint = type === "tv" ? `/tv/${id}` : `/movie/${id}`;
    return this.request(endpoint, { append_to_response: "credits,alternative_titles" });
  }
}

module.exports = {
  TmdbClient,
  cacheKey,
  isTemporaryError,
};
