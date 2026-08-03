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
  const pass = qualityGate({ items_evaluated: 100, test_like_count: 1, parser_low_confidence_count: 10, unsupported_media_count: 5, valid_video_count: 85, invalid_quality_input_count: 0 });
  assert.equal(pass.passed, true); assert.equal(pass.stop_before_file_info, false);
  const failed = qualityGate({ items_evaluated: 100, test_like_count: 2, parser_low_confidence_count: 11, unsupported_media_count: 6, valid_video_count: 84, invalid_quality_input_count: 0 });
  assert.equal(failed.passed, false); assert.deepEqual(failed.failures, ["TEST_LIKE_RATE_EXCEEDED", "PARSER_LOW_CONFIDENCE_RATE_EXCEEDED", "UNSUPPORTED_MEDIA_RATE_EXCEEDED", "VALID_VIDEO_RATE_TOO_LOW"]); assert.equal(failed.stop_before_import_planning, true);
});

test("quality gate is not evaluable for an empty page", () => {
  const result = qualityGate({ items_evaluated: 0, valid_video_count: 0, test_like_count: 0, parser_low_confidence_count: 0, unsupported_media_count: 0, invalid_quality_input_count: 0 });
  assert.equal(result.verdict, "NOT_EVALUABLE"); assert.equal(result.stop_before_file_info, true);
});

test("each quality threshold fails independently while exact boundaries pass", () => {
  const base = { items_evaluated: 100, valid_video_count: 85, test_like_count: 1, parser_low_confidence_count: 10, unsupported_media_count: 5, invalid_quality_input_count: 0 };
  assert.equal(qualityGate(base).verdict, "PASS");
  for (const [field, reason] of [["test_like_count", "TEST_LIKE_RATE_EXCEEDED"], ["parser_low_confidence_count", "PARSER_LOW_CONFIDENCE_RATE_EXCEEDED"], ["unsupported_media_count", "UNSUPPORTED_MEDIA_RATE_EXCEEDED"]]) {
    const value = { ...base, [field]: base[field] + 1 };
    assert.deepEqual(qualityGate(value).failures, [reason]);
  }
  assert.deepEqual(qualityGate({ ...base, valid_video_count: 84 }).failures, ["VALID_VIDEO_RATE_TOO_LOW"]);
});

test("query policy does not relax B19A strict decisions", () => {
  assert.equal(reviewDecision(["TEST_LIKE_CONTENT"]), "REVIEW_REQUIRED");
  assert.equal(reviewDecision(["UNSUPPORTED_MEDIA_CLASSIFICATION"]), "BLOCKED");
});
