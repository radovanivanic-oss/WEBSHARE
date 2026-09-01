"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openCatalogDatabase } = require("../src/db/catalog-db");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const { DEFAULT_POLICY, applyDailyPlan, buildDailyPlan } = require("../lib/daily-maintenance");

test("B48 apply accepts a separately validated pre-write backup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b48-prevalidated-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const databasePath = path.join(root, "catalog.sqlite");
  const inputPath = path.join(root, "items.jsonl");
  const known = { ident: "known-ident", name: "Known Movie 2026 1080p.mkv", title: "Known Movie 2026 1080p.mkv", size: 1000, extension: "mkv", type: "mkv", category: "video", mime: "video/x-matroska", url: "webshare://known-ident" };
  const inserted = { ident: "pilot-ident", name: "Pilot Movie 2026 1080p.mkv", title: "Pilot Movie 2026 1080p.mkv", size: 2000, extension: "mkv", type: "mkv", category: "video", mime: "video/x-matroska", url: "webshare://pilot-ident" };
  fs.writeFileSync(inputPath, JSON.stringify(known) + "\n");
  await importCatalog({ input: inputPath, database: databasePath, batchSize: 10, errorLog: path.join(root, "errors.jsonl") });

  const database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  const plan = buildDailyPlan({ database, items: [inserted], discovery: { complete: true }, now: "2026-09-01T05:00:00.000Z", policy: { ...DEFAULT_POLICY, maxDeletionFraction: 1 } });
  database.close();
  assert.equal(plan.status, "READY_FOR_REVIEW");

  const backupPath = path.join(root, "validated-backup.sqlite");
  const source = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  await source.backup(backupPath);
  source.close();
  assert.equal(fs.existsSync(backupPath), true);

  const applied = await applyDailyPlan({
    databasePath,
    plan,
    backupPath,
    prevalidatedBackup: true,
    policy: { ...DEFAULT_POLICY, maxDeletionFraction: 1 },
  });
  assert.equal(applied.result.inserted, 1);
  assert.equal(applied.result.deactivated, 0);

  const backup = openCatalogDatabase(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(backup.pragma("quick_check", { simple: true }), "ok");
  assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM files WHERE ident = 'pilot-ident'").get().count, 0);
  backup.close();

  const after = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM files WHERE ident = 'pilot-ident'").get().count, 1);
  after.close();
});
