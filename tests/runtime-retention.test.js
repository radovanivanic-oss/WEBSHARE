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
