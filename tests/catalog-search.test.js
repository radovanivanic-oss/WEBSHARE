"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { createCatalogApi } = require("../server/catalog-api");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");

const fixtureItems = [
  { ident: "inception-fixture", name: "Inception 2010 1080p AV1 10Bit DKong.mkv", size: "4000", type: "mkv", category: "video" },
  { ident: "inception-alt-one", name: "Inception 2010 720p fixture-one.mkv", size: "3000", type: "mkv", category: "video" },
  { ident: "inception-alt-two", name: "Inception 2010 480p fixture-two.mkv", size: "2000", type: "mkv", category: "video" },
  { ident: "inactive-inception", name: "Inception 2010 inactive.mkv", size: "3000", type: "mkv", category: "video" },
  { ident: "nonplayable-inception", name: "Inception 2010 archive.zip", size: "100", type: "zip", category: "video" },
  { ident: "accent-fixture", name: "Zena 2025 1080p.mkv", size: "2000", type: "mkv", category: "video" },
  { ident: "series-fixture", name: "Oasis S01E01 2026 1080p.mkv", size: "2000", type: "mkv", category: "video" },
];

async function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-catalog-search-"));
  const inputPath = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  const errorPath = path.join(directory, "errors.jsonl");
  const manifestPath = path.join(directory, "catalog-items.manifest.json");
  fs.writeFileSync(inputPath, `${fixtureItems.map((item) => JSON.stringify(item)).join("\n")}\n`);
  fs.writeFileSync(manifestPath, JSON.stringify({ success: true, is_full: true, source_size: fs.statSync(inputPath).size }));
  await importCatalog({ input: inputPath, database: databasePath, errorLog: errorPath, manifest: manifestPath });

  const database = openCatalogDatabase(databasePath, { readonly: false, fileMustExist: true });
  const inception = database.prepare("SELECT media_id AS id FROM files WHERE ident = 'inception-fixture'").get();
  const accent = database.prepare("SELECT media_id AS id FROM files WHERE ident = 'accent-fixture'").get();
  const series = database.prepare("SELECT id FROM media WHERE media_type = 'tv' AND title = 'Oasis'").get();
  assert.ok(inception);
  assert.ok(accent);
  assert.ok(series);
  database.prepare("UPDATE media SET title = 'Unrelated catalogue label', year = NULL WHERE id = ?").run(inception.id);
  database.prepare("UPDATE media SET title = 'Žena', year = 2025 WHERE id = ?").run(accent.id);
  database.exec("DELETE FROM media_fts");
  database.exec(`
    INSERT INTO media_fts(media_id, title, original_title, aliases)
    SELECT CAST(media.id AS TEXT), media.title, COALESCE(media.original_title, ''), '' FROM media
  `);

  database.prepare("UPDATE files SET is_active = 0 WHERE ident = 'inactive-inception'").run();
  const config = { ...getCatalogConfig({ CATALOG_DB_PATH: databasePath }), apiMaxPageSize: 3, apiBasePath: "/api" };
  const app = createCatalogApi({ config, database, skipMigrations: true, logger: false });
  t.after(async () => {
    await app.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app, inceptionId: inception.id, accentId: accent.id, seriesId: series.id };
}

async function search(app, query, params = {}) {
  const searchParams = new URLSearchParams({ q: query, ...params });
  return app.inject({ method: "GET", url: `/api/search?${searchParams.toString()}` });
}

test("catalog search matches filenames, years and active playable files", async (t) => {
  const { app, inceptionId } = await createFixture(t);
  for (const query of ["Inception", "inception", "Inception 2010", "DKong", "2010"]) {
    const response = await search(app, query);
    assert.equal(response.statusCode, 200, query);
    assert.ok(response.json().data.length > 0, query);
    if (query === "DKong") assert.equal(response.json().data.length, 1, query);
    if (query !== "DKong") assert.ok(response.json().data.some((row) => row.id === inceptionId), `${query}: ids=${JSON.stringify(response.json().data.map((row) => row.id))}, expected=${inceptionId}`);
  }

  const files = await app.inject({ method: "GET", url: `/api/media/${inceptionId}/files?limit=10` });
  assert.equal(files.statusCode, 200);
  assert.deepEqual(files.json().data.map((file) => file.ident), ["inception-fixture"]);
});

test("catalog search is Unicode-safe, bounded and deterministic", async (t) => {
  const { app, accentId } = await createFixture(t);
  const first = await search(app, "Zena");
  const second = await search(app, "Žena");
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().data[0].id, accentId);
  assert.deepEqual(first.json().data.map((row) => row.id), second.json().data.map((row) => row.id));

  const bounded = await search(app, "Inception", { limit: "999" });
  assert.equal(bounded.statusCode, 200);
  assert.equal(bounded.json().pagination.limit, 3);
  assert.equal(bounded.json().data.length, 3);
  assert.equal(bounded.json().pagination.has_more, false);
});

test("category-scoped series search returns canonical TV entities from episode files", async (t) => {
  const { app, seriesId } = await createFixture(t);
  const response = await app.inject({ method: "GET", url: "/api/search/series?q=Oasis" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.pagination.total, 1);
  assert.deepEqual(body.data.map((row) => row.id), [seriesId]);
  assert.equal(body.data[0].media_type, "tv");
  assert.equal(body.data[0].category, "series");
});

test("catalog search is parameterized and fails safely for empty results", async (t) => {
  const { app } = await createFixture(t);
  const injection = await search(app, "Inception' OR 1=1--");
  assert.equal(injection.statusCode, 200);
  assert.deepEqual(injection.json().data, []);

  const empty = await search(app, "no such fixture title");
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().data, []);

  const missing = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(missing.statusCode, 400);
});
