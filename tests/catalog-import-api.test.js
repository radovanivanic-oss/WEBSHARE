const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { importCatalog, readJsonLines } = require("../scripts/import-catalog-jsonl");
const { createCatalogApi } = require("../server/catalog-api");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { rebuildMediaFts } = require("../src/repositories/media-repository");

function fixtureItems() {
  return [
    { ident: "dune-1080", name: "Dune.Part.Two.2024.1080p.WEB-DL.CZ.mkv", size: "2000", type: "mkv", category: "video" },
    { ident: "dune-2160", name: "Dune.Part.Two.2024.2160p.BluRay.EN.mkv", size: "4000", type: "mkv", category: "video" },
    { ident: "last-1080", name: "The.Last.of.Us.S01E03.1080p.WEB-DL.CZ.mkv", size: "3000", type: "mkv", category: "video" },
    { ident: "last-2160", name: "The.Last.of.Us.S01E03.2160p.WEB-DL.EN.mkv", size: "5000", type: "mkv", category: "video" },
    { ident: "archive", name: "Movie.Archive.2024.zip", size: "100", type: "zip", category: "video" },
  ];
}

async function createImportedFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-catalog-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  const errorPath = path.join(directory, "errors.jsonl");
  fs.writeFileSync(
    inputPath,
    [...fixtureItems().map((item) => JSON.stringify(item)), "{invalid-json"].join("\n") + "\n"
  );
  const manifestPath = path.join(directory, "catalog-items.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    success: true,
    is_full: true,
    source_size: fs.statSync(inputPath).size,
  }));
  await importCatalog({
    input: inputPath,
    database: databasePath,
    errorLog: errorPath,
    manifest: manifestPath,
    batchSize: 2,
  });
  return { directory, inputPath, databasePath, errorPath, manifestPath };
}

test("JSONL reader resumes from an exact byte offset", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-lines-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "lines.jsonl");
  const first = JSON.stringify({ ident: "one" }) + "\n";
  fs.writeFileSync(input, first + JSON.stringify({ ident: "two" }) + "\n");
  const rows = [];
  for await (const row of readJsonLines(input, Buffer.byteLength(first))) rows.push(JSON.parse(row.line));
  assert.deepEqual(rows, [{ ident: "two" }]);
});

test("streaming import is idempotent and groups file versions", async (t) => {
  const fixture = await createImportedFixture(t);
  let database = openCatalogDatabase(fixture.databasePath, { fileMustExist: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM files").get().count, 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM files WHERE is_playable_video = 1").get().count, 4);
  assert.equal(database.prepare("SELECT file_count FROM candidates WHERE candidate_key LIKE 'movie|dune-part-two|2024'").get().file_count, 2);
  assert.equal(database.prepare("SELECT file_count FROM candidates WHERE candidate_key LIKE 'episode|the-last-of-us|s01|e003'").get().file_count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM metadata_jobs").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media WHERE media_type = 'tv'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media WHERE is_active = 1").get().count, 3);
  assert.equal(database.prepare("SELECT invalid_count FROM import_runs ORDER BY id DESC LIMIT 1").get().invalid_count, 1);
  database.close();

  await importCatalog({
    input: fixture.inputPath,
    database: fixture.databasePath,
    errorLog: fixture.errorPath,
    manifest: fixture.manifestPath,
    batchSize: 3,
  });
  database = openCatalogDatabase(fixture.databasePath, { fileMustExist: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM files").get().count, 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM import_runs").get().count, 2);
  database.close();
});

test("catalog API paginates, limits output and exposes versions without tokens", async (t) => {
  const fixture = await createImportedFixture(t);
  const database = openCatalogDatabase(fixture.databasePath, { fileMustExist: true });
  const config = { ...getCatalogConfig({ CATALOG_DB_PATH: fixture.databasePath }), apiMaxPageSize: 2, apiBasePath: "/api" };
  const app = createCatalogApi({ config, database, skipMigrations: true, logger: false });
  try {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().files, 5);

    const listing = await app.inject({ method: "GET", url: "/api/media?category=movies&page=1&limit=999" });
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.json().pagination.limit, 2);
    assert.equal(listing.json().data.length, 1);
    const media = listing.json().data[0];
    assert.equal(media.versions, 2);
    assert.equal(media.display_title, media.title);

    const files = await app.inject({ method: "GET", url: `/api/media/${media.id}/files` });
    assert.equal(files.statusCode, 200);
    assert.equal(files.json().data.length, 2);
    assert.equal(files.json().data[0].needs_file_link, true);
    assert.equal(Object.prototype.hasOwnProperty.call(files.json().data[0], "wst"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(files.json().data[0], "direct_url"), false);

  const search = await app.inject({ method: "GET", url: "/api/search?q=Dune%27%20OR%201%3D1--" });
    assert.equal(search.statusCode, 200);
    assert.ok(Array.isArray(search.json().data));
  const missing = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(missing.statusCode, 400);
  const series = await app.inject({ method: "GET", url: "/api/media?category=series" });
  assert.equal(series.statusCode, 200);
  assert.equal(series.json().data.length, 1);
  assert.equal(series.json().data[0].media_type, "tv");
  database.prepare("UPDATE media SET overview = ?, poster_url = ?, backdrop_url = ? WHERE media_type = 'tv'").run("Series overview", "https://img/series.jpg", "https://img/backdrop.jpg");
  const seasons = await app.inject({ method: "GET", url: `/api/media/${series.json().data[0].id}/seasons` });
  assert.equal(seasons.statusCode, 200);
  assert.deepEqual(seasons.json().data, [{ season_number: 1, episode_count: 1 }]);
  const lightSeries = await app.inject({ method: "GET", url: "/api/media?category=series&light=1&limit=1" });
  assert.equal(lightSeries.statusCode, 200);
  assert.equal(lightSeries.json().pagination.total, null);
  assert.equal(lightSeries.json().pagination.has_more, false);
  const episodes = await app.inject({ method: "GET", url: `/api/media/${series.json().data[0].id}/episodes?season=1` });
  assert.equal(episodes.statusCode, 200);
  assert.equal(episodes.json().data.length, 1);
  assert.equal(episodes.json().data[0].series_overview, "Series overview");
  assert.equal(episodes.json().data[0].series_poster_url, "https://img/series.jpg");
  const recentEpisodes = await app.inject({ method: "GET", url: "/api/media?category=series&type=episode&sort=recent" });
  assert.equal(recentEpisodes.statusCode, 200);
  assert.equal(recentEpisodes.json().data[0].media_type, "episode");
  assert.equal(recentEpisodes.json().data[0].series_overview, "Series overview");
  } finally {
    await app.close();
    database.close();
  }
});

test("movie news use release dates and metadata failures do not block files", async (t) => {
  const fixture = await createImportedFixture(t);
  const database = openCatalogDatabase(fixture.databasePath, { fileMustExist: true });
  const dune = database.prepare("SELECT * FROM media WHERE media_type = 'movie' AND is_active = 1 LIMIT 1").get();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE media SET external_source = 'tmdb', external_id = '693134',
      external_url = 'https://www.themoviedb.org/movie/693134', release_date = '2024-02-27',
      metadata_status = 'matched'
    WHERE id = ?
  `).run(dune.id);
  const insertMedia = database.prepare(`
    INSERT INTO media(
      media_key, media_type, category, title, year, release_date,
      metadata_status, metadata_confidence, created_at, updated_at, is_active
    ) VALUES (?, 'movie', 'movies', ?, ?, ?, 'local', 0.5, ?, ?, 1)
  `);
  const newestId = Number(insertMedia.run("local:newest", "Newest Movie", 2025, "2025-05-10", now, now).lastInsertRowid);
  database.prepare(`
    UPDATE media SET external_source = 'tmdb', external_id = '999001',
      external_url = 'https://www.themoviedb.org/movie/999001', metadata_status = 'matched'
    WHERE id = ?
  `).run(newestId);
  const yearOnlyId = Number(insertMedia.run("local:year-only", "Year Only Movie", 2023, null, now, now).lastInsertRowid);
  insertMedia.run("local:unknown-year", "Unknown Year", null, null, now, now);
  insertMedia.run("local:future", "Future Movie", 2099, null, now, now);

  const metadataProvider = {
    async get(media) {
      if (media.id === newestId) throw Object.assign(new Error("provider failed"), { code: "TEST_FAILURE" });
      return {
        available: true,
        metadataAvailable: true,
        source: "tmdb",
        externalId: media.external_id,
        overview: "Live overview",
        posterUrl: "https://image.test/poster.jpg",
        backdropUrl: null,
        genres: ["Sci-Fi"],
        runtimeMinutes: 166,
        rating: 8.3,
      };
    },
  };
  const config = { ...getCatalogConfig({ CATALOG_DB_PATH: fixture.databasePath }), apiBasePath: "/api" };
  const app = createCatalogApi({ config, database, skipMigrations: true, logger: false, metadataProvider });
  try {
    const listing = await app.inject({ method: "GET", url: "/api/media?category=movies&sort=release_date_desc&page=1&limit=50" });
    assert.equal(listing.statusCode, 200);
    assert.deepEqual(listing.json().data.map((item) => item.title), ["Newest Movie", dune.title, "Year Only Movie"]);
    assert.equal(listing.json().data.some((item) => item.title === "Unknown Year"), false);
    assert.equal(listing.json().data.some((item) => item.title === "Future Movie"), false);
    const duneListing = listing.json().data.find((item) => item.id === dune.id);
    assert.equal(duneListing.external_id, "693134");
    assert.equal(duneListing.external_url, "https://www.themoviedb.org/movie/693134");
    assert.equal(duneListing.release_date_precision, "day");
    assert.equal(duneListing.available_files_count, 2);
    assert.equal(duneListing.best_quality, "2160p");
    const yearOnlyListing = listing.json().data.find((item) => item.id === yearOnlyId);
    assert.equal(yearOnlyListing.release_date, null);
    assert.equal(yearOnlyListing.release_date_precision, "year");

    const metadata = await app.inject({ method: "GET", url: `/api/media/${dune.id}/metadata` });
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.json().overview, "Live overview");

    const fallback = await app.inject({ method: "GET", url: `/api/media/${newestId}/metadata` });
    assert.equal(fallback.statusCode, 200);
    assert.equal(fallback.json().available, false);
    assert.equal(fallback.json().reason, "metadata_provider_error");

    const files = await app.inject({ method: "GET", url: `/api/media/${dune.id}/files` });
    assert.equal(files.statusCode, 200);
    assert.equal(files.json().data[0].original_name, files.json().data[0].name);
    assert.equal(files.json().data[0].size_bytes, files.json().data[0].size);
    assert.equal(files.json().data[0].is_active, true);
  } finally {
    await app.close();
    database.close();
  }
});

test("API exposes a safe display title while preserving identity and search aliases", async (t) => {
  const fixture = await createImportedFixture(t);
  const database = openCatalogDatabase(fixture.databasePath, { fileMustExist: true });
  const movie = database.prepare("SELECT * FROM media WHERE media_type = 'movie' AND is_active = 1 LIMIT 1").get();
  database.prepare("UPDATE media SET title = ?, original_title = ?, metadata_status = 'matched', metadata_confidence = 0.98 WHERE id = ?")
    .run("入戏", "入戏", movie.id);
  database.prepare("INSERT INTO media_aliases(media_id, alias, normalized_alias, language, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(movie.id, "Deep In The Act", "deep in the act", "en", "tmdb", new Date().toISOString());
  rebuildMediaFts(database, movie.id);
  const config = { ...getCatalogConfig({ CATALOG_DB_PATH: fixture.databasePath }), apiBasePath: "/api" };
  const app = createCatalogApi({ config, database, skipMigrations: true, logger: false });
  try {
    const listing = await app.inject({ method: "GET", url: "/api/media?category=movies&page=1&limit=50" });
    assert.equal(listing.statusCode, 200);
    const row = listing.json().data.find((item) => item.id === movie.id);
    assert.equal(row.title, "入戏");
    assert.equal(row.original_title, "入戏");
    assert.equal(row.display_title, "Deep In The Act");
    const search = await app.inject({ method: "GET", url: "/api/search/movies?q=Deep%20In%20The%20Act" });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().data.some((item) => item.id === movie.id), true);
  } finally {
    await app.close();
    database.close();
  }
});

test("series new releases use the newest non-future episode date with deterministic fallbacks", async (t) => {
  const fixture = await createImportedFixture(t);
  const database = openCatalogDatabase(fixture.databasePath, { fileMustExist: true });
  const now = new Date().toISOString();
  const series = database.prepare("SELECT * FROM media WHERE media_type = 'tv' AND is_active = 1 LIMIT 1").get();
  const episode = database.prepare("SELECT * FROM media WHERE tvshow_id = ? LIMIT 1").get(series.id);
  database.prepare("UPDATE media SET release_date = '2020-01-01', year = 2020 WHERE id = ?").run(series.id);
  database.prepare("UPDATE media SET release_date = '2026-02-01', year = 2026 WHERE id = ?").run(episode.id);
  const insertSeries = database.prepare(`
    INSERT INTO media(media_key, media_type, category, title, year, release_date,
      metadata_status, metadata_confidence, created_at, updated_at, is_active)
    VALUES (?, 'tv', 'series', ?, ?, ?, 'local', 0.8, ?, ?, 1)
  `);
  const futureId = Number(insertSeries.run("local:future-series", "Future Series", 2024, "2099-01-01", now, now).lastInsertRowid);
  const yearOnlyId = Number(insertSeries.run("local:year-only-series", "Year Only Series", 2025, null, now, now).lastInsertRowid);
  const config = { ...getCatalogConfig({ CATALOG_DB_PATH: fixture.databasePath }), apiBasePath: "/api" };
  const app = createCatalogApi({ config, database, skipMigrations: true, logger: false });
  try {
    const listing = await app.inject({ method: "GET", url: "/api/media?category=series&sort=series_release_date_desc&page=1&limit=50" });
    assert.equal(listing.statusCode, 200);
    const data = listing.json().data;
    assert.equal(data[0].id, series.id);
    assert.equal(data[0].latest_episode_date, "2026-02-01");
    assert.equal(data[0].release_date, "2026-02-01");
    assert.equal(data[0].release_date_precision, "day");
    assert.ok(data.findIndex((item) => item.id === yearOnlyId) < data.findIndex((item) => item.id === futureId));
    const future = data.find((item) => item.id === futureId);
    assert.equal(future.release_date, null);
    assert.equal(future.release_date_precision, "year");
    assert.deepEqual(data.map((item) => item.id), [...data].sort((left, right) => {
      const leftDate = left.release_date || `${left.year || 0}-01-01`;
      const rightDate = right.release_date || `${right.year || 0}-01-01`;
      return rightDate.localeCompare(leftDate) || right.id - left.id;
    }).map((item) => item.id));
  } finally {
    await app.close();
    database.close();
  }
});
