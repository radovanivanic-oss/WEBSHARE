const fs = require("fs");
const { getAppState, parseJson } = require("./media-repository");

const CATEGORY_TITLES = {
  movies: "Filmy",
  series: "Seriály",
  documentaries: "Dokumentárne",
  concerts: "Koncerty",
  anime: "Anime",
  sports: "Šport",
  kids: "Detské",
  "music-videos": "Hudobné videá",
  other: "Ostatné",
  unknown: "Nezaradené",
};

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function escapeFtsQuery(value) {
  return normalizeSearchTokens(value)
    .map((token) => `"${token.folded.replace(/"/g, "")}"*`)
    .join(" AND ");
}

function normalizeSearchTokens(value) {
  const rawTokens = String(value || "").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  return rawTokens
    .map((raw) => ({
      raw,
      folded: raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
    }))
    .filter((token) => token.folded.length > 0);
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function fileSearchCondition(token, alias) {
  const variants = [...new Set([token.raw.toLowerCase(), token.folded].filter(Boolean))];
  const values = [];
  const fields = ["ident", "original_name", "normalized_name", "parsed_title"];
  const clauses = [];
  for (const variant of variants) {
    const pattern = `%${escapeLikePattern(variant)}%`;
    for (const field of fields) {
      clauses.push(`${alias}.${field} LIKE ? COLLATE NOCASE ESCAPE '\\'`);
      values.push(pattern);
    }
  }
  return {
    sql: `(${clauses.join(" OR ")})`,
    values,
  };
}

function fileSearchClause(token, alias) {
  const condition = fileSearchCondition(token, alias);
  return {
    sql: `EXISTS (
      SELECT 1 FROM files ${alias}
      WHERE ${alias}.media_id = m.id
        AND ${alias}.is_active = 1
        AND ${alias}.is_playable_video = 1
        AND ${condition.sql}
    )`,
    values: condition.values,
  };
}

function externalUrlFor(row) {
  if (row.external_url) return row.external_url;
  if (row.external_source !== "tmdb" || !row.external_id) return null;
  if (row.media_type === "tv") return `https://www.themoviedb.org/tv/${row.external_id}`;
  if (row.media_type === "episode") {
    const match = String(row.external_id).match(/^(\d+):s(\d+):e(\d+)$/i);
    if (match) return `https://www.themoviedb.org/tv/${match[1]}/season/${Number(match[2])}/episode/${Number(match[3])}`;
    return null;
  }
  return `https://www.themoviedb.org/movie/${row.external_id}`;
}

function serializeMedia(row) {
  if (!row) return null;
  const externalUrl = externalUrlFor(row);
  const hasEffectiveRelease = Object.prototype.hasOwnProperty.call(row, "effective_release_date");
  const serializedReleaseDate = hasEffectiveRelease ? row.effective_release_date : row.release_date;
  const releaseDate = String(serializedReleaseDate || "").trim();
  const releaseYear = hasEffectiveRelease ? row.effective_release_year : row.year;
  return {
    id: row.id,
    media_key: row.media_key,
    media_type: row.media_type,
    category: row.category,
    is_active: Boolean(row.is_active),
    title: row.title,
    original_title: row.original_title,
    year: row.year,
    release_date: serializedReleaseDate ?? null,
    release_date_precision: /^\d{4}-\d{2}-\d{2}$/u.test(releaseDate)
      ? "day"
      : row.effective_release_precision || (releaseYear
        ? "year"
        : null),
    latest_release_date: row.effective_release_date ?? null,
    latest_release_precision: row.effective_release_precision || null,
    latest_episode_date: row.latest_episode_date ?? null,
    latest_episode_year: row.latest_episode_year ?? null,
    external_source: row.external_source,
    external_id: row.external_id,
    external_url: externalUrl,
    season_number: row.season_number,
    episode_number: row.episode_number,
    tvshow_id: row.tvshow_id,
    overview: row.overview,
    genres: parseJson(row.genres_json, []),
    runtime_minutes: row.runtime_minutes,
    rating: row.rating,
    vote_count: row.vote_count,
    countries: parseJson(row.countries_json, []),
    languages: parseJson(row.languages_json, []),
    director: row.director,
    cast: parseJson(row.cast_json, []),
    poster_url: row.poster_url,
    backdrop_url: row.backdrop_url,
    adult: Boolean(row.adult),
    metadata_status: row.metadata_status,
    metadata_confidence: row.metadata_confidence,
    metadata_language: row.metadata_language,
    metadata_updated_at: row.metadata_updated_at,
    versions: row.version_count === undefined ? undefined : row.version_count,
    available_files_count: row.version_count === undefined ? undefined : row.version_count,
    best_quality: row.best_quality === undefined ? undefined : row.best_quality,
    updated_at: row.updated_at,
  };
}

function serializeFile(row) {
  return {
    id: row.id,
    ident: row.ident,
    name: row.original_name,
    original_name: row.original_name,
    size: row.size_bytes,
    size_bytes: row.size_bytes,
    extension: row.extension,
    resolution: row.parsed_resolution,
    source: row.parsed_source,
    video_codec: row.parsed_video_codec,
    audio_codec: row.parsed_audio_codec,
    hdr: Boolean(row.parsed_hdr),
    dolby_vision: Boolean(row.parsed_dolby_vision),
    languages: parseJson(row.parsed_languages_json, []),
    has_dubbing: Boolean(row.parsed_has_dubbing),
    has_subtitles: Boolean(row.parsed_has_subtitles),
    positive_votes: row.positive_votes,
    negative_votes: row.negative_votes,
    password_protected: Boolean(row.password_protected),
    is_active: Boolean(row.is_active),
    source_provider: "webshare",
    needs_file_link: true,
    url: `webshare://${row.ident}`,
  };
}

function createCatalogRepository(database, config) {
  function buildMediaQuery(params = {}) {
    const where = ["m.is_active = 1"];
    const values = [];
    const seriesListing = params.category === "series" && !params.type;
    if (params.category) {
      where.push("m.category = ?");
      values.push(params.category);
      if (seriesListing) {
        where.push("m.media_type = 'tv'");
        where.push("m.metadata_confidence >= 0.5");
      }
    }
    if (params.type) {
      where.push("m.media_type = ?");
      values.push(params.type);
    }
    if (params.year) {
      where.push("m.year = ?");
      values.push(Number.parseInt(params.year, 10));
    }
    if (params.genre) {
      where.push("EXISTS (SELECT 1 FROM json_each(m.genres_json) genre WHERE lower(CASE WHEN genre.type = 'object' THEN json_extract(genre.value, '$.name') ELSE genre.value END) = lower(?))");
      values.push(params.genre);
    }
    if (params.language) {
      where.push(seriesListing ? `EXISTS (
        SELECT 1 FROM media language_episode
        JOIN files language_file ON language_file.media_id = language_episode.id,
        json_each(language_file.parsed_languages_json) language
        WHERE language_episode.tvshow_id = m.id
          AND language_episode.is_active = 1
          AND language_file.is_active = 1
          AND upper(language.value) = upper(?)
      )` : `EXISTS (
        SELECT 1 FROM files language_file, json_each(language_file.parsed_languages_json) language
        WHERE language_file.media_id = m.id AND language_file.is_active = 1 AND upper(language.value) = upper(?)
      )`);
      values.push(params.language);
    }
    if (params.quality) {
      where.push(seriesListing
        ? `EXISTS (
          SELECT 1 FROM media quality_episode
          JOIN files quality_file ON quality_file.media_id = quality_episode.id
          WHERE quality_episode.tvshow_id = m.id
            AND quality_episode.is_active = 1
            AND quality_file.is_active = 1
            AND quality_file.parsed_resolution = ?
        )`
        : "EXISTS (SELECT 1 FROM files quality_file WHERE quality_file.media_id = m.id AND quality_file.is_active = 1 AND quality_file.parsed_resolution = ?)");
      values.push(params.quality);
    }
    if (params.sort === "release_date_desc") {
      where.push("m.media_type = 'movie'");
      where.push("((m.release_date IS NOT NULL AND date(m.release_date) <= date('now')) OR (m.release_date IS NULL AND m.year IS NOT NULL AND printf('%04d-01-01', m.year) <= date('now')))");
      where.push("(m.release_date IS NOT NULL OR m.year IS NOT NULL)");
    }
    if (params.query) {
      where.push(seriesListing
        ? `EXISTS (
          SELECT 1 FROM media visible_episode
          JOIN files visible_file ON visible_file.media_id = visible_episode.id
          WHERE visible_episode.tvshow_id = m.id
            AND visible_episode.is_active = 1
            AND visible_file.is_active = 1
            AND visible_file.is_playable_video = 1
        )`
        : "EXISTS (SELECT 1 FROM files visible_file WHERE visible_file.media_id = m.id AND visible_file.is_active = 1 AND visible_file.is_playable_video = 1)");
      for (const token of normalizeSearchTokens(params.query)) {
        const fileSearch = fileSearchClause(token, "search_file");
        if (/^(?:19|20)\d{2}$/u.test(token.folded)) {
          const yearFileSearch = fileSearchCondition(token, "year_file");
          where.push(`(
            m.year = ?
            OR EXISTS (
              SELECT 1 FROM files year_file
              WHERE year_file.media_id = m.id
                AND year_file.is_active = 1
                AND year_file.is_playable_video = 1
                AND (year_file.parsed_year = ? OR ${yearFileSearch.sql})
            )
          )`);
          values.push(Number(token.folded), Number(token.folded), ...yearFileSearch.values);
          continue;
        }
        where.push(`(
          m.id IN (SELECT CAST(media_id AS INTEGER) FROM media_fts WHERE media_fts MATCH ?)
          OR ${fileSearch.sql}
        )`);
        values.push(escapeFtsQuery(token.folded), ...fileSearch.values);
      }
    }
    return { where: where.join(" AND "), values };
  }

  function listMedia(params = {}) {
    const page = positiveInteger(params.page, 1);
    const limit = Math.min(config.apiMaxPageSize, positiveInteger(params.limit, 50));
    const light = truthy(params.light);
    const seriesRecent = params.category === "series" && !params.type && (params.sort || "recent") === "recent";
    const seriesReleaseRecent = params.category === "series" && !params.type && params.sort === "series_release_date_desc";
    const order = params.sort === "release_date_desc"
      ? "DESC"
      : String(params.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const sortColumns = {
      recent: "m.updated_at",
      title: "m.title COLLATE NOCASE",
      year: "m.year",
      rating: "m.rating",
      release_date_desc: "COALESCE(m.release_date, printf('%04d-01-01', m.year))",
      series_release_date_desc: "series_release.effective_sort_key",
    };
    const sortColumn = seriesReleaseRecent
      ? sortColumns.series_release_date_desc
      : seriesRecent ? "series_activity.latest_file_id" : sortColumns[params.sort] || sortColumns.recent;
    const query = buildMediaQuery(params);
    const total = light
      ? null
      : database.prepare(`SELECT COUNT(*) AS count FROM media m WHERE ${query.where}`).get(...query.values).count;
    const rowLimit = light ? limit + 1 : limit;
    const seriesActivityCte = seriesRecent ? `
      series_activity AS (
        SELECT episode.tvshow_id AS id, MAX(file.id) AS latest_file_id
        FROM media episode
        JOIN files file ON file.media_id = episode.id
        WHERE episode.tvshow_id IS NOT NULL
          AND episode.is_active = 1
          AND file.is_active = 1
          AND file.is_playable_video = 1
        GROUP BY episode.tvshow_id
      ),
    ` : "";
    const seriesReleaseCte = seriesReleaseRecent ? `
      series_release_base AS MATERIALIZED (
        SELECT
          series.id,
          (
            SELECT MAX(episode.release_date)
            FROM media episode
            WHERE episode.tvshow_id = series.id
              AND episode.is_active = 1
              AND episode.release_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
              AND episode.release_date <= date('now')
          ) AS latest_episode_date,
          (
            SELECT MAX(episode.year)
            FROM media episode
            WHERE episode.tvshow_id = series.id
              AND episode.is_active = 1
              AND episode.year IS NOT NULL
              AND episode.year <= CAST(strftime('%Y', 'now') AS INTEGER)
          ) AS latest_episode_year,
          CASE
            WHEN series.release_date IS NOT NULL
              AND series.release_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
              AND series.release_date <= date('now')
            THEN series.release_date
          END AS series_release_date,
          series.year AS series_year
        FROM media series
        WHERE series.media_type = 'tv' AND series.is_active = 1
      ),
      series_release AS (
        SELECT
          id,
          latest_episode_date,
          latest_episode_year,
          COALESCE(latest_episode_date, series_release_date) AS effective_release_date,
          CASE
            WHEN latest_episode_date IS NOT NULL OR series_release_date IS NOT NULL THEN 'day'
            WHEN latest_episode_year IS NOT NULL OR (series_year IS NOT NULL AND series_year <= CAST(strftime('%Y', 'now') AS INTEGER)) THEN 'year'
            ELSE NULL
          END AS effective_release_precision,
          CASE
            WHEN latest_episode_date IS NOT NULL THEN latest_episode_date
            WHEN series_release_date IS NOT NULL THEN series_release_date
            WHEN latest_episode_year IS NOT NULL THEN printf('%04d-01-01', latest_episode_year)
            WHEN series_year IS NOT NULL AND series_year <= CAST(strftime('%Y', 'now') AS INTEGER) THEN printf('%04d-01-01', series_year)
            ELSE '0000-01-01'
          END AS effective_sort_key,
          CASE
          WHEN latest_episode_year IS NOT NULL THEN latest_episode_year
            WHEN series_year IS NOT NULL AND series_year <= CAST(strftime('%Y', 'now') AS INTEGER) THEN series_year
          END AS effective_release_year
        FROM series_release_base
      ),
    ` : "";
    const seriesActivityJoin = seriesRecent ? "JOIN series_activity ON series_activity.id = m.id" : "";
    const seriesReleaseJoin = seriesReleaseRecent ? "JOIN series_release ON series_release.id = m.id" : "";
    const seriesReleaseProjection = seriesReleaseRecent ? `,
      series_release.effective_release_date,
      series_release.effective_release_precision,
      series_release.effective_release_year,
      series_release.latest_episode_date,
      series_release.latest_episode_year
    ` : "";
    const rows = database.prepare(`
      WITH ${seriesActivityCte}${seriesReleaseCte} page_media AS (
        SELECT m.id
        FROM media m
        ${seriesActivityJoin}
        ${seriesReleaseJoin}
        WHERE ${query.where}
        ORDER BY ${sortColumn} ${order}, m.id ${order}
        LIMIT ? OFFSET ?
      )
      SELECT m.*, CASE WHEN m.media_type = 'tv' THEN (
        SELECT COUNT(*) FROM media episode_media
        JOIN files episode_file INDEXED BY idx_files_media_active_playable_recent
          ON episode_file.media_id = episode_media.id
        WHERE episode_media.tvshow_id = m.id AND episode_file.is_active = 1 AND episode_file.is_playable_video = 1
      ) ELSE (
        SELECT COUNT(*) FROM files direct_file
        WHERE direct_file.media_id = m.id AND direct_file.is_active = 1 AND direct_file.is_playable_video = 1
      ) END AS version_count,
      CASE WHEN m.media_type = 'tv' THEN NULL ELSE (
        SELECT best_file.parsed_resolution FROM files best_file
        WHERE best_file.media_id = m.id AND best_file.is_active = 1 AND best_file.is_playable_video = 1
        ORDER BY CASE best_file.parsed_resolution
          WHEN '4320p' THEN 6 WHEN '2160p' THEN 5 WHEN '1080p' THEN 4
          WHEN '720p' THEN 3 WHEN '576p' THEN 2 WHEN '480p' THEN 1 ELSE 0 END DESC,
          best_file.size_bytes DESC
        LIMIT 1
      ) END AS best_quality
      ${seriesReleaseProjection}
      FROM media m
      JOIN page_media ON page_media.id = m.id
      ${seriesActivityJoin}
      ${seriesReleaseJoin}
      ORDER BY ${sortColumn} ${order}, m.id ${order}
    `).all(...query.values, rowLimit, (page - 1) * limit);
    const hasMore = light && rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      data: pageRows.map(serializeMedia),
      pagination: {
        page,
        limit,
        total: light ? null : total,
        pages: light ? page + (hasMore ? 1 : 0) : Math.ceil(total / limit),
        has_more: light ? hasMore : page < Math.ceil(total / limit),
      },
    };
  }

  function getMedia(id) {
    const row = database.prepare(`
      SELECT m.*, CASE WHEN m.media_type = 'tv' THEN (
        SELECT COUNT(*) FROM media episode_media JOIN files episode_file ON episode_file.media_id = episode_media.id
        WHERE episode_media.tvshow_id = m.id AND episode_file.is_active = 1 AND episode_file.is_playable_video = 1
      ) ELSE (
        SELECT COUNT(*) FROM files direct_file
        WHERE direct_file.media_id = m.id AND direct_file.is_active = 1 AND direct_file.is_playable_video = 1
      ) END AS version_count,
      CASE WHEN m.media_type = 'tv' THEN NULL ELSE (
        SELECT best_file.parsed_resolution FROM files best_file
        WHERE best_file.media_id = m.id AND best_file.is_active = 1 AND best_file.is_playable_video = 1
        ORDER BY CASE best_file.parsed_resolution
          WHEN '4320p' THEN 6 WHEN '2160p' THEN 5 WHEN '1080p' THEN 4
          WHEN '720p' THEN 3 WHEN '576p' THEN 2 WHEN '480p' THEN 1 ELSE 0 END DESC,
          best_file.size_bytes DESC
        LIMIT 1
      ) END AS best_quality
      FROM media m WHERE m.id = ?
    `).get(id);
    if (!row) return null;
    const media = serializeMedia(row);
    media.aliases = database.prepare("SELECT alias, language, source FROM media_aliases WHERE media_id = ? ORDER BY alias").all(id);
    return media;
  }

  function getMediaFiles(id, params = {}) {
    const page = positiveInteger(params.page, 1);
    const limit = Math.min(config.apiMaxPageSize, positiveInteger(params.limit, 100));
    const total = database.prepare(`
      SELECT COUNT(*) AS count FROM files
      WHERE media_id = ? AND is_active = 1 AND is_playable_video = 1
    `).get(id).count;
    const rows = database.prepare(`
      SELECT * FROM files
      WHERE media_id = ? AND is_active = 1 AND is_playable_video = 1
      ORDER BY
        CASE parsed_resolution WHEN '4320p' THEN 6 WHEN '2160p' THEN 5 WHEN '1080p' THEN 4
          WHEN '720p' THEN 3 WHEN '576p' THEN 2 WHEN '480p' THEN 1 ELSE 0 END DESC,
        parsed_dolby_vision DESC, parsed_hdr DESC, size_bytes DESC
      LIMIT ? OFFSET ?
    `).all(id, limit, (page - 1) * limit).map(serializeFile);
    return {
      data: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  function getEpisodes(tvshowId, params = {}) {
    const page = positiveInteger(params.page, 1);
    const limit = Math.min(config.apiMaxPageSize, positiveInteger(params.limit, 50));
    const values = [tvshowId];
    let seasonSql = "";
    if (params.season !== undefined && params.season !== null && params.season !== "") {
      seasonSql = "AND episode.season_number = ?";
      values.push(positiveInteger(params.season, 0));
    }
    const total = database.prepare(`
      SELECT COUNT(*) AS count FROM media episode
      WHERE episode.tvshow_id = ? AND episode.is_active = 1 ${seasonSql}
    `).get(...values).count;
    const rows = database.prepare(`
      SELECT episode.*, (
        SELECT COUNT(*) FROM files f
        WHERE f.media_id = episode.id AND f.is_active = 1 AND f.is_playable_video = 1
      ) AS version_count
      FROM media episode
      WHERE episode.tvshow_id = ? AND episode.is_active = 1 ${seasonSql}
      ORDER BY episode.season_number, episode.episode_number, episode.id
      LIMIT ? OFFSET ?
    `).all(...values, limit, (page - 1) * limit);
    return {
      data: rows.map(serializeMedia),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  function getSeasons(tvshowId) {
    const rows = database.prepare(`
      SELECT episode.season_number AS season_number, COUNT(*) AS episode_count
      FROM media episode
      WHERE episode.tvshow_id = ? AND episode.is_active = 1 AND episode.season_number IS NOT NULL
      GROUP BY episode.season_number
      ORDER BY episode.season_number
    `).all(tvshowId);
    return {
      data: rows.map((row) => ({
        season_number: row.season_number,
        episode_count: row.episode_count,
      })),
    };
  }

  function categories() {
    const counts = database.prepare(`
      SELECT m.category, COUNT(DISTINCT m.id) AS count FROM media m
      WHERE m.is_active = 1 AND (m.category != 'series' OR m.media_type = 'tv')
      GROUP BY m.category
    `).all();
    const byCategory = new Map(counts.map((row) => [row.category, row.count]));
    return Object.entries(CATEGORY_TITLES).map(([id, title]) => ({ id, title, count: byCategory.get(id) || 0 }));
  }

  function distinctFilter(column, category) {
    const allowed = {
      years: "m.year",
      qualities: "f.parsed_resolution",
    };
    if (!allowed[column]) throw new Error("Neplatný filter.");
    const values = [];
    const categorySql = category ? "AND m.category = ?" : "";
    if (category) values.push(category);
    return database.prepare(`
      SELECT ${allowed[column]} AS value, COUNT(DISTINCT m.id) AS count
      FROM media m JOIN files f ON f.media_id = m.id
      WHERE f.is_active = 1 AND f.is_playable_video = 1 AND ${allowed[column]} IS NOT NULL ${categorySql}
      GROUP BY ${allowed[column]} ORDER BY ${allowed[column]} DESC
    `).all(...values);
  }

  function genres(category) {
    const values = [];
    const categorySql = category ? "AND m.category = ?" : "";
    if (category) values.push(category);
    return database.prepare(`
      SELECT CASE WHEN genre.type = 'object' THEN json_extract(genre.value, '$.name') ELSE genre.value END AS value,
        COUNT(DISTINCT m.id) AS count
      FROM media m, json_each(m.genres_json) genre
      WHERE 1 = 1 ${categorySql}
      GROUP BY value ORDER BY count DESC, value
    `).all(...values);
  }

  function languages(category) {
    const values = [];
    const categorySql = category ? "AND m.category = ?" : "";
    if (category) values.push(category);
    return database.prepare(`
      SELECT language.value AS value, COUNT(DISTINCT m.id) AS count
      FROM media m JOIN files f ON f.media_id = m.id, json_each(f.parsed_languages_json) language
      WHERE f.is_active = 1 AND f.is_playable_video = 1 ${categorySql}
      GROUP BY language.value ORDER BY count DESC, language.value
    `).all(...values);
  }

  function health() {
    const schemaVersion = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS files,
        (SELECT COUNT(*) FROM files WHERE is_active = 1) AS active_files,
        (SELECT COUNT(*) FROM media) AS media,
        (SELECT COUNT(*) FROM metadata_jobs WHERE status = 'pending') AS pending_jobs,
        (SELECT COUNT(*) FROM metadata_jobs WHERE status = 'ambiguous') AS ambiguous,
        (SELECT COUNT(*) FROM metadata_jobs WHERE status = 'not_found') AS not_found,
        (SELECT COUNT(*) FROM metadata_jobs WHERE status IN ('temporary_error','permanent_error')) AS metadata_errors
    `).get();
    return {
      success: true,
      database: "ok",
      schema_version: schemaVersion,
      ...counts,
      categories: categories().filter((row) => row.count > 0).length,
      last_import: getAppState(database, "last_import"),
      last_enrichment: getAppState(database, "last_enrichment"),
      last_reclassification: getAppState(database, "last_reclassification"),
      database_size_bytes: fs.existsSync(config.databasePath) ? fs.statSync(config.databasePath).size : 0,
    };
  }

  return { categories, distinctFilter, genres, getEpisodes, getMedia, getMediaFiles, getSeasons, health, languages, listMedia };
}

module.exports = {
  CATEGORY_TITLES,
  createCatalogRepository,
  escapeLikePattern,
  escapeFtsQuery,
  externalUrlFor,
  normalizeSearchTokens,
  positiveInteger,
  serializeFile,
  serializeMedia,
};
