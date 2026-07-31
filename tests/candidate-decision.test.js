"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DECISIONS,
  MAX_LOG_BYTES,
  createCandidateDecisionConfig,
  decisionEvidenceDigest,
  runCandidateDecision,
} = require("../lib/discovery/candidate-decision");

function fixture(t, suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `webshare-candidate-${suffix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function config(root, discoverySummary, records, limits = {}) {
  return createCandidateDecisionConfig({
    root,
    discoverySummary,
    filesExistEvidence: { records, requests_reserved: 4, requests_completed: 4 },
    limits: { maxCandidates: 20, maxDurationMs: 10_000, ...limits },
  });
}

function evidence(ident, fields = {}) {
  return {
    ident,
    exists: false,
    checked_at: "2026-07-31T00:00:00.000Z",
    response_status: 404,
    transport_error: null,
    retryable: false,
    ...fields,
  };
}

test("candidate decisions map evidence deterministically", async (t) => {
  const root = fixture(t, "mapping");
  const records = [
    evidence("eligible", { exists: true, response_status: 200 }),
    evidence("missing"),
    evidence("retry", { transport_error: "temporary", retryable: true, response_status: 503 }),
    evidence("error", { transport_error: "fatal", retryable: false, response_status: 400 }),
  ];
  const result = await runCandidateDecision(
    config(root, { idents: ["eligible", "missing", "retry", "error", "invalid"] }, records),
  );
  assert.deepEqual(
    result.manifest.decision_counters,
    { ELIGIBLE: 1, NOT_FOUND: 1, TRANSPORT_ERROR: 1, RETRY_LATER: 1, INVALID_INPUT: 1, LIMIT_REACHED: 0 }
  );
  const decisions = JSON.parse(fs.readFileSync(result.paths.decisions, "utf8"));
  assert.deepEqual(decisions.records.map((record) => record.decision), [
    "ELIGIBLE",
    "NOT_FOUND",
    "RETRY_LATER",
    "TRANSPORT_ERROR",
    "INVALID_INPUT",
  ]);
  for (const record of decisions.records) {
    assert.deepEqual(Object.keys(record).sort(), [
      "decision",
      "decision_timestamp",
      "evidence_digest",
      "ident",
      "reason",
    ]);
  }
  assert.deepEqual(DECISIONS, [
    "ELIGIBLE",
    "NOT_FOUND",
    "TRANSPORT_ERROR",
    "RETRY_LATER",
    "INVALID_INPUT",
    "LIMIT_REACHED",
  ]);
});

test("candidate evidence digest is stable and bounded", (t) => {
  const record = evidence("stable", { exists: true, response_status: 200 });
  assert.equal(decisionEvidenceDigest(record), decisionEvidenceDigest({ ...record, title: "ignored" }));
  assert.match(decisionEvidenceDigest(record), /^[0-9a-f]{64}$/u);
  assert.equal(decisionEvidenceDigest(record), "7e9f70a42a86e10371d57b758ba2e756eb3da1f71b67e08af008f9d4aec9c23f");
});

test("candidate checkpoint resume validates input and configuration digests", async (t) => {
  const root = fixture(t, "resume");
  const summary = { idents: ["one", "two", "three"] };
  const records = [evidence("one", { exists: true, response_status: 200 }), evidence("two"), evidence("three")];
  const current = config(root, summary, records);
  const controller = new AbortController();
  const interrupted = await runCandidateDecision(current, {
    signal: controller.signal,
    testHook(stage, index) {
      if (stage === "before_candidate" && index === 1) controller.abort(new Error("operator stop"));
    },
  });
  assert.equal(interrupted.manifest.status, "interrupted");
  assert.equal(interrupted.manifest.processed_candidates, 1);
  assert.equal(interrupted.manifest.request_counters.completed, 4);

  const corruptManifest = JSON.parse(fs.readFileSync(current.paths.manifest, "utf8"));
  corruptManifest.input_digest = "0".repeat(64);
  fs.writeFileSync(current.paths.manifest, `${JSON.stringify(corruptManifest)}\n`);
  await assert.rejects(
    runCandidateDecision(current, { resume: true }),
    /manifest|kompatibilný/i
  );
  fs.writeFileSync(current.paths.manifest, `${JSON.stringify(interrupted.manifest)}\n`);

  await assert.rejects(
    runCandidateDecision(
      config(root, { idents: ["changed", "two", "three"] }, records),
      { resume: true }
    ),
    /checkpoint|digest|resumovateľný/i
  );

  const resumed = await runCandidateDecision(current, { resume: true });
  assert.equal(resumed.manifest.status, "completed");
  assert.equal(resumed.manifest.processed_candidates, 3);
  assert.equal(resumed.manifest.eligible, 1);
  assert.equal(resumed.manifest.not_found, 2);
});

test("candidate decision applies LIMIT_REACHED and preserves bounded artifacts", async (t) => {
  const root = fixture(t, "limit");
  const current = config(
    root,
    { idents: ["one", "two", "three"] },
    [evidence("one", { exists: true, response_status: 200 }), evidence("two"), evidence("three")],
    { maxCandidates: 2 }
  );
  const result = await runCandidateDecision(current);
  assert.equal(result.manifest.limit_reached, 1);
  assert.equal(result.manifest.processed_candidates, 3);
  assert.equal(result.manifest.remaining_candidates, 0);
  assert.equal(fs.statSync(result.paths.log).size <= MAX_LOG_BYTES, true);
  for (const file of [result.paths.checkpoint, result.paths.decisions, result.paths.manifest]) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".tmp-")), false);
  }
});
