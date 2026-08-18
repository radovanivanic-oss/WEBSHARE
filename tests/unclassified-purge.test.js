const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { applyUnclassifiedPurge, readPurgeData, readCounts, sha256File, validatePurgeData } = require("../lib/unclassified-purge");
const { compactCatalog } = require("../lib/catalog-compaction");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-unclassified-purge-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  const rows = [
    { ident: "unknown-a", name: "Unknown A 2020 1080p.mkv", size: 100 },
    { ident: "unknown-b", name: "Unknown B 2021 720p.mkv", size: 200 },
    { ident: "classified", name: "Known Movie 2020 1080p.mkv", size: 300 },
  ];
  fs.writeFileSync(input, `${rows.map((row) => JSON.stringify({ ...row, type: "mkv", category: "video" })).join("\n")}\n`);
  await importCatalog({ input, database: databasePath, batchSize: 2 });
  const db = openCatalogDatabase(databasePath, { fileMustExist: true });
  const unknownA = db.prepare("SELECT * FROM files WHERE ident='unknown-a'").get();
  const unknownB = db.prepare("SELECT * FROM files WHERE ident='unknown-b'").get();
  const classified = db.prepare("SELECT * FROM files WHERE ident='classified'").get();
  db.prepare("UPDATE media SET category='unknown', is_active=1 WHERE id IN (?,?)").run(unknownA.media_id, unknownB.media_id);
  db.prepare("UPDATE media SET category='movies', media_type='movie', is_active=1, title='Known Movie', year=2020 WHERE id=?").run(classified.media_id);
  db.prepare("INSERT INTO media_aliases(media_id,alias,normalized_alias,language,source,created_at) VALUES (?,?,?,?,?,?)").run(unknownA.media_id, "Unknown A alias", "unknown a alias", "en", "fixture", new Date().toISOString());
  db.prepare("INSERT INTO classification_audit(file_id,media_id,old_category,new_category,reason,confidence,classifier_version,created_at) VALUES (?,?,?,?,?,?,?,?)").run(unknownA.id, unknownA.media_id, "unknown", "movies", "fixture", 0.9, "fixture", new Date().toISOString());
  const orphan = db.prepare("SELECT * FROM files WHERE media_id=?").get(classified.media_id);
  db.prepare("UPDATE files SET media_id=NULL WHERE id=?").run(orphan.id);
  const classifiedAnchor = db.prepare("SELECT id FROM media WHERE id=?").get(classified.media_id).id;
  db.close();
  const readOnly = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  const plan = readPurgeData(readOnly);
  const completePlan = { schema_version: plan.schema_version, repository_commit: "fixture", ...plan, sqlite_write_performed: false };
  readOnly.close();
  const planPath = path.join(directory, "purge-plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(completePlan, null, 2)}\n`);
  return { directory, databasePath, planPath, plan: completePlan, classifiedAnchor, orphanId: orphan.id, unknownFileIds: [unknownA.id, unknownB.id] };
}

function applyOptions(fixture) {
  return {
    databasePath: fixture.databasePath,
    planPath: fixture.planPath,
    expectedPlanSha256: sha256File(fixture.planPath),
    backupPath: path.join(fixture.directory, "backup.sqlite"),
    outputDir: fixture.directory,
  };
}

test("planner and controlled purge delete only unknown scope and preserve classified content/orphans", async (t) => {
  const local = await fixture(t);
  const beforeDb = openCatalogDatabase(local.databasePath, { readonly: true, fileMustExist: true });
  const before = readCounts(beforeDb);
  const data = readPurgeData(beforeDb);
  beforeDb.close();
  assert.equal(data.baseline.cross_boundary.classified_children_of_unclassified, 0);
  assert.equal(data.baseline.cross_boundary.unclassified_children_of_classified, 0);
  assert.equal(data.baseline.counts.unclassified_media, 2);
  assert.equal(data.baseline.sets.files.count, 2);
  assert.ok(data.dependent.aliases >= 1);
  const result = await applyUnclassifiedPurge(applyOptions(local));
  assert.equal(result.committed, true);
  assert.equal(result.transaction_count, 1);
  assert.equal(result.deleted.media, 2);
  assert.equal(result.deleted.files, 2);
  const db = openCatalogDatabase(local.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media WHERE category='unknown'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM files WHERE id IN (?,?)").get(...local.unknownFileIds).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media WHERE id=?").get(local.classifiedAnchor).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM files WHERE id=?").get(local.orphanId).count, 1);
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(readCounts(db).files, before.files - 2);
  } finally { db.close(); }
});

test("purge fails closed on stale plan, digest mismatch, and injected transaction failure with full rollback", async (t) => {
  const stale = await fixture(t);
  const staleDb = openCatalogDatabase(stale.databasePath, { fileMustExist: true });
  staleDb.prepare("UPDATE media SET category='movies' WHERE id=(SELECT media_id FROM files WHERE ident='unknown-a')").run();
  staleDb.close();
  await assert.rejects(() => applyUnclassifiedPurge(applyOptions(stale)), /purge-plan-drift|purge-baseline-drift/);

  const digest = await fixture(t);
  await assert.rejects(() => applyUnclassifiedPurge({ ...applyOptions(digest), expectedPlanSha256: "0".repeat(64) }), /plan-digest-mismatch/);

  const rollback = await fixture(t);
  await assert.rejects(() => applyUnclassifiedPurge({ ...applyOptions(rollback), failureAfter: "files" }), /injected-transaction-failure/);
  const check = openCatalogDatabase(rollback.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(readCounts(check).unclassified_media, 2);
    assert.equal(readCounts(check).unclassified_files, 2);
    assert.equal(check.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { check.close(); }
});

test("purge policy rejects cross-boundary classified children and invalid schema", async (t) => {
  const local = await fixture(t);
  const db = openCatalogDatabase(local.databasePath, { fileMustExist: true });
  const unknownId = db.prepare("SELECT id FROM media WHERE category='unknown' LIMIT 1").get().id;
  const classifiedId = local.classifiedAnchor;
  db.prepare("UPDATE media SET tvshow_id=? WHERE id=?").run(unknownId, classifiedId);
  const data = readPurgeData(db);
  db.close();
  assert.equal(data.baseline.cross_boundary.classified_children_of_unclassified, 1);
  assert.throws(() => validatePurgeData({ ...data, schema_version: 9 }), /cross-boundary-dependency/);
  assert.throws(() => validatePurgeData({ ...data, schema_version: 8 }), /unsupported-schema-version/);
});

test("second execution is not idempotently destructive and fails on the changed baseline", async (t) => {
  const local = await fixture(t);
  await applyUnclassifiedPurge(applyOptions(local));
  await assert.rejects(() => applyUnclassifiedPurge(applyOptions(local)), /purge-plan-drift|purge-baseline-drift/);
});

test("compaction produces a validated compact copy without replacing the source by default", async (t) => {
  const local = await fixture(t);
  await applyUnclassifiedPurge(applyOptions(local));
  const result = await compactCatalog({
    databasePath: local.databasePath,
    outputDir: path.join(local.directory, "compact-evidence"),
    expected: { schema_version: 9, counts: local.plan.after_counts },
  });
  assert.equal(result.replacement, null);
  assert.equal(result.after.files, local.plan.after_counts.files);
  assert.ok(result.physical_after.size <= result.physical_before.size);
  assert.equal(fs.existsSync(local.databasePath), true);
  assert.equal(fs.existsSync(result.compact_path), true);
});
