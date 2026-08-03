"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeQuery, queryProvenance, qualityGate } = require("../lib/discovery/representative-query-policy");
const { reviewDecision } = require("../scripts/run-import-review-b19a");

test("representative query policy normalizes explicit, bounded non-generic queries", () => {
  assert.equal(normalizeQuery("  Dr   House "), "dr house");
  assert.equal(normalizeQuery("2025"), "2025");
  assert.deepEqual(queryProvenance("Akta X"), { policy_version: "1.0.0", explicitly_supplied: true, normalized_query: "akta x", wildcarded: false, denylist_checked: true, enumeration_complete: false });
});

test("representative query policy rejects generic, wildcarded and unsafe queries", () => {
  for (const value of ["test", "sample", "demo", "upload", "video", "file", "test movie", "a*", " ", "ab"]) assert.throws(() => normalizeQuery(value));
});

test("quality gate stops before metadata or planning on conservative failures", () => {
  const pass = qualityGate({ total: 100, test_like: 1, parser_low_confidence: 10, unsupported_media: 5, valid_video: 85 });
  assert.equal(pass.passed, true); assert.equal(pass.stop_before_file_info, false);
  const failed = qualityGate({ total: 100, test_like: 2, parser_low_confidence: 11, unsupported_media: 6, valid_video: 84 });
  assert.equal(failed.passed, false); assert.deepEqual(failed.failures, ["TEST_LIKE_RATE_EXCEEDED", "PARSER_LOW_CONFIDENCE_RATE_EXCEEDED", "UNSUPPORTED_MEDIA_RATE_EXCEEDED", "VALID_VIDEO_RATE_TOO_LOW"]); assert.equal(failed.stop_before_import_planning, true);
});

test("query policy does not relax B19A strict decisions", () => {
  assert.equal(reviewDecision(["TEST_LIKE_CONTENT"]), "REVIEW_REQUIRED");
  assert.equal(reviewDecision(["UNSUPPORTED_MEDIA_CLASSIFICATION"]), "BLOCKED");
});
