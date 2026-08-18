"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseMediaName } = require("../lib/media-name-parser");
const {
  DEEP_UNCLASSIFIED_CLASSIFIER_VERSION,
  classifyDeepUnclassifiedMedia,
} = require("../lib/media-classifier");
const { openCatalogDatabase } = require("../src/db/catalog-db");

const POLICY_VERSION = "B36-unclassified-deep-evidence-v1";
const AUDIT_SCHEMA_VERSION = 2;
const DEFAULT_BATCH_SIZE = 1000;
const SAMPLE_LIMIT = 20;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`Neplatný argument ${value}.`);
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function digest(value) {
  return sha256(JSON.stringify(value));
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function addBoundedSample(map, key, row, limit = SAMPLE_LIMIT) {
  if (!map[key]) map[key] = [];
  if (map[key].length >= limit) return;
  map[key].push(row);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasMarker(text, pattern) {
  return pattern.test(String(text || ""));
}

function tolerantEpisode(value) {
  const text = String(value || "");
  const seasonEpisode = text.match(/(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?=$|[^0-9])/i);
  if (seasonEpisode) {
    return { key: `${Number(seasonEpisode[1])}x${Number(seasonEpisode[2])}`, number: Number(seasonEpisode[2]) };
  }
  const episodeWord = text.match(/\b(?:episode|ep)\s*0*(\d{1,3})\b/i);
  if (episodeWord) return { key: `e${Number(episodeWord[1])}`, number: Number(episodeWord[1]) };
  return null;
}

function aggregateFileEvidence(files) {
  const evidence = {
    files: 0,
    activeFiles: 0,
    playableFiles: 0,
    episodePatternFiles: 0,
    distinctEpisodeKeys: 0,
    episodeWordFiles: 0,
    distinctEpisodeNumbers: 0,
    documentaryFiles: 0,
    musicVideoFiles: 0,
    concertFiles: 0,
    sportFiles: 0,
    animeFiles: 0,
    keywordOnly: false,
    nonGenericEpisodeTitle: false,
    sampleNames: [],
  };
  const episodeKeys = new Set();
  const episodeNumbers = new Set();

  for (const file of files) {
    evidence.files += 1;
    if (file.is_active) evidence.activeFiles += 1;
    if (file.is_active && file.is_playable_video) evidence.playableFiles += 1;
    if (evidence.sampleNames.length < 3) evidence.sampleNames.push(String(file.original_name || "").slice(0, 240));

    const name = String(file.original_name || "");
    const lowerName = name.toLowerCase();
    const parsed = parseMediaName(name, { extension: file.extension });
    const tolerant = tolerantEpisode(name);
    if ((file.parsed_season != null && file.parsed_episode != null) || tolerant) {
      evidence.episodePatternFiles += 1;
      const key = file.parsed_season != null && file.parsed_episode != null
        ? `${Number(file.parsed_season)}x${Number(file.parsed_episode)}`
        : tolerant.key;
      episodeKeys.add(key);
      if (file.parsed_episode != null) episodeNumbers.add(Number(file.parsed_episode));
      else episodeNumbers.add(tolerant.number);
      if (parsed.title && !/^episode\s*\d+$/i.test(parsed.title.trim())) evidence.nonGenericEpisodeTitle = true;
    }
    if (/\b(?:episode|ep)\s*0*\d{1,3}\b/i.test(lowerName)) {
      evidence.episodeWordFiles += 1;
      if (tolerant?.number != null) episodeNumbers.add(tolerant.number);
      const remainder = lowerName.replace(/\b(?:episode|ep)\s*0*\d{1,3}\b/i, " ");
      if (remainder.replace(/[^a-z\p{L}]+/giu, " ").trim().length >= 4) evidence.nonGenericEpisodeTitle = true;
    }

    const documentary = hasMarker(lowerName, /\b(?:documentary|document|dokument(?:ary|ární|arni)?|national[ ._-]+geographic|bbc[ ._-]+documentary|history[ ._-]+documentary)\b/i);
    const musicVideo = hasMarker(lowerName, /\b(?:official[ ._-]+(?:music[ ._-]+)?video|music[ ._-]+video|videoclip|video[ ._-]+clip)\b/i);
    const concert = hasMarker(lowerName, /\b(?:concert|koncert|unplugged|live[ ._-]+concert|world[ ._-]+tour|music[ ._-]+festival|live[ ._-]+at|live[ ._-]+in)\b/i);
    const sport = hasMarker(lowerName, /\b(?:formula[ ._-]?1|f1|motogp|ufc|wwe|nba|nhl|nfl|uefa|champions[ ._-]+league|premier[ ._-]+league|matchday)\b/i);
    const anime = hasMarker(lowerName, /\banime\b/i);
    evidence.documentaryFiles += documentary ? 1 : 0;
    evidence.musicVideoFiles += musicVideo ? 1 : 0;
    evidence.concertFiles += concert ? 1 : 0;
    evidence.sportFiles += sport ? 1 : 0;
    evidence.animeFiles += anime ? 1 : 0;
    if (documentary || musicVideo || concert || sport || anime) evidence.keywordOnly = true;
  }

  evidence.distinctEpisodeKeys = episodeKeys.size;
  evidence.distinctEpisodeNumbers = episodeNumbers.size;
  for (const key of ["episodePattern", "episodeWord", "documentary", "musicVideo", "concert", "sport"]) {
    const count = evidence[`${key}Files`];
    evidence[`${key}Ratio`] = evidence.files ? Number((count / evidence.files).toFixed(6)) : 0;
  }
  return evidence;
}

function buildMediaSelect() {
  return `
    SELECT m.id, m.title, m.original_title, m.media_type, m.category, m.year,
      m.tvshow_id, m.external_source, m.external_id, m.metadata_status,
      m.metadata_confidence, m.genres_json, m.countries_json, m.languages_json,
      m.is_active
    FROM media m
    WHERE m.category = 'unknown' AND m.id > ?
    ORDER BY m.id
    LIMIT ?`;
}

function buildInClause(ids) {
  return ids.map(() => "?").join(",");
}

function referenceStatistics(database) {
  const rows = database.prepare(`
    SELECT m.category, COUNT(*) AS entities,
      SUM(m.is_active = 1) AS active_entities,
      COUNT(f.id) AS files,
      SUM(f.is_active = 1 AND f.is_playable_video = 1) AS active_playable_files
    FROM media m LEFT JOIN files f ON f.media_id = m.id
    WHERE m.category <> 'unknown'
    GROUP BY m.category ORDER BY m.category`).all();
  return rows.map((row) => ({ ...row, entities: Number(row.entities), active_entities: Number(row.active_entities || 0), files: Number(row.files || 0), active_playable_files: Number(row.active_playable_files || 0) }));
}

function runDeepUnclassifiedAudit({ databasePath, batchSize = DEFAULT_BATCH_SIZE, onProgress = () => {} }) {
  if (!databasePath) throw new Error("Vyžaduje sa --database.");
  const database = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  const selectMedia = database.prepare(buildMediaSelect());
  const reasonCounts = {};
  const confidenceCounts = {};
  const categoryProposals = {};
  const buckets = {};
  const samples = {};
  const conflicts = [];
  const candidates = [];
  const lastIds = [];
  let lastId = 0;
  let total = 0;
  let active = 0;
  let activePlayableFiles = 0;
  let aliasBearing = 0;
  let rowsInBatch;

  do {
    rowsInBatch = selectMedia.all(lastId, batchSize);
    if (!rowsInBatch.length) break;
    const ids = rowsInBatch.map((row) => row.id);
    const filesByMedia = new Map(ids.map((id) => [id, []]));
    const aliasesByMedia = new Map();
    const placeholders = buildInClause(ids);
    const files = database.prepare(`SELECT media_id, original_name, extension, parsed_season, parsed_episode, is_active, is_playable_video FROM files WHERE media_id IN (${placeholders}) ORDER BY media_id, id`).all(...ids);
    for (const file of files) filesByMedia.get(file.media_id).push(file);
    for (const alias of database.prepare(`SELECT media_id, COUNT(*) AS count FROM media_aliases WHERE media_id IN (${placeholders}) GROUP BY media_id`).all(...ids)) aliasesByMedia.set(alias.media_id, Number(alias.count));

    for (const media of rowsInBatch) {
      const fileEvidence = aggregateFileEvidence(filesByMedia.get(media.id) || []);
      const classification = classifyDeepUnclassifiedMedia({ media, fileEvidence });
      const aliasCount = aliasesByMedia.get(media.id) || 0;
      if (aliasCount) aliasBearing += 1;
      const activePlayable = fileEvidence.playableFiles;
      total += 1;
      if (media.is_active) active += 1;
      activePlayableFiles += activePlayable;
      for (const reason of classification.reasonCodes) increment(reasonCounts, reason);
      increment(confidenceCounts, classification.confidenceClass);

      let bucket = "INSUFFICIENT_EVIDENCE";
      if (classification.confidenceClass === "CONFLICTING") bucket = "CONFLICTING_EVIDENCE";
      else if (classification.eligible) bucket = `STRONG_${classification.category.toUpperCase().replace(/-/g, "_")}_CANDIDATE`;
      else if (classification.reasonCodes.includes("AMBIGUOUS_KEYWORD_ONLY")) bucket = "WEAK_FILENAME_ONLY";
      else if (!String(media.title || "").trim() || /\uFFFD/.test(String(media.title || ""))) bucket = "NOISE_OR_CORRUPTED";
      increment(buckets, bucket);

      const sample = {
        media_id: media.id,
        title: media.title,
        media_type: media.media_type,
        active: Boolean(media.is_active),
        file_count: fileEvidence.files,
        active_playable_file_count: activePlayable,
        proposed_category: classification.category,
        confidence: classification.confidenceClass,
        reason_codes: classification.reasonCodes,
        sample_filenames: fileEvidence.sampleNames,
      };
      addBoundedSample(samples, classification.eligible ? classification.category : bucket, sample);
      if (classification.confidenceClass === "CONFLICTING" && conflicts.length < SAMPLE_LIMIT * 5) conflicts.push({ ...sample, conflict_flags: classification.conflictFlags });

      if (classification.eligible) {
        increment(categoryProposals, classification.category);
        const record = {
          media_id: media.id,
          current_category: media.category,
          proposed_category: classification.category,
          confidence: classification.confidenceClass,
          confidence_score: classification.confidence,
          reason_codes: classification.reasonCodes,
          evidence_digest: digest(classification.evidence),
          evidence: classification.evidence,
          file_count: fileEvidence.files,
          active_playable_file_count: activePlayable,
          active: Boolean(media.is_active),
          media_type: media.media_type,
          external_source: media.external_source || null,
          external_id: media.external_id || null,
          alias_count: aliasCount,
          policy_version: POLICY_VERSION,
        };
        candidates.push(record);
      }
    }
    lastId = rowsInBatch[rowsInBatch.length - 1].id;
    lastIds.push(lastId);
    onProgress({ total, active, lastId });
  } while (rowsInBatch.length === batchSize);

  const reference = referenceStatistics(database);
  database.close();
  candidates.sort((left, right) => left.media_id - right.media_id);
  const activeCandidateCounts = {};
  for (const candidate of candidates) if (candidate.active) increment(activeCandidateCounts, candidate.proposed_category);
  const core = {
    schema_version: AUDIT_SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    classifier_version: DEEP_UNCLASSIFIED_CLASSIFIER_VERSION,
    catalog_read_only: true,
    sqlite_write_performed: false,
    counts: {
      total_unclassified: total,
      active_unclassified: active,
      active_playable_unclassified_files: activePlayableFiles,
      proposals: candidates.length,
      active_proposals: candidates.filter((candidate) => candidate.active).length,
      expected_remaining_unclassified: total - candidates.length,
      expected_remaining_active_unclassified: active - candidates.filter((candidate) => candidate.active).length,
      reduction_percent_active: active ? Number(((candidates.filter((candidate) => candidate.active).length / active) * 100).toFixed(4)) : 0,
      entities_with_aliases: aliasBearing,
    },
    buckets,
    confidence_counts: confidenceCounts,
    reason_counts: reasonCounts,
    proposed_by_category: categoryProposals,
    proposed_active_by_category: activeCandidateCounts,
    bounded_samples: samples,
    conflicts: conflicts.slice(0, SAMPLE_LIMIT * 5),
    reference_statistics: reference,
    last_batch_ids: lastIds,
    candidate_ids: candidates.map((candidate) => candidate.media_id),
  };
  const plan = {
    schema_version: AUDIT_SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    classifier_version: DEEP_UNCLASSIFIED_CLASSIFIER_VERSION,
    candidates,
  };
  return {
    ...core,
    deterministic_sha256: digest(core),
    plan: { ...plan, plan_sha256: digest(plan) },
  };
}

function writeArtifacts(outputDir, report) {
  fs.mkdirSync(outputDir, { recursive: true });
  const files = {
    "classification-summary.json": report,
    "reason-distribution.json": report.reason_counts,
    "confidence-distribution.json": report.confidence_counts,
    "category-proposals.json": { proposed_by_category: report.proposed_by_category, proposed_active_by_category: report.proposed_active_by_category, samples: report.bounded_samples },
    "conflicts.json": report.conflicts,
    "ambiguous-samples.json": report.bounded_samples.WEAK_FILENAME_ONLY || [],
    "migration-candidates.json": report.plan,
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const manifest = {
    schema_version: AUDIT_SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    classifier_version: DEEP_UNCLASSIFIED_CLASSIFIER_VERSION,
    catalog_read_only: true,
    sqlite_write_performed: false,
    deterministic_sha256: report.deterministic_sha256,
    plan_sha256: report.plan.plan_sha256,
    artifact_files: Object.keys(files),
  };
  fs.writeFileSync(path.join(outputDir, "audit.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "audit.log"), "read-only audit; SQLite writes: 0\n", "utf8");
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = runDeepUnclassifiedAudit({
    databasePath: options.database,
    batchSize: Math.max(100, Math.min(Number.parseInt(options.batchSize || String(DEFAULT_BATCH_SIZE), 10) || DEFAULT_BATCH_SIZE, 5000)),
    onProgress: ({ total, lastId }) => {
      if (total % 10000 === 0) console.error(`processed=${total} last_id=${lastId}`);
    },
  });
  if (options.outputDir) writeArtifacts(path.resolve(options.outputDir), report);
  console.log(JSON.stringify({ ...report, bounded_samples: undefined, conflicts: undefined, plan: { ...report.plan, candidates: undefined } }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  POLICY_VERSION,
  aggregateFileEvidence,
  classifyDeepUnclassifiedMedia,
  runDeepUnclassifiedAudit,
  tolerantEpisode,
  writeArtifacts,
};
