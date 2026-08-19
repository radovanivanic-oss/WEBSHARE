"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { buildPublicCatalog, validatePublicCatalog } = require("../lib/public-catalog");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "catalog.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);
    INSERT INTO schema_migrations VALUES(9, 'series release evidence performance', 'x', 'now');
    CREATE TABLE media (
      id INTEGER PRIMARY KEY, media_key TEXT, external_source TEXT, external_id TEXT, media_type TEXT,
      category TEXT, title TEXT, original_title TEXT, year INTEGER, release_date TEXT,
      season_number INTEGER, episode_number INTEGER, tvshow_id INTEGER, overview TEXT,
      genres_json TEXT, runtime_minutes INTEGER, rating REAL, vote_count INTEGER,
      countries_json TEXT, languages_json TEXT, director TEXT, cast_json TEXT,
      poster_url TEXT, backdrop_url TEXT, adult INTEGER, metadata_language TEXT,
      metadata_status TEXT, metadata_confidence REAL, metadata_updated_at TEXT, updated_at TEXT,
      is_active INTEGER
    );
    CREATE TABLE media_aliases(id INTEGER PRIMARY KEY, media_id INTEGER, alias TEXT, language TEXT, source TEXT);
    CREATE TABLE files (
      id INTEGER PRIMARY KEY, ident TEXT, original_name TEXT, size_bytes INTEGER, extension TEXT,
      parsed_resolution TEXT, parsed_source TEXT, parsed_video_codec TEXT, parsed_audio_codec TEXT,
      parsed_hdr INTEGER, parsed_dolby_vision INTEGER, parsed_languages_json TEXT,
      parsed_has_dubbing INTEGER, parsed_has_subtitles INTEGER, positive_votes INTEGER,
      negative_votes INTEGER, password_protected INTEGER, media_id INTEGER, is_active INTEGER,
      is_playable_video INTEGER
    );
  `);
  const media = db.prepare(`INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  media.run(10, "movie:10", "tmdb", "27205", "movie", "movies", "Počiatok", "Inception", 2010, "2010-07-15", null, null, null, "plot", "[]", null, null, null, "[]", "[]", null, "[]", null, null, 0, "sk-SK", "matched", 0.99, null, "2026-01-01", 1);
  media.run(20, "tv:20", "tmdb", "300954", "tv", "series", "결혼의 완성", "결혼의 완성", 2026, "2026-07-04", null, null, null, "plot", "[]", null, null, null, "[]", "[]", null, "[]", null, null, 0, "sk-SK", "matched", 0.99, null, "2026-01-01", 1);
  media.run(21, "episode:21", "tmdb", "300954:s1:e1", "episode", "series", "The Husband S01E01", null, 2026, null, 1, 1, 20, null, "[]", null, null, null, "[]", "[]", null, "[]", null, null, 0, null, "matched", 0.99, null, "2026-01-01", 1);
  db.prepare("INSERT INTO media_aliases VALUES(1,20,'The Completion of Marriage',NULL,'tmdb')").run();
  const file = db.prepare("INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  file.run(100, "movie-ident", "Inception.mkv", 100, "mkv", "1080p", "web", "h264", "aac", 0, 0, "[]", 0, 1, 1, 0, 0, 10, 1, 1);
  file.run(101, "episode-ident", "show S01E01.mkv", 100, "mkv", "1080p", "web", "h264", "aac", 0, 0, "[]", 0, 1, 1, 0, 0, 21, 1, 1);
  db.close();
  return { dir, dbPath, output: path.join(dir, "out") };
}

test("builds and validates a deterministic public media/series/files read model", t => {
  const f = fixture(t);
  const result = buildPublicCatalog({ database: f.dbPath, outputDir: f.output, generationId: "fixture-1", buildSourceCommit: "fixture-commit" });
  const validation = validatePublicCatalog(result.root);
  assert.equal(validation.pass, true);
  assert.equal(validation.media, 2);
  assert.equal(validation.files, 2);
  assert.equal(validation.episodes, 1);
  assert.equal(result.manifest.unclassified_exported, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.root, "generations", "fixture-1", "manifest.json"), "utf8"));
  assert.equal(manifest.source_schema_version, 9);
  assert.equal(manifest.build_source_commit, "fixture-commit");
  assert.ok(manifest.categories.find(x => x.category === "series").record_count === 1);
});

test("fixed-generation manifests and objects are deterministic", t => {
  const f = fixture(t);
  const first = buildPublicCatalog({ database: f.dbPath, outputDir: path.join(f.dir, "one"), generationId: "same-generation" });
  const second = buildPublicCatalog({ database: f.dbPath, outputDir: path.join(f.dir, "two"), generationId: "same-generation" });
  const oneManifest = fs.readFileSync(path.join(first.root, "generations", "same-generation", "manifest.json"));
  const twoManifest = fs.readFileSync(path.join(second.root, "generations", "same-generation", "manifest.json"));
  assert.deepEqual(oneManifest, twoManifest);
  assert.deepEqual(
    fs.readdirSync(path.join(first.root, "generations", "same-generation", "objects")).sort(),
    fs.readdirSync(path.join(second.root, "generations", "same-generation", "objects")).sort(),
  );
});

test("rejects a tampered content-addressed public object", t => {
  const f = fixture(t);
  const result = buildPublicCatalog({ database: f.dbPath, outputDir: f.output, generationId: "fixture-2" });
  const object = fs.readdirSync(path.join(result.root, "generations", "fixture-2", "objects"))[0];
  fs.appendFileSync(path.join(result.root, "generations", "fixture-2", "objects", object), "x");
  assert.throws(() => validatePublicCatalog(result.root), /PUBLIC_OBJECT_HASH_MISMATCH/);
});
