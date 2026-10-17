
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const m = require("../lib/maintenance-cycle");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

test("B54 state machine accepts the guarded happy-path and rejects illegal transitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-state-"));
  try {
    const cycleId = "state-fixture";
    write(path.join(root, "state.json"), { schema_version: 1, cycle_id: cycleId, state: m.STATES.CREATED, next_action: "select" });
    fs.writeFileSync(path.join(root, "state-history.jsonl"), "");
    const ordered = [
      m.STATES.OBSERVATIONS_SELECTED,
      m.STATES.PERSISTENCE_REFRESHED,
      m.STATES.ELIGIBILITY_READY,
      m.STATES.PLAN_READY,
      m.STATES.APPLY_AUTHORIZATION_REQUIRED,
      m.STATES.APPLY_AUTHORIZED,
      m.STATES.APPLY_RUNNING,
      m.STATES.APPLY_VERIFIED,
      m.STATES.PUBLICATION_AUTHORIZATION_REQUIRED,
      m.STATES.PUBLICATION_AUTHORIZED,
      m.STATES.PUBLICATION_RUNNING,
      m.STATES.PUBLICATION_VERIFIED,
      m.STATES.COMPLETE,
    ];
    for (const next of ordered) m.transition(root, next);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "state.json"))).state, m.STATES.COMPLETE);
    assert.throws(() => m.transition(root, m.STATES.CREATED), /ILLEGAL_CYCLE_TRANSITION/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B54 completed publication compacts local snapshots but preserves audit state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-compaction-"));
  try {
    write(path.join(root, "state.json"), { cycle_id: "compaction-fixture", state: m.STATES.COMPLETE, next_action: "none" });
    write(path.join(root, "publication-result.json"), { kind: "B54_PUBLICATION_RESULT", result: { generation_id: "fixture-generation" } });
    for (const name of [".source-observations", "backup", "publication-source", "publication-candidate"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "payload.bin"), "snapshot");
    }
    const result = m.compactCompletedCycle(root);
    assert.equal(result.status, "COMPACTED");
    assert.equal(result.removed.length, 4);
    for (const name of [".source-observations", "backup", "publication-source", "publication-candidate"]) assert.equal(fs.existsSync(path.join(root, name)), false, name);
    assert.equal(fs.existsSync(path.join(root, "state.json")), true);
    assert.equal(fs.existsSync(path.join(root, "publication-result.json")), true);
    assert.equal(fs.existsSync(path.join(root, "compaction.json")), true);
    assert.equal(m.compactCompletedCycle(root).status, "ALREADY_COMPACTED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B54 compaction never removes unresolved publication artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-compaction-failed-"));
  try {
    write(path.join(root, "state.json"), { cycle_id: "failed-fixture", state: m.STATES.PUBLICATION_FAILED, next_action: "rollback-publication" });
    write(path.join(root, "publication-result.json"), { kind: "B54_PUBLICATION_RESULT" });
    fs.mkdirSync(path.join(root, "publication-source"), { recursive: true });
    fs.writeFileSync(path.join(root, "publication-source", "payload.bin"), "keep");
    const result = m.compactCompletedCycle(root);
    assert.equal(result.status, "SKIPPED");
    assert.equal(result.reason, "NOT_COMPLETE");
    assert.equal(fs.existsSync(path.join(root, "publication-source", "payload.bin")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("B54 isolated demonstration produces an auditable frozen lifecycle without real mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-demo-"));
  try {
    const result = m.demonstrate({ demoRoot: path.join(root, "cycle") });
    assert.equal(result.state.state, m.STATES.APPLY_AUTHORIZATION_REQUIRED);
    assert.equal(result.safety.production_mutated, false);
    assert.equal(result.safety.public_pointer_mutated, false);
    for (const name of ["cycle.json", "state.json", "state-history.jsonl", "artifact-index.json"]) {
      assert.equal(fs.existsSync(path.join(result.root, name)), true, name);
    }
    const history = fs.readFileSync(path.join(result.root, "state-history.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(history.map((x) => x.state), [
      m.STATES.CREATED,
      m.STATES.OBSERVATIONS_SELECTED,
      m.STATES.PERSISTENCE_REFRESHED,
      m.STATES.ELIGIBILITY_READY,
      m.STATES.PLAN_READY,
      m.STATES.APPLY_AUTHORIZATION_REQUIRED,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B54 apply authorization is bound to exact cycle and plan and cannot be replayed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-auth-"));
  try {
    const cycleId = "authorization-fixture";
    const planSha = "a".repeat(64);
    const candidateSha = "b".repeat(64);
    write(path.join(root, "cycle.json"), {
      schema_version: 1,
      kind: "B54_MAINTENANCE_CYCLE",
      cycle_id: cycleId,
      semantic_contract_id: "semantic-fixture",
      production_baseline_sha256: "c".repeat(64),
      b39_sidecar_sha256: "d".repeat(64),
      public_baseline: { generation_id: "public-fixture", pointer_sha256: "e".repeat(64), manifest_sha256: "f".repeat(64) },
    });
    write(path.join(root, "state.json"), { schema_version: 1, cycle_id: cycleId, state: m.STATES.APPLY_AUTHORIZATION_REQUIRED, next_action: "authorize-apply" });
    write(path.join(root, "plan.json"), { plan_sha256: planSha, candidate_set_sha256: candidateSha, discovery_delta: [{ ident: "fixture", action: "INSERT" }] });
    write(path.join(root, "candidate-set.json"), { candidate_set_sha256: candidateSha, identifiers: ["fixture"] });
    const phrase = "AUTHORIZE APPLY " + cycleId + " " + planSha;
    assert.throws(() => m.authorizeApply({ cycleId, cycleRoot: root, planSha, confirmation: "AUTHORIZE APPLY " + cycleId + " wrong" }), /TYPED_CONFIRMATION_MISMATCH/);
    const authorized = m.authorizeApply({ cycleId, cycleRoot: root, planSha, candidateSetSha: candidateSha, confirmation: phrase, identity: "test-operator", authorizedAt: "2026-09-01T00:00:00.000Z" });
    assert.equal(authorized.state.state, m.STATES.APPLY_AUTHORIZED);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "apply-authorization.json"))).reusable, false);
    assert.throws(() => m.authorizeApply({ cycleId, cycleRoot: root, planSha, confirmation: phrase }), /APPLY_AUTHORIZATION_NOT_EXPECTED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B54 immutable artifact writer refuses overwrite and artifact index records hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-artifact-"));
  try {
    const cycle = { cycle_id: "artifact-fixture", semantic_contract_id: "semantic", b39_sidecar_sha256: "a".repeat(64), production_baseline_sha256: "b".repeat(64), public_baseline: { generation_id: "public", pointer_sha256: "c".repeat(64), manifest_sha256: "d".repeat(64) } };
    write(path.join(root, "cycle.json"), cycle);
    write(path.join(root, "state.json"), { state: m.STATES.CREATED });
    assert.throws(() => {
      fs.writeFileSync(path.join(root, "cycle.json"), "changed\n", { flag: "wx" });
    }, /EEXIST/);
    const index = m.artifactIndex(root, cycle);
    assert.equal(index.artifacts["cycle.json"].bytes > 0, true);
    assert.equal(index.artifacts["cycle.json"].file_sha256.length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B54 compact immutable ledger output remains valid JSON without pretty-print expansion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-compact-ledger-"));
  try {
    const artifact = path.join(root, "persistence-ledger.json");
    const value = { kind: "B47_PERSISTENCE_LEDGER", records: Array.from({ length: 300 }, (_, index) => ({ ident: `record-${index}`, payload: "x".repeat(2000) })) };
    m.writeNew(artifact, value, { compact: true });
    const text = fs.readFileSync(artifact, "utf8");
    assert.equal(text.includes("\n"), true);
    assert.equal(text.trim().includes("\n"), false);
    assert.deepEqual(JSON.parse(text), value);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("B54 inventory excludes diagnostic artifacts and preserves one independent date", () => {
  const { buildObservationContract, SET_NAMES, sha256, stableJson } = require("../lib/daily-observation");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-inventory-"));
  try {
    const contract = buildObservationContract({ repositoryCommit: "fixture" });
    write(path.join(root, "series.json"), { series_id: "fixture-series", observations: [], failures: [] });
    const make = (name, finished, ident, diagnostic) => {
      const run = path.join(root, name);
      fs.mkdirSync(path.join(run, "sets"), { recursive: true });
      const sets = {};
      for (const setName of SET_NAMES) {
        const text = setName === "raw_unique" && ident ? ident + "\n" : "";
        fs.writeFileSync(path.join(run, "sets", setName + ".txt"), text);
        sets[setName] = { file: "sets/" + setName + ".txt", count: text ? 1 : 0, sha256: sha256(text ? ident : "") };
      }
      const manifest = { schema_version: 1, status: "SUCCESS", observation_started_at: finished, observation_finished_at: finished, local_calendar_date: "2026-09-01", contract, contract_fingerprint: contract.fingerprint, diagnostic: Boolean(diagnostic), sets };
      manifest.manifest_sha256 = sha256(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifest_sha256")));
      write(path.join(run, "manifest.json"), manifest);
    };
    make("20260901T030000Z", "2026-09-01T01:00:00.000Z", "fixture-a", false);
    make("20260901T040000Z-diagnostic-fixture", "2026-09-01T02:00:00.000Z", "fixture-b", false);
    const result = m.inventory({ observationRoot: root, cutoff: "2026-09-01T23:59:59.000Z", expectedContract: contract });
    assert.equal(result.counts.diagnostic_only, 1);
    assert.equal(result.counts.selected_independent_successes, 1);
    assert.equal(result.counts.duplicate_date_exclusions, 0);
    assert.deepEqual(result.selected.map((entry) => entry.artifact_dir), ["20260901T030000Z"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B54 CLI rejects generic confirmation switches", () => {
  const { parse } = require("../scripts/maintenance-cycle");
  assert.throws(() => parse(["prepare", "--cycle-id", "fixture", "--yes"]), /MAINTENANCE_OPTION_INVALID/);
  assert.throws(() => parse(["prepare", "--cycle-id", "fixture", "--force"]), /MAINTENANCE_OPTION_INVALID/);
});

test("B54 no-eligible lifecycle is an explicit safe terminal outcome", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b54-noop-"));
  try {
    const cycleId = "noop-fixture";
    write(path.join(root, "state.json"), { schema_version: 1, cycle_id: cycleId, state: m.STATES.PLAN_READY, next_action: "authorize-apply" });
    fs.writeFileSync(path.join(root, "state-history.jsonl"), "");
    m.transition(root, m.STATES.NO_ELIGIBLE_ITEMS, { next_action: "none", candidate_count: 0 });
    const current = JSON.parse(fs.readFileSync(path.join(root, "state.json")));
    assert.equal(current.state, m.STATES.NO_ELIGIBLE_ITEMS);
    assert.equal(current.candidate_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B55 publication authorization retry preserves failure and binds a fresh artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b55-pub-retry-"));
  try {
    const cycleId = "publication-retry-fixture";
    write(path.join(root, "cycle.json"), { cycle_id: cycleId, public_baseline: { pointer_sha256: "b".repeat(64) } });
    write(path.join(root, "state.json"), { cycle_id: cycleId, state: m.STATES.PUBLICATION_FAILED, failure: { stage: "publication", code: "RELEASE_VIEW_FAILED", rollback: null }, next_action: "rollback-publication" });
    fs.writeFileSync(path.join(root, "state-history.jsonl"), "");
    write(path.join(root, "publication-plan.json"), { source_database_digest: "c".repeat(64), generation_id: "fixture-generation", manifest_sha256: "d".repeat(64) });
    fs.writeFileSync(path.join(root, "publication-authorization.json"), JSON.stringify({ stale: true }) + "\n");
    const plan = JSON.parse(fs.readFileSync(path.join(root, "publication-plan.json")));
    const planSha = m.digest(plan);
    const phrase = "AUTHORIZE PUBLICATION " + cycleId + " " + planSha;
    const authorized = m.authorizePublication({ cycleId, cycleRoot: root, planSha, confirmation: phrase, identity: "test-retry", authorizedAt: "2026-09-01T00:00:00.000Z" });
    assert.equal(authorized.state.state, m.STATES.PUBLICATION_AUTHORIZED);
    assert.equal(authorized.state.publication_authorization_artifact, "publication-authorization-2.json");
    assert.equal(fs.existsSync(path.join(root, "publication-authorization-2.json")), true);
    const history = fs.readFileSync(path.join(root, "state-history.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(history.map((x) => x.state), [m.STATES.PUBLICATION_AUTHORIZATION_REQUIRED, m.STATES.PUBLICATION_AUTHORIZED]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
