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

function titleCacheId(media) {
  // Bump this whenever the title-to-TMDb matching policy changes.  It keeps
  // stale results produced by an older, first-result-wins matcher from being
  // served forever (for example Gold Rush resolving to an unrelated show).
  return `title-match-v2:${media.media_type}:${media.id || ""}:${String(media.title || "").trim().toLowerCase()}`;
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tvCandidateScore(query, candidate, requestedYear) {
  const wanted = normalizeTitle(query);
  const names = [candidate?.name, candidate?.original_name]
    .map(normalizeTitle)
    .filter(Boolean);
  if (!wanted || !names.length) return 0;
  if (names.includes(wanted)) return 1;
  const wantedTokens = new Set(wanted.split(/\s+/u).filter(Boolean));
  let best = 0;
  for (const name of names) {
    const candidateTokens = new Set(name.split(/\s+/u).filter(Boolean));
    const overlap = [...wantedTokens].filter((token) => candidateTokens.has(token)).length;
    const coverage = overlap / Math.max(wantedTokens.size, candidateTokens.size);
    best = Math.max(best, coverage);
  }
  const candidateYear = Number.parseInt(String(candidate?.first_air_date || "").slice(0, 4), 10);
  if (requestedYear && candidateYear && Math.abs(candidateYear - Number(requestedYear)) <= 1) best += 0.08;
  return Math.min(1, best);
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
  for (const key of ["overview", "poster_path", "still_path", "backdrop_path", "runtime", "episode_run_time", "vote_average", "genres"]) {
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
  const runtime = details.runtime || (Array.isArray(details.episode_run_time) ? details.episode_run_time.find(Boolean) : null);
  const available = Boolean(overview || posterUrl || backdropUrl || genres.length || runtime || details.vote_average);
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
    runtimeMinutes: Number.isFinite(Number(runtime)) && Number(runtime) > 0 ? Number(runtime) : null,
    rating: Number.isFinite(Number(details.vote_average)) && Number(details.vote_average) > 0 ? Number(details.vote_average) : null,
    language,
    message: overview ? null : "Popis nie je k dispozícii.",
    cached: false,
    stale: false,
  };
}

function serializeEpisodeDetails(media, details, language, tvId) {
  const overview = String(details.overview || "").trim() || null;
  const posterUrl = imageUrl(details.still_path, "w500");
  const runtime = Number(details.runtime);
  const rating = Number(details.vote_average);
  const available = Boolean(overview || posterUrl || runtime || rating);
  return {
    available,
    metadataAvailable: available,
    source: "tmdb",
    externalId: String(media.external_id),
    externalUrl: `https://www.themoviedb.org/tv/${tvId}/season/${media.season_number}/episode/${media.episode_number}`,
    overview,
    posterUrl,
    backdropUrl: null,
    genres: [],
    runtimeMinutes: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
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
    this.database = database;
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
    if (media.media_type === "episode") return this.getEpisode(media);
    if (!new Set(["movie", "tv"]).has(media.media_type)) {
      return unavailable(media, "unsupported_media_type");
    }

    const languages = this.languages();
    const hasExternalId = media.external_source === "tmdb" && /^\d+$/.test(String(media.external_id || ""));
    if (!hasExternalId && media.media_type !== "tv") {
      return unavailable(media, "external_id_missing");
    }

    const cacheMedia = hasExternalId
      ? media
      : { ...media, external_source: "tmdb_search", external_id: titleCacheId(media) };
    const key = cacheKey(cacheMedia, languages);
    const now = new Date().toISOString();
    const cached = this.getCache.get(key);
    if (cached && cached.expires_at > now) {
      return this.cachedPayload(cached) || unavailable(media, cached.error_code || cached.status, { cached: true });
    }
    if (!this.config.tmdbApiKey) {
      const stale = cached && cached.stale_until > now ? this.cachedPayload(cached, { stale: true }) : null;
      return stale || unavailable(media, "metadata_disabled");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.tmdbLiveTotalTimeoutMs);
    let merged = null;
    let selectedLanguage = languages[0] || "sk-SK";
    try {
      const lookupMedia = hasExternalId ? media : await this.findTvShow(media, languages, controller.signal);
      if (!lookupMedia) {
        this.writeCache(
          key,
          cacheMedia,
          languages,
          null,
          "not_found",
          "title_not_found",
          3600000,
          3600000
        );
        return unavailable(media, "title_not_found");
      }

      const endpoint = lookupMedia.media_type === "tv" ? `/tv/${lookupMedia.external_id}` : `/movie/${lookupMedia.external_id}`;
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
      const payload = serializeDetails(lookupMedia, merged || {}, selectedLanguage);
      this.writeCache(
        key,
        cacheMedia,
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
      this.writeCache(key, cacheMedia, languages, null, status, kind, ttl, ttl);
      this.logger.warn?.({ status: error.response?.status || null, code: error.code || null, message: error.message || null }, "TMDb live metadata unavailable");
      return unavailable(media, kind);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getEpisode(media) {
    const parent = media.tvshow_id
      ? this.database.prepare("SELECT * FROM media WHERE id = ? AND media_type = 'tv'").get(media.tvshow_id)
      : null;
    const series = parent || media;
    const season = Number.parseInt(media.season_number, 10);
    const episode = Number.parseInt(media.episode_number, 10);
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 0) {
      return unavailable(media, "episode_coordinates_missing");
    }

    const languages = this.languages();
    let lookup = series;
    let showId = series.external_source === "tmdb" && /^\d+$/.test(String(series.external_id || ""))
      ? String(series.external_id)
      : null;
    const cacheMedia = {
      ...media,
      external_source: "tmdb",
      external_id: showId ? `${showId}:s${season}:e${episode}` : `${media.tvshow_id || media.id}:s${season}:e${episode}`,
      media_type: "episode",
    };
    let key = cacheKey(cacheMedia, languages);
    const now = new Date().toISOString();
    const cached = this.getCache.get(key);
    if (cached && cached.expires_at > now) {
      return this.cachedPayload(cached) || unavailable(media, cached.error_code || cached.status, { cached: true });
    }
    if (!this.config.tmdbApiKey) {
      const stale = cached && cached.stale_until > now ? this.cachedPayload(cached, { stale: true }) : null;
      return stale || unavailable(media, "metadata_disabled");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.tmdbLiveTotalTimeoutMs);
    try {
      if (!showId) {
        lookup = await this.findTvShow(series, languages, controller.signal);
        showId = lookup?.external_id ? String(lookup.external_id) : null;
      }
      if (!showId) {
        this.writeCache(key, cacheMedia, languages, null, "not_found", "tv_not_found", 3600000, 3600000);
        return unavailable(media, "tv_not_found");
      }
      cacheMedia.external_id = `${showId}:s${season}:e${episode}`;
      // When the parent series had no stored TMDb ID, the first lookup used a
      // local episode identity.  Store the resolved episode under the stable
      // TMDb identity as well, so a later request can reuse the same cache
      // entry instead of doing the title search again.
      const resolvedKey = cacheKey(cacheMedia, languages);
      let merged = null;
      let selectedLanguage = languages[0] || "sk-SK";
      for (const language of languages) {
        const response = await this.client.get(`/tv/${showId}/season/${season}/episode/${episode}`, {
          params: { api_key: this.config.tmdbApiKey, language },
          signal: controller.signal,
        });
        if (!response.data || typeof response.data !== "object") {
          throw Object.assign(new Error("invalid_tmdb_response"), { code: "INVALID_RESPONSE" });
        }
        merged = mergeDetails(merged, response.data);
        if (String(response.data.overview || "").trim()) {
          selectedLanguage = language;
          break;
        }
      }
      const payload = serializeEpisodeDetails(cacheMedia, merged || {}, selectedLanguage, showId);
      key = resolvedKey;
      this.writeCache(key, cacheMedia, languages, payload, "ok", null, this.config.tmdbLiveCacheTtlHours * 3600000, this.config.tmdbLiveStaleTtlHours * 3600000);
      return payload;
    } catch (error) {
      const kind = errorKind(error);
      const stale = cached && cached.stale_until > now ? this.cachedPayload(cached, { stale: true }) : null;
      if (stale) return stale;
      const status = kind === "not_found" ? "not_found" : kind === "INVALID_RESPONSE" ? "invalid_response" : "temporary_error";
      const ttl = kind === "not_found" ? 3600000 : this.config.tmdbLiveErrorTtlMinutes * 60000;
      this.writeCache(key, cacheMedia, languages, null, status, kind, ttl, ttl);
      this.logger.warn?.({ status: error.response?.status || null, code: error.code || null, message: error.message || null }, "TMDb live episode metadata unavailable");
      return unavailable(media, kind);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async findTvShow(media, languages, signal) {
    const query = String(media.title || "").trim();
    if (!query) return null;

    const normalizedQuery = normalizeTitle(query);
    const candidates = new Map();
    for (const language of languages) {
      const response = await this.client.get("/search/tv", {
        params: {
          api_key: this.config.tmdbApiKey,
          query,
          language,
          include_adult: "false",
          first_air_date_year: media.year || undefined,
        },
        signal,
      });
      const results = Array.isArray(response.data?.results) ? response.data.results : [];
      const exact = results.find((candidate) => {
        const names = [candidate?.name, candidate?.original_name].map(normalizeTitle);
        const candidateYear = Number.parseInt(String(candidate?.first_air_date || "").slice(0, 4), 10);
        return names.includes(normalizedQuery)
          && (!media.year || !candidateYear || Math.abs(candidateYear - Number(media.year)) <= 1);
      });
      if (exact?.id) {
        return {
          ...media,
          external_source: "tmdb",
          external_id: String(exact.id),
          external_url: `https://www.themoviedb.org/tv/${exact.id}`,
        };
      }
      for (const result of results) if (result?.id) candidates.set(String(result.id), result);
    }
    const ranked = [...candidates.values()]
      .map((candidate) => ({ candidate, score: tvCandidateScore(normalizedQuery, candidate, media.year) }))
      .sort((left, right) => right.score - left.score || Number(right.candidate.id) - Number(left.candidate.id));
    const selected = ranked.find((entry) => entry.score >= 0.88)?.candidate;
    if (!selected?.id) return null;
    return {
      ...media,
      external_source: "tmdb",
      external_id: String(selected.id),
      external_url: `https://www.themoviedb.org/tv/${selected.id}`,
    };
  }
}

module.exports = {
  TmdbLiveMetadata,
  cacheKey,
  errorKind,
  mergeDetails,
  normalizeTitle,
  serializeDetails,
  serializeEpisodeDetails,
  tvCandidateScore,
  titleCacheId,
  unavailable,
};
