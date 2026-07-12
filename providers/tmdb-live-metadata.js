const crypto = require("crypto");
const axios = require("axios");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

function addMilliseconds(isoValue, milliseconds) {
  return new Date(new Date(isoValue).getTime() + milliseconds).toISOString();
}

function cacheKey(media, languages) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      source: media.external_source,
      id: String(media.external_id),
      type: media.media_type,
      languages,
    }))
    .digest("hex");
}

function imageUrl(path, size) {
  return path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : null;
}

function unavailable(media, reason, options = {}) {
  return {
    available: false,
    metadataAvailable: false,
    source: media.external_source || null,
    externalId: media.external_id ? String(media.external_id) : null,
    overview: null,
    posterUrl: null,
    backdropUrl: null,
    genres: [],
    runtimeMinutes: null,
    rating: null,
    message: "Popis nie je k dispozícii.",
    reason,
    cached: Boolean(options.cached),
    stale: Boolean(options.stale),
  };
}

function mergeDetails(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const result = { ...primary };
  for (const key of ["overview", "poster_path", "backdrop_path", "runtime", "vote_average", "genres"]) {
    if ((!result[key] || (Array.isArray(result[key]) && result[key].length === 0)) && fallback[key]) {
      result[key] = fallback[key];
    }
  }
  return result;
}

function serializeDetails(media, details, language) {
  const genres = (details.genres || []).map((item) => item?.name).filter(Boolean);
  const overview = String(details.overview || "").trim() || null;
  const posterUrl = imageUrl(details.poster_path, "w500");
  const backdropUrl = imageUrl(details.backdrop_path, "w1280");
  const available = Boolean(overview || posterUrl || backdropUrl || genres.length || details.runtime || details.vote_average);
  return {
    available,
    metadataAvailable: available,
    source: "tmdb",
    externalId: String(media.external_id),
    externalUrl: media.external_url || `https://www.themoviedb.org/${media.media_type === "tv" ? "tv" : "movie"}/${media.external_id}`,
    overview,
    posterUrl,
    backdropUrl,
    genres,
    runtimeMinutes: Number.isFinite(Number(details.runtime)) && Number(details.runtime) > 0 ? Number(details.runtime) : null,
    rating: Number.isFinite(Number(details.vote_average)) && Number(details.vote_average) > 0 ? Number(details.vote_average) : null,
    language,
    message: overview ? null : "Popis nie je k dispozícii.",
    cached: false,
    stale: false,
  };
}

function errorKind(error) {
  const status = error.response?.status;
  if (status === 404) return "not_found";
  if (status === 429) return "http_429";
  if (status >= 500) return `http_${status}`;
  return error.code || "request_failed";
}

class TmdbLiveMetadata {
  constructor(config, database, logger = console) {
    this.config = config;
    this.logger = logger;
    this.client = axios.create({
      baseURL: TMDB_BASE_URL,
      timeout: config.tmdbLiveRequestTimeoutMs,
      headers: { Accept: "application/json", "User-Agent": "Webshare Media Server/1.0" },
    });
    this.getCache = database.prepare("SELECT * FROM metadata_live_cache WHERE cache_key = ?");
    this.putCache = database.prepare(`
      INSERT INTO metadata_live_cache(
        cache_key, external_source, external_id, media_type, language, payload_json,
        status, error_code, fetched_at, expires_at, stale_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        status = excluded.status,
        error_code = excluded.error_code,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at,
        stale_until = excluded.stale_until
    `);
  }

  languages() {
    return [this.config.tmdbLanguage, ...this.config.tmdbFallbackLanguages]
      .filter((value, index, values) => value && values.indexOf(value) === index);
  }

  writeCache(key, media, languages, payload, status, errorCode, ttlMilliseconds, staleMilliseconds) {
    const now = new Date().toISOString();
    this.putCache.run(
      key,
      media.external_source,
      String(media.external_id),
      media.media_type,
      languages.join(","),
      payload ? JSON.stringify(payload) : null,
      status,
      errorCode,
      now,
      addMilliseconds(now, ttlMilliseconds),
      addMilliseconds(now, staleMilliseconds)
    );
  }

  cachedPayload(row, options = {}) {
    if (!row?.payload_json) return null;
    try {
      return { ...JSON.parse(row.payload_json), cached: true, stale: Boolean(options.stale) };
    } catch {
      return null;
    }
  }

  async get(media) {
    if (media.external_source !== "tmdb" || !/^\d+$/.test(String(media.external_id || ""))) {
      return unavailable(media, "external_id_missing");
    }
    if (!new Set(["movie", "tv"]).has(media.media_type)) {
      return unavailable(media, "unsupported_media_type");
    }

    const languages = this.languages();
    const key = cacheKey(media, languages);
    const now = new Date().toISOString();
    const cached = this.getCache.get(key);
    if (cached && cached.expires_at > now) {
      return this.cachedPayload(cached) || unavailable(media, cached.error_code || cached.status, { cached: true });
    }
    if (!this.config.tmdbApiKey) {
      const stale = cached && cached.stale_until > now ? this.cachedPayload(cached, { stale: true }) : null;
      return stale || unavailable(media, "metadata_disabled");
    }

    const endpoint = media.media_type === "tv" ? `/tv/${media.external_id}` : `/movie/${media.external_id}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.tmdbLiveTotalTimeoutMs);
    let merged = null;
    let selectedLanguage = languages[0] || "sk-SK";
    try {
      for (const language of languages) {
        const response = await this.client.get(endpoint, {
          params: { api_key: this.config.tmdbApiKey, language },
          signal: controller.signal,
        });
        if (!response.data || typeof response.data !== "object" || !response.data.id) {
          throw Object.assign(new Error("invalid_tmdb_response"), { code: "INVALID_RESPONSE" });
        }
        merged = mergeDetails(merged, response.data);
        if (String(response.data.overview || "").trim()) {
          selectedLanguage = language;
          break;
        }
      }
      const payload = serializeDetails(media, merged || {}, selectedLanguage);
      this.writeCache(
        key,
        media,
        languages,
        payload,
        "ok",
        null,
        this.config.tmdbLiveCacheTtlHours * 3600000,
        this.config.tmdbLiveStaleTtlHours * 3600000
      );
      return payload;
    } catch (error) {
      const kind = errorKind(error);
      const stale = cached && cached.stale_until > now ? this.cachedPayload(cached, { stale: true }) : null;
      if (stale) return stale;
      const status = kind === "not_found" ? "not_found" : kind === "INVALID_RESPONSE" ? "invalid_response" : "temporary_error";
      const ttl = kind === "not_found" ? 3600000 : this.config.tmdbLiveErrorTtlMinutes * 60000;
      this.writeCache(key, media, languages, null, status, kind, ttl, ttl);
      this.logger.warn?.({ status: error.response?.status || null, code: error.code || null }, "TMDb live metadata unavailable");
      return unavailable(media, kind);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

module.exports = {
  TmdbLiveMetadata,
  cacheKey,
  errorKind,
  mergeDetails,
  serializeDetails,
  unavailable,
};
