"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hasEpisodeMarker, hasNonFeatureMarker, hasResolutionYearCollision, partitionBatches, logicalDigest } = require("../lib/bootstrap-backlog");

test("bootstrap batch partition is deterministic, bounded and exact", () => {
  const records = Array.from({ length: 1001 }, (_, index) => ({ ident: String(index).padStart(5, "0") }));
  const batches = partitionBatches(records);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.candidate_count), [500, 500, 1]);
  assert.equal(new Set(batches.flatMap((batch) => batch.records.map((row) => row.ident))).size, records.length);
  assert.equal(logicalDigest(batches.flatMap((batch) => batch.records)), logicalDigest(records));
  assert.throws(() => partitionBatches(records, { batchSize: 501 }), /BOOTSTRAP_BATCH_SIZE_INVALID/);
});

test("bootstrap audit safety markers reject episodic and non-feature movie evidence", () => {
  assert.equal(hasEpisodeMarker("Show Season 2 Episode 4 1080p.mkv"), true);
  assert.equal(hasEpisodeMarker("Show S02E04 1080p.mkv"), true);
  assert.equal(hasEpisodeMarker("Movie 2026 1080p.mkv"), false);
  assert.equal(hasNonFeatureMarker("Movie 2026 trailer 1080p.mkv"), true);
  assert.equal(hasNonFeatureMarker("Movie 2026 1080p.mkv"), false);
  assert.equal(hasResolutionYearCollision("Title 1920x1080 HEVC.mkv", 1920), true);
  assert.equal(hasResolutionYearCollision("Title 2026 1080p.mkv", 2026), false);
});
