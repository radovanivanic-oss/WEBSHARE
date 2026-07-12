#!/usr/bin/env node
const { classifyMedia } = require("../lib/media-classifier");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { nowIso, openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");
const { parseJson, setAppState } = require("../src/repositories/media-repository");

function main() {
  const config = getCatalogConfig();
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1], 10) || 0 : 0;
  const batchIndex = process.argv.indexOf("--batch-size");
  const batchSize = batchIndex >= 0 ? Number.parseInt(process.argv[batchIndex + 1], 10) || 5000 : 5000;
  const database = openCatalogDatabase(config.databasePath);
  migrateDatabase(database, config.migrationsDir, { logger: console });
  const selectBatch = database.prepare(`
    SELECT m.*, c.id AS candidate_id, c.candidate_type, c.parse_confidence,
      c.normalized_title AS candidate_title,
      (SELECT original_name FROM files WHERE media_id = m.id LIMIT 1) AS sample_name
    FROM media m LEFT JOIN candidates c ON c.media_id = m.id
    WHERE m.id > ? ORDER BY m.id LIMIT ?
  `);
  const update = database.prepare("UPDATE media SET category = ?, classifier_version = ?, updated_at = ? WHERE id = ?");
  const audit = database.prepare(`
    INSERT INTO classification_audit(media_id, old_category, new_category, reason, confidence, classifier_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let changed = 0;
  let processed = 0;
  let lastId = 0;
  const processBatch = database.transaction((rows) => {
    for (const row of rows) {
      const classification = classifyMedia({
        media: { ...row, genres: parseJson(row.genres_json, []) },
        candidate: { candidateType: row.candidate_type, parseConfidence: row.parse_confidence, title: row.candidate_title },
        sampleName: row.sample_name || "",
      });
      if (classification.category !== row.category) {
        update.run(classification.category, classification.classifierVersion, nowIso(), row.id);
        audit.run(row.id, row.category, classification.category, classification.reason, classification.confidence, classification.classifierVersion, nowIso());
        changed += 1;
      }
    }
  });
  try {
    while (!limit || processed < limit) {
      const currentLimit = limit ? Math.min(batchSize, limit - processed) : batchSize;
      const rows = selectBatch.all(lastId, currentLimit);
      if (!rows.length) break;
      processBatch(rows);
      processed += rows.length;
      lastId = rows[rows.length - 1].id;
      console.log(JSON.stringify({ processed, changed, lastId }));
    }
    setAppState(database, "last_reclassification", { processed, changed, generatedAt: nowIso() });
    console.log(JSON.stringify({ processed, changed }, null, 2));
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
