const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { classifyUnclassifiedMedia } = require("../lib/media-classifier");
const { runUnclassifiedAudit } = require("../scripts/audit-unclassified-classification");

test("unclassified policy accepts persisted trusted and structural evidence", () => {
  assert.equal(classifyUnclassifiedMedia({
    media: { media_type: "movie", external_source: "tmdb", external_id: "1", metadata_status: "matched", metadata_confidence: 0.99 },
  }).category, "movies");
  assert.equal(classifyUnclassifiedMedia({
    media: { media_type: "unknown" },
    fileEvidence: { episodePattern: true },
  }).category, "series");
  assert.equal(classifyUnclassifiedMedia({ media: { media_type: "concert" } }).category, "concerts");
  assert.equal(classifyUnclassifiedMedia({ media: { media_type: "sports" } }).category, "sports");
});

test("unclassified policy rejects keyword-only and conflicting evidence", () => {
  const movie = classifyUnclassifiedMedia({
    media: { media_type: "movie", external_source: "tmdb", external_id: "2", metadata_status: "matched", metadata_confidence: 0.99, title: "Live Concert 2024" },
  });
  assert.equal(movie.category, "movies");
  const ambiguous = classifyUnclassifiedMedia({ media: { title: "Anime Concert Sport Episode" } });
  assert.equal(ambiguous.category, "unknown");
  assert.equal(ambiguous.reason, "AMBIGUOUS_KEYWORD_ONLY");
  assert.equal(classifyUnclassifiedMedia({ media: { title: "Japanese animation", genres_json: '["Animation"]' } }).category, "unknown");
});

test("unclassified audit is read-only, bounded and deterministic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-unclassified-audit-"));
  try {
    const databasePath = path.join(directory, "catalog.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE media (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, original_title TEXT, media_type TEXT NOT NULL,
        category TEXT NOT NULL, year INTEGER, tvshow_id INTEGER, external_source TEXT, external_id TEXT,
        metadata_status TEXT, metadata_confidence REAL, genres_json TEXT, countries_json TEXT,
        languages_json TEXT, is_active INTEGER NOT NULL
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY, media_id INTEGER, parsed_season INTEGER, parsed_episode INTEGER,
        is_active INTEGER, is_playable_video INTEGER, original_name TEXT
      );
      INSERT INTO media VALUES
        (1, 'Trusted Movie', NULL, 'movie', 'unknown', 2024, NULL, 'tmdb', '1', 'matched', 0.99, '[]', '[]', '[]', 1),
        (2, 'Weak Concert', NULL, 'unknown', 'unknown', NULL, NULL, NULL, NULL, 'local', 0.4, '[]', '[]', '[]', 1),
        (3, 'Episode', NULL, 'unknown', 'unknown', NULL, NULL, NULL, NULL, 'local', 0.4, '[]', '[]', '[]', 1);
      INSERT INTO files VALUES (1, 3, 1, 2, 1, 1, 'Episode S01E02.mkv');
    `);
    const before = database.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'unknown'").get().count;
    database.close();
    const left = runUnclassifiedAudit({ databasePath, sampleLimit: 2 });
    const right = runUnclassifiedAudit({ databasePath, sampleLimit: 2 });
    assert.equal(left.catalog_read_only, true);
    assert.equal(left.sqlite_write_performed, false);
    assert.equal(left.proposed_by_category.movies, 1);
    assert.equal(left.proposed_by_category.series, 1);
    assert.deepEqual(left, right);
    const check = new Database(databasePath, { readonly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM media WHERE category = 'unknown'").get().count, before);
    check.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
