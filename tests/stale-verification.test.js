"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BUCKET_COUNT,
  BUCKET_CONTRACT_VERSION,
  RESULT_TAXONOMY_VERSION,
  STALE_CONTRACT_VERSION,
  STATUS,
  assignBuckets,
  buildStaleLedger,
  classifyRequestError,
  digestIdents,
  impactPreview,
  normalizeBatchResponse,
  selectBucketForDate,
  splitBatches,
} = require("../lib/stale-verification");

function productionRow(ident = "safe", extra = {}) {
  return { ident, media_id: 1, media_type: "movie", category: "movies", is_active: 1, is_playable_video: 1, ...extra };
}

function observation(runId, date, status, ident = "safe") {
  return { contract_version: STALE_CONTRACT_VERSION, run_id: runId, local_calendar_date: date, finished_at: `${date}T01:00:00.000Z`, records: [{ ident, status, observed_at: `${date}T01:00:00.000Z`, run_id: runId, local_calendar_date: date }] };
}

test("B56 bucket contract is deterministic, unique and reasonably balanced", () => {
  const rows = Array.from({ length: 5200 }, (_, index) => ({ ident: `ident-${String(index).padStart(5, "0")}` }));
  const first = assignBuckets(rows);
  const second = assignBuckets(rows);
  assert.equal(first.length, BUCKET_COUNT);
  assert.deepEqual(first, second);
  assert.equal(first.flat().length, rows.length);
  assert.equal(new Set(first.flat().map((row) => row.ident)).size, rows.length);
  const sizes = first.map((bucket) => bucket.length);
  assert.ok(Math.min(...sizes) > 0);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 180);
  assert.equal(BUCKET_CONTRACT_VERSION, "webshare-stale-buckets/v1");
});

test("B56 weekly selection is Europe/Bratislava ISO-week based and version-stable", () => {
  const selection = selectBucketForDate(new Date("2026-09-01T12:00:00.000Z"));
  assert.equal(selection.date, "2026-09-01");
  assert.equal(selection.iso_week, 36);
  assert.equal(selection.bucket, 35);
  assert.equal(selectBucketForDate(new Date("2026-09-07T23:59:00.000Z")).bucket, 36);
});

test("B56 batches are bounded at 50 and preserve exact input accounting", () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ ident: `id-${index}` }));
  const batches = splitBatches(rows);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 1]);
  assert.deepEqual(batches.flat(), rows);
  assert.throws(() => splitBatches(rows, 51), /BATCH_SIZE/);
});

test("B56 batch parser accepts only complete item-level answers", () => {
  const response = normalizeBatchResponse(["a", "b"], { status: 200, files: [{ ident: "a", exists: true, downloadable: true }, { ident: "b", exists: false, downloadable: false }] });
  assert.deepEqual(response.files, [{ ident: "a", exists: true, downloadable: true }, { ident: "b", exists: false, downloadable: false }]);
  assert.throws(() => normalizeBatchResponse(["a", "b"], { status: 200, files: [{ ident: "a", exists: false }] }), /Incomplete|Invalid/);
  assert.throws(() => normalizeBatchResponse(["a", "b"], { status: 200, files: [{ ident: "a", exists: false }, { ident: "a", exists: true }] }), /Invalid/);
});

test("B56 request failures are conservative and retryable classes are bounded", () => {
  assert.deepEqual(classifyRequestError(Object.assign(new Error("timeout"), { code: "TIMEOUT", retryable: true })), { code: "TIMEOUT", status: null, retryable: true, result_status: STATUS.TRANSIENT_FAILURE });
  assert.equal(classifyRequestError(Object.assign(new Error("429"), { status: 429 })).result_status, STATUS.TRANSIENT_FAILURE);
  assert.equal(classifyRequestError(Object.assign(new Error("malformed"), { code: "MALFORMED_RESPONSE" })).result_status, STATUS.INVALID_RESPONSE);
  assert.equal(classifyRequestError(Object.assign(new Error("bad request"), { status: 400 })).result_status, STATUS.INVALID_RESPONSE);
});

test("B56 lifecycle requires independent missing dates and excludes same-run retries", () => {
  const one = buildStaleLedger([observation("run-a", "2026-01-01", STATUS.DEFINITIVE_MISSING), observation("run-a-retry", "2026-01-01", STATUS.DEFINITIVE_MISSING)], [productionRow()]);
  assert.equal(one[0].definitive_missing_observation_count, 1);
  assert.equal(one[0].state, "SUSPECT");
  const two = buildStaleLedger([observation("run-a", "2026-01-01", STATUS.DEFINITIVE_MISSING), observation("run-b", "2026-01-08", STATUS.DEFINITIVE_MISSING)], [productionRow()]);
  assert.equal(two[0].definitive_missing_observation_count, 2);
  assert.equal(two[0].state, "WOULD_DEACTIVATE");
});

test("B56 transient failures do not advance strikes and PRESENT resets progression", () => {
  const transient = buildStaleLedger([observation("run-a", "2026-01-01", STATUS.DEFINITIVE_MISSING), observation("run-b", "2026-01-08", STATUS.TRANSIENT_FAILURE)], [productionRow()]);
  assert.equal(transient[0].definitive_missing_observation_count, 1);
  assert.equal(transient[0].state, "SUSPECT");
  const reset = buildStaleLedger([observation("run-a", "2026-01-01", STATUS.DEFINITIVE_MISSING), observation("run-b", "2026-01-08", STATUS.PRESENT), observation("run-c", "2026-01-15", STATUS.DEFINITIVE_MISSING)], [productionRow()]);
  assert.equal(reset[0].definitive_missing_observation_count, 2);
  assert.equal(reset[0].state, "SUSPECT");
  assert.equal(reset[0].last_present_at, "2026-01-08");
});

test("B56 same-day PRESENT wins over a same-day missing answer", () => {
  const ledger = buildStaleLedger([observation("run-a", "2026-01-01", STATUS.DEFINITIVE_MISSING), observation("run-b", "2026-01-01", STATUS.PRESENT)], [productionRow()]);
  assert.equal(ledger[0].definitive_missing_observation_count, 0);
  assert.equal(ledger[0].state, STATUS.PRESENT);
});

test("B56 excludes incompatible observations from deterministic ledger rebuild", () => {
  const ledger = buildStaleLedger([{ contract_version: "old-contract", run_id: "old", local_calendar_date: "2026-01-01", records: [{ ident: "safe", status: STATUS.DEFINITIVE_MISSING }] }, observation("run-a", "2026-01-08", STATUS.PRESENT)], [productionRow()]);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].independent_observation_dates, ["2026-01-08"]);
});

test("B56 impact preview identifies last-active-variant risk without writes", () => {
  const ledger = buildStaleLedger([observation("run-a", "2026-01-01", STATUS.DEFINITIVE_MISSING), observation("run-b", "2026-01-08", STATUS.DEFINITIVE_MISSING)], [productionRow("safe", { media_id: 7 })]);
  const impact = impactPreview(ledger, [productionRow("safe", { media_id: 7 })]);
  assert.equal(impact.would_deactivate_files, 1);
  assert.equal(impact.affected_media_entities, 1);
  assert.equal(impact.media_losing_last_active_playable_variant, 1);
});

test("B56 checked-ident digest is deterministic", () => {
  assert.equal(digestIdents(["a", "b"]), digestIdents(["a", "b"]));
  assert.notEqual(digestIdents(["a", "b"]), digestIdents(["b", "a"]));
  assert.equal(RESULT_TAXONOMY_VERSION, "webshare-stale-result/v1");
});
