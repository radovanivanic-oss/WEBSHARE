const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { applyMediaEntityMigration, readCounts, sha256File, validatePlan } = require("../lib/media-entity-migration");
const { parseArgs } = require("../scripts/apply-media-entity-resolution");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-media-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "catalog.jsonl");
  const databasePath = path.join(directory, "catalog.sqlite");
  const rows = [
    { ident: "canonical-file", name: "Inception.2010.1080p.BluRay.mkv", size: 1000 },
    { ident: "source-file", name: "Inception.2010.CAM.XviD-TA.mkv", size: 2000 },
  ];
  fs.writeFileSync(input, `${rows.map((row) => JSON.stringify({ ...row, type: "mkv", category: "video" })).join("\n")}\n`);
  await importCatalog({ input, database: databasePath, batchSize: 2 });
  const database = openCatalogDatabase(databasePath, { fileMustExist: true });
  const canonicalFile = database.prepare("SELECT * FROM files WHERE ident='canonical-file'").get();
  const sourceFile = database.prepare("SELECT * FROM files WHERE ident='source-file'").get();
  const canonicalId = canonicalFile.media_id;
  const sourceId = sourceFile.media_id;
  database.prepare("UPDATE media SET title='Počiatok',original_title='Inception',external_source='tmdb',external_id='27205',metadata_status='matched',metadata_confidence=0.98,year=2010,overview='Canonical',poster_url='https://image.test/poster.jpg',is_active=1 WHERE id=?").run(canonicalId);
  database.prepare("UPDATE media SET year=2010,is_active=1 WHERE id=?").run(sourceId);
  const before = readCounts(database);
  database.close();
  const plan = {
    mode: "READ_ONLY_DRY_RUN",
    global: { movie_entities: before.movie_entities, active_movie_entities: before.active_movie_entities, active_playable_movie_files: before.active_playable_movie_files },
    plan: {
      safe_groups: [{
        status: "SAFE", group_key: "inception|2010", canonical: { id: canonicalId, title: "Počiatok", external_source: "tmdb", external_id: "27205" },
        source_ids: [sourceId], mergeable: [{ source: sourceId, target: canonicalId, status: "STRONG_SAME_MOVIE", reason: "fixture", evidence: ["tmdb:27205:movie"] }], rejected: [],
        files_to_reassign: [sourceFile.id], before: { entities: 2, files: 2 }, after_if_applied: { entities: 1, files: 2 },
      }], partial_groups: [], ambiguous_groups: [], conflicting_groups: [], entities_affected: 1, files_affected: 1,
    },
  };
  const planPath = path.join(directory, "plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { directory, databasePath, planPath, plan, before, canonicalId, sourceId, sourceFileId: sourceFile.id };
}

function options(fixture) {
  return {
    databasePath: fixture.databasePath,
    planPath: fixture.planPath,
    expectedPlanSha256: sha256File(fixture.planPath),
    backupPath: path.join(fixture.directory, "backup.sqlite"),
    expectedCounts: fixture.before,
    expectedGroups: 1,
    maxGroups: 1,
    maxFileReassignments: 1,
  };
}

test("controlled migration reassigns files, rehomes references, deletes only unreferenced sources, and preserves canonical metadata", async (t) => {
  const fixture = await fixtureForTest(t);
  const result = await applyMediaEntityMigration(options(fixture));
  assert.equal(result.committed, true);
  assert.equal(result.transaction_count, 1);
  assert.equal(result.files_reassigned, 1);
  assert.equal(result.source_entities_handled, 1);
  assert.equal(result.entities_deleted, 1);
  const database = openCatalogDatabase(fixture.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(database.prepare("SELECT media_id FROM files WHERE id=?").get(fixture.sourceFileId).media_id, fixture.canonicalId);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM media WHERE id=?").get(fixture.sourceId).count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM candidates WHERE media_id=?").get(fixture.sourceId).count, 0);
    const metadata = database.prepare("SELECT title,original_title,external_id,overview,poster_url FROM media WHERE id=?").get(fixture.canonicalId);
    assert.deepEqual(metadata, { title: "Počiatok", original_title: "Inception", external_id: "27205", overview: "Canonical", poster_url: "https://image.test/poster.jpg" });
    assert.equal(database.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); }
});

test("migration rejects ambiguous plans, digest mismatch, stale baseline, missing entities, unexpected owners, and duplicate assignments", async (t) => {
  for (const name of ["ambiguous", "duplicate-file", "missing-source"]) {
    const local = await fixtureForTest(t);
    if (name === "ambiguous") local.plan.plan.safe_groups[0].mergeable[0].status = "AMBIGUOUS";
    if (name === "duplicate-file") { local.plan.plan.safe_groups[0].files_to_reassign.push(local.sourceFileId); local.plan.plan.files_affected = 2; }
    if (name === "missing-source") { local.plan.plan.safe_groups[0].source_ids[0] = 999999; local.plan.plan.safe_groups[0].mergeable[0].source = 999999; }
    fs.writeFileSync(local.planPath, `${JSON.stringify(local.plan, null, 2)}\n`);
    const expected = name === "missing-source" ? /file-owner-drift|source-entity-drift/ : name === "ambiguous" ? /invalid-merge-item/ : /duplicate-file-reassignment/;
    await assert.rejects(() => applyMediaEntityMigration({ ...options(local), expectedPlanSha256: sha256File(local.planPath) }), expected);
  }
  const digest = await fixtureForTest(t);
  await assert.rejects(() => applyMediaEntityMigration({ ...options(digest), expectedPlanSha256: "0".repeat(64) }), /plan-digest-mismatch/);
  const stale = await fixtureForTest(t);
  const db = openCatalogDatabase(stale.databasePath, { fileMustExist: true }); db.prepare("UPDATE files SET is_active=0 WHERE ident='canonical-file'").run(); db.close();
  await assert.rejects(() => applyMediaEntityMigration(options(stale)), /expected-count-drift|plan-count-drift/);
});

test("transaction exception rolls back every file and entity change and rerun fails on stale baseline", async (t) => {
  const fixture = await fixtureForTest(t);
  await assert.rejects(() => applyMediaEntityMigration({ ...options(fixture), failureAfterFiles: 1 }), /injected-transaction-failure/);
  let database = openCatalogDatabase(fixture.databasePath, { readonly: true, fileMustExist: true });
  assert.equal(database.prepare("SELECT media_id FROM files WHERE id=?").get(fixture.sourceFileId).media_id, fixture.sourceId);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM media WHERE id=?").get(fixture.sourceId).count, 1);
  database.close();
  await applyMediaEntityMigration(options(fixture));
  await assert.rejects(() => applyMediaEntityMigration(options(fixture)), /expected-count-drift|plan-count-drift/);
});

test("source entities with unapproved inactive files are retired rather than deleting the remaining file", async (t) => {
  const local = await fixtureForTest(t);
  const database = openCatalogDatabase(local.databasePath, { fileMustExist: true });
  const source = database.prepare("SELECT * FROM files WHERE id=?").get(local.sourceFileId);
  const columns = Object.keys(source).filter((key) => key !== "id");
  const values = columns.map((key) => key === "ident" ? "source-extra" : key === "is_active" || key === "is_playable_video" ? 0 : source[key]);
  database.prepare(`INSERT INTO files(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
  local.before = readCounts(database);
  local.plan.global.movie_entities = local.before.movie_entities;
  local.plan.global.active_movie_entities = local.before.active_movie_entities;
  local.plan.global.active_playable_movie_files = local.before.active_playable_movie_files;
  database.close();
  fs.writeFileSync(local.planPath, `${JSON.stringify(local.plan, null, 2)}\n`);
  const result = await applyMediaEntityMigration({ ...options(local), expectedPlanSha256: sha256File(local.planPath) });
  assert.equal(result.entities_deleted, 0);
  assert.equal(result.entities_retired, 1);
  const check = openCatalogDatabase(local.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(check.prepare("SELECT is_active FROM media WHERE id=?").get(local.sourceId), { is_active: 0 });
    assert.equal(check.prepare("SELECT media_id FROM files WHERE ident='source-extra'").get().media_id, local.sourceId);
    assert.equal(check.prepare("SELECT media_id FROM files WHERE id=?").get(local.sourceFileId).media_id, local.canonicalId);
  } finally { check.close(); }
});

test("plan validation rejects conflicting media types and prohibited statuses", () => {
  assert.throws(() => validatePlan({ mode: "READ_ONLY_DRY_RUN", global: {}, plan: { safe_groups: [{ status: "SAFE", group_key: "x", canonical: { id: 1 }, source_ids: [2], mergeable: [{ source: 2, target: 1, status: "PROVEN_DIFFERENT_MOVIE" }], rejected: [], files_to_reassign: [] }], partial_groups: [], ambiguous_groups: [], conflicting_groups: [], entities_affected: 1, files_affected: 0 } }), /invalid-merge-item/);
});

test("plan validation accepts an explicitly reviewed safe subset while preserving ambiguous exclusions", () => {
  const plan = {
    mode: "READ_ONLY_DRY_RUN", global: {},
    plan: {
      safe_groups: [], partial_groups: [], ambiguous_groups: [], conflicting_groups: [],
      approved_additional_groups: [{
        status: "SAFE_APPROVED_SUBSET", approval: "B33_REVIEWED_SAFE_SUBSET", group_key: "inception|2010",
        canonical: { id: 1 }, source_ids: [2],
        mergeable: [{ source: 2, target: 1, status: "STRONG_SAME_MOVIE" }],
        rejected: [{ source: 3, target: 1, status: "AMBIGUOUS" }], files_to_reassign: [10],
      }],
      entities_affected: 1, files_affected: 1,
    },
  };
  assert.deepEqual(validatePlan(plan), { sourceIds: [2], fileIds: [10], groupCount: 1 });
});

test("CLI baseline loader ignores non-count preflight metadata", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-media-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plan = path.join(directory, "plan.json");
  const counts = path.join(directory, "counts.json");
  fs.writeFileSync(plan, "{}");
  fs.writeFileSync(counts, JSON.stringify({ repository_commit: "commit", quick_check: "ok", files: 1 }));
  const parsed = parseArgs(["--database", "db", "--plan", plan, "--expected-plan-sha256", "hash", "--backup", "backup", "--output-dir", directory, "--expected-groups", "1", "--max-groups", "1", "--max-file-reassignments", "1", "--expected-counts-json", counts]);
  assert.deepEqual(parsed.expectedCounts, { files: 1 });
});

async function fixtureForTest(t) {
  return fixture(t);
}
