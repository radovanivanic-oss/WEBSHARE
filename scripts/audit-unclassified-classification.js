"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { classifyUnclassifiedMedia, UNCLASSIFIED_CLASSIFIER_VERSION } = require("../lib/media-classifier");
const { openCatalogDatabase } = require("../src/db/catalog-db");

const POLICY_VERSION = "B34-unclassified-evidence-v1";

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

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function addSample(samples, key, row, limit) {
  if (!samples[key]) samples[key] = [];
  if (samples[key].length >= limit) return;
  samples[key].push({
    id: row.id,
    title: row.title,
    media_type: row.media_type,
    reason: row.reason,
    confidence: row.confidence,
    evidence: row.evidence,
    sample_name: row.sample_name || null,
  });
}

function runUnclassifiedAudit({ databasePath, sampleLimit = 5 }) {
  if (!databasePath) throw new Error("Vyžaduje sa --database.");
  const database = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  const samples = {};
  const proposedByCategory = {};
  const proposedActiveByCategory = {};
  const reasons = {};
  const confidenceBands = { "0.00-0.49": 0, "0.50-0.79": 0, "0.80-0.94": 0, "0.95-1.00": 0 };
  let total = 0;
  let active = 0;
  let proposed = 0;
  let proposedActive = 0;
  let activePlayableFiles = 0;

  const rows = database.prepare(`
    SELECT
      m.id, m.title, m.original_title, m.media_type, m.category, m.year,
      m.tvshow_id, m.external_source, m.external_id, m.metadata_status,
      m.metadata_confidence, m.genres_json, m.countries_json, m.languages_json,
      m.is_active,
      MAX(CASE WHEN f.parsed_season IS NOT NULL AND f.parsed_episode IS NOT NULL THEN 1 ELSE 0 END) AS episode_pattern,
      MIN(CASE WHEN f.is_active = 1 AND f.is_playable_video = 1 THEN f.original_name END) AS sample_name,
      SUM(CASE WHEN f.is_active = 1 AND f.is_playable_video = 1 THEN 1 ELSE 0 END) AS playable_file_count
    FROM media m
    LEFT JOIN files f ON f.media_id = m.id
    WHERE m.category = 'unknown'
    GROUP BY m.id
    ORDER BY m.id
  `).iterate();

  for (const media of rows) {
    total += 1;
    if (media.is_active) active += 1;
    activePlayableFiles += Number(media.playable_file_count || 0);
    const classification = classifyUnclassifiedMedia({
      media,
      fileEvidence: {
        episodePattern: Boolean(media.episode_pattern),
        sampleName: media.sample_name,
      },
    });
    increment(reasons, classification.reason);
    const confidence = Number(classification.confidence || 0);
    if (confidence < 0.5) confidenceBands["0.00-0.49"] += 1;
    else if (confidence < 0.8) confidenceBands["0.50-0.79"] += 1;
    else if (confidence < 0.95) confidenceBands["0.80-0.94"] += 1;
    else confidenceBands["0.95-1.00"] += 1;
    if (classification.category === "unknown") {
      addSample(samples, classification.reason, { ...media, ...classification }, sampleLimit);
      continue;
    }
    proposed += 1;
    increment(proposedByCategory, classification.category);
    if (media.is_active) {
      proposedActive += 1;
      increment(proposedActiveByCategory, classification.category);
    }
    addSample(samples, classification.category, { ...media, ...classification }, sampleLimit);
  }
  database.close();

  const report = {
    schema_version: 1,
    policy_version: POLICY_VERSION,
    classifier_version: UNCLASSIFIED_CLASSIFIER_VERSION,
    catalog_read_only: true,
    sqlite_write_performed: false,
    counts: {
      total_unclassified: total,
      active_unclassified: active,
      active_playable_unclassified_files: activePlayableFiles,
      proposed_entities: proposed,
      proposed_active_entities: proposedActive,
      expected_remaining_unclassified: total - proposed,
      expected_remaining_active_unclassified: active - proposedActive,
    },
    proposed_by_category: proposedByCategory,
    proposed_active_by_category: proposedActiveByCategory,
    reason_counts: reasons,
    confidence_bands: confidenceBands,
    bounded_samples: samples,
  };
  report.deterministic_sha256 = digest(report);
  return report;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = runUnclassifiedAudit({
    databasePath: options.database,
    sampleLimit: Math.max(1, Math.min(Number.parseInt(options.sampleLimit || "5", 10) || 5, 25)),
  });
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  }
  console.log(JSON.stringify({ ...report, bounded_samples: undefined }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { POLICY_VERSION, runUnclassifiedAudit };
