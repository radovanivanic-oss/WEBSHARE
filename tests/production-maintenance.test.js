"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runAutomaticProductionMaintenance } = require("../lib/production-maintenance");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-production-maintenance-"));
  const health = { snapshot: { files: 100, media: 50 }, production_baseline_sha256: "before" };
  const pointer = { generation_id: "old-generation", manifest_sha256: "old-manifest", url: "https://example.test/current.json" };
  return { root, health, pointer };
}

function baseDependencies(f, events) {
  return {
    observe: async () => { events.push("observe"); return { manifest: { observation_finished_at: "2026-09-04T01:18:00.000Z", local_calendar_date: "2026-09-04", discovery: { unique_idents: 3 }, plan: { counters: { accepted: 2 } }, deep_audit: { rejected: 1 } } }; },
    health: () => f.health,
    pointer: () => f.pointer,
    prepare: async () => { events.push("prepare"); return { state: { state: "NO_ELIGIBLE_ITEMS" }, plan: { discovery_delta: [], counters: { planned: 0 } } }; },
    authorizeApply: async () => { throw new Error("apply should not be authorized"); },
    apply: async () => { throw new Error("apply should not run"); },
    authorizePublication: async () => { throw new Error("publication should not be authorized"); },
    publish: async () => { throw new Error("publication should not run"); },
    supersedeFailedPublication: async () => { throw new Error("publication recovery should not run"); },
    prepareCurrentPublication: async () => { throw new Error("publication recovery should not run"); },
  };
}

test("daily no-change run skips apply and publication", async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await runAutomaticProductionMaintenance({ now: "2026-09-04T01:20:00.000Z", statusRoot: f.root, maintenanceRoot: path.join(f.root, "maintenance"), dependencies: baseDependencies(f, events) });
    assert.equal(result.status, "NO_CHANGES");
    assert.deepEqual(events, ["observe", "prepare"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "latest.json"))).last_error, null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("daily additions drain batches and rerun idempotently", async () => {
  const f = fixture();
  try {
    const events = [];
    let remaining = 2;
    const deps = baseDependencies(f, events);
    deps.prepare = async () => {
      events.push("prepare");
      if (!remaining) return { state: { state: "NO_ELIGIBLE_ITEMS" }, plan: { discovery_delta: [], counters: { planned: 0 } } };
      const count = remaining;
      remaining = 0;
      return { root: f.root, state: { state: "APPLY_AUTHORIZATION_REQUIRED" }, plan: { plan_sha256: `plan-${count}`, candidate_set_sha256: `set-${count}`, discovery_delta: Array.from({ length: count }, (_, i) => ({ ident: `new-${i}` })), counters: { planned: count, movies: 1, series_episodes: count - 1 } }, publication_plan: { generation_id: `generation-${count}` } };
    };
    deps.authorizeApply = async () => { events.push("authorize-apply"); return { authorization: { automatic: true } }; };
    deps.apply = async () => { events.push("apply"); f.health = { snapshot: { files: 102, media: 52 }, production_baseline_sha256: "after" }; return { result: { inserted_files: 2, preflight: { snapshot: { media: 50 } }, postflight: f.health }, publication_plan: { generation_id: "generation-2" } }; };
    deps.authorizePublication = async () => { events.push("authorize-publication"); return { authorization: { automatic: true } }; };
    deps.publish = async () => { events.push("publish"); f.pointer = { ...f.pointer, generation_id: "generation-2" }; return { publicationResult: { result: { generation_id: "generation-2", release_id: "release-2" } } }; };
    const first = await runAutomaticProductionMaintenance({ now: "2026-09-04T01:21:00.000Z", statusRoot: f.root, maintenanceRoot: path.join(f.root, "maintenance"), dependencies: deps });
    assert.equal(first.files_added, 2);
    assert.equal(first.media_added, 2);
    assert.equal(first.current_public.generation_id, "generation-2");
    const second = await runAutomaticProductionMaintenance({ now: "2026-09-05T01:21:00.000Z", statusRoot: f.root, maintenanceRoot: path.join(f.root, "maintenance"), dependencies: { ...baseDependencies(f, events), prepare: async () => ({ state: { state: "NO_ELIGIBLE_ITEMS" }, plan: { discovery_delta: [], counters: { planned: 0 } } }) } });
    assert.equal(second.status, "NO_CHANGES");
    assert.equal(events.filter((event) => event === "publish").length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("classification rejection can leave an empty safe plan", async () => {
  const f = fixture();
  try {
    const events = [];
    const deps = baseDependencies(f, events);
    deps.observe = async () => ({ manifest: { observation_finished_at: "2026-09-04T01:18:00.000Z", local_calendar_date: "2026-09-04", discovery: { unique_idents: 4 }, plan: { counters: { accepted: 0 } }, deep_audit: { rejected: 4 } } });
    const result = await runAutomaticProductionMaintenance({ now: "2026-09-04T01:22:00.000Z", statusRoot: f.root, maintenanceRoot: path.join(f.root, "maintenance"), dependencies: deps });
    assert.equal(result.status, "NO_CHANGES");
    assert.equal(result.files_added, 0);
    assert.deepEqual(events, ["prepare"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("discovery failure reuses the latest successful observation for downstream work", async () => {
  const f = fixture();
  const observationRoot = path.join(f.root, "observations");
  const artifactDir = "2026-09-03T011800Z";
  fs.mkdirSync(path.join(observationRoot, artifactDir), { recursive: true });
  fs.writeFileSync(path.join(observationRoot, "series.json"), JSON.stringify({ observations: [{ observation_finished_at: "2026-09-03T01:19:00.000Z", local_calendar_date: "2026-09-03", artifact_dir: artifactDir }] }));
  fs.writeFileSync(path.join(observationRoot, artifactDir, "manifest.json"), JSON.stringify({ observation_finished_at: "2026-09-03T01:19:00.000Z", local_calendar_date: "2026-09-03", discovery: { unique_idents: 7 }, plan: { counters: { accepted: 6 } }, deep_audit: { rejected: 1 } }));
  try {
    const events = [];
    const deps = baseDependencies(f, events);
    deps.observe = async () => { events.push("observe"); throw Object.assign(new Error("provider denied request"), { code: "ERR_BAD_REQUEST" }); };
    const result = await runAutomaticProductionMaintenance({ now: "2026-09-04T01:20:00.000Z", observationRoot, statusRoot: f.root, maintenanceRoot: path.join(f.root, "maintenance"), dependencies: deps });
    assert.equal(result.status, "NO_CHANGES");
    assert.equal(result.discovery_failure.code, "ERR_BAD_REQUEST");
    assert.deepEqual(events, ["observe", "prepare"]);
    const status = JSON.parse(fs.readFileSync(path.join(f.root, "latest.json")));
    assert.equal(status.last_discovery.reused, true);
    assert.equal(status.last_discovery.local_calendar_date, "2026-09-03");
    assert.equal(status.last_discovery_failure.code, "ERR_BAD_REQUEST");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("publication failure records an error without changing the previous pointer", async () => {
  const f = fixture();
  try {
    const events = [];
    const deps = baseDependencies(f, events);
    deps.prepare = async () => ({ root: f.root, state: { state: "APPLY_AUTHORIZATION_REQUIRED" }, plan: { plan_sha256: "plan", candidate_set_sha256: "set", discovery_delta: [{ ident: "new" }], counters: { planned: 1 } }, publication_plan: { generation_id: "generation-failed" } });
    deps.authorizeApply = async () => ({ authorization: { automatic: true } });
    deps.apply = async () => ({ result: { inserted_files: 1, preflight: { snapshot: { media: 50 } }, postflight: { snapshot: { files: 101, media: 51 }, production_baseline_sha256: "after" } }, publication_plan: { generation_id: "generation-failed" } });
    deps.authorizePublication = async () => ({ authorization: { automatic: true } });
    deps.publish = async () => { throw Object.assign(new Error("REMOTE_POINTER_SWITCH_FAILED"), { code: "REMOTE_POINTER_SWITCH_FAILED" }); };
    await assert.rejects(() => runAutomaticProductionMaintenance({ now: "2026-09-04T01:23:00.000Z", statusRoot: f.root, maintenanceRoot: path.join(f.root, "maintenance"), dependencies: deps }), /REMOTE_POINTER_SWITCH_FAILED/);
    assert.equal(f.pointer.generation_id, "old-generation");
    const status = JSON.parse(fs.readFileSync(path.join(f.root, "latest.json")));
    assert.equal(status.state, "FAILED");
    assert.equal(status.last_error.stage, "publication");
    assert.equal(status.last_successful_apply.files_added, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("publication recovery snapshots the current database after source drift", async () => {
  const f = fixture();
  try {
    const events = [];
    const maintenanceRoot = path.join(f.root, "maintenance");
    const pendingRoot = path.join(maintenanceRoot, "old-cycle");
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.writeFileSync(path.join(pendingRoot, "state.json"), JSON.stringify({ state: "PUBLICATION_FAILED", failure: { rollback: null } }));
    fs.writeFileSync(path.join(pendingRoot, "publication-plan.json"), JSON.stringify({ generation_id: "old-generation" }));
    fs.writeFileSync(path.join(pendingRoot, "apply-result.json"), JSON.stringify({ inserted_files: 2, postflight: { production_baseline_sha256: "before" } }));
    const deps = baseDependencies(f, events);
    deps.supersedeFailedPublication = async () => { events.push("supersede"); };
    deps.prepareCurrentPublication = async () => { events.push("prepare-current"); return { root: path.join(maintenanceRoot, "recovery"), publicationPlan: { generation_id: "fresh-generation" } }; };
    deps.authorizePublication = async () => { events.push("authorize-publication"); };
    deps.publish = async () => { events.push("publish"); return { publicationResult: { result: { generation_id: "fresh-generation" } } }; };
    f.health = { snapshot: { files: 101, media: 51 }, production_baseline_sha256: "after" };
    const result = await runAutomaticProductionMaintenance({ now: "2026-09-08T01:24:00.000Z", statusRoot: f.root, maintenanceRoot, dependencies: { ...deps, prepare: async () => ({ state: { state: "NO_ELIGIBLE_ITEMS" }, plan: { discovery_delta: [], counters: { planned: 0 } } }) } });
    assert.equal(result.last_publication.generation_id, "fresh-generation");
    assert.deepEqual(events, ["observe", "supersede", "prepare-current", "authorize-publication", "publish"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed publication plans are rebuilt from the committed current database", async () => {
  const f = fixture();
  try {
    const events = [];
    const maintenanceRoot = path.join(f.root, "maintenance");
    const pendingRoot = path.join(maintenanceRoot, "failed-cycle");
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.writeFileSync(path.join(pendingRoot, "state.json"), JSON.stringify({ state: "PUBLICATION_FAILED", failure: { rollback: null } }));
    fs.writeFileSync(path.join(pendingRoot, "publication-plan.json"), JSON.stringify({ generation_id: "stale-generation" }));
    fs.writeFileSync(path.join(pendingRoot, "apply-result.json"), JSON.stringify({ inserted_files: 1, postflight: { production_baseline_sha256: "before" } }));
    const deps = baseDependencies(f, events);
    deps.supersedeFailedPublication = async () => { events.push("supersede"); };
    deps.prepareCurrentPublication = async () => { events.push("prepare-current"); return { root: path.join(maintenanceRoot, "recovery"), publicationPlan: { generation_id: "fresh-generation" } }; };
    deps.authorizePublication = async () => { events.push("authorize-publication"); };
    deps.publish = async () => { events.push("publish"); return { publicationResult: { result: { generation_id: "fresh-generation" } } }; };
    const result = await runAutomaticProductionMaintenance({ now: "2026-09-08T01:25:00.000Z", statusRoot: f.root, maintenanceRoot, dependencies: deps });
    assert.equal(result.last_publication.generation_id, "fresh-generation");
    assert.deepEqual(events, ["observe", "supersede", "prepare-current", "authorize-publication", "publish", "prepare"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
