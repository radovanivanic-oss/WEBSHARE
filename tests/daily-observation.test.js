"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseArguments } = require("../scripts/run-daily-discovery-observation");
const { analyzeSeries } = require("../lib/daily-observation-analyzer");
const {
  buildObservationContract,
  canonicalSetText,
  comparison,
  digestIdents,
  normalizeIdents,
  readManifest,
  sha256,
} = require("../lib/daily-observation");

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function fixtureSeries() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b467-observation-"));
  const contract = buildObservationContract({ repositoryCommit: "fixture-commit" });
  const days = [
    { date: "2026-08-23", accepted: ["a", "b"], deep_approved: ["a"], quarantine: ["q", "q3"], raw_unique: ["a", "b", "q", "q3"] },
    { date: "2026-08-24", accepted: ["a", "b", "c"], deep_approved: ["a", "b"], quarantine: ["q", "q2"], raw_unique: ["a", "b", "c", "q", "q2"] },
    { date: "2026-08-25", accepted: ["a", "c"], deep_approved: ["a", "c"], quarantine: ["q2", "q3"], raw_unique: ["a", "c", "q2", "q3"] },
  ];
  const observations = [];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const runName = `${day.date.replaceAll("-", "")}T031700Z`;
    const runDir = path.join(root, runName);
    fs.mkdirSync(path.join(runDir, "sets"), { recursive: true });
    const sets = {
      raw_unique: day.raw_unique,
      post_b39: day.raw_unique,
      current_known: [],
      current_unknown: [...new Set([...day.accepted, ...day.quarantine])],
      accepted: day.accepted,
      quarantine: day.quarantine,
      deep_approved: day.deep_approved,
      deep_rejected: day.accepted.filter((ident) => !day.deep_approved.includes(ident)),
    };
    const metadata = {};
    for (const [name, values] of Object.entries(sets)) {
      const canonical = canonicalSetText(values);
      write(path.join(runDir, "sets", `${name}.txt`), canonical ? `${canonical}\n` : "");
      metadata[name] = { file: `sets/${name}.txt`, count: new Set(values).size, sha256: sha256(canonical) };
    }
    const finished = `${day.date}T03:17:30.000Z`;
    const base = {
      schema_version: 1,
      kind: "B46.7_DAILY_OBSERVATION",
      status: "SUCCESS",
      series_id: "fixture-series",
      observation_started_at: `${day.date}T03:17:00.000Z`,
      observation_finished_at: finished,
      local_calendar_date: day.date,
      runtime_ms: 1000 + index,
      contract,
      contract_fingerprint: contract.fingerprint,
      provider: { requests: 142 },
      sets: metadata,
    };
    const manifest = { ...base, manifest_sha256: sha256(base) };
    write(path.join(runDir, "manifest.json"), manifest);
    observations.push({ status: "SUCCESS", observation_started_at: base.observation_started_at, observation_finished_at: finished, local_calendar_date: day.date, artifact_dir: runName, manifest_sha256: manifest.manifest_sha256, contract_fingerprint: contract.fingerprint, sets: metadata });
  }
  const series = {
    schema_version: 1,
    kind: "B46.7_DAILY_OBSERVATION_SERIES",
    series_id: "fixture-series",
    lifecycle: "COLLECTING",
    started_at: observations[0].observation_started_at,
    latest_at: observations.at(-1).observation_finished_at,
    completed_at: null,
    target_valid_observations: 7,
    successful_observations: observations.length,
    failed_observations: 1,
    expected_contract_fingerprint: contract.fingerprint,
    contract,
    observations,
    failures: [{ status: "FAILED", error_code: "TIMEOUT" }],
    created_at: observations[0].observation_started_at,
  };
  write(path.join(root, "series.json"), series);
  return { root, contract };
}

test("observation contract and identifier digests are deterministic", () => {
  const left = buildObservationContract({ repositoryCommit: "abc" });
  const right = buildObservationContract({ repositoryCommit: "abc" });
  assert.deepEqual(left, right);
  assert.equal(canonicalSetText(["b", "a", "a"]), "a\nb");
  assert.equal(digestIdents(["b", "a"]), digestIdents(["a", "b"]));
  assert.deepEqual(comparison(new Set(["a", "b"]), new Set(["b", "c"])), { old: 2, new: 2, intersection: 1, old_only: 1, new_only: 1, union: 3, jaccard: 1 / 3, persistence: 0.5, replacement: 0.5, disappearance: 0.5 });
});

test("observation command surface rejects production apply and mutation options", () => {
  assert.throws(() => parseArguments(["--apply"]), /OBSERVATION_OPTION_NOT_ALLOWED/);
  assert.throws(() => parseArguments(["--advance-state"]), /OBSERVATION_OPTION_NOT_ALLOWED/);
  assert.deepEqual(parseArguments(["--series-id", "x"]).seriesId, "x");
});

test("analyzer calculates adjacent churn, lifetimes, reappearance, stable cores and incomplete state", () => {
  const fixture = fixtureSeries();
  const report = analyzeSeries({ seriesRoot: fixture.root, seriesId: "fixture-series" });
  assert.equal(report.complete, false);
  assert.equal(report.valid_observations, 3);
  assert.equal(report.failed_observations, 1);
  assert.equal(report.adjacent_comparisons.length, 2);
  assert.equal(report.adjacent_comparisons[0].accepted.intersection, 2);
  assert.equal(report.populations.accepted.seen_exactly_days[3], 1);
  assert.equal(report.populations.accepted.seen_exactly_days[2], 2);
  assert.equal(report.populations.accepted.disappeared_and_reappeared, 0);
  assert.equal(report.populations.quarantine.disappeared_and_reappeared, 1);
  assert.equal(report.populations.deep_approved.stable_core.at_least_2, 1);
  assert.equal(report.hypothetical_deep_approved_persistence_gates.seen_at_least_3_observations, 1);
  assert.equal(report.safety.production_apply, false);
});

test("manifest and set digests detect tampering", () => {
  const fixture = fixtureSeries();
  const runDir = path.join(fixture.root, "20260823T031700Z");
  assert.doesNotThrow(() => readManifest(runDir));
  fs.appendFileSync(path.join(runDir, "sets", "accepted.txt"), "tampered\n");
  assert.throws(() => readManifest(runDir), /OBSERVATION_SET_DIGEST_MISMATCH/);
});

test("analyzer rejects incompatible observation contract fingerprints", () => {
  const fixture = fixtureSeries();
  const seriesPath = path.join(fixture.root, "series.json");
  const series = JSON.parse(fs.readFileSync(seriesPath, "utf8"));
  series.expected_contract_fingerprint = "different";
  fs.writeFileSync(seriesPath, `${JSON.stringify(series, null, 2)}\n`);
  assert.throws(() => analyzeSeries({ seriesRoot: fixture.root, seriesId: "fixture-series" }), /SERIES_MANIFEST_REFERENCE_MISMATCH|CONTRACT_FINGERPRINT_MISMATCH/);
});
