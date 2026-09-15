#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { buildCandidate } = require("../lib/candidate-grouper");
const {
  assertSourceIsNotShadow,
  assertFullReconciliationAllowed,
  fileFingerprint,
  loadAndValidateCatalogManifest,
} = require("../lib/catalog-safety");
const { classifyMedia } = require("../lib/media-classifier");
const { parseMediaName } = require("../lib/media-name-parser");
const { resolveCanonicalSeriesRoot } = require("../lib/series-identity");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { nowIso, openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");

function parseArguments(argv) {
  const result = { allowDeactivation: false, full: false, restart: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--full") result.full = true;
    else if (value === "--restart") result.restart = true;
    else if (value === "--allow-deactivation") result.allowDeactivation = true;
    else if (value.startsWith("--")) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

function validateFullManifest(options, inputPath, stat) {
  if (!options.full) return null;
  const manifestPath = path.resolve(
    options.manifest || path.join(path.dirname(inputPath), "catalog-items.manifest.json")
  );
  assertSourceIsNotShadow(inputPath, manifestPath);
  const manifest = loadAndValidateCatalogManifest(manifestPath, inputPath, stat, {
    requireCurrentSchema: true,
  });
  assertFullReconciliationAllowed(options, manifest, manifestPath);
  return manifest;
}

async function* readJsonLines(inputPath, startOffset = 0) {
  const stream = fs.createReadStream(inputPath, { start: startOffset });
  let buffer = Buffer.alloc(0);
  let absoluteOffset = startOffset;
  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf(10)) !== -1) {
      const lineBuffer = buffer.subarray(0, newlineIndex);
      buffer = buffer.subarray(newlineIndex + 1);
      absoluteOffset += newlineIndex + 1;
      yield { line: lineBuffer.toString("utf8").replace(/\r$/, ""), nextOffset: absoluteOffset };
    }
  }
  if (buffer.length > 0) {
    absoluteOffset += buffer.length;
    yield { line: buffer.toString("utf8").replace(/\r$/, ""), nextOffset: absoluteOffset };
  }
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function prepareStatements(database) {
  return {
    upsertCandidate: database.prepare(`
      INSERT INTO candidates (
        candidate_key, lookup_key, normalized_title, parsed_year, candidate_type,
        season_number, episode_number, series_key, parse_confidence,
        grouping_version, status, created_at, updated_at
      ) VALUES (
        @candidateKey, @lookupKey, @normalizedTitle, @parsedYear, @candidateType,
        @seasonNumber, @episodeNumber, @seriesKey, @parseConfidence,
        @groupingVersion, 'pending', @now, @now
      ) ON CONFLICT(candidate_key) DO UPDATE SET
        parse_confidence = MAX(candidates.parse_confidence, excluded.parse_confidence),
        updated_at = excluded.updated_at
      RETURNING id, media_id
    `),
    insertMedia: database.prepare(`
      INSERT INTO media (
        media_key, media_type, category, title, year, season_number, episode_number,
        tvshow_id, metadata_status, metadata_confidence, classifier_version, created_at, updated_at
      ) VALUES (
        @mediaKey, @mediaType, @category, @title, @year, @seasonNumber, @episodeNumber,
        @tvshowId, 'local', @confidence, @classifierVersion, @now, @now
      ) ON CONFLICT(media_key) DO UPDATE SET updated_at = excluded.updated_at
      RETURNING id
    `),
    linkCandidate: database.prepare("UPDATE candidates SET media_id = ?, updated_at = ? WHERE id = ?"),
    upsertFile: database.prepare(`
      INSERT INTO files (
        ident, original_name, normalized_name, extension, mime, size_bytes,
        webshare_category, placeholder_url, first_seen_at, last_seen_at,
        last_seen_run_id, is_active, is_playable_video, candidate_id, media_id,
        parsed_title, parsed_year, parsed_season, parsed_episode, parsed_resolution,
        parsed_source, parsed_video_codec, parsed_audio_codec, parsed_hdr,
        parsed_dolby_vision, parsed_languages_json, parsed_has_dubbing,
        parsed_has_subtitles, parsed_release_group, parse_confidence, parse_reason,
        parse_version, img, stripe, stripe_count, queued, positive_votes,
        negative_votes, password_protected, raw_json, created_at, updated_at
      ) VALUES (
        @ident, @originalName, @normalizedName, @extension, @mime, @sizeBytes,
        @webshareCategory, @placeholderUrl, @now, @now,
        @crawlRunId, 1, @isPlayableVideo, @candidateId, @mediaId,
        @parsedTitle, @parsedYear, @parsedSeason, @parsedEpisode, @parsedResolution,
        @parsedSource, @parsedVideoCodec, @parsedAudioCodec, @parsedHdr,
        @parsedDolbyVision, @parsedLanguagesJson, @parsedHasDubbing,
        @parsedHasSubtitles, @parsedReleaseGroup, @parseConfidence, @parseReason,
        @parseVersion, @img, @stripe, @stripeCount, @queued, @positiveVotes,
        @negativeVotes, @passwordProtected, @rawJson, @now, @now
      ) ON CONFLICT(ident) DO UPDATE SET
        original_name = excluded.original_name,
        normalized_name = excluded.normalized_name,
        extension = excluded.extension,
        mime = excluded.mime,
        size_bytes = excluded.size_bytes,
        webshare_category = excluded.webshare_category,
        placeholder_url = excluded.placeholder_url,
        last_seen_at = excluded.last_seen_at,
        last_seen_run_id = excluded.last_seen_run_id,
        is_active = 1,
        is_playable_video = excluded.is_playable_video,
        candidate_id = excluded.candidate_id,
        media_id = excluded.media_id,
        parsed_title = excluded.parsed_title,
        parsed_year = excluded.parsed_year,
        parsed_season = excluded.parsed_season,
        parsed_episode = excluded.parsed_episode,
        parsed_resolution = excluded.parsed_resolution,
        parsed_source = excluded.parsed_source,
        parsed_video_codec = excluded.parsed_video_codec,
        parsed_audio_codec = excluded.parsed_audio_codec,
        parsed_hdr = excluded.parsed_hdr,
        parsed_dolby_vision = excluded.parsed_dolby_vision,
        parsed_languages_json = excluded.parsed_languages_json,
        parsed_has_dubbing = excluded.parsed_has_dubbing,
        parsed_has_subtitles = excluded.parsed_has_subtitles,
        parsed_release_group = excluded.parsed_release_group,
        parse_confidence = excluded.parse_confidence,
        parse_reason = excluded.parse_reason,
        parse_version = excluded.parse_version,
        img = excluded.img,
        stripe = excluded.stripe,
        stripe_count = excluded.stripe_count,
        queued = excluded.queued,
        positive_votes = excluded.positive_votes,
        negative_votes = excluded.negative_votes,
        password_protected = excluded.password_protected,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
      RETURNING created_at = updated_at AS inserted
    `),
    enqueueMetadata: database.prepare(`
      INSERT INTO metadata_jobs (
        candidate_id, candidate_key, parsed_title, parsed_year, candidate_type,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(candidate_key) DO NOTHING
    `),
  };
}

function rebuildCatalogIndexesAndCounts(database) {
  const rebuild = database.transaction(() => {
    database.prepare(`
      UPDATE candidates SET
        file_count = (SELECT COUNT(*) FROM files WHERE files.candidate_id = candidates.id),
        updated_at = ?
    `).run(nowIso());
    database.exec("DELETE FROM media_fts;");
    database.exec(`
      INSERT INTO media_fts(media_id, title, original_title, aliases)
      SELECT CAST(media.id AS TEXT), media.title, COALESCE(media.original_title, ''),
        COALESCE((SELECT GROUP_CONCAT(alias, ' ') FROM media_aliases WHERE media_id = media.id), '')
      FROM media
    `);
  });
  rebuild();
}

function rebuildMediaVisibility(database) {
    database.exec("UPDATE media SET is_active = 0;");
    database.exec(`
      UPDATE media SET is_active = 1 WHERE id IN (
        SELECT DISTINCT media_id FROM files
        WHERE media_id IS NOT NULL AND is_active = 1 AND is_playable_video = 1
      )
    `);
    database.exec(`
      UPDATE media SET is_active = 1
      WHERE id IN (
        SELECT DISTINCT episode.tvshow_id
        FROM media episode JOIN files ON files.media_id = episode.id
        WHERE episode.tvshow_id IS NOT NULL AND files.is_active = 1 AND files.is_playable_video = 1
      )
    `);
}

function rebuildDerivedCatalogData(database) {
  rebuildCatalogIndexesAndCounts(database);
  const rebuild = database.transaction(() => {
    rebuildMediaVisibility(database);
  });
  rebuild();
}

function createImportBatch(database, statements, context) {
  return database.transaction((entries) => applyImportEntries(database, statements, entries, context));
}

function applyImportEntries(database, statements, entries, context) {
    let inserted = 0;
    let updated = 0;
    const seriesIdentityCache = context.seriesIdentityCache || new Map();
    for (const entry of entries) {
      const { item, rawJson } = entry;
      const ident = String(item.ident || item.id || "").trim();
      const originalName = String(item.name || item.title || ident).trim();
      if (!ident || !originalName) {
        throw new Error("missing-ident-or-name");
      }
      const parsed = parseMediaName(originalName, { extension: item.extension || item.type });
      const candidate = buildCandidate(parsed);
      const now = nowIso();
      const candidateRow = statements.upsertCandidate.get({ ...candidate, now });
      let mediaId = candidateRow.media_id;
      if (!mediaId) {
        const classification = classifyMedia({ candidate: { ...candidate, title: parsed.title }, sampleName: originalName });
        let tvshowId = null;
        if (candidate.candidateType === "episode" && candidate.seriesKey) {
          const resolution = resolveCanonicalSeriesRoot(database, parsed, { cache: seriesIdentityCache });
          if (resolution.status === "MATCHED") {
            tvshowId = resolution.root_id;
          } else {
            const showMediaKey = `local:${candidate.seriesKey}`;
            tvshowId = statements.insertMedia.get({
              mediaKey: showMediaKey,
              mediaType: "tv",
              category: "series",
              title: parsed.title || originalName,
              year: parsed.year,
              seasonNumber: null,
              episodeNumber: null,
              tvshowId: null,
              confidence: parsed.confidence,
              classifierVersion: classification.classifierVersion,
              now,
            }).id;
          }
        }
        mediaId = statements.insertMedia.get({
          mediaKey: `local:${candidate.candidateKey}`,
          mediaType: candidate.candidateType,
          category: classification.category,
          title: candidate.candidateType === "episode"
            ? `${parsed.title || originalName} S${String(parsed.season || 0).padStart(2, "0")}E${String(parsed.episode || 0).padStart(2, "0")}`
            : parsed.title || originalName,
          year: parsed.year,
          seasonNumber: parsed.season,
          episodeNumber: parsed.episode,
          tvshowId,
          confidence: classification.confidence,
          classifierVersion: classification.classifierVersion,
          now,
        }).id;
        statements.linkCandidate.run(mediaId, now, candidateRow.id);
      }
      const fileResult = statements.upsertFile.get({
        ident,
        originalName,
        normalizedName: parsed.normalizedName,
        extension: parsed.extension,
        mime: item.mime || null,
        sizeBytes: normalizeInteger(item.size),
        webshareCategory: item.category || null,
        placeholderUrl: item.url || `webshare://${ident}`,
        crawlRunId: context.crawlRunId,
        isPlayableVideo: parsed.isVideoExtension ? 1 : 0,
        candidateId: candidateRow.id,
        mediaId,
        parsedTitle: parsed.title,
        parsedYear: parsed.year,
        parsedSeason: parsed.season,
        parsedEpisode: parsed.episode,
        parsedResolution: parsed.resolution,
        parsedSource: parsed.source,
        parsedVideoCodec: parsed.videoCodec,
        parsedAudioCodec: parsed.audioCodec,
        parsedHdr: parsed.hdr ? 1 : 0,
        parsedDolbyVision: parsed.dolbyVision ? 1 : 0,
        parsedLanguagesJson: JSON.stringify(parsed.languages),
        parsedHasDubbing: parsed.hasDubbing ? 1 : 0,
        parsedHasSubtitles: parsed.hasSubtitles ? 1 : 0,
        parsedReleaseGroup: parsed.releaseGroup,
        parseConfidence: parsed.confidence,
        parseReason: parsed.reason,
        parseVersion: parsed.parserVersion,
        img: item.img || null,
        stripe: item.stripe || null,
        stripeCount: normalizeInteger(item.stripe_count),
        queued: normalizeInteger(item.queued),
        positiveVotes: normalizeInteger(item.positive_votes),
        negativeVotes: normalizeInteger(item.negative_votes),
        passwordProtected: item.password_protected ? 1 : 0,
        rawJson,
        now,
      });
      if (fileResult.inserted) inserted += 1;
      else updated += 1;

      if (["movie", "episode"].includes(candidate.candidateType) && parsed.confidence >= 0.6) {
        statements.enqueueMetadata.run(
          candidateRow.id,
          candidate.lookupKey,
          parsed.title,
          parsed.year,
          candidate.candidateType === "episode" ? "tv" : "movie",
          now,
          now
        );
      }
    }
    return { inserted, updated };
}

function createOrResumeRun(database, inputPath, stat, fingerprint, options) {
  const sourceManifest = options.sourceManifest
    ? JSON.stringify(options.sourceManifest)
    : JSON.stringify({ inputPath, fingerprint });
  if (!options.restart) {
    const existing = database.prepare(`
      SELECT * FROM import_runs
      WHERE input_path = ? AND input_fingerprint = ? AND status != 'completed'
      ORDER BY id DESC LIMIT 1
    `).get(inputPath, fingerprint);
    if (existing) {
      database.prepare("UPDATE import_runs SET status = 'running', updated_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
      database.prepare(`
        UPDATE crawl_runs SET is_full = ?, status = 'running', source_manifest = ?, updated_at = ?
        WHERE id = ?
      `).run(options.full ? 1 : 0, sourceManifest, nowIso(), existing.crawl_run_id);
      return existing;
    }
  }
  const now = nowIso();
  const crawlRunId = database.prepare(`
    INSERT INTO crawl_runs(started_at, status, is_full, source_manifest, created_at, updated_at)
    VALUES (?, 'running', ?, ?, ?, ?)
  `).run(now, options.full ? 1 : 0, sourceManifest, now, now).lastInsertRowid;
  const importRunId = database.prepare(`
    INSERT INTO import_runs(
      crawl_run_id, input_path, input_size, input_mtime_ms, input_fingerprint,
      status, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(crawlRunId, inputPath, stat.size, Math.trunc(stat.mtimeMs), fingerprint, now, now).lastInsertRowid;
  return database.prepare("SELECT * FROM import_runs WHERE id = ?").get(importRunId);
}

async function importCatalog(options) {
  const config = getCatalogConfig();
  const inputPath = path.resolve(options.input || path.join(config.runtimeDir, "catalog-items.jsonl"));
  const databasePath = path.resolve(options.database || config.databasePath);
  const batchSize = Number.parseInt(options.batchSize, 10) || config.importBatchSize;
  const errorPath = path.resolve(options.errorLog || path.join(config.runtimeDir, "catalog-import-errors.jsonl"));
  const stat = fs.statSync(inputPath);
  const sourceManifest = options.full
    ? validateFullManifest(options, inputPath, stat)
    : options.manifest
      ? loadAndValidateCatalogManifest(path.resolve(options.manifest), inputPath, stat)
      : null;
  options.sourceManifest = sourceManifest;
  const fingerprint = fileFingerprint(inputPath, stat);
  fs.mkdirSync(path.dirname(errorPath), { recursive: true });
  const database = openCatalogDatabase(databasePath);
  migrateDatabase(database, config.migrationsDir, { logger: console });
  const run = createOrResumeRun(database, inputPath, stat, fingerprint, options);
  const statements = prepareStatements(database);
  const writeBatch = createImportBatch(database, statements, { crawlRunId: run.crawl_run_id });
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let lineNumber = run.line_number;
  let byteOffset = run.byte_offset;
  let insertedCount = run.inserted_count;
  let updatedCount = run.updated_count;
  let invalidCount = run.invalid_count;
  let batch = [];
  const startedAt = Date.now();

  try {
    for await (const entry of readJsonLines(inputPath, byteOffset)) {
      lineNumber += 1;
      byteOffset = entry.nextOffset;
      if (!entry.line.trim()) continue;
      try {
        const item = JSON.parse(entry.line);
        if (!String(item.ident || item.id || "").trim() || !String(item.name || item.title || "").trim()) {
          throw new Error("missing-ident-or-name");
        }
        batch.push({ item, rawJson: entry.line });
      } catch (error) {
        invalidCount += 1;
        fs.appendFileSync(errorPath, `${JSON.stringify({ lineNumber, message: error.message })}\n`);
      }

      if (batch.length >= batchSize || interrupted) {
        if (batch.length) {
          const result = writeBatch(batch);
          insertedCount += result.inserted;
          updatedCount += result.updated;
          batch = [];
        }
        database.prepare(`
          UPDATE import_runs SET byte_offset = ?, line_number = ?, inserted_count = ?,
            updated_count = ?, invalid_count = ?, updated_at = ? WHERE id = ?
        `).run(byteOffset, lineNumber, insertedCount, updatedCount, invalidCount, nowIso(), run.id);
        if (lineNumber % (batchSize * 10) === 0 || interrupted) {
          console.log(JSON.stringify({ lineNumber, byteOffset, insertedCount, updatedCount, invalidCount }));
        }
      }
      if (interrupted) break;
    }

    if (!interrupted && batch.length) {
      const result = writeBatch(batch);
      insertedCount += result.inserted;
      updatedCount += result.updated;
    }

    const finishedAt = nowIso();
    if (interrupted) {
      database.prepare(`
        UPDATE import_runs SET status = 'interrupted', byte_offset = ?, line_number = ?,
          inserted_count = ?, updated_count = ?, invalid_count = ?, updated_at = ? WHERE id = ?
      `).run(byteOffset, lineNumber, insertedCount, updatedCount, invalidCount, finishedAt, run.id);
      database.prepare("UPDATE crawl_runs SET status = 'partial', items_seen = ?, updated_at = ? WHERE id = ?")
        .run(lineNumber, finishedAt, run.crawl_run_id);
      process.exitCode = 130;
      return;
    }

    if (options.full) {
      if (invalidCount !== 0) {
        throw new Error(
          `Full reconciliation je zablokovaný: import obsahuje ${invalidCount} neplatných riadkov.`
        );
      }
      if (lineNumber !== Number(sourceManifest.items)) {
        throw new Error(
          `Full reconciliation je zablokovaný: manifest očakáva ${sourceManifest.items} položiek, ` +
          `ale import prečítal ${lineNumber} riadkov.`
        );
      }
    }

    console.log("Prepočítavam počty verzií a obnovujem FTS index.");
    rebuildCatalogIndexesAndCounts(database);
    const finish = database.transaction(() => {
      if (options.full) {
        database.prepare("UPDATE files SET is_active = 0 WHERE last_seen_run_id != ? OR last_seen_run_id IS NULL")
          .run(run.crawl_run_id);
      }
      rebuildMediaVisibility(database);
      database.prepare(`
        UPDATE import_runs SET status = 'completed', byte_offset = ?, line_number = ?,
          inserted_count = ?, updated_count = ?, invalid_count = ?, updated_at = ?, finished_at = ?
        WHERE id = ?
      `).run(byteOffset, lineNumber, insertedCount, updatedCount, invalidCount, finishedAt, finishedAt, run.id);
      database.prepare(`
        UPDATE crawl_runs SET status = 'completed', finished_at = ?, items_seen = ?,
          errors_count = ?, updated_at = ? WHERE id = ?
      `).run(finishedAt, lineNumber, invalidCount, finishedAt, run.crawl_run_id);
      database.prepare(`
        INSERT INTO app_state(key, value_json, updated_at) VALUES ('last_import', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(JSON.stringify({ importRunId: run.id, crawlRunId: run.crawl_run_id, lineNumber, invalidCount }), finishedAt);
    });
    finish();
    database.pragma("wal_checkpoint(PASSIVE)");
    console.log(JSON.stringify({
      success: true,
      inputPath,
      databasePath,
      lineNumber,
      insertedCount,
      updatedCount,
      invalidCount,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    }, null, 2));
  } catch (error) {
    database.prepare("UPDATE import_runs SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(nowIso(), run.id);
    database.prepare("UPDATE crawl_runs SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(nowIso(), run.crawl_run_id);
    throw error;
  } finally {
    database.close();
  }
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2));
  importCatalog(options).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  applyImportEntries,
  fileFingerprint,
  importCatalog,
  parseArguments,
  prepareStatements,
  createImportBatch,
  rebuildCatalogIndexesAndCounts,
  rebuildDerivedCatalogData,
  rebuildMediaVisibility,
  readJsonLines,
  validateFullManifest,
};
