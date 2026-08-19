"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase } = require("../src/db/migrate");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { importCatalog } = require("../scripts/import-catalog-jsonl");
const {
  DEFAULT_POLICY,
  applyDailyPlan,
  buildDailyPlan,
  discoverRecent,
  applyVerificationResults,
  snapshotDatabase,
  stableJson,
} = require("../lib/daily-maintenance");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-daily-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "catalog.sqlite");
  const input = path.join(root, "items.jsonl");
  const item = { ident: "known-ident", name: "Known Movie 2026 1080p WEB-DL H264.mkv", title: "Known Movie 2026 1080p WEB-DL H264.mkv", size: 1000, type: "mkv", extension: "mkv", category: "video", url: "webshare://known-ident", mime: "video/x-matroska" };
  fs.writeFileSync(input, `${JSON.stringify(item)}\n`);
  await importCatalog({ input, database: databasePath, batchSize: 10, errorLog: path.join(root, "errors.jsonl") });
  return { root, databasePath, item };
}

function database(pathname, readonly = true) {
  const db = openCatalogDatabase(pathname, { readonly, fileMustExist: readonly });
  if (!readonly) migrateDatabase(db, getCatalogConfig().migrationsDir, { logger: false });
  return db;
}

test("daily discovery deduplicates overlap and requires the prior frontier", async () => {
  const pages = new Map([
    ["a:0", { files: [{ ident: "new", name: "New Movie 2026 1080p.mkv", size: 1, type: "mkv" }, { ident: "boundary", name: "Old Movie 2025 1080p.mkv", size: 1, type: "mkv" }] }],
    ["a:100", { files: [{ ident: "boundary", name: "Old Movie 2025 1080p.mkv", size: 1, type: "mkv" }] }],
  ]);
  const result = await discoverRecent({
    prefixes: ["a"],
    state: { schema_version: 1, frontiers: { a: { idents: ["boundary"] } }, verifications: {} },
    policy: { ...DEFAULT_POLICY, pageSize: 100, maxPagesPerPrefix: 3, overlapPages: 1, maxRequests: 5 },
    fetchPage: async ({ prefix, offset }) => pages.get(`${prefix}:${offset}`) || { files: [] },
    normalize: (item) => ({ ...item, ident: item.ident, name: item.name, title: item.name }),
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => item.ident), ["boundary", "new"]);
  assert.equal(result.requests, 1);
});

test("daily plan quarantines unclassifiable discoveries and does not advance on ambiguous discovery", async (t) => {
  const f = await fixture(t);
  const db = database(f.databasePath);
  const plan = buildDailyPlan({
    database: db,
    items: [f.item, { ident: "mystery", name: "mystery.bin", size: 1, type: "bin" }],
    discovery: { complete: false, page_reports: [] },
    now: "2026-08-19T00:00:00.000Z",
    policy: { ...DEFAULT_POLICY, maxDeletionFraction: 1 },
  });
  assert.equal(plan.status, "BLOCKED");
  assert.ok(plan.blocked_reasons.includes("DISCOVERY_FRONTIER_NOT_CONFIRMED"));
  assert.equal(plan.counters.already_known, 1);
  assert.equal(plan.counters.ignored_unclassified, 1);
  assert.equal(plan.safety.sqlite_write_performed, false);
  db.close();
});

test("two definitive missing observations are required before deactivation", async (t) => {
  const f = await fixture(t);
  const db = database(f.databasePath);
  const row = db.prepare("SELECT id, ident, media_id FROM files WHERE ident = ?").get(f.item.ident);
  const state = { schema_version: 1, frontiers: { a: { idents: ["boundary"] } }, verifications: { [row.ident]: { state: "SUSPECT", missing_streak: 1 } } };
  const plan = buildDailyPlan({
    database: db,
    items: [],
    state,
    staleCandidates: [row],
    verificationOutcomes: [{ ident: row.ident, result: "definitive_missing" }],
    discovery: { complete: true },
    now: "2026-08-19T00:00:00.000Z",
    policy: { ...DEFAULT_POLICY, maxDeletionFraction: 1 },
  });
  assert.equal(plan.status, "READY_FOR_REVIEW");
  assert.equal(plan.counters.confirmed_missing, 1);
  const next = applyVerificationResults(state, [{ ident: row.ident, result: "error" }], "2026-08-19T00:00:00.000Z");
  assert.equal(next.verifications[row.ident].missing_streak, 1);
  assert.equal(next.verifications[row.ident].state, "RETRY_LATER");
  db.close();
});

test("plan digest is deterministic for the same database snapshot and inputs", async (t) => {
  const f = await fixture(t);
  const db = database(f.databasePath);
  const input = { database: db, items: [], state: { schema_version: 1, frontiers: {}, verifications: {} }, discovery: { complete: true }, now: "2026-08-19T00:00:00.000Z" };
  const first = buildDailyPlan(input);
  const second = buildDailyPlan(input);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.equal(stableJson(first.baseline), stableJson(second.baseline));
  db.close();
});

test("provider outage never becomes a deletion plan", async (t) => {
  const f = await fixture(t);
  const db = database(f.databasePath);
  const row = db.prepare("SELECT id, ident, media_id FROM files WHERE ident = ?").get(f.item.ident);
  const plan = buildDailyPlan({ database: db, items: [], staleCandidates: [row], verificationOutcomes: [{ ident: row.ident, result: "error" }], discovery: { complete: true }, now: "2026-08-19T00:00:00.000Z" });
  assert.equal(plan.status, "BLOCKED");
  assert.ok(plan.blocked_reasons.includes("STALE_VERIFICATION_ERRORS"));
  assert.equal(plan.deactivations.length, 0);
  db.close();
});

test("approved fixture delta applies atomically and preserves a validated backup", async (t) => {
  const f = await fixture(t);
  const db = database(f.databasePath);
  const newItem = { ident: "new-ident", name: "New Movie 2026 1080p WEB-DL H264.mkv", title: "New Movie 2026 1080p WEB-DL H264.mkv", size: 2000, type: "mkv", extension: "mkv", category: "video", url: "webshare://new-ident", mime: "video/x-matroska" };
  const plan = buildDailyPlan({ database: db, items: [newItem], discovery: { complete: true }, now: "2026-08-19T00:00:00.000Z", policy: { ...DEFAULT_POLICY, maxDeletionFraction: 1 } });
  assert.equal(plan.status, "READY_FOR_REVIEW");
  db.close();
  const backup = path.join(f.root, "backup.sqlite");
  const applied = await applyDailyPlan({ databasePath: f.databasePath, plan, backupPath: backup, policy: { ...DEFAULT_POLICY, maxDeletionFraction: 1 } });
  assert.equal(applied.result.inserted, 1);
  assert.equal(applied.result.deactivated, 0);
  assert.equal(fs.existsSync(backup), true);
  const check = database(backup);
  assert.equal(check.pragma("quick_check", { simple: true }), "ok");
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM files WHERE ident = 'new-ident'").get().count, 0);
  check.close();
  const after = database(f.databasePath);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM files WHERE ident = 'new-ident'").get().count, 1);
  after.close();
});
