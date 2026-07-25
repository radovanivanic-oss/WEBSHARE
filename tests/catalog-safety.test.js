const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  RUN_STATUSES,
  buildManuallyConfirmedManifest,
  buildUnverifiedCrawlerManifest,
  canRunFullReconciliation,
  loadAndValidateCatalogManifest,
} = require("../lib/catalog-safety");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { openCatalogDatabase } = require("../src/db/catalog-db");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-safety-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJsonl(inputPath, rows) {
  fs.writeFileSync(
    inputPath,
    `${rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n")}\n`
  );
}

function writeSafeManifest(manifestPath, inputPath, items) {
  const stat = fs.statSync(inputPath);
  const manifest = buildManuallyConfirmedManifest({ inputPath, stat, items });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

test("crawler manifest fails closed while prefix strategy is unverified", (t) => {
  const directory = temporaryDirectory(t);
  const inputPath = path.join(directory, "catalog.jsonl");
  writeJsonl(inputPath, [{ ident: "one", name: "One.2024.mkv" }]);
  const manifest = buildUnverifiedCrawlerManifest({
    inputPath,
    stat: fs.statSync(inputPath),
    items: 1,
    failedPrefixes: 0,
  });

  assert.equal(manifest.success, true);
  assert.equal(manifest.run_status, RUN_STATUSES.INCOMPLETE);
  assert.equal(manifest.is_full, false);
  assert.equal(manifest.reconciliation_safe, false);
  assert.equal(manifest.completeness_reason, "prefix_strategy_not_verified");
  assert.match(manifest.source_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    canRunFullReconciliation(manifest, { CATALOG_ALLOW_FULL_RECONCILIATION: "true" }),
    false
  );
});

test("full reconciliation requires manifest, CLI and ENV consent", async (t) => {
  const directory = temporaryDirectory(t);
  const inputPath = path.join(directory, "catalog.jsonl");
  const manifestPath = path.join(directory, "catalog-items.manifest.json");
  const databasePath = path.join(directory, "catalog.sqlite");
  writeJsonl(inputPath, [{ ident: "one", name: "One.2024.mkv" }]);
  writeSafeManifest(manifestPath, inputPath, 1);

  await assert.rejects(
    importCatalog({
      input: inputPath,
      database: databasePath,
      manifest: manifestPath,
      full: true,
      env: { CATALOG_ALLOW_FULL_RECONCILIATION: "true" },
    }),
    /--allow-deactivation/
  );
  await assert.rejects(
    importCatalog({
      input: inputPath,
      database: databasePath,
      manifest: manifestPath,
      full: true,
      allowDeactivation: true,
      env: { CATALOG_ALLOW_FULL_RECONCILIATION: "false" },
    }),
    /CATALOG_ALLOW_FULL_RECONCILIATION=true/
  );
});

test("schema 2 manifest rejects a changed JSONL source", (t) => {
  const directory = temporaryDirectory(t);
  const inputPath = path.join(directory, "catalog.jsonl");
  const manifestPath = path.join(directory, "catalog-items.manifest.json");
  writeJsonl(inputPath, [{ ident: "one", name: "One.2024.mkv" }]);
  writeSafeManifest(manifestPath, inputPath, 1);

  const original = fs.readFileSync(inputPath, "utf8");
  fs.writeFileSync(inputPath, original.replace("One.2024", "Two.2024"));
  assert.throws(
    () => loadAndValidateCatalogManifest(
      manifestPath,
      inputPath,
      fs.statSync(inputPath),
      { requireCurrentSchema: true }
    ),
    /Fingerprint JSONL nesedí/
  );
});

test("invalid full input cannot deactivate old files; valid confirmed input can", async (t) => {
  const directory = temporaryDirectory(t);
  const inputPath = path.join(directory, "catalog.jsonl");
  const manifestPath = path.join(directory, "catalog-items.manifest.json");
  const databasePath = path.join(directory, "catalog.sqlite");
  const errorPath = path.join(directory, "errors.jsonl");
  const oldFile = { ident: "old", name: "Old.Movie.2020.mkv", type: "mkv" };
  const keptFile = { ident: "kept", name: "Kept.Movie.2024.mkv", type: "mkv" };

  writeJsonl(inputPath, [oldFile, keptFile]);
  await importCatalog({ input: inputPath, database: databasePath, errorLog: errorPath });

  writeJsonl(inputPath, [keptFile, "{invalid-json"]);
  writeSafeManifest(manifestPath, inputPath, 2);
  await assert.rejects(
    importCatalog({
      input: inputPath,
      database: databasePath,
      errorLog: errorPath,
      manifest: manifestPath,
      full: true,
      allowDeactivation: true,
      env: { CATALOG_ALLOW_FULL_RECONCILIATION: "true" },
    }),
    /obsahuje 1 neplatných riadkov/
  );

  let database = openCatalogDatabase(databasePath, { fileMustExist: true });
  assert.equal(database.prepare("SELECT is_active FROM files WHERE ident = 'old'").get().is_active, 1);
  database.close();

  writeJsonl(inputPath, [keptFile]);
  writeSafeManifest(manifestPath, inputPath, 1);
  await importCatalog({
    input: inputPath,
    database: databasePath,
    errorLog: errorPath,
    manifest: manifestPath,
    full: true,
    allowDeactivation: true,
    env: { CATALOG_ALLOW_FULL_RECONCILIATION: "true" },
  });

  database = openCatalogDatabase(databasePath, { fileMustExist: true });
  assert.equal(database.prepare("SELECT is_active FROM files WHERE ident = 'old'").get().is_active, 0);
  assert.equal(database.prepare("SELECT is_active FROM files WHERE ident = 'kept'").get().is_active, 1);
  const oldMediaId = database.prepare("SELECT media_id FROM files WHERE ident = 'old'").get().media_id;
  assert.equal(database.prepare("SELECT is_active FROM media WHERE id = ?").get(oldMediaId).is_active, 0);
  database.close();
});
