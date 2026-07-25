const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { processJob } = require("../scripts/enrich-metadata");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");

test("TMDb external ID merges differently parsed movie candidates", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-enrichment-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  fs.writeFileSync(inputPath, [
    JSON.stringify({ ident: "matrix-a", name: "The.Matrix.1999.1080p.WEB-DL.mkv", type: "mkv", category: "video", size: 1000 }),
    JSON.stringify({ ident: "matrix-b", name: "Matrix.The.1999.2160p.WEB-DL.mkv", type: "mkv", category: "video", size: 2000 }),
  ].join("\n") + "\n");
  await importCatalog({ input: inputPath, database: databasePath, batchSize: 2 });
  const database = openCatalogDatabase(databasePath, { fileMustExist: true });
  const config = {
    ...getCatalogConfig({ CATALOG_DB_PATH: databasePath }),
    metadataAutoMatchThreshold: 0.5,
    metadataAmbiguousThreshold: 0.4,
    tmdbLanguage: "sk-SK",
  };
  const fakeClient = {
    async search() {
      return [{ id: 603, title: "The Matrix", release_date: "1999-03-31", popularity: 100 }];
    },
    async details() {
      return {
        id: 603,
        title: "The Matrix",
        original_title: "The Matrix",
        release_date: "1999-03-31",
        overview: "Test",
        genres: [{ id: 878, name: "Science Fiction" }],
        production_countries: [{ iso_3166_1: "US", name: "United States" }],
        spoken_languages: [{ iso_639_1: "en", name: "English" }],
        credits: { crew: [], cast: [] },
        alternative_titles: { titles: [] },
        vote_average: 8.2,
        vote_count: 1000,
      };
    },
  };

  try {
    const jobs = database.prepare("SELECT * FROM metadata_jobs ORDER BY id").all();
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      await processJob(database, fakeClient, job, config, { dryRun: false });
    }
    const linked = database.prepare("SELECT COUNT(DISTINCT media_id) AS count FROM files").get();
    assert.equal(linked.count, 1);
    const matched = database.prepare("SELECT COUNT(*) AS count FROM media WHERE external_source = 'tmdb' AND external_id = '603'").get();
    assert.equal(matched.count, 1);
  } finally {
    database.close();
  }
});
