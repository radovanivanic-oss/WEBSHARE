"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyRetention, diskSpacePreflight, retentionPlan } = require("../lib/runtime-retention");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webshare-retention-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test("retention keeps recent and referenced cycles, and never removes failed runs", () => {
  const root = tempRoot();
  const maintenanceRoot = path.join(root, "maintenance");
  const staleRoot = path.join(root, "stale");
  const publicRepository = path.join(root, "public");
  for (let index = 0; index < 5; index += 1) {
    const name = `cycle-${index}`;
    writeJson(path.join(maintenanceRoot, name, "state.json"), { state: "COMPLETE", updated_at: `2026-09-0${index + 1}T00:00:00Z` });
  }
  writeJson(path.join(maintenanceRoot, "failed", "state.json"), { state: "PUBLICATION_FAILED" });
  writeJson(path.join(maintenanceRoot, "cycle-0", "publication-plan.json"), { generation_id: "current-generation" });
  writeJson(path.join(publicRepository, "catalog/v1/current.json"), { generation_id: "current-generation" });
  writeJson(path.join(staleRoot, "stale-old", "result.json"), { status: "COMPLETED", finished_at: "2026-08-01T00:00:00Z" });

  const plan = retentionPlan({ maintenanceRoot, staleRoot, publicRepository, keepComplete: 2, keepStaleComplete: 1 });
  assert.equal(plan.skipped_referenced.length, 1);
  const result = applyRetention(plan);
  assert.equal(result.deleted.length, 2);
  assert.equal(fs.existsSync(path.join(maintenanceRoot, "failed")), true);
  assert.equal(fs.existsSync(path.join(maintenanceRoot, "cycle-0")), true);
});

test("disk preflight blocks a large snapshot below the reserve", () => {
  const root = tempRoot();
  const databasePath = path.join(root, "catalog.sqlite");
  fs.writeFileSync(databasePath, "");
  fs.truncateSync(databasePath, 2 * 1024 ** 3);
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 10, bsize: 1024 ** 3 });
  try {
    const result = diskSpacePreflight({ databasePath, runtimePath: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, "DISK_GUARD_BLOCKED");
  } finally {
    fs.statfsSync = original;
  }
});

test("retention enumerates stale runs below the production runs directory", () => {
  const root = tempRoot();
  const staleRoot = path.join(root, "stale");
  const publicRepository = path.join(root, "public");
  writeJson(path.join(staleRoot, "runs", "new", "result.json"), { status: "COMPLETED", finished_at: "2026-09-02T00:00:00Z" });
  writeJson(path.join(staleRoot, "runs", "old", "result.json"), { status: "COMPLETED", finished_at: "2026-09-01T00:00:00Z" });
  writeJson(path.join(publicRepository, "catalog/v1/current.json"), { generation_id: "current-generation" });
  const plan = retentionPlan({ maintenanceRoot: path.join(root, "maintenance"), staleRoot, publicRepository, keepComplete: 0, keepStaleComplete: 1 });
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].name, "old");
  assert.equal(plan.delete[0].directory, path.join(staleRoot, "runs", "old"));
});

test("retention deletes only explicitly superseded maintenance cycles", () => {
  const root = tempRoot();
  const maintenanceRoot = path.join(root, "maintenance");
  const publicRepository = path.join(root, "public");
  writeJson(path.join(maintenanceRoot, "superseded-recovery", "state.json"), { state: "PUBLICATION_ROLLED_BACK", updated_at: "2026-09-01T00:00:00Z", failure: { superseded: true, reason: "CURRENT_PRODUCTION_SOURCE_ADVANCED" } });
  writeJson(path.join(maintenanceRoot, "unresolved", "state.json"), { state: "PUBLICATION_RECOVERY_READY", updated_at: "2026-09-02T00:00:00Z" });
  writeJson(path.join(publicRepository, "catalog/v1/current.json"), { generation_id: "current-generation" });
  const plan = retentionPlan({ maintenanceRoot, staleRoot: path.join(root, "stale"), publicRepository });
  assert.deepEqual(plan.delete.map((row) => row.name), ["superseded-recovery"]);
});


test("retention bounds terminal no-op cycles and nested stale completions", () => {
  const root = tempRoot();
  const maintenanceRoot = path.join(root, "maintenance");
  const staleRoot = path.join(root, "stale");
  const publicRepository = path.join(root, "public");
  writeJson(path.join(publicRepository, "catalog/v1/current.json"), { generation_id: "current-generation" });
  for (let index = 0; index < 3; index += 1) {
    writeJson(path.join(maintenanceRoot, "no-op-" + index, "state.json"), { state: "NO_ELIGIBLE_ITEMS", updated_at: "2026-09-0" + (index + 1) + "T00:00:00Z" });
  }
  writeJson(path.join(staleRoot, "runs", "new", "result.json"), { status: "COMPLETED", finished_at: "2026-09-03T00:00:00Z" });
  writeJson(path.join(staleRoot, "runs", "old", "publication-cycle", "state.json"), { state: "COMPLETE", created_at: "2026-09-01T00:00:00Z" });

  const plan = retentionPlan({ maintenanceRoot, staleRoot, publicRepository, keepComplete: 1, keepStaleComplete: 1 });
  assert.deepEqual(plan.delete.map((row) => row.name).sort(), ["no-op-0", "no-op-1", "old"]);
});

test("retention refuses to prune when the published pointer is unavailable", () => {
  const root = tempRoot();
  writeJson(path.join(root, "maintenance", "old", "state.json"), { state: "NO_ELIGIBLE_ITEMS", updated_at: "2026-09-01T00:00:00Z" });
  const plan = retentionPlan({ maintenanceRoot: path.join(root, "maintenance"), staleRoot: path.join(root, "stale"), publicRepository: path.join(root, "public") });
  assert.equal(plan.pointer_unavailable, true);
  assert.equal(plan.delete.length, 0);
});
