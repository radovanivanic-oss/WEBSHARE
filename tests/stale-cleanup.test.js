"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LockActiveError } = require("../lib/crawler/errors");
const stale = require("../lib/stale-cleanup");
const maintenance = require("../lib/maintenance-cycle");

const ids = Array.from({ length: 167 }, (_, index) => `fixture-${String(index).padStart(3, "0")}`);

function original() {
  return { root: "fixture-evidence", run: {}, results: {}, idents: ids, count: ids.length, sha256: stale.ORIGINAL_SUSPECT_SHA256 };
}

function rows(active = true) {
  return ids.map((ident, index) => ({ id: index + 1, ident, media_id: index < 2 ? 1 : index + 1, is_active: active ? 1 : 0, is_playable_video: 1, media_type: index < 2 ? "movie" : "episode", category: index < 2 ? "movies" : "tvshows" }));
}

function records(statuses = {}) {
  return ids.map((ident) => ({ ident, status: statuses[ident] || stale.STATUS.PRESENT }));
}

function fakeHealth(files = 167) {
  return { snapshot: { files, active_files: files, active_playable_files: files, media: files, unclassified: 0, fts: files, orphan_files: 0, categories: {}, file_identity_sha256: String(files) }, quick_check: "ok", foreign_key_check: 0, duplicate_idents: 0, duplicate_ownership: 0, unclassified: 0, b39_purged_ident_leakage: 0, production_baseline_sha256: String(files) };
}

function fakeCycle() {
  return ({ cycleId, cycleRoot }) => {
    fs.mkdirSync(cycleRoot, { recursive: true });
    fs.writeFileSync(path.join(cycleRoot, "cycle.json"), JSON.stringify({ cycle_id: cycleId }) + "\n");
    fs.writeFileSync(path.join(cycleRoot, "state.json"), JSON.stringify({ state: maintenance.STATES.CREATED, cycle_id: cycleId }) + "\n");
    fs.writeFileSync(path.join(cycleRoot, "state-history.jsonl"), "");
    return { cycle_id: cycleId, root: cycleRoot };
  };
}

function baseDependencies(root, currentRows, resultRecords, changed = false) {
  let published = 0;
  const before = fakeHealth(167);
  const after = fakeHealth(changed ? 166 : 167);
  return {
    loadOriginalSuspects: () => original(),
    beforeHealth: () => before,
    loadCurrentRows: () => currentRows,
    mediaPlayableCounts: () => ({ "1": changed ? 1 : 2 }),
    recheckExact: async () => ({ records: resultRecords, requestLog: [{ status: 200, attempt: 1 }], meter: { auth_reserved: 2 } }),
    acquireLock: () => ({ release() {} }),
    createCycle: fakeCycle(),
    apply: async ({ plan }) => {
      assert.equal(plan.discovery_delta.length, 0);
      assert.equal(plan.deactivations.length, changed ? 1 : 0);
      if (changed) currentRows[0].is_active = 0;
      return { result: { deactivated: changed ? 1 : 0 }, backup: { path: "fixture.sqlite", sha256: "backup" } };
    },
    afterHealth: () => after,
    publish: async () => { published += 1; return { generation_id: "b54-fixture" }; },
    get published() { return published; },
  };
}

test("files_exist present is safe", async () => {
  const result = await stale.recheckExact({ idents: ids, session: { filesExistBatch: async (batch) => ({ status: 200, files: batch.map((ident) => ({ ident, exists: true })) }) }, sleepFn: async () => {} });
  assert.equal(result.records.filter((row) => row.status === stale.STATUS.PRESENT).length, 167);
  assert.equal(result.records.filter((row) => row.status !== stale.STATUS.PRESENT).length, 0);
  assert.equal(result.requestLog.length, 4);
});

test("missing is actionable, while malformed and provider failures are unresolved", async () => {
  const missing = await stale.recheckExact({ idents: ids, session: { filesExistBatch: async (batch) => ({ status: 200, files: batch.map((ident, index) => ({ ident, exists: index !== 0 })) }) }, sleepFn: async () => {} });
  assert.equal(missing.records.filter((row) => row.status === stale.STATUS.MISSING).length, 4);

  const partial = await stale.recheckExact({ idents: ids, session: { filesExistBatch: async (batch) => ({ status: 200, files: batch.slice(0, -1).map((ident) => ({ ident, exists: false })) }) }, sleepFn: async () => {} });
  assert.equal(partial.records.filter((row) => row.status === stale.STATUS.UNRESOLVED).length, 167);

  const failed = await stale.recheckExact({ idents: ids, session: { filesExistBatch: async () => { throw Object.assign(new Error("provider unavailable"), { code: "SERVER_ERROR", retryable: true, status: 503 }); } }, sleepFn: async () => {} });
  assert.equal(failed.records.filter((row) => row.status === stale.STATUS.UNRESOLVED).length, 167);
  assert.equal(failed.records.some((row) => row.status === stale.STATUS.MISSING), false);
});

test("media impact distinguishes a retained variant from a lost final variant", () => {
  assert.deepEqual(stale.computeMediaImpact({ "1": 2 }, { "1": 1 }, [1]), { affected_media: [1], media_retaining_another_playable_source: [1], media_losing_final_playable_source: [] });
  assert.deepEqual(stale.computeMediaImpact({ "2": 1 }, { "2": 0 }, [2]), { affected_media: [2], media_retaining_another_playable_source: [], media_losing_final_playable_source: [2] });
});

test("no-change cleanup does not apply or publish", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stale-noop-"));
  try {
    const deps = baseDependencies(root, rows(), records(), false);
    const result = await stale.runStaleCleanup({ outputRoot: root }, deps);
    assert.equal(result.status, "NO_CHANGES");
    assert.equal(deps.published, 0);
    assert.equal(fs.existsSync(path.join(root, result.run_id, "production-before-cleanup.sqlite")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing sources deactivate without delete and publish only after change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stale-change-"));
  try {
    const current = rows();
    const deps = baseDependencies(root, current, records({ [ids[0]]: stale.STATUS.MISSING }), true);
    const result = await stale.runStaleCleanup({ outputRoot: root }, deps);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.deactivations.length, 1);
    assert.equal(current[0].is_active, 0);
    assert.equal(deps.published, 1);
    assert.equal(result.safety.deletion_performed, false);
    assert.deepEqual(result.media_impact.media_retaining_another_playable_source, [1]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rerun is idempotent after the source is inactive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stale-idempotent-"));
  try {
    const current = rows();
    let publishes = 0;
    const makeDeps = () => ({ ...baseDependencies(root, current, records({ [ids[0]]: stale.STATUS.MISSING }), true), publish: async () => { publishes += 1; return { generation_id: "fixture" }; } });
    const first = await stale.runStaleCleanup({ outputRoot: root }, makeDeps());
    assert.equal(first.deactivations.length, 1);
    const second = await stale.runStaleCleanup({ outputRoot: root }, makeDeps());
    assert.equal(second.status, "NO_CHANGES");
    assert.equal(publishes, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("shared maintenance lock blocks stale cleanup without touching the crawler path", async () => {
  let called = false;
  const result = await stale.runStaleCleanup({ outputRoot: fs.mkdtempSync(path.join(os.tmpdir(), "stale-lock-")) }, {
    acquireLock: () => { called = true; throw new LockActiveError("busy", { code: "lock_active" }); },
    loadOriginalSuspects: () => { throw new Error("must not read while locked"); },
  });
  assert.equal(called, true);
  assert.equal(result.status, "LOCKED");
});

test("stale cleanup remains separate from daily production orchestration", () => {
  const packageJson = require("../package.json");
  assert.equal(packageJson.scripts["maintenance:production"], "node scripts/run-production-maintenance.js");
  assert.equal(fs.readFileSync(path.join(__dirname, "../scripts/run-production-maintenance.js"), "utf8").includes("stale:cleanup"), false);
  assert.equal(fs.readFileSync(path.join(__dirname, "../lib/production-maintenance.js"), "utf8").includes("stale-cleanup"), false);
});
