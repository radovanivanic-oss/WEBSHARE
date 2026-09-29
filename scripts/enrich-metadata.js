#!/usr/bin/env node
const { classifyMedia } = require("../lib/media-classifier");
const { selectBestMatch } = require("../lib/match-scorer");
const { TmdbClient, isTemporaryError } = require("../providers/tmdb-client");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { nowIso, openCatalogDatabase } = require("../src/db/catalog-db");
const { reconcileCanonicalSeriesInPlace } = require("../lib/series-identity");
const { migrateDatabase } = require("../src/db/migrate");
const { rebuildMediaFts, setAppState } = require("../src/repositories/media-repository");
const { buildEnrichmentCandidates } = require("../lib/metadata-enrichment");

function parseArguments(argv) {
  const options = {
    limit: 1000,
    dryRun: false,
    retryFailed: false,
    maxAttempts: 3,
    onlyPending: false,
    recentFirst: false,
    provider: "tmdb",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--retry-failed") options.retryFailed = true;
    else if (value === "--max-attempts") options.maxAttempts = Math.max(1, Number.parseInt(argv[++index], 10) || 3);
    else if (value === "--only-pending") options.onlyPending = true;
    else if (value === "--recent-first") options.recentFirst = true;
    else if (value === "--limit") options.limit = Number.parseInt(argv[++index], 10) || 1000;
    else if (value === "--provider") options.provider = argv[++index] || "tmdb";
  }
  return options;
}

function jobStatuses(options) {
  if (options.onlyPending) return ["pending"];
  if (options.retryFailed) return ["pending", "temporary_error", "not_found", "ambiguous"];
  return ["pending", "temporary_error"];
}

function nextRetryAt(status, attempts, maxAttempts) {
  if (status === "temporary_error") return new Date(Date.now() + 3600000).toISOString();
  if (!maxAttempts || attempts >= maxAttempts) return null;
  const days = status === "ambiguous" ? 7 : Math.min(30, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + days * 86400000).toISOString();
}

function mapMetadata(details, type) {
  const credits = details.credits || {};
  const directors = (credits.crew || [])
    .filter((person) => person.job === "Director")
    .map((person) => person.name)
    .filter(Boolean);
  return {
    externalId: String(details.id),
    mediaType: type,
    title: details.title || details.name || "",
    originalTitle: details.original_title || details.original_name || null,
    releaseDate: details.release_date || details.first_air_date || null,
    year: Number.parseInt(String(details.release_date || details.first_air_date || "").slice(0, 4), 10) || null,
    overview: details.overview || null,
    genres: details.genres || [],
    runtime: details.runtime || (details.episode_run_time || [])[0] || null,
    rating: details.vote_average || 0,
    voteCount: details.vote_count || 0,
    countries: (details.production_countries || details.origin_country || []).map((item) => item.name || item.iso_3166_1 || item),
    languages: details.spoken_languages || [],
    director: directors.join(", ") || null,
    cast: (credits.cast || []).slice(0, 15).map((person) => ({ id: person.id, name: person.name, character: person.character })),
    posterUrl: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
    backdropUrl: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
    adult: details.adult ? 1 : 0,
    aliases: (details.alternative_titles?.titles || details.alternative_titles?.results || [])
      .map((item) => item.title || item.name)
      .filter(Boolean),
  };
}

function applyMovieMatch(database, job, candidate, metadata, confidence, config) {
  const duplicate = database.prepare(`
    SELECT * FROM media
    WHERE external_source = 'tmdb' AND external_id = ? AND media_type = 'movie'
    LIMIT 1
  `).get(metadata.externalId);
  const targetMediaId = duplicate?.id || candidate.media_id;
  const media = database.prepare("SELECT * FROM media WHERE id = ?").get(targetMediaId);
  const classification = classifyMedia({
    media: { ...metadata, media_type: "movie", external_id: metadata.externalId },
    candidate: {
      candidateType: candidate.candidate_type,
      parseConfidence: candidate.parse_confidence,
      title: candidate.normalized_title,
    },
  });
  const now = nowIso();
  if (targetMediaId !== candidate.media_id) {
    database.prepare("UPDATE files SET media_id = ?, updated_at = ? WHERE candidate_id = ?")
      .run(targetMediaId, now, candidate.id);
    database.prepare("UPDATE candidates SET media_id = ?, updated_at = ? WHERE id = ?")
      .run(targetMediaId, now, candidate.id);
    database.prepare(`
      UPDATE media SET is_active = CASE WHEN EXISTS (
        SELECT 1 FROM files WHERE files.media_id = media.id AND files.is_active = 1 AND files.is_playable_video = 1
      ) THEN 1 ELSE 0 END WHERE id IN (?, ?)
    `).run(targetMediaId, candidate.media_id);
  }
  database.prepare(`
    UPDATE media SET external_source = 'tmdb', external_id = ?, external_url = ?, media_type = 'movie',
      category = ?, title = ?, original_title = ?, year = ?, release_date = ?, overview = ?,
      genres_json = ?, runtime_minutes = ?, rating = ?, vote_count = ?, countries_json = ?,
      languages_json = ?, director = ?, cast_json = ?, poster_url = ?, backdrop_url = ?,
      adult = ?, metadata_language = ?, metadata_status = 'matched', metadata_confidence = ?,
      metadata_updated_at = ?, classifier_version = ?, updated_at = ? WHERE id = ?
  `).run(
    metadata.externalId, `https://www.themoviedb.org/movie/${metadata.externalId}`,
    classification.category, metadata.title || candidate.normalized_title,
    metadata.originalTitle, metadata.year, metadata.releaseDate, metadata.overview,
    JSON.stringify(metadata.genres), metadata.runtime, metadata.rating, metadata.voteCount,
    JSON.stringify(metadata.countries), JSON.stringify(metadata.languages), metadata.director,
    JSON.stringify(metadata.cast), metadata.posterUrl, metadata.backdropUrl, metadata.adult,
    config.tmdbLanguage, confidence, now, classification.classifierVersion, now, targetMediaId
  );
  if (media.category !== classification.category) {
    database.prepare(`
      INSERT INTO classification_audit(media_id, old_category, new_category, reason, confidence, classifier_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(targetMediaId, media.category, classification.category, classification.reason, classification.confidence, classification.classifierVersion, now);
  }
  return [targetMediaId];
}

function applyTvMatch(database, job, metadata, confidence, config) {
  const now = nowIso();
  const showKey = `tmdb:tv:${metadata.externalId}`;
  const existingShow = database.prepare("SELECT id FROM media WHERE media_key = ?").get(showKey);
  const showClassification = classifyMedia({ media: { ...metadata, media_type: "tv", external_id: metadata.externalId } });
  const showId = existingShow?.id || database.prepare(`
    INSERT INTO media(
      media_key, external_source, external_id, external_url, media_type, category, title, original_title,
      year, release_date, overview, genres_json, runtime_minutes, rating, vote_count,
      countries_json, languages_json, director, cast_json, poster_url, backdrop_url,
      adult, metadata_language, metadata_status, metadata_confidence, metadata_updated_at,
      classifier_version, created_at, updated_at
    ) VALUES (?, 'tmdb', ?, ?, 'tv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', ?, ?, ?, ?, ?)
  `).run(
    showKey, metadata.externalId, `https://www.themoviedb.org/tv/${metadata.externalId}`,
    showClassification.category, metadata.title, metadata.originalTitle,
    metadata.year, metadata.releaseDate, metadata.overview, JSON.stringify(metadata.genres), metadata.runtime,
    metadata.rating, metadata.voteCount, JSON.stringify(metadata.countries), JSON.stringify(metadata.languages),
    metadata.director, JSON.stringify(metadata.cast), metadata.posterUrl, metadata.backdropUrl, metadata.adult,
    config.tmdbLanguage, confidence, now, showClassification.classifierVersion, now, now
  ).lastInsertRowid;
  if (existingShow) {
    database.prepare(`
      UPDATE media SET external_source = 'tmdb', external_id = ?, external_url = ?,
        title = ?, original_title = ?, category = ?, year = ?, release_date = ?, overview = ?, genres_json = ?,
        poster_url = ?, backdrop_url = ?, rating = ?, vote_count = ?, metadata_status = 'matched',
        metadata_confidence = ?, metadata_updated_at = ?, updated_at = ? WHERE id = ?
    `).run(metadata.externalId, `https://www.themoviedb.org/tv/${metadata.externalId}`,
      metadata.title, metadata.originalTitle, showClassification.category, metadata.year, metadata.releaseDate, metadata.overview,
      JSON.stringify(metadata.genres), metadata.posterUrl, metadata.backdropUrl, metadata.rating,
      metadata.voteCount, confidence, now, now, showId);
  }

  const episodeRows = database.prepare("SELECT * FROM candidates WHERE lookup_key = ?").all(job.candidate_key);
  const mediaIds = [showId];
  const previousShowIds = new Set();
  for (const episode of episodeRows) {
    if (!episode.media_id) continue;
    const previousEpisodeMedia = database.prepare("SELECT tvshow_id FROM media WHERE id = ?").get(episode.media_id);
    if (previousEpisodeMedia?.tvshow_id) previousShowIds.add(previousEpisodeMedia.tvshow_id);
    const episodeExternalId = `${metadata.externalId}:s${episode.season_number}:e${episode.episode_number}`;
    const duplicateEpisode = database.prepare(`
      SELECT id FROM media
      WHERE external_source = 'tmdb' AND external_id = ? AND media_type = 'episode'
      LIMIT 1
    `).get(episodeExternalId);
    const targetEpisodeMediaId = duplicateEpisode?.id || episode.media_id;
    if (targetEpisodeMediaId !== episode.media_id) {
      database.prepare("UPDATE files SET media_id = ?, updated_at = ? WHERE candidate_id = ?")
        .run(targetEpisodeMediaId, now, episode.id);
      database.prepare("UPDATE candidates SET media_id = ?, updated_at = ? WHERE id = ?")
        .run(targetEpisodeMediaId, now, episode.id);
    }
    database.prepare(`
      UPDATE media SET external_source = 'tmdb', external_id = ?, external_url = ?, media_type = 'episode',
        category = 'series', tvshow_id = ?, poster_url = COALESCE(poster_url, ?),
        backdrop_url = COALESCE(backdrop_url, ?), metadata_language = ?,
        metadata_status = 'matched', metadata_confidence = ?, metadata_updated_at = ?,
        classifier_version = ?, updated_at = ? WHERE id = ?
    `).run(
      episodeExternalId,
      `https://www.themoviedb.org/tv/${metadata.externalId}/season/${episode.season_number}/episode/${episode.episode_number}`,
      showId,
      metadata.posterUrl, metadata.backdropUrl, config.tmdbLanguage, confidence, now,
      showClassification.classifierVersion, now, targetEpisodeMediaId
    );
    database.prepare("UPDATE candidates SET status = 'matched', updated_at = ? WHERE id = ?")
      .run(now, episode.id);
    mediaIds.push(targetEpisodeMediaId);
  }
  database.prepare("UPDATE media SET is_active = 1 WHERE id = ?").run(showId);
  reconcileCanonicalSeriesInPlace(database, showId, { title: metadata.title, year: metadata.year });
  for (const previousShowId of previousShowIds) {
    if (previousShowId === showId) continue;
    database.prepare(`
      UPDATE media SET is_active = CASE WHEN EXISTS (
        SELECT 1 FROM media episode WHERE episode.tvshow_id = media.id AND episode.is_active = 1
      ) THEN 1 ELSE 0 END WHERE id = ?
    `).run(previousShowId);
  }
  return [...new Set(mediaIds)];
}

function addAliases(database, mediaIds, metadata) {
  const insert = database.prepare(`
    INSERT INTO media_aliases(media_id, alias, normalized_alias, language, source, created_at)
    VALUES (?, ?, lower(trim(?)), NULL, 'tmdb', ?)
    ON CONFLICT(media_id, normalized_alias) DO NOTHING
  `);
  const aliases = [metadata.title, metadata.originalTitle, ...metadata.aliases].filter(Boolean);
  for (const mediaId of mediaIds) {
    for (const alias of aliases) insert.run(mediaId, alias, alias, nowIso());
  }
}

async function processJob(database, client, job, config, options) {
  const candidate = database.prepare("SELECT * FROM candidates WHERE id = ?").get(job.candidate_id);
  if (!candidate) throw new Error(`Chýba candidate ${job.candidate_id}.`);
  const media = candidate.media_id ? database.prepare("SELECT * FROM media WHERE id = ?").get(candidate.media_id) : null;
  const files = candidate.media_id
    ? database.prepare("SELECT parsed_title, parsed_year, original_name FROM files WHERE media_id = ? AND is_active = 1 AND is_playable_video = 1 ORDER BY id DESC LIMIT 12").all(candidate.media_id)
    : [];
  const aliases = candidate.media_id
    ? database.prepare("SELECT alias FROM media_aliases WHERE media_id = ? ORDER BY id").all(candidate.media_id)
    : [];
  const candidates = buildEnrichmentCandidates({
    media: media || { title: job.parsed_title, year: job.parsed_year, media_type: job.candidate_type },
    files: [{ parsed_title: job.parsed_title, parsed_year: job.parsed_year }, ...files],
    aliases,
    limit: 5,
  });
  if (!candidates.length) candidates.push({ title: job.parsed_title, year: job.parsed_year, source: "job" });
  let selection = { status: "not_found", best: null, scored: [] };
  for (const enrichmentCandidate of candidates) {
    const candidateForScore = { title: enrichmentCandidate.title, parsedYear: enrichmentCandidate.year };
    const results = await client.search(candidateForScore, job.candidate_type);
    const current = selectBestMatch(candidateForScore, results, job.candidate_type, {
      auto: config.metadataAutoMatchThreshold,
      ambiguous: config.metadataAmbiguousThreshold,
    });
    if (!selection.best || (current.best && current.best.score > selection.best.score)) selection = current;
    if (current.status === "matched") break;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ job: job.id, key: job.candidate_key, status: selection.status, best: selection.best?.score || null }));
    return selection.status;
  }
  const now = nowIso();
  if (selection.status !== "matched") {
    const attempts = Number(job.attempts || 0) + 1;
    const nextAttempt = nextRetryAt(selection.status, attempts, options.maxAttempts);
    database.prepare(`
      UPDATE metadata_jobs SET status = ?, attempts = attempts + 1, confidence = ?,
        selected_source = 'tmdb', selected_external_id = ?, last_error = NULL,
        next_attempt_at = ?, locked_at = NULL, updated_at = ? WHERE id = ?
    `).run(selection.status, selection.best?.score || null, selection.best?.result?.id || null, nextAttempt, now, job.id);
    return selection.status;
  }
  const details = await client.details(job.candidate_type, selection.best.result.id);
  const metadata = mapMetadata(details, job.candidate_type);
  const apply = database.transaction(() => {
    const mediaIds = job.candidate_type === "tv"
      ? applyTvMatch(database, job, metadata, selection.best.score, config)
      : applyMovieMatch(database, job, candidate, metadata, selection.best.score, config);
    addAliases(database, mediaIds, metadata);
    for (const mediaId of mediaIds) rebuildMediaFts(database, mediaId);
    database.prepare(`
      UPDATE metadata_jobs SET status = 'matched', attempts = attempts + 1,
        selected_source = 'tmdb', selected_external_id = ?, confidence = ?,
        last_error = NULL, locked_at = NULL, updated_at = ? WHERE id = ?
    `).run(metadata.externalId, selection.best.score, now, job.id);
    database.prepare("UPDATE candidates SET status = 'matched', updated_at = ? WHERE lookup_key = ?")
      .run(now, job.candidate_key);
  });
  apply();
  return "matched";
}

async function runWorker(options) {
  const config = getCatalogConfig();
  if (options.provider !== "tmdb") throw new Error(`Nepodporovaný provider: ${options.provider}`);
  if (!config.tmdbApiKey) {
    console.log("TMDB_API_KEY chýba. Metadata enrichment sa nespustil; crawler ani databáza neboli zmenené.");
    return;
  }
  const database = openCatalogDatabase(config.databasePath);
  migrateDatabase(database, config.migrationsDir, { logger: console });
  const staleBefore = new Date(Date.now() - 3600000).toISOString();
  database.prepare(`
    UPDATE metadata_jobs SET status = 'temporary_error', next_attempt_at = ?, locked_at = NULL,
      last_error = 'stale worker lock recovered', updated_at = ?
    WHERE status = 'processing' AND (locked_at IS NULL OR locked_at < ?)
  `).run(nowIso(), nowIso(), staleBefore);
  const client = new TmdbClient(config, database, console);
  const statuses = jobStatuses(options);
  const placeholders = statuses.map(() => "?").join(",");
  const orderBy = options.recentFirst
    ? "attempts, CASE WHEN candidate_type = 'movie' THEN 0 ELSE 1 END, parsed_year DESC, id"
    : "attempts, id";
  const jobs = database.prepare(`
    SELECT * FROM metadata_jobs
    WHERE status IN (${placeholders}) AND (status NOT IN ('not_found', 'ambiguous') OR attempts < ?)
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY ${orderBy} LIMIT ?
  `).all(...statuses, options.maxAttempts, nowIso(), options.limit);
  let cursor = 0;
  const counts = {};
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  async function worker() {
    while (!stopping) {
      const job = jobs[cursor++];
      if (!job) return;
      if (!options.dryRun) {
        database.prepare("UPDATE metadata_jobs SET status = 'processing', locked_at = ?, updated_at = ? WHERE id = ?")
          .run(nowIso(), nowIso(), job.id);
      }
      try {
        const status = await processJob(database, client, job, config, options);
        counts[status] = (counts[status] || 0) + 1;
      } catch (error) {
        const temporary = isTemporaryError(error);
        counts[temporary ? "temporary_error" : "permanent_error"] = (counts[temporary ? "temporary_error" : "permanent_error"] || 0) + 1;
        if (!options.dryRun) {
          const nextAttempt = temporary ? new Date(Date.now() + 3600000).toISOString() : null;
          database.prepare(`
            UPDATE metadata_jobs SET status = ?, attempts = attempts + 1, next_attempt_at = ?,
              last_error = ?, locked_at = NULL, updated_at = ? WHERE id = ?
          `).run(temporary ? "temporary_error" : "permanent_error", nextAttempt, error.message, nowIso(), job.id);
        }
        console.error(`Metadata job ${job.id} zlyhal: ${error.message}`);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: config.tmdbMaxConcurrency }, () => worker()));
    setAppState(database, "last_enrichment", { processed: cursor, counts, stopped: stopping, generatedAt: nowIso() });
    console.log(JSON.stringify({ processed: Math.min(cursor, jobs.length), counts, stopped: stopping }, null, 2));
  } finally {
    database.close();
  }
}

if (require.main === module) {
  runWorker(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  mapMetadata,
  parseArguments,
  processJob,
  runWorker,
};
