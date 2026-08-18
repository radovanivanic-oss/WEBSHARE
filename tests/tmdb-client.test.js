const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { TmdbClient } = require("../providers/tmdb-client");
const { TmdbLiveMetadata } = require("../providers/tmdb-live-metadata");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");

test("TMDb detail fetch merges overview from fallback language", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-tmdb-client-test-"));
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
    TMDB_REQUEST_DELAY_MS: "0",
  });
  migrateDatabase(database, config.migrationsDir, { logger: false });

  const client = new TmdbClient(config, database, { warn() {} });
  const calls = [];
  client.client.get = async (endpoint, options) => {
    calls.push({ endpoint, language: options.params.language });
    if (options.params.language === "sk-SK") {
      return { status: 200, data: { id: 1202033, overview: "", poster_path: "/poster.jpg" } };
    }
    return {
      status: 200,
      data: {
        id: 1202033,
        overview: "Český popis",
        poster_path: "/poster.jpg",
        backdrop_path: "/backdrop.jpg",
        runtime: 109,
      },
    };
  };

  const details = await client.details("movie", 1202033);
  assert.equal(details.overview, "Český popis");
  assert.equal(details.poster_path, "/poster.jpg");
  assert.equal(details.backdrop_path, "/backdrop.jpg");
  assert.equal(calls.length, 2);
});

test("live metadata can resolve local TV shows by title", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-tmdb-live-test-"));
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
  });
  migrateDatabase(database, config.migrationsDir, { logger: false });

  const provider = new TmdbLiveMetadata(config, database, { warn() {} });
  const calls = [];
  provider.client.get = async (endpoint, options) => {
    calls.push({ endpoint, language: options.params.language || null });
    if (endpoint === "/search/tv") {
      return {
        status: 200,
        data: {
          results: [
            { id: 48891, name: "Brooklyn Nine-Nine", original_name: "Brooklyn Nine-Nine" },
            { id: 999, name: "Brooklyn", original_name: "Brooklyn" },
          ],
        },
      };
    }
    if (endpoint === "/tv/48891" && options.params.language === "sk-SK") {
      return { status: 200, data: { id: 48891, overview: "", poster_path: "/poster.jpg", genres: [] } };
    }
    return {
      status: 200,
      data: {
        id: 48891,
        overview: "Situačná komédia z policajného okrsku.",
        poster_path: "/poster.jpg",
        backdrop_path: "/backdrop.jpg",
        episode_run_time: [22],
        vote_average: 8.2,
        genres: [{ name: "Komédia" }],
      },
    };
  };

  const payload = await provider.get({
    id: 471485,
    title: "Brooklyn Nine-Nine",
    media_type: "tv",
    external_source: null,
    external_id: null,
  });

  assert.equal(payload.available, true);
  assert.equal(payload.externalId, "48891");
  assert.equal(payload.overview, "Situačná komédia z policajného okrsku.");
  assert.equal(payload.posterUrl, "https://image.tmdb.org/t/p/w500/poster.jpg");
  assert.equal(payload.runtimeMinutes, 22);
  assert.deepEqual(calls.map((call) => call.endpoint), ["/search/tv", "/tv/48891", "/tv/48891"]);

  provider.client.get = async () => {
    throw new Error("should use cache");
  };
  const cached = await provider.get({
    id: 471485,
    title: "Brooklyn Nine-Nine",
    media_type: "tv",
    external_source: null,
    external_id: null,
  });
  assert.equal(cached.cached, true);
  assert.equal(cached.overview, payload.overview);
});

test("TMDb client enforces the configured minimum live request interval", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-tmdb-rate-test-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const database = openCatalogDatabase(databasePath);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = getCatalogConfig({ TMDB_API_KEY: "test-key", TMDB_REQUEST_DELAY_MS: "0", TMDB_LANGUAGE: "en-US", TMDB_FALLBACK_LANGUAGES: "en-US" });
  migrateDatabase(database, config.migrationsDir, { logger: false });
  const client = new TmdbClient(config, database, { warn() {} }, { minRequestIntervalMs: 20 });
  client.client.get = async () => ({ status: 200, data: { ok: true } });
  const started = Date.now();
  await client.request("/one", {}, "en-US");
  await client.request("/two", {}, "en-US");
  assert.ok(Date.now() - started >= 15);
});
