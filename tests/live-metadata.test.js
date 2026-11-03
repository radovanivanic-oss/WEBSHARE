const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { TmdbLiveMetadata } = require("../providers/tmdb-live-metadata");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");

test("live metadata uses language fallback and then serves SQLite cache", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-live-metadata-test-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const database = openCatalogDatabase(databasePath);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = getCatalogConfig({
    CATALOG_DB_PATH: databasePath,
    TMDB_API_KEY: "test-key",
    TMDB_LANGUAGE: "sk-SK",
    TMDB_FALLBACK_LANGUAGES: "cs-CZ,en-US",
    TMDB_LIVE_REQUEST_TIMEOUT_MS: "100",
    TMDB_LIVE_TOTAL_TIMEOUT_MS: "1000",
  });
  migrateDatabase(database, config.migrationsDir, { logger: false });
  const service = new TmdbLiveMetadata(config, database, { warn() {} });
  const calls = [];
  service.client.get = async (endpoint, options) => {
    calls.push({ endpoint, language: options.params.language });
    if (options.params.language === "sk-SK") {
      return { data: { id: 693134, overview: "", poster_path: "/poster.jpg", genres: [] } };
    }
    return {
      data: {
        id: 693134,
        overview: "Český popis",
        poster_path: "/poster.jpg",
        backdrop_path: "/backdrop.jpg",
        genres: [{ id: 878, name: "Sci-Fi" }],
        runtime: 166,
        vote_average: 8.3,
      },
    };
  };
  const media = {
    external_source: "tmdb",
    external_id: "693134",
    external_url: "https://www.themoviedb.org/movie/693134",
    media_type: "movie",
  };
  const first = await service.get(media);
  assert.equal(first.available, true);
  assert.equal(first.overview, "Český popis");
  assert.equal(first.language, "cs-CZ");
  assert.equal(first.posterUrl, "https://image.tmdb.org/t/p/w500/poster.jpg");
  assert.equal(calls.length, 2);

  const second = await service.get(media);
  assert.equal(second.cached, true);
  assert.equal(second.overview, "Český popis");
  assert.equal(calls.length, 2);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM metadata_live_cache").get().count, 1);
});

test("episode metadata chooses the exact series and loads the episode still/plot", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-live-episode-test-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const database = openCatalogDatabase(databasePath);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = getCatalogConfig({
    CATALOG_DB_PATH: databasePath,
    TMDB_API_KEY: "test-key",
    TMDB_LANGUAGE: "sk-SK",
    TMDB_FALLBACK_LANGUAGES: "en-US",
    TMDB_LIVE_REQUEST_TIMEOUT_MS: "100",
    TMDB_LIVE_TOTAL_TIMEOUT_MS: "1000",
  });
  migrateDatabase(database, config.migrationsDir, { logger: false });
  const service = new TmdbLiveMetadata(config, database, { warn() {} });
  const calls = [];
  service.client.get = async (endpoint, options) => {
    calls.push(endpoint);
    if (endpoint === "/search/tv") {
      return { data: { results: [
        { id: 111, name: "Gold Rush: White Water", first_air_date: "2018-01-01" },
        { id: 222, name: "Gold Rush", first_air_date: "2010-12-03" },
      ] } };
    }
    return { data: { id: 9001, overview: "Episode plot", still_path: "/still.jpg", runtime: 43, vote_average: 8.1 } };
  };
  const result = await service.get({
    id: 77,
    title: "Gold Rush",
    media_type: "episode",
    tvshow_id: null,
    season_number: 17,
    episode_number: 1,
    external_source: null,
    external_id: null,
  });
  assert.equal(result.available, true);
  assert.equal(result.overview, "Episode plot");
  assert.equal(result.posterUrl, "https://image.tmdb.org/t/p/w500/still.jpg");
  assert.deepEqual(calls, ["/search/tv", "/tv/222/season/17/episode/1"]);
});
