"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const test = require("node:test");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { buildPublicCatalog, validatePublicCatalog } = require("../lib/public-catalog");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const {
  auditSeriesIdentities,
  applySeriesReconciliation,
  buildSeriesReconciliationPlan,
  normalizeSeriesTitle,
  resolveCanonicalSeriesRoot,
} = require("../lib/series-identity");

function fixtureNames(names) {
  return names.map((name, index) => JSON.stringify({ ident: `fixture-${index}-${crypto.randomUUID()}`, name, type: path.extname(name).slice(1), size: 1000 + index })).join("\n") + "\n";
}

async function fixture(t, names = ["Atlas Show 2024 S01E01.mkv"]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "series-identity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  fs.writeFileSync(input, fixtureNames(names));
  await importCatalog({ input, database: databasePath, batchSize: 100 });
  return { directory, databasePath, database: openCatalogDatabase(databasePath, { fileMustExist: true }) };
}

function insertRoot(database, { mediaKey, title, year = null, externalId = null, active = 1 }) {
  const now = new Date().toISOString();
  return Number(database.prepare(`
    INSERT INTO media(media_key, external_source, external_id, media_type, category, title, year,
      metadata_status, metadata_confidence, created_at, updated_at, is_active)
    VALUES (?, ?, ?, 'tv', 'series', ?, ?, ?, ?, ?, ?, ?)
  `).run(mediaKey, externalId ? "tmdb" : null, externalId, title, year, externalId ? "matched" : "local", externalId ? 0.98 : 0.96, now, now, active).lastInsertRowid);
}

function insertEpisode(database, rootId, { externalId = null, season = 1, episode = 1, active = 1, title = "Atlas Show" } = {}) {
  const now = new Date().toISOString();
  const suffix = externalId || `local-${rootId}-${season}-${episode}`;
  return Number(database.prepare(`
    INSERT INTO media(media_key, external_source, external_id, media_type, category, title, year,
      season_number, episode_number, tvshow_id, metadata_status, metadata_confidence,
      created_at, updated_at, is_active)
    VALUES (?, ?, ?, 'episode', 'series', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`episode:${suffix}`, externalId ? "tmdb" : null, externalId, `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`, season, episode, rootId, externalId ? "matched" : "local", externalId ? 0.98 : 0.96, now, now, active).lastInsertRowid);
}

function insertPlayableFile(database, mediaId, ident) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO files(ident, original_name, normalized_name, size_bytes, first_seen_at, last_seen_at,
      is_active, is_playable_video, media_id, parse_version, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, 1000, ?, ?, 1, 1, ?, 'fixture', '{}', ?, ?)
  `).run(ident, `${ident}.mkv`, ident, now, now, mediaId, now, now);
}

function addTmdbSeries(database, { id, title = "Atlas Show", year = 2024, episodes = ["1:1"], files = true }) {
  const rootId = insertRoot(database, { mediaKey: `tmdb:tv:${id}`, title, year, externalId: String(id) });
  for (const value of episodes) {
    const [season, episode] = value.split(":").map(Number);
    const episodeId = insertEpisode(database, rootId, { externalId: `${id}:s${season}:e${episode}`, season, episode, title });
    if (files) insertPlayableFile(database, episodeId, `tmdb-${id}-${season}-${episode}`);
  }
  return rootId;
}

function addLocalSeries(database, { key = "atlas-show", title = "Atlas Show", year = 2024, episodes = ["1:1"], files = true }) {
  const rootId = insertRoot(database, { mediaKey: `local:tv|${key}`, title, year });
  for (const value of episodes) {
    const [season, episode] = value.split(":").map(Number);
    const episodeId = insertEpisode(database, rootId, { season, episode, title });
    if (files) insertPlayableFile(database, episodeId, `local-${key}-${season}-${episode}`);
  }
  return rootId;
}

function activeRoot(database, mediaKey) {
  return database.prepare("SELECT * FROM media WHERE media_key = ?").get(mediaKey);
}

test("existing TMDb root plus later local episode reuses the canonical root", async (t) => {
  const fixtureData = await fixture(t);
  const { database } = fixtureData;
  const tmdbRoot = addTmdbSeries(database, { id: 9001, episodes: ["1:1"] });
  const resolution = resolveCanonicalSeriesRoot(database, { candidateType: "episode", normalizedTitle: "atlas-show", title: "Atlas Show", year: 2024, season: 2, episode: 1 });
  assert.equal(resolution.status, "MATCHED");
  assert.equal(resolution.root_id, tmdbRoot);
  database.close();
});

test("local root later receiving authoritative TMDb identity reconciles its ownership", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S02E01.mkv"]);
  const { database } = fixtureData;
  const localRoot = activeRoot(database, "local:tv|atlas-show");
  const tmdbRoot = addTmdbSeries(database, { id: 9002, episodes: ["1:1"] });
  const result = require("../lib/series-identity").reconcileCanonicalSeriesInPlace(database, tmdbRoot, { title: "Atlas Show", year: 2024 });
  assert.equal(result.status, "RECONCILED");
  assert.equal(database.prepare("SELECT tvshow_id FROM media WHERE id=?").get(localRoot.id).tvshow_id, tmdbRoot);
  assert.equal(database.prepare("SELECT is_active FROM media WHERE id=?").get(localRoot.id).is_active, 0);
  database.close();
});

test("complementary seasons merge under one authoritative root", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S02E01.mkv"]);
  const { database } = fixtureData;
  const tmdbRoot = addTmdbSeries(database, { id: 9003, episodes: ["1:1"] });
  const plan = buildSeriesReconciliationPlan(database);
  assert.equal(plan.totals.groups, 1);
  applySeriesReconciliation(database, plan);
  assert.deepEqual(database.prepare("SELECT season_number,episode_number FROM media WHERE tvshow_id=? AND is_active=1 ORDER BY season_number,episode_number").all(tmdbRoot), [{ season_number: 1, episode_number: 1 }, { season_number: 2, episode_number: 1 }]);
  database.close();
});

test("overlapping episodes combine source variants without duplicate active episodes", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S01E01.mkv"]);
  const { database } = fixtureData;
  const tmdbRoot = addTmdbSeries(database, { id: 9004, episodes: ["1:1"] });
  const beforeFiles = database.prepare("SELECT COUNT(*) AS count FROM files WHERE is_active=1 AND is_playable_video=1").get().count;
  const plan = buildSeriesReconciliationPlan(database);
  applySeriesReconciliation(database, plan);
  const afterFiles = database.prepare("SELECT COUNT(*) AS count FROM files WHERE is_active=1 AND is_playable_video=1").get().count;
  assert.equal(afterFiles, beforeFiles);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media WHERE tvshow_id=? AND is_active=1 AND season_number=1 AND episode_number=1").get(tmdbRoot).count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM files WHERE media_id=(SELECT id FROM media WHERE tvshow_id=? AND season_number=1 AND episode_number=1 AND is_active=1)").get(tmdbRoot).count, 2);
  database.close();
});

test("same title with different year remains ambiguous", async (t) => {
  const fixtureData = await fixture(t, []);
  const { database } = fixtureData;
  addTmdbSeries(database, { id: 9005, year: 2023, episodes: ["1:1"] });
  addLocalSeries(database, { year: 2024, episodes: ["2:1"] });
  const candidate = auditSeriesIdentities(database).candidates.find((item) => item.normalizedTitle === "atlas-show");
  assert.equal(candidate.confidence, "AMBIGUOUS");
  assert.equal(buildSeriesReconciliationPlan(database).totals.groups, 0);
  database.close();
});

test("same normalized title with conflicting TMDb IDs remains ambiguous", async (t) => {
  const fixtureData = await fixture(t, []);
  const { database } = fixtureData;
  addTmdbSeries(database, { id: 9006, episodes: ["1:1"] });
  addTmdbSeries(database, { id: 9007, episodes: ["2:1"] });
  addLocalSeries(database, { episodes: ["3:1"] });
  const candidate = auditSeriesIdentities(database).candidates.find((item) => item.normalizedTitle === "atlas-show");
  assert.equal(candidate.confidence, "AMBIGUOUS");
  assert.equal(buildSeriesReconciliationPlan(database).totals.groups, 0);
  database.close();
});

test("local-only ambiguous candidates remain untouched", async (t) => {
  const fixtureData = await fixture(t, []);
  const { database } = fixtureData;
  addLocalSeries(database, { key: "same-one", episodes: ["1:1"] });
  addLocalSeries(database, { key: "same-two", episodes: ["2:1"] });
  const candidate = auditSeriesIdentities(database).candidates.find((item) => item.normalizedTitle === "atlas-show");
  assert.equal(candidate.confidence, "AMBIGUOUS");
  const before = database.prepare("SELECT COUNT(*) AS count FROM media WHERE media_type='tv' AND category='series' AND tvshow_id IS NULL AND is_active=1").get().count;
  assert.equal(buildSeriesReconciliationPlan(database).totals.groups, 0);
  const after = database.prepare("SELECT COUNT(*) AS count FROM media WHERE media_type='tv' AND category='series' AND tvshow_id IS NULL AND is_active=1").get().count;
  assert.equal(after, before);
  database.close();
});

test("reconciliation is idempotent", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S02E01.mkv"]);
  const { database } = fixtureData;
  addTmdbSeries(database, { id: 9008, episodes: ["1:1"] });
  const plan = buildSeriesReconciliationPlan(database);
  applySeriesReconciliation(database, plan);
  const second = buildSeriesReconciliationPlan(database);
  assert.equal(second.totals.groups, 0);
  database.close();
});

test("future episode after reconciliation attaches to the canonical root", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S02E01.mkv"]);
  const { database, databasePath, directory } = fixtureData;
  const tmdbRoot = addTmdbSeries(database, { id: 9009, episodes: ["1:1"] });
  applySeriesReconciliation(database, buildSeriesReconciliationPlan(database));
  database.close();
  const input = path.join(directory, "later.jsonl");
  fs.writeFileSync(input, fixtureNames(["Atlas Show 2024 S03E01.mkv"]));
  await importCatalog({ input, database: databasePath, batchSize: 100 });
  const reopened = openCatalogDatabase(databasePath, { fileMustExist: true });
  assert.equal(reopened.prepare("SELECT tvshow_id FROM media WHERE season_number=3 AND episode_number=1").get().tvshow_id, tmdbRoot);
  reopened.close();
});

test("catalog export contains one canonical series with combined seasons", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S02E01.mkv"]);
  const { database, databasePath, directory } = fixtureData;
  addTmdbSeries(database, { id: 9010, episodes: ["1:1"] });
  applySeriesReconciliation(database, buildSeriesReconciliationPlan(database));
  database.close();
  const output = path.join(directory, "public");
  const built = buildPublicCatalog({ database: databasePath, outputDir: output, generationId: "series-fixture" });
  validatePublicCatalog(built.root);
  assert.equal(built.manifest.categories.find((item) => item.category === "series").record_count, 1);
  assert.equal(built.manifest.episodes.record_count, 2);
});

test("identity resolver and implementation contain no Gentlemen-specific branch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "series-identity.js"), "utf8");
  assert.doesNotMatch(source, /gentlemen/iu);
  assert.equal(normalizeSeriesTitle("The Gentlemen"), "the-gentlemen");
});

test("public episode objects retain canonical ownership after export", async (t) => {
  const fixtureData = await fixture(t, ["Atlas Show 2024 S02E01.mkv"]);
  const { database, databasePath, directory } = fixtureData;
  const tmdbRoot = addTmdbSeries(database, { id: 9011, episodes: ["1:1"] });
  applySeriesReconciliation(database, buildSeriesReconciliationPlan(database));
  database.close();
  const built = buildPublicCatalog({ database: databasePath, outputDir: path.join(directory, "consumer"), generationId: "consumer-fixture" });
  const episodeObjects = built.manifest.episodes.shards.flatMap((shard) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(built.root, "generations", "consumer-fixture", "objects", shard.sha256 + ".json.gz"))).toString("utf8")));
  assert.deepEqual(episodeObjects.map((group) => group.id), [tmdbRoot]);
  assert.deepEqual(episodeObjects[0].episodes.map((episode) => episode.season_number), [1, 2]);
});
