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
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, "")}"*`)
    .join(" AND ");
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
  return {
    id: row.id,
    media_key: row.media_key,
    media_type: row.media_type,
    category: row.category,
    title: row.title,
    original_title: row.original_title,
    year: row.year,
    release_date: row.release_date,
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
    if (params.category) {
      where.push("m.category = ?");
      values.push(params.category);
      if (params.category === "series" && !params.type) {
        where.push("m.media_type = 'tv'");
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
      where.push(`EXISTS (
        SELECT 1 FROM files language_file, json_each(language_file.parsed_languages_json) language
        WHERE language_file.media_id = m.id AND language_file.is_active = 1 AND upper(language.value) = upper(?)
      )`);
      values.push(params.language);
    }
    if (params.quality) {
      where.push("EXISTS (SELECT 1 FROM files quality_file WHERE quality_file.media_id = m.id AND quality_file.is_active = 1 AND quality_file.parsed_resolution = ?)");
      values.push(params.quality);
    }
    if (params.sort === "release_date_desc") {
      where.push("m.release_date IS NOT NULL");
      where.push("date(m.release_date) <= date('now')");
      where.push("m.external_source = 'tmdb'");
      where.push("m.external_id IS NOT NULL");
      where.push("m.metadata_status = 'matched'");
    }
    if (params.query) {
      const fts = escapeFtsQuery(params.query);
      if (fts) {
        where.push("m.id IN (SELECT CAST(media_id AS INTEGER) FROM media_fts WHERE media_fts MATCH ?)");
        values.push(fts);
      }
    }
    return { where: where.join(" AND "), values };
  }

  function listMedia(params = {}) {
    const page = positiveInteger(params.page, 1);
    const limit = Math.min(config.apiMaxPageSize, positiveInteger(params.limit, 50));
    const light = truthy(params.light);
    const order = params.sort === "release_date_desc"
      ? "DESC"
      : String(params.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const sortColumns = {
      recent: "m.updated_at",
      title: "m.title COLLATE NOCASE",
      year: "m.year",
      rating: "m.rating",
      release_date_desc: "COALESCE(m.release_date, printf('%04d-01-01', m.year))",
    };
    const sortColumn = sortColumns[params.sort] || sortColumns.recent;
    const query = buildMediaQuery(params);
    const total = light
      ? null
      : database.prepare(`SELECT COUNT(*) AS count FROM media m WHERE ${query.where}`).get(...query.values).count;
    const rowLimit = light ? limit + 1 : limit;
    const rows = database.prepare(`
      WITH page_media AS (
        SELECT m.id
        FROM media m
        WHERE ${query.where}
        ORDER BY ${sortColumn} ${order}, m.id ${order}
        LIMIT ? OFFSET ?
      )
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
      FROM media m
      JOIN page_media ON page_media.id = m.id
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
  escapeFtsQuery,
  externalUrlFor,
  positiveInteger,
  serializeFile,
  serializeMedia,
};
