"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hasEpisodeMarker, hasNonFeatureMarker, hasResolutionYearCollision, partitionBatches, logicalDigest, streamingFileSha256, verifyFileSha256 } = require("../lib/bootstrap-backlog");

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

test("large-file SHA-256 validation streams beyond the 2 GiB Buffer boundary", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-large-hash-"));
  const filePath = path.join(directory, "sparse.sqlite");
  const descriptor = fs.openSync(filePath, "w");
  try { fs.ftruncateSync(descriptor, (2 * 1024 * 1024 * 1024) + 17); } finally { fs.closeSync(descriptor); }
  const actual = await streamingFileSha256(filePath);
  const expectedHash = crypto.createHash("sha256");
  const zeroChunk = Buffer.alloc(1024 * 1024);
  for (let remaining = (2 * 1024 * 1024 * 1024) + 17; remaining > 0;) {
    const length = Math.min(remaining, zeroChunk.length);
    expectedHash.update(length === zeroChunk.length ? zeroChunk : zeroChunk.subarray(0, length));
    remaining -= length;
  }
  assert.equal(actual, expectedHash.digest("hex"));
  assert.equal(await verifyFileSha256(filePath, actual), actual);
  await assert.rejects(() => verifyFileSha256(filePath, "0".repeat(64)), /FILE_SHA256_MISMATCH/);
  await assert.rejects(() => verifyFileSha256(path.join(directory, "missing.sqlite")), /FILE_FOR_HASH_MISSING/);
  fs.rmSync(directory, { recursive: true, force: true });
});
