#!/usr/bin/env node
const { classifyMedia } = require("../lib/media-classifier");
const { selectBestMatch } = require("../lib/match-scorer");
const { TmdbClient, isTemporaryError } = require("../providers/tmdb-client");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { nowIso, openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");
const { rebuildMediaFts, setAppState } = require("../src/repositories/media-repository");

function parseArguments(argv) {
  const options = { limit: 1000, dryRun: false, retryFailed: false, onlyPending: false, provider: "tmdb" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--retry-failed") options.retryFailed = true;
    else if (value === "--only-pending") options.onlyPending = true;
    else if (value === "--limit") options.limit = Number.parseInt(argv[++index], 10) || 1000;
    else if (value === "--provider") options.provider = argv[++index] || "tmdb";
  }
  return options;
}

function jobStatuses(options) {
  if (options.onlyPending) return ["pending"];
  if (options.retryFailed) return ["pending", "temporary_error", "not_found"];
  return ["pending", "temporary_error"];
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
  }
  database.prepare(`
    UPDATE media SET external_source = 'tmdb', external_id = ?, media_type = 'movie',
      category = ?, title = ?, original_title = ?, year = ?, release_date = ?, overview = ?,
      genres_json = ?, runtime_minutes = ?, rating = ?, vote_count = ?, countries_json = ?,
      languages_json = ?, director = ?, cast_json = ?, poster_url = ?, backdrop_url = ?,
      adult = ?, metadata_language = ?, metadata_status = 'matched', metadata_confidence = ?,
      metadata_updated_at = ?, classifier_version = ?, updated_at = ? WHERE id = ?
  `).run(
    metadata.externalId, classification.category, metadata.title || candidate.normalized_title,
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
      media_key, external_source, external_id, media_type, category, title, original_title,
      year, release_date, overview, genres_json, runtime_minutes, rating, vote_count,
      countries_json, languages_json, director, cast_json, poster_url, backdrop_url,
      adult, metadata_language, metadata_status, metadata_confidence, metadata_updated_at,
      classifier_version, created_at, updated_at
    ) VALUES (?, 'tmdb', ?, 'tv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', ?, ?, ?, ?, ?)
  `).run(
    showKey, metadata.externalId, showClassification.category, metadata.title, metadata.originalTitle,
    metadata.year, metadata.releaseDate, metadata.overview, JSON.stringify(metadata.genres), metadata.runtime,
    metadata.rating, metadata.voteCount, JSON.stringify(metadata.countries), JSON.stringify(metadata.languages),
    metadata.director, JSON.stringify(metadata.cast), metadata.posterUrl, metadata.backdropUrl, metadata.adult,
    config.tmdbLanguage, confidence, now, showClassification.classifierVersion, now, now
  ).lastInsertRowid;
  if (existingShow) {
    database.prepare(`
      UPDATE media SET title = ?, original_title = ?, category = ?, overview = ?, genres_json = ?,
        poster_url = ?, backdrop_url = ?, rating = ?, vote_count = ?, metadata_status = 'matched',
        metadata_confidence = ?, metadata_updated_at = ?, updated_at = ? WHERE id = ?
    `).run(metadata.title, metadata.originalTitle, showClassification.category, metadata.overview,
      JSON.stringify(metadata.genres), metadata.posterUrl, metadata.backdropUrl, metadata.rating,
      metadata.voteCount, confidence, now, now, showId);
  }

  const episodeRows = database.prepare("SELECT * FROM candidates WHERE lookup_key = ?").all(job.candidate_key);
  const mediaIds = [showId];
  for (const episode of episodeRows) {
    if (!episode.media_id) continue;
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
      UPDATE media SET external_source = 'tmdb', external_id = ?, media_type = 'episode',
        category = 'series', tvshow_id = ?, poster_url = COALESCE(poster_url, ?),
        backdrop_url = COALESCE(backdrop_url, ?), metadata_language = ?,
        metadata_status = 'matched', metadata_confidence = ?, metadata_updated_at = ?,
        classifier_version = ?, updated_at = ? WHERE id = ?
    `).run(
      episodeExternalId, showId,
      metadata.posterUrl, metadata.backdropUrl, config.tmdbLanguage, confidence, now,
      showClassification.classifierVersion, now, targetEpisodeMediaId
    );
    database.prepare("UPDATE candidates SET status = 'matched', updated_at = ? WHERE id = ?")
      .run(now, episode.id);
    mediaIds.push(targetEpisodeMediaId);
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
  const candidateForScore = { title: job.parsed_title, parsedYear: job.parsed_year };
  const results = await client.search(candidateForScore, job.candidate_type);
  const selection = selectBestMatch(candidateForScore, results, job.candidate_type, {
    auto: config.metadataAutoMatchThreshold,
    ambiguous: config.metadataAmbiguousThreshold,
  });
  if (options.dryRun) {
    console.log(JSON.stringify({ job: job.id, key: job.candidate_key, status: selection.status, best: selection.best?.score || null }));
    return selection.status;
  }
  const now = nowIso();
  if (selection.status !== "matched") {
    database.prepare(`
      UPDATE metadata_jobs SET status = ?, attempts = attempts + 1, confidence = ?,
        selected_source = 'tmdb', selected_external_id = ?, last_error = NULL,
        locked_at = NULL, updated_at = ? WHERE id = ?
    `).run(selection.status, selection.best?.score || null, selection.best?.result?.id || null, now, job.id);
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
  const jobs = database.prepare(`
    SELECT * FROM metadata_jobs
    WHERE status IN (${placeholders}) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY attempts, id LIMIT ?
  `).all(...statuses, nowIso(), options.limit);
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
  mapMetadata,
  parseArguments,
  processJob,
  runWorker,
};
