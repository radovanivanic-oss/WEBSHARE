const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { TmdbClient } = require("../providers/tmdb-client");
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
