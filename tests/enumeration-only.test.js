"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildEnumerationCertificate,
  compareIdentSets,
  validateCompletenessCertificate,
  validatePartitionProof,
} = require("../lib/enumeration-only");

test("enumeration comparison deduplicates idents and identifies only new records", () => {
  const result = compareIdentSets({ knownIdents: new Set(["a", "b"]), observedIdents: ["a", "c", "c"] });
  assert.equal(result.observed_unique, 2);
  assert.equal(result.known_observed, 1);
  assert.deepEqual(result.new_idents, ["c"]);
  assert.equal(result.not_seen_idents, null);
  assert.equal(result.absence_comparison_eligible, false);
});

test("incomplete enumeration cannot produce absence candidates", () => {
  const result = compareIdentSets({ knownIdents: new Set(["a", "b"]), observedIdents: ["a"], complete: true, coverageStatus: "UNPROVEN" });
  assert.equal(result.not_seen_idents, null);
  assert.equal(result.absence_comparison_eligible, false);
});

test("proven complete enumeration produces deterministic new and not-seen sets", () => {
  const result = compareIdentSets({ knownIdents: new Set(["a", "b", "c"]), observedIdents: ["a", "c", "d"], complete: true, coverageStatus: "PROVEN_COMPLETE" });
  assert.deepEqual(result.new_idents, ["d"]);
  assert.deepEqual(result.not_seen_idents, ["b"]);
  assert.equal(result.absence_comparison_eligible, true);
  const certificate = buildEnumerationCertificate({ runId: "run-1", startedAt: "a", finishedAt: "b", queryContract: { mode: "fixture" }, partitions: { ids: ["all"], catch_all: true }, completionStatus: "COMPLETE", coverageStatus: "PROVEN_COMPLETE", rawRecords: 3, uniqueIdents: new Set(["a", "c", "d"]), duplicateCount: 0, malformedCount: 0, knownIndex: { count: 3 }, comparison: result });
  assert.equal(certificate.absence_comparison_eligible, true);
  assert.equal(validateCompletenessCertificate(certificate), true);
});

test("certificate rejects provider-cap or partial runs", () => {
  const certificate = buildEnumerationCertificate({ runId: "run-2", startedAt: "a", finishedAt: "b", queryContract: { mode: "fixture" }, partitions: { ids: ["prefix-a"], catch_all: false }, completionStatus: "PARTIAL", coverageStatus: "UNPROVEN", rawRecords: 1, uniqueIdents: new Set(["a"]), duplicateCount: 0, malformedCount: 0, knownIndex: { count: 3 }, comparison: compareIdentSets({ knownIdents: new Set(["a"]), observedIdents: ["a"] }) });
  assert.throws(() => validateCompletenessCertificate(certificate), /NOT_COMPLETE/);
});

test("complete coverage requires an explicit catch-all partition proof", () => {
  assert.throws(() => validatePartitionProof({ coverage_status: "PROVEN_COMPLETE", partition_complete: true, catch_all: false, partitions: [] }), /PARTITION_PROOF_INVALID/);
  assert.deepEqual(validatePartitionProof({ coverage_status: "PROVEN_COMPLETE", partition_complete: true, catch_all: true, partitions: [{ id: "all", coverage_proven: true }] }).partitions, [{ id: "all", coverage_proven: true }]);
});
