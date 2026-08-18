const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { DEEP_CONFIDENCE, classifyDeepUnclassifiedMedia } = require("../lib/media-classifier");
const { aggregateFileEvidence, runDeepUnclassifiedAudit } = require("../scripts/audit-unclassified-classification-v2");

function evidence(overrides = {}) {
  return {
    files: 4, episodePatternFiles: 0, distinctEpisodeKeys: 0, episodePatternRatio: 0,
    episodeWordFiles: 0, distinctEpisodeNumbers: 0, episodeWordRatio: 0,
    documentaryFiles: 0, documentaryRatio: 0, musicVideoFiles: 0, musicVideoRatio: 0,
    concertFiles: 0, concertRatio: 0, sportFiles: 0, sportRatio: 0,
    nonGenericEpisodeTitle: false, ...overrides,
  };
}

test("deep classifier accepts multi-file episode consensus", () => {
  const result = classifyDeepUnclassifiedMedia({ media: { media_type: "unknown", title: "Example Show" }, fileEvidence: evidence({ episodePatternFiles: 4, distinctEpisodeKeys: 4, episodePatternRatio: 1 }) });
  assert.equal(result.category, "series");
  assert.equal(result.confidenceClass, DEEP_CONFIDENCE.HIGH);
  assert.equal(result.eligible, true);
});

test("deep classifier accepts episode-word consensus but not one episode keyword", () => {
  const strong = classifyDeepUnclassifiedMedia({ media: { media_type: "unknown", title: "Example Show" }, fileEvidence: evidence({ episodeWordFiles: 8, distinctEpisodeNumbers: 8, episodeWordRatio: 1, nonGenericEpisodeTitle: true }) });
  assert.equal(strong.category, "series");
  assert.equal(classifyDeepUnclassifiedMedia({ media: { media_type: "unknown", title: "Episode" }, fileEvidence: evidence({ episodeWordFiles: 1, distinctEpisodeNumbers: 1, episodeWordRatio: 1 }) }).category, "unknown");
});

test("deep classifier accepts conservative documentary, concert and music-video consensus", () => {
  for (const [category, field] of [["documentaries", "documentary"], ["concerts", "concert"], ["music-videos", "musicVideo"]]) {
    const result = classifyDeepUnclassifiedMedia({ media: { media_type: "unknown", title: "Example" }, fileEvidence: evidence({ [`${field}Files`]: 3, [`${field}Ratio`]: 0.75 }) });
    assert.equal(result.category, category);
    assert.equal(result.confidenceClass, DEEP_CONFIDENCE.HIGH);
  }
});

test("deep classifier rejects keyword collisions and conflicting evidence", () => {
  assert.equal(classifyDeepUnclassifiedMedia({ media: { media_type: "unknown", title: "Live Sport Episode" }, fileEvidence: evidence({ keywordOnly: true }) }).eligible, false);
  const conflict = classifyDeepUnclassifiedMedia({ media: { media_type: "unknown", title: "Documentary Concert" }, fileEvidence: evidence({ documentaryFiles: 3, documentaryRatio: 0.75, concertFiles: 3, concertRatio: 0.75 }) });
  assert.equal(conflict.confidenceClass, DEEP_CONFIDENCE.CONFLICTING);
  assert.equal(conflict.eligible, false);
});

test("trusted provider type remains authoritative but conflicts with strong series structure", () => {
  assert.equal(classifyDeepUnclassifiedMedia({ media: { media_type: "movie", external_source: "tmdb", external_id: "42", metadata_status: "matched", metadata_confidence: 0.99 }, fileEvidence: evidence() }).category, "movies");
  const conflict = classifyDeepUnclassifiedMedia({ media: { media_type: "movie", external_source: "tmdb", external_id: "42", metadata_status: "matched", metadata_confidence: 0.99 }, fileEvidence: evidence({ episodePatternFiles: 4, distinctEpisodeKeys: 4, episodePatternRatio: 1 }) });
  assert.equal(conflict.confidenceClass, DEEP_CONFIDENCE.CONFLICTING);
});

test("file aggregation uses tolerant episode parsing and preserves Unicode names", () => {
  const result = aggregateFileEvidence([
    { original_name: "[Judas] Príbeh - S01E01v2.mkv", extension: "mkv", is_active: 1, is_playable_video: 1 },
    { original_name: "[Judas] Príbeh - S01E02v2.mkv", extension: "mkv", is_active: 1, is_playable_video: 1 },
    { original_name: "[Judas] Príbeh - S01E03v2.mkv", extension: "mkv", is_active: 1, is_playable_video: 1 },
  ]);
  assert.equal(result.episodePatternFiles, 3);
  assert.equal(result.distinctEpisodeKeys, 3);
  assert.match(result.sampleNames[0], /Príbeh/);
});

test("deep audit is read-only, batched and deterministic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-deep-classification-"));
  try {
    const databasePath = path.join(directory, "catalog.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE media (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, original_title TEXT, media_type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'unknown', year INTEGER, tvshow_id INTEGER,
        external_source TEXT, external_id TEXT, metadata_status TEXT NOT NULL DEFAULT 'local',
        metadata_confidence REAL NOT NULL DEFAULT 0, genres_json TEXT NOT NULL DEFAULT '[]',
        countries_json TEXT NOT NULL DEFAULT '[]', languages_json TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY, media_id INTEGER, original_name TEXT NOT NULL, extension TEXT,
        parsed_season INTEGER, parsed_episode INTEGER, is_active INTEGER NOT NULL,
        is_playable_video INTEGER NOT NULL
      );
      CREATE TABLE media_aliases (id INTEGER PRIMARY KEY, media_id INTEGER NOT NULL, alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL, language TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO media(id,title,media_type,category,is_active) VALUES
        (1,'Series Fixture','unknown','unknown',1),
        (2,'Dokument Fixture','unknown','unknown',1),
        (3,'Unknown Fixture','unknown','unknown',1),
        (4,'Existing Movie','movie','movies',1);
      INSERT INTO files VALUES
        (1,1,'Series Fixture S01E01v2.mkv','mkv',NULL,NULL,1,1),
        (2,1,'Series Fixture S01E02v2.mkv','mkv',NULL,NULL,1,1),
        (3,1,'Series Fixture S01E03v2.mkv','mkv',NULL,NULL,1,1),
        (4,2,'History documentary CZ.mkv','mkv',NULL,NULL,1,1),
        (5,2,'History documentary CZ (1).mkv','mkv',NULL,NULL,1,1),
        (6,3,'Ordinary title.mkv','mkv',NULL,NULL,1,1);
    `);
    database.close();
    const left = runDeepUnclassifiedAudit({ databasePath, batchSize: 2 });
    const right = runDeepUnclassifiedAudit({ databasePath, batchSize: 2 });
    assert.equal(left.catalog_read_only, true);
    assert.equal(left.sqlite_write_performed, false);
    assert.equal(left.proposed_by_category.series, 1);
    assert.equal(left.proposed_by_category.documentaries, 1);
    assert.deepEqual(left, right);
    const check = new Database(databasePath, { readonly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM media WHERE category='unknown'").get().count, 3);
    check.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
