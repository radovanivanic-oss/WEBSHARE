"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const weekly = require("../lib/weekly-stale-maintenance");
const schedule = require("../scripts/stale-schedule");
const maintenance = require("../lib/maintenance-cycle");

const NOW = new Date("2026-09-04T12:00:00.000Z");

function row(ident = "x", mediaId = 1) { return { id: 1, ident, media_id: mediaId, is_active: 1, is_playable_video: 1, media_type: "movie", category: "movies" }; }
function record(ident, status, at = NOW.toISOString()) { return { ident, status, observed_at: at }; }
function stateWith(suspects = {}) { return { ...weekly.emptyState(), suspects }; }
function fakeCycle() {
  return ({ cycleId, cycleRoot }) => {
    fs.mkdirSync(cycleRoot, { recursive: true });
    fs.writeFileSync(path.join(cycleRoot, "cycle.json"), JSON.stringify({ cycle_id: cycleId }) + "\n");
    fs.writeFileSync(path.join(cycleRoot, "state.json"), JSON.stringify({ state: maintenance.STATES.CREATED, cycle_id: cycleId }) + "\n");
    fs.writeFileSync(path.join(cycleRoot, "state-history.jsonl"), "");
    return { cycle_id: cycleId, root: cycleRoot };
  };
}
function runDeps(root, current, checked, changed = false) {
  let published = 0;
  const health = { snapshot: { files: changed ? 0 : 1, active_files: changed ? 0 : 1, active_playable_files: changed ? 0 : 1, media: 1, unclassified: 0, fts: 1, orphan_files: 0, categories: {}, file_identity_sha256: "x" }, quick_check: "ok", foreign_key_check: 0, duplicate_idents: 0, duplicate_ownership: 0, unclassified: 0, b39_purged_ident_leakage: 0, production_baseline_sha256: changed ? "after" : "before" };
  return {
    acquireLock: () => ({ release() {} }),
    currentRows: () => ({ rows: current, byIdent: new Map(current.map((item) => [item.ident, item])) }),
    loadBucketRows: () => ({ rows: [], eligible_count: 0, excluded: { b39_hits: 0 } }),
    checkIdents: async ({ idents }) => ({ records: idents.map((ident) => checked[ident] || record(ident, weekly.STATUS.PRESENT)), requestLog: idents.length ? [{ status: 200, attempt: 1 }] : [], meter: { auth_reserved: 1 } }),
    productionHealth: () => health,
    mediaCounts: () => ({ "1": changed ? 0 : 1 }),
    createCycle: fakeCycle(),
    apply: async ({ plan }) => { assert.equal(plan.deactivations.length, changed ? 1 : 0); return { result: { deactivated: changed ? 1 : 0 }, backup: { path: "backup.sqlite", sha256: "backup" } }; },
    publish: async () => { published += 1; return { generation_id: "b54-test" }; },
    skipPendingResume: true,
    get published() { return published; },
    root,
  };
}

test("weekly bucket selection is deterministic and Europe/Bratislava based", () => {
  assert.equal(weekly.selectBucketForDate(new Date("2026-09-04T22:30:00Z")).bucket, weekly.selectBucketForDate(new Date("2026-09-05T00:30:00Z")).bucket);
  assert.equal(weekly.selectBucketForDate(new Date("2026-09-04T12:00:00Z")).time_zone, "Europe/Bratislava");
});

test("due confirmation uses 24 hours and pending suspects do not become due", () => {
  const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString();
  const state = stateWith({ old: { ident: "old", state: "SUSPECT", first_missing_at: old }, fresh: { ident: "fresh", state: "SUSPECT", first_missing_at: fresh } });
  assert.deepEqual(weekly.dueSuspects(state, NOW).map((item) => item.ident), ["old"]);
  assert.deepEqual(weekly.pendingSuspects(state, NOW).map((item) => item.ident), ["fresh"]);
});

test("first sweep missing creates suspect and present clears it", () => {
  const state = stateWith({ present: { ident: "present", state: "SUSPECT", first_missing_at: "2026-09-01T00:00:00Z" } });
  const result = weekly.mergeEvidence(state, [record("new", weekly.STATUS.MISSING), record("present", weekly.STATUS.PRESENT)], new Map([["new", row("new")], ["present", row("present")]]), 35, { run_id: "run-1" });
  assert.deepEqual(result.newSuspects, ["new"]);
  assert.equal(result.state.suspects.new.state, "SUSPECT");
  assert.equal(result.state.suspects.present, undefined);
});

test("unresolved results never create a stale strike", () => {
  const result = weekly.mergeEvidence(stateWith(), [record("new", weekly.STATUS.UNRESOLVED)], new Map([["new", row("new")]]), 35, { run_id: "run-1" });
  assert.equal(Object.keys(result.state.suspects).length, 0);
});

test("due missing confirmation deactivates and publishes, while rerun is idempotent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-stale-change-"));
  try {
    const firstMissing = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(stateWith({ gone: { ...row("gone"), state: "SUSPECT", first_missing_at: firstMissing, first_missing_run_id: "old", evidence_run_ids: ["old"] } })));
    const current = [row("gone")];
    const deps = runDeps(root, current, { gone: record("gone", weekly.STATUS.MISSING) }, true);
    const result = await weekly.runWeeklyStaleMaintenance({ stateRoot: root, runsRoot: path.join(root, "runs"), databasePath: "fixture.sqlite", sidecarPath: "fixture.json", observationRoot: "fixture-observations", publicRepository: "fixture-public", now: NOW, runId: "run-1" }, deps);
    assert.equal(result.deactivated, 1);
    assert.equal(result.publication.generation_id, "b54-test");
    assert.equal(deps.published, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "state.json"))).suspects.gone, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("no-change weekly run does not publish", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-stale-noop-"));
  try {
    const deps = runDeps(root, [row("present")], { present: record("present", weekly.STATUS.PRESENT) });
    const result = await weekly.runWeeklyStaleMaintenance({ stateRoot: root, runsRoot: path.join(root, "runs"), databasePath: "fixture.sqlite", sidecarPath: "fixture.json", now: NOW, runId: "run-2" }, deps);
    assert.equal(result.status, "NO_CHANGES");
    assert.equal(deps.published, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("busy shared lock exits without reading or mutating", async () => {
  const result = await weekly.runWeeklyStaleMaintenance({ stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), "weekly-stale-lock-")), now: NOW, runId: "run-lock" }, { acquireLock: () => { const error = new Error("busy"); error.code = "lock_active"; throw error; }, skipPendingResume: true });
  assert.equal(result.status, "LOCKED");
  assert.equal(result.skipped, true);
});

test("scheduler install is idempotent, removable, and does not contain daily commands", () => {
  const daily = "CRON_TZ=Europe/Bratislava\n47 3 * * * cd /home/radeco/webshare-crawler && /usr/bin/node scripts/run-production-maintenance.js\n";
  const once = schedule.installText(daily), twice = schedule.installText(once);
  assert.equal(twice, once);
  assert.match(once, /0 5 \* \* 0/u);
  assert.match(once, /47 3 \* \* \*/u);
  assert.equal(schedule.removeBlock(once).text, daily);
  assert.equal(schedule.statusFromText(once).scheduler_enabled, true);
});

test("secrets are absent from safe errors", () => { assert.doesNotMatch(JSON.stringify(weekly.safeError(new Error("wst=secret password=hidden"))), /secret|hidden/u); });
