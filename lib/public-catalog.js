"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const Database = require("better-sqlite3");
const { selectDisplayTitle } = require("../src/repositories/display-title");

const SCHEMA = "webshare-atlas-public-catalog/v1";
const SCHEMA_VERSION = 2;
const SHARD_RANGE = 25000;
const LISTING_CHUNK_SIZE = 5000;
const CATEGORIES = Object.freeze(["movies", "series", "concerts", "sports", "music-videos", "other"]);
const CATEGORY_MEDIA = Object.freeze({
  movies: "m.media_type = 'movie'",
  series: "m.media_type = 'tv'",
  concerts: "m.media_type <> 'episode'",
  sports: "m.media_type <> 'episode'",
  "music-videos": "m.media_type <> 'episode'",
  other: "m.media_type <> 'episode'",
});

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function sha256File(file) {
  const fd = fs.openSync(file, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function json(value) { return JSON.stringify(value); }
function parseJson(value, fallback) {
  try { const parsed = JSON.parse(value || ""); return parsed == null ? fallback : parsed; } catch { return fallback; }
}
function shardName(kind, category, range) { return `${kind}-${category}-${String(range).padStart(5, "0")}.json.gz`; }
function rangeFor(id) { return Math.floor(Number(id) / SHARD_RANGE); }
function safeMkdir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o750 }); }
function writeAtomic(file, bytes) {
  safeMkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o640 });
  fs.renameSync(tmp, file);
}
function writeJson(file, value) { writeAtomic(file, Buffer.from(`${json(value)}\n`, "utf8")); }
function writeObject(objectsDir, value) {
  const plain = Buffer.from(`${json(value)}\n`, "utf8");
  const compressed = zlib.gzipSync(plain, { level: 9, mtime: 0 });
  const hash = sha256(compressed);
  const file = path.join(objectsDir, `${hash}.json.gz`);
  if (!fs.existsSync(file)) writeAtomic(file, compressed);
  return { sha256: hash, compressed_bytes: compressed.length, uncompressed_bytes: plain.length, records: Array.isArray(value) ? value.length : 1, file: path.basename(file) };
}

function externalUrlFor(row) {
  if (row.external_url) return row.external_url;
  if (row.external_source !== "tmdb" || !row.external_id) return null;
  if (row.media_type === "tv") return `https://www.themoviedb.org/tv/${row.external_id}`;
  if (row.media_type === "episode") {
    const match = String(row.external_id).match(/^(\d+):s(\d+):e(\d+)$/iu);
    if (match) return `https://www.themoviedb.org/tv/${match[1]}/season/${Number(match[2])}/episode/${Number(match[3])}`;
    return null;
  }
  return `https://www.themoviedb.org/movie/${row.external_id}`;
}

function baseMedia(row, aliases) {
  return {
    id: row.id,
    media_type: row.media_type,
    category: row.category,
    title: row.title,
    display_title: selectDisplayTitle(row, aliases),
    aliases: aliases.map(alias => alias.alias).filter(Boolean),
    original_title: row.original_title,
    year: row.year,
    release_date: row.release_date,
    release_date_precision: /^\d{4}-\d{2}-\d{2}$/u.test(String(row.release_date || "")) ? "day" : row.year ? "year" : null,
    latest_release_date: row.latest_episode_date || row.release_date || null,
    latest_release_precision: row.latest_episode_date ? "day" : row.release_date ? "day" : row.year ? "year" : null,
    latest_episode_date: row.latest_episode_date || null,
    latest_episode_year: row.latest_episode_year || null,
    external_source: row.external_source,
    external_id: row.external_id,
    external_url: externalUrlFor(row),
    overview: row.overview,
    genres: parseJson(row.genres_json, []),
    runtime_minutes: row.runtime_minutes,
    rating: row.rating,
    vote_count: row.vote_count,
    countries: parseJson(row.countries_json, []),
    languages: parseJson(row.languages_json, []),
    poster_url: row.poster_url,
    backdrop_url: row.backdrop_url,
    adult: Boolean(row.adult),
    metadata_status: row.metadata_status,
    metadata_confidence: row.metadata_confidence,
    metadata_language: row.metadata_language,
    available_files_count: row.version_count || 0,
    variant_count: row.version_count || 0,
    updated_at: row.updated_at,
  };
}

function listingMedia(row, aliases) {
  return {
    id: row.id,
    media_type: row.media_type,
    category: row.category,
    title: row.title,
    display_title: selectDisplayTitle(row, aliases),
    original_title: row.original_title,
    external_source: row.external_source,
    external_id: row.external_id,
    external_url: externalUrlFor(row),
    aliases: aliases.map(alias => alias.alias).filter(Boolean),
    year: row.year,
    release_date: row.release_date,
    release_date_precision: /^\d{4}-\d{2}-\d{2}$/u.test(String(row.release_date || "")) ? "day" : row.year ? "year" : null,
    latest_release_date: row.latest_episode_date || row.release_date || null,
    latest_release_precision: row.latest_episode_date ? "day" : row.release_date ? "day" : row.year ? "year" : null,
    latest_episode_year: row.latest_episode_year || null,
    poster_url: row.poster_url,
    available_files_count: row.version_count || 0,
    variant_count: row.version_count || 0,
  };
}

function fileRecord(row) {
  return {
    id: row.id,
    ident: row.ident,
    name: row.original_name,
    size: row.size_bytes,
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
    needs_file_link: true,
  };
}

function releaseListingRows(rows) {
  const today = new Date().toISOString().slice(0, 10);
  return rows
    .filter(row => {
      const effectiveDate = row.latest_release_date || row.release_date;
      return !effectiveDate || effectiveDate <= today;
    })
    .sort((a, b) => {
      const aDate = a.latest_release_date || a.release_date || "";
      const bDate = b.latest_release_date || b.release_date || "";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      const aYear = Number(a.latest_episode_year || a.year || 0);
      const bYear = Number(b.latest_episode_year || b.year || 0);
      if (aYear !== bYear) return bYear - aYear;
      return Number(b.id || 0) - Number(a.id || 0);
    });
}

function episodeRecord(row) {
  return {
    id: row.id,
    media_type: "episode",
    title: row.title,
    original_title: row.original_title,
    year: row.year,
    release_date: row.release_date,
    release_date_precision: /^\d{4}-\d{2}-\d{2}$/u.test(String(row.release_date || "")) ? "day" : row.year ? "year" : null,
    season_number: row.season_number,
    episode_number: row.episode_number,
    overview: row.overview,
    runtime_minutes: row.runtime_minutes,
    languages: parseJson(row.languages_json, []),
    poster_url: row.poster_url,
    backdrop_url: row.backdrop_url,
    external_source: row.external_source,
    external_id: row.external_id,
    external_url: externalUrlFor(row),
    metadata_status: row.metadata_status,
    metadata_confidence: row.metadata_confidence,
    tvshow_id: row.tvshow_id,
  };
}

function episodeListingRecord(row) {
  const record = episodeRecord(row);
  const season = Number(row.season_number || 0);
  const episode = Number(row.episode_number || 0);
  const coordinates = season || episode ? ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` : "";
  return {
    ...record,
    category: "series",
    display_title: `${row.series_title || row.title || ""}${coordinates}`.trim(),
    series_title: row.series_title || null,
    series_overview: row.series_overview || null,
    series_poster_url: row.series_poster_url || null,
    series_backdrop_url: row.series_backdrop_url || null,
    genres: parseJson(row.series_genres_json, []),
    updated_at: row.updated_at || null,
  };
}

function prepareRootRows(db, category, minId, maxId, directCounts, tvCounts, releaseEvidence) {
  const where = CATEGORY_MEDIA[category] || "1=1";
  return db.prepare(`
    SELECT m.*
    FROM media m
    WHERE m.is_active = 1 AND m.category = ? AND ${where}
      AND m.id >= ? AND m.id < ?
    ORDER BY m.id ASC
  `).all(category, minId, maxId).map(row => ({
    ...row,
    version_count: row.media_type === "tv" ? (tvCounts.get(row.id) || 0) : (directCounts.get(row.id) || 0),
    latest_episode_date: releaseEvidence.get(row.id)?.latest_episode_date || null,
    latest_episode_year: releaseEvidence.get(row.id)?.latest_episode_year || null,
  })).filter(row => row.version_count > 0);
}

function aliasesFor(db, ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT media_id, alias, language, source FROM media_aliases WHERE media_id IN (${ids.map(() => "?").join(",")}) ORDER BY media_id, alias`).all(...ids);
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.media_id)) result.set(row.media_id, []);
    result.get(row.media_id).push(row);
  }
  return result;
}

function buildPublicCatalog(options) {
  const database = path.resolve(options.database);
  const output = path.resolve(options.outputDir);
  const generationId = String(options.generationId || "");
  if (!database || !fs.existsSync(database) || fs.lstatSync(database).isSymbolicLink()) throw new Error("UNSAFE_DATABASE");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(generationId)) throw new Error("INVALID_GENERATION_ID");
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("OUTPUT_DIR_MUST_BE_EMPTY");
  safeMkdir(output);
  const root = path.join(output, "catalog", "v1");
  const generation = path.join(root, "generations", generationId);
  const objectsDir = path.join(generation, "objects");
  safeMkdir(objectsDir);
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const dbSha256 = sha256File(database);
    const maxId = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM media").get().max_id;
    const mapQuery = (statement, key, value) => {
      const map = new Map();
      for (const row of statement.iterate()) map.set(row[key], value ? value(row) : row);
      return map;
    };
    const directCounts = mapQuery(db.prepare("SELECT media_id, COUNT(*) AS count FROM files WHERE is_active=1 AND is_playable_video=1 GROUP BY media_id"), "media_id", row => row.count);
    const tvCounts = mapQuery(db.prepare("SELECT ep.tvshow_id AS media_id, COUNT(*) AS count FROM media ep JOIN media tv ON tv.id=ep.tvshow_id JOIN files f ON f.media_id=ep.id WHERE ep.media_type='episode' AND ep.tvshow_id IS NOT NULL AND ep.is_active=1 AND tv.is_active=1 AND tv.category IN ('movies','series','concerts','sports','music-videos','other') AND f.is_active=1 AND f.is_playable_video=1 GROUP BY ep.tvshow_id"), "media_id", row => row.count);
    const releaseEvidence = mapQuery(db.prepare(`
      SELECT tvshow_id,
        MAX(CASE WHEN release_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND release_date <= date('now') THEN release_date END) AS latest_episode_date,
        MAX(CASE WHEN year IS NOT NULL AND year <= CAST(strftime('%Y', 'now') AS INTEGER) THEN year END) AS latest_episode_year
      FROM media WHERE tvshow_id IS NOT NULL AND is_active=1 GROUP BY tvshow_id
    `), "tvshow_id");
    const inventory = [];
    const detailsInventory = [];
    const listingRecordsByCategory = new Map();
    const objectMap = new Map();
    const addObject = (kind, category, shard, value, count) => {
      const artifact = writeObject(objectsDir, value);
      const key = artifact.sha256;
      if (!objectMap.has(key)) objectMap.set(key, { ...artifact, kind, category, shard, record_count: count });
      return objectMap.get(key);
    };

    for (const category of CATEGORIES) {
      const shards = [];
      const listingRecords = [];
      let categoryCount = 0;
      for (let range = 0; range <= rangeFor(maxId); range++) {
        const rows = prepareRootRows(db, category, range * SHARD_RANGE, (range + 1) * SHARD_RANGE, directCounts, tvCounts, releaseEvidence);
        if (!rows.length) continue;
        const aliasMap = aliasesFor(db, rows.map(row => row.id));
        const details = rows.map(row => baseMedia(row, aliasMap.get(row.id) || []));
        const records = rows.map(row => listingMedia(row, aliasMap.get(row.id) || []));
        listingRecords.push(...records);
        const artifact = addObject("media", category, shardName("media", category, range), records, records.length);
        const detailArtifact = addObject("details", category, shardName("details", category, range), details, details.length);
        shards.push({ name: artifact.file, sha256: artifact.sha256, compressed_bytes: artifact.compressed_bytes, uncompressed_bytes: artifact.uncompressed_bytes, record_count: records.length, range });
        let detailEntry = detailsInventory.find(entry => entry.category === category);
        if (!detailEntry) { detailEntry = { category, record_count: 0, shards: [] }; detailsInventory.push(detailEntry); }
        detailEntry.shards.push({ name: detailArtifact.file, sha256: detailArtifact.sha256, compressed_bytes: detailArtifact.compressed_bytes, uncompressed_bytes: detailArtifact.uncompressed_bytes, record_count: details.length, range });
        detailEntry.record_count += details.length;
        categoryCount += records.length;
      }
      inventory.push({ category, record_count: categoryCount, shards });
      listingRecordsByCategory.set(category, listingRecords);
    }

    const listings = [];
    for (const entry of [
      { category: "movies", sort: "release_date_desc" },
      { category: "series", sort: "series_release_date_desc" },
    ]) {
      const rows = releaseListingRows(listingRecordsByCategory.get(entry.category) || []);
      const shards = [];
      for (let offset = 0; offset < rows.length; offset += LISTING_CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + LISTING_CHUNK_SIZE);
        const range = Math.floor(offset / LISTING_CHUNK_SIZE);
        const artifact = addObject("listing", entry.category, `listing-${entry.category}-${entry.sort}-${String(range).padStart(4, "0")}`, chunk, chunk.length);
        shards.push({ name: artifact.file, sha256: artifact.sha256, compressed_bytes: artifact.compressed_bytes, uncompressed_bytes: artifact.uncompressed_bytes, record_count: chunk.length, range });
      }
      listings.push({ category: entry.category, sort: entry.sort, order: "desc", chunk_size: LISTING_CHUNK_SIZE, record_count: rows.length, shards });
    }

    const fileShards = [];
    let fileCount = 0;
    let currentRange = null;
    let currentRecords = [];
    const flushFiles = () => {
      if (group) { currentRecords.push(group); group = null; }
      if (currentRange === null || !currentRecords.length) return;
      const artifact = addObject("files", "all", shardName("files", "all", currentRange), currentRecords, currentRecords.length);
      fileShards.push({ name: artifact.file, sha256: artifact.sha256, compressed_bytes: artifact.compressed_bytes, uncompressed_bytes: artifact.uncompressed_bytes, record_count: currentRecords.length, range: currentRange });
      currentRecords = [];
    };
    const fileRows = db.prepare("SELECT f.* FROM files f JOIN media owner ON owner.id=f.media_id LEFT JOIN media tv ON tv.id=owner.tvshow_id WHERE f.is_active=1 AND f.is_playable_video=1 AND owner.is_active=1 AND ((owner.media_type='episode' AND owner.tvshow_id IS NOT NULL AND tv.is_active=1 AND tv.category IN ('movies','series','concerts','sports','music-videos','other')) OR (owner.media_type<>'episode' AND owner.category IN ('movies','series','concerts','sports','music-videos','other'))) ORDER BY f.media_id ASC, f.id ASC").iterate();
    let group = null;
    for (const row of fileRows) {
      const range = rangeFor(row.media_id);
      if (currentRange !== null && range !== currentRange) flushFiles();
      currentRange = range;
      if (!group || group.id !== row.media_id) {
        if (group) currentRecords.push(group);
        group = { id: row.media_id, files: [] };
      }
      group.files.push(fileRecord(row));
      fileCount++;
    }
    flushFiles();

    const episodeShards = [];
    const episodeListingRows = [];
    let episodeCount = 0;
    const seasonSummaryRows = db.prepare(`
      SELECT ep.tvshow_id, ep.season_number,
        COUNT(DISTINCT ep.id) AS episode_count,
        MAX(COALESCE(ep.year, CAST(substr(ep.release_date, 1, 4) AS INTEGER))) AS year,
        MAX(ep.runtime_minutes) AS runtime_minutes,
        MIN(NULLIF(ep.poster_url, '')) AS poster_url,
        MIN(NULLIF(ep.backdrop_url, '')) AS backdrop_url,
        GROUP_CONCAT(DISTINCT upper(language.value)) AS languages
      FROM media ep
      JOIN media tv ON tv.id = ep.tvshow_id
      LEFT JOIN files season_file
        ON season_file.media_id = ep.id
        AND season_file.is_active = 1
        AND season_file.is_playable_video = 1
      LEFT JOIN json_each(CASE
        WHEN json_valid(season_file.parsed_languages_json) THEN season_file.parsed_languages_json
        ELSE '[]'
      END) language ON true
      WHERE ep.is_active = 1
        AND ep.media_type = 'episode'
        AND ep.tvshow_id IS NOT NULL
        AND tv.is_active = 1
        AND tv.category IN ('movies','series','concerts','sports','music-videos','other')
        AND ep.season_number IS NOT NULL
      GROUP BY ep.tvshow_id, ep.season_number
      ORDER BY ep.tvshow_id, ep.season_number
    `).all();
    const seasonsBySeries = new Map();
    for (const row of seasonSummaryRows) {
      if (!seasonsBySeries.has(row.tvshow_id)) seasonsBySeries.set(row.tvshow_id, []);
      const summary = {
        season_number: row.season_number,
        episode_count: row.episode_count,
      };
      if (row.year) summary.year = row.year;
      if (row.runtime_minutes) summary.runtime_minutes = row.runtime_minutes;
      if (row.poster_url) summary.poster_url = row.poster_url;
      if (row.backdrop_url) summary.backdrop_url = row.backdrop_url;
      if (row.languages) summary.languages = row.languages.split(",").filter(Boolean).sort();
      seasonsBySeries.get(row.tvshow_id).push(summary);
    }
    currentRange = null; currentRecords = []; group = null;
    const flushEpisodes = () => {
      if (group) { currentRecords.push(group); group = null; }
      if (currentRange === null || !currentRecords.length) return;
      const artifact = addObject("episodes", "series", shardName("episodes", "series", currentRange), currentRecords, currentRecords.length);
      episodeShards.push({ name: artifact.file, sha256: artifact.sha256, compressed_bytes: artifact.compressed_bytes, uncompressed_bytes: artifact.uncompressed_bytes, record_count: currentRecords.length, range: currentRange });
      currentRecords = [];
    };
    const episodeRows = db.prepare("SELECT ep.*, tv.title AS series_title, tv.overview AS series_overview, tv.poster_url AS series_poster_url, tv.backdrop_url AS series_backdrop_url, tv.genres_json AS series_genres_json FROM media ep JOIN media tv ON tv.id=ep.tvshow_id WHERE ep.is_active=1 AND ep.media_type='episode' AND ep.tvshow_id IS NOT NULL AND tv.is_active=1 AND tv.category IN ('movies','series','concerts','sports','music-videos','other') ORDER BY ep.tvshow_id ASC, ep.season_number ASC, ep.episode_number ASC, ep.id ASC").iterate();
    for (const row of episodeRows) {
      const range = rangeFor(row.tvshow_id);
      if (currentRange !== null && range !== currentRange) flushEpisodes();
      currentRange = range;
      if (!group || group.id !== row.tvshow_id) {
        if (group) currentRecords.push(group);
        group = { id: row.tvshow_id, episodes: [], seasons: seasonsBySeries.get(row.tvshow_id) || [] };
      }
      group.episodes.push(episodeRecord(row));
      episodeListingRows.push(episodeListingRecord(row));
      episodeCount++;
    }
    flushEpisodes();

    episodeListingRows.sort((left, right) => {
      const leftUpdated = String(left.updated_at || "");
      const rightUpdated = String(right.updated_at || "");
      if (leftUpdated !== rightUpdated) return rightUpdated.localeCompare(leftUpdated);
      const leftRelease = String(left.release_date || "");
      const rightRelease = String(right.release_date || "");
      if (leftRelease !== rightRelease) return rightRelease.localeCompare(leftRelease);
      return Number(right.id || 0) - Number(left.id || 0);
    });
    const episodeListingShards = [];
    for (let offset = 0; offset < episodeListingRows.length; offset += LISTING_CHUNK_SIZE) {
      const chunk = episodeListingRows.slice(offset, offset + LISTING_CHUNK_SIZE);
      const range = Math.floor(offset / LISTING_CHUNK_SIZE);
      const artifact = addObject("listing", "series", `listing-series-episode_recent-${String(range).padStart(4, "0")}`, chunk, chunk.length);
      episodeListingShards.push({ name: artifact.file, sha256: artifact.sha256, compressed_bytes: artifact.compressed_bytes, uncompressed_bytes: artifact.uncompressed_bytes, record_count: chunk.length, range });
    }
    listings.push({ category: "series", sort: "episode_recent", order: "desc", chunk_size: LISTING_CHUNK_SIZE, record_count: episodeListingRows.length, shards: episodeListingShards });

    const manifest = {
      schema: SCHEMA,
      schema_version: SCHEMA_VERSION,
      generation_id: generationId,
      build_source_commit: String(options.buildSourceCommit || ""),
      source_database_sha256: dbSha256,
      source_schema_version: Number(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version || 0),
      authoritative_source: "private catalog.sqlite",
      unclassified_exported: 0,
      shard_range: SHARD_RANGE,
      sort_contracts: {
        movies_new_releases: "release_date DESC, year DESC, id DESC; future dates excluded",
        series_new_releases: "latest episode/series release evidence DESC, year DESC, id DESC; future dates excluded",
        title: "display_title NFC, case-insensitive ASC, id ASC",
      },
      categories: inventory,
      details: { record_count: detailsInventory.reduce((sum, entry) => sum + entry.record_count, 0), categories: detailsInventory, shards: detailsInventory.flatMap(entry => entry.shards) },
      listings,
      files: { record_count: fileCount, group_count: fileShards.reduce((n, shard) => n + shard.record_count, 0), shards: fileShards },
      episodes: { record_count: episodeCount, group_count: episodeShards.reduce((n, shard) => n + shard.record_count, 0), shards: episodeShards },
      object_count: objectMap.size,
      object_bytes_compressed: [...objectMap.values()].reduce((n, x) => n + x.compressed_bytes, 0),
      object_bytes_uncompressed: [...objectMap.values()].reduce((n, x) => n + x.uncompressed_bytes, 0),
      immutable_generation: true,
      export_complete: true,
      object_path_template: "objects/{sha256}.json.gz",
    };
    if (options.objectBaseUrl) manifest.object_base_url = String(options.objectBaseUrl).replace(/\/$/u, "");
    writeJson(path.join(generation, "manifest.json"), manifest);
    writeJson(path.join(root, "current.json"), { schema: "webshare-atlas-public-catalog-current/v1", schema_version: 1, generation_id: generationId, generation_path: `generations/${generationId}`, manifest_path: `generations/${generationId}/manifest.json`, manifest_sha256: sha256(fs.readFileSync(path.join(generation, "manifest.json"))) });
    return { manifest, root, generation, objectsDir };
  } finally { db.close(); }
}

function validatePublicCatalog(root) {
  const absolute = path.resolve(root);
  const pointer = JSON.parse(fs.readFileSync(path.join(absolute, "current.json"), "utf8"));
  if (pointer.schema !== "webshare-atlas-public-catalog-current/v1" || pointer.schema_version !== 1) throw new Error("INVALID_PUBLIC_POINTER");
  const manifestPath = path.join(absolute, pointer.manifest_path);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== SCHEMA || ![1, 2].includes(manifest.schema_version) || manifest.export_complete !== true || manifest.unclassified_exported !== 0) throw new Error("INVALID_PUBLIC_MANIFEST");
  const manifestHash = sha256(fs.readFileSync(manifestPath));
  if (manifestHash !== pointer.manifest_sha256) throw new Error("PUBLIC_MANIFEST_HASH_MISMATCH");
  const seenMedia = new Set(); const seenFiles = new Set(); const seenIdents = new Set(); const rootVariants = new Map(); const fileVariants = new Map(); const episodeOwners = new Map(); let media = 0; let files = 0; let episodes = 0; let rootVariantTotal = 0;
  const readObject = (item) => {
    const file = path.join(absolute, path.dirname(manifestPath).replace(absolute, ""), "objects", item.sha256 + ".json.gz");
    const candidate = path.join(path.dirname(manifestPath), "objects", item.sha256 + ".json.gz");
    const objectPath = fs.existsSync(candidate) ? candidate : path.join(absolute, "objects", item.sha256 + ".json.gz");
    const bytes = fs.readFileSync(objectPath);
    if (sha256(bytes) !== item.sha256 || bytes.length !== item.compressed_bytes) throw new Error(`PUBLIC_OBJECT_HASH_MISMATCH:${item.sha256}`);
    return JSON.parse(zlib.gunzipSync(bytes).toString("utf8"));
  };
  for (const category of manifest.categories) for (const shard of category.shards) for (const row of readObject(shard)) {
    if (!row.id || seenMedia.has(row.id) || row.category === "unclassified") throw new Error("INVALID_PUBLIC_MEDIA_IDENTITY");
    if (!Number.isInteger(Number(row.variant_count || row.available_files_count)) || Number(row.variant_count || row.available_files_count) < 1) throw new Error("INVALID_PUBLIC_MEDIA_VARIANT_COUNT");
    seenMedia.add(row.id); rootVariants.set(Number(row.id), Number(row.variant_count || row.available_files_count)); rootVariantTotal += Number(row.variant_count || row.available_files_count); media++;
  }
  if (manifest.schema_version >= 2) {
    const detailIds = new Set();
    for (const shard of manifest.details?.shards || []) for (const row of readObject(shard)) {
      if (!row.id || detailIds.has(Number(row.id)) || !seenMedia.has(Number(row.id))) throw new Error("INVALID_PUBLIC_DETAIL_IDENTITY");
      detailIds.add(Number(row.id));
    }
    if (detailIds.size !== seenMedia.size) throw new Error(`PUBLIC_DETAIL_COUNT_MISMATCH:${detailIds.size}:${seenMedia.size}`);
  }
  for (const shard of manifest.files.shards) for (const group of readObject(shard)) {
    fileVariants.set(Number(group.id), (group.files || []).length);
    for (const file of group.files || []) { if (!file.id || !file.ident || seenFiles.has(file.id) || seenIdents.has(file.ident) || !file.needs_file_link) throw new Error("INVALID_PUBLIC_FILE_IDENTITY"); seenFiles.add(file.id); seenIdents.add(file.ident); files++; }
  }
  for (const shard of manifest.episodes.shards) for (const group of readObject(shard)) {
    if (!group.id || !Array.isArray(group.episodes)) throw new Error("INVALID_PUBLIC_EPISODE_GROUP");
    for (const episode of group.episodes) episodeOwners.set(Number(episode.id), Number(group.id));
    episodes += group.episodes.length;
  }
  const rootFileVariants = new Map();
  for (const [id, count] of fileVariants) {
    const rootId = rootVariants.has(id) ? id : episodeOwners.get(id);
    if (!rootId) throw new Error(`PUBLIC_ORPHAN_VARIANT_GROUP:${id}:${count}`);
    rootFileVariants.set(rootId, (rootFileVariants.get(rootId) || 0) + count);
  }
  for (const [id, count] of rootVariants) if (rootFileVariants.get(id) !== count) throw new Error(`PUBLIC_ROOT_VARIANT_GROUP_MISMATCH:${id}:${count}:${rootFileVariants.get(id) || 0}`);
  for (const listing of manifest.listings || []) {
    const listingIds = new Set(); let listingCount = 0;
    for (const shard of listing.shards || []) for (const row of readObject(shard)) {
      const isEpisodeListing = listing.sort === "episode_recent" && episodeOwners.has(Number(row.id));
      if (!row.id || listingIds.has(Number(row.id)) || row.category !== listing.category || (!rootVariants.has(Number(row.id)) && !isEpisodeListing)) throw new Error(`INVALID_PUBLIC_LISTING_ROW:${listing.category}`);
      listingIds.add(Number(row.id)); listingCount++;
    }
    if (listingCount !== Number(listing.record_count || 0)) throw new Error(`PUBLIC_LISTING_COUNT_MISMATCH:${listing.category}:${listingCount}:${listing.record_count}`);
  }
  if (rootVariantTotal !== files) throw new Error(`PUBLIC_ROOT_VARIANT_TOTAL_MISMATCH:${rootVariantTotal}:${files}`);
  return { pass: true, generation_id: manifest.generation_id, media, files, episodes, objects: manifest.object_count, unclassified: 0 };
}

module.exports = { SCHEMA, SCHEMA_VERSION, SHARD_RANGE, CATEGORIES, buildPublicCatalog, validatePublicCatalog, sha256, sha256File };
