"use strict";

const POLICY_VERSION = "1.0.0";
const MAX_QUERY_BYTES = 64;
const DENYLIST = Object.freeze(new Set(["test", "sample", "demo", "upload", "video", "file"]));
const QUALITY_THRESHOLDS = Object.freeze({ max_test_like_rate: 0.01, max_parser_low_confidence_rate: 0.1, max_unsupported_media_rate: 0.05, min_valid_video_rate: 0.85 });
const QUALITY_FIELDS = Object.freeze(["items_evaluated", "valid_video_count", "test_like_count", "parser_low_confidence_count", "unsupported_media_count", "invalid_quality_input_count"]);

function normalizeQuery(value) {
  if (typeof value !== "string") throw new TypeError("discovery query must be explicitly supplied as text");
  const query = value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (!query || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES || /[\u0000-\u001f\u007f]/u.test(query)) throw new Error("discovery query must be non-empty, bounded and free of control characters");
  if (query.includes("*")) throw new Error("discovery query must not contain a wildcard");
  if (query.split(/[^\p{L}\p{N}]+/u).filter(Boolean).some(token => DENYLIST.has(token))) throw new Error("discovery query contains denied test or generic vocabulary");
  if (query.length < 3) throw new Error("discovery query is too short to be representative");
  return query;
}

function queryProvenance(input) {
  const query = normalizeQuery(input);
  return Object.freeze({ policy_version: POLICY_VERSION, explicitly_supplied: true, normalized_query: query, wildcarded: false, denylist_checked: true, enumeration_complete: false });
}

function emptyQualityCounts() { return Object.fromEntries(QUALITY_FIELDS.map(field => [field, 0])); }
function qualityRates(counts) {
  const total = counts.items_evaluated;
  return total === 0 ? { test_like_rate: null, parser_low_confidence_rate: null, unsupported_media_rate: null, valid_video_rate: null } : { test_like_rate: counts.test_like_count / total, parser_low_confidence_rate: counts.parser_low_confidence_count / total, unsupported_media_rate: counts.unsupported_media_count / total, valid_video_rate: counts.valid_video_count / total };
}
function validateCounts(counts) {
  const output = {};
  for (const field of QUALITY_FIELDS) {
    const value = counts?.[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`quality count ${field} must be a non-negative integer`);
    output[field] = value;
  }
  if (output.test_like_count > output.items_evaluated || output.parser_low_confidence_count > output.items_evaluated || output.unsupported_media_count > output.items_evaluated || output.valid_video_count > output.items_evaluated) throw new Error("invalid discovery quality counts");
  return output;
}

function qualityGate(counts, thresholds = QUALITY_THRESHOLDS) {
  const values = validateCounts(counts);
  if (values.items_evaluated === 0) return Object.freeze({ verdict: "NOT_EVALUABLE", passed: false, thresholds: { ...thresholds }, counts: values, rates: qualityRates(values), failures: ["QUALITY_EVIDENCE_EMPTY"], stop_before_file_info: true, stop_before_import_planning: true });
  const rates = qualityRates(values);
  const failures = [];
  if (rates.test_like_rate > thresholds.max_test_like_rate) failures.push("TEST_LIKE_RATE_EXCEEDED");
  if (rates.parser_low_confidence_rate > thresholds.max_parser_low_confidence_rate) failures.push("PARSER_LOW_CONFIDENCE_RATE_EXCEEDED");
  if (rates.unsupported_media_rate > thresholds.max_unsupported_media_rate) failures.push("UNSUPPORTED_MEDIA_RATE_EXCEEDED");
  if (rates.valid_video_rate < thresholds.min_valid_video_rate) failures.push("VALID_VIDEO_RATE_TOO_LOW");
  return Object.freeze({ verdict: failures.length === 0 ? "PASS" : "FAIL", passed: failures.length === 0, thresholds: { ...thresholds }, counts: values, rates, failures, stop_before_file_info: failures.length > 0, stop_before_import_planning: failures.length > 0 });
}

module.exports = { DENYLIST, MAX_QUERY_BYTES, POLICY_VERSION, QUALITY_FIELDS, QUALITY_THRESHOLDS, emptyQualityCounts, normalizeQuery, queryProvenance, qualityGate, qualityRates, validateCounts };
