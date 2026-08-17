const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { createCatalogApi } = require("../server/catalog-api");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { compareMedia, planGroup } = require("../lib/media-entity-resolver");

const canonical = {
  id: 100,
  media_type: "movie",
  title: "Počiatok",
  original_title: "Inception",
  aliases: ["Pocatek"],
  year: 2010,
  external_source: "tmdb",
  external_id: "27205",
  metadata_status: "matched",
  metadata_confidence: 0.98,
};

test("Inception variants plan to one metadata-backed canonical entity and preserve files", () => {
  const rows = [
    canonical,
    { id: 101, media_type: "movie", title: "Inception CAM TA", year: 2010, metadata_status: "local" },
    { id: 102, media_type: "movie", title: "Inception 10bit AAC5 1", year: 2010, metadata_status: "local" },
    { id: 103, media_type: "movie", title: "Pocatek Inception", year: 2010, metadata_status: "local" },
    { id: 104, media_type: "movie", title: "Inception The Cobol Job vipers", year: 2010, metadata_status: "local" },
  ];
  const files = new Map(rows.map((row) => [row.id, [{ id: row.id * 10, ident: `file-${row.id}` }]]));
  const plan = planGroup(rows, files);
  assert.equal(plan.canonical.id, 100);
  assert.deepEqual(plan.mergeable.map((item) => item.source), [101, 102, 103]);
  assert.equal(plan.rejected[0].status, "AMBIGUOUS");
  assert.deepEqual(plan.files_to_reassign, [1010, 1020, 1030]);
});

test("resolver fails closed for years, IDs, and media types that conflict", () => {
  assert.equal(compareMedia({ media_type: "movie", year: 2010, external_source: "tmdb", external_id: "1" }, { media_type: "movie", year: 2010, external_source: "tmdb", external_id: "2" }).status, "PROVEN_DIFFERENT_MOVIE");
  assert.equal(compareMedia({ media_type: "movie", year: 2010, external_source: "tmdb", external_id: "1" }, { media_type: "tv", year: 2010, external_source: "tmdb", external_id: "1" }).status, "PROVEN_DIFFERENT_MOVIE");
  assert.equal(compareMedia({ media_type: "movie", year: 2010, title: "King Kong" }, { media_type: "movie", year: 2005, title: "King Kong" }).status, "AMBIGUOUS");
  assert.equal(compareMedia({ media_type: "movie", year: null, title: "The Thing" }, { media_type: "movie", year: null, title: "The Thing" }).status, "AMBIGUOUS");
  assert.equal(compareMedia({ media_type: "movie", year: 2010, title: "Example", metadata_status: "local" }, { media_type: "movie", year: 2010, title: "Example", metadata_status: "local" }).status, "AMBIGUOUS");
});

test("fixture reassignment exposes one canonical movie and all file variants through the API", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-entity-resolution-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  const names = [
    "Počiatok.2010.1080p.BluRay.CZ.mkv",
    "Inception.2010.720p.BluRay.x264-GeneMige.mkv",
    "Inception.2010.CAM.XviD-TA.avi",
    "Inception.2010.2160p.4K.BluRay.x265.10bit.AAC5.1-[YTS.MX].mkv",
    "Pocatek - Inception (2010) - FullHD 1080p (H264) - CZ dabing.mkv",
  ];
  fs.writeFileSync(input, `${names.map((name, index) => JSON.stringify({ ident: `inception-${index}`, name, type: path.extname(name).slice(1), size: 1000 + index })).join("\n")}\n`);
  await importCatalog({ input, database: databasePath, batchSize: 10 });
  const database = openCatalogDatabase(databasePath, { fileMustExist: true });
  const mediaIds = database.prepare("SELECT DISTINCT media_id FROM files WHERE is_playable_video=1").all().map((row) => row.media_id);
  const canonicalId = database.prepare("SELECT id FROM media WHERE title LIKE 'Počiatok%' LIMIT 1").get().id;
  database.prepare("UPDATE media SET external_source='tmdb',external_id='27205',original_title='Inception',metadata_status='matched',metadata_confidence=0.98,overview='Canonical overview',poster_url='https://image.test/poster.jpg',is_active=1 WHERE id=?").run(canonicalId);
  database.prepare("UPDATE media_aliases SET media_id=? WHERE media_id IN (SELECT id FROM media WHERE id<>?)").run(canonicalId, canonicalId);
  for (const id of mediaIds) database.prepare("UPDATE files SET media_id=? WHERE media_id=?").run(canonicalId, id);
  database.prepare("UPDATE media SET is_active=CASE WHEN id=? THEN 1 ELSE 0 END WHERE id IN (SELECT id FROM media WHERE media_type='movie')").run(canonicalId);
  database.prepare("DELETE FROM media_fts").run();
  database.prepare("INSERT INTO media_fts(media_id,title,original_title,aliases) SELECT CAST(id AS TEXT),title,COALESCE(original_title,''),' ' FROM media").run();
  const app = createCatalogApi({ config: { ...getCatalogConfig({ CATALOG_DB_PATH: databasePath }), apiBasePath: "/api", apiMaxPageSize: 50 }, database, skipMigrations: true, logger: false });
  try {
    const listing = await app.inject({ method: "GET", url: "/api/media?category=movies&sort=title&order=asc" });
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.json().data.length, 1);
    assert.equal(listing.json().data[0].id, canonicalId);
    assert.equal(listing.json().data[0].versions, names.length);
    const detail = await app.inject({ method: "GET", url: `/api/media/${canonicalId}` });
    assert.equal(detail.json().data.title, "Počiatok");
    assert.equal(detail.json().data.overview, "Canonical overview");
    const variants = await app.inject({ method: "GET", url: `/api/media/${canonicalId}/files` });
    assert.equal(variants.json().pagination.total, names.length);
    assert.deepEqual(variants.json().data.map((row) => row.ident).sort(), names.map((_, index) => `inception-${index}`).sort());
    for (const query of ["Inception", "Inception 2010", "Počiatok"]) {
      const search = await app.inject({ method: "GET", url: `/api/search/movies?q=${encodeURIComponent(query)}` });
      assert.equal(search.json().data.length, 1, query);
    }
  } finally {
    await app.close();
    database.close();
  }
});
