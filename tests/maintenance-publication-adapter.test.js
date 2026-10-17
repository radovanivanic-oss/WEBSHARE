"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../lib/maintenance-publication-adapter");

test("B55 pointer is deterministic and uses the public catalog schema", () => {
  const p = a.buildPointer("b54-20260901T174654Z", "a".repeat(64));
  assert.deepEqual(p, {
    schema: "webshare-atlas-public-catalog-current/v1",
    schema_version: 1,
    generation_id: "b54-20260901T174654Z",
    generation_path: "generations/b54-20260901T174654Z",
    manifest_path: "generations/b54-20260901T174654Z/manifest.json",
    manifest_sha256: "a".repeat(64),
  });
  assert.throws(() => a.buildPointer("../unsafe", "a".repeat(64)), /INVALID_GENERATION_ID/);
});

test("B55 object references are unique and content-addressed", () => {
  const m = { categories: [{ shards: [{ name: "a".repeat(64) + ".json.gz", sha256: "a".repeat(64), compressed_bytes: 1 }] }], details: { shards: [] }, listings: [], files: { shards: [] }, episodes: { shards: [] } };
  assert.equal(a.objectReferences(m).size, 1);
  assert.throws(() => a.objectReferences({ categories: [{ shards: [{ name: "bad.json.gz", sha256: "a".repeat(64) }] }] }), /INVALID_PUBLIC_OBJECT_REFERENCE/);
});

test("B55 manifest delta distinguishes retained, new, and removed object hashes", () => {
  const oldM = { categories: [{ category: "movies", record_count: 10 }], files: { record_count: 10 }, details: { record_count: 10 }, episodes: { record_count: 0 }, object_count: 2, object_bytes_compressed: 20, object_bytes_uncompressed: 40 };
  const newM = { categories: [{ category: "movies", record_count: 11 }, { category: "sports", record_count: 1 }], files: { record_count: 11 }, details: { record_count: 11 }, episodes: { record_count: 0 }, object_count: 2, object_bytes_compressed: 24, object_bytes_uncompressed: 44 };
  const d = a.manifestDelta(oldM, newM, ["keep", "remove"], ["keep", "add"]);
  assert.equal(d.source_files, 1);
  assert.deepEqual(d.retained_hashes, ["keep"]);
  assert.deepEqual(d.new_hashes, ["add"]);
  assert.deepEqual(d.removed_hashes, ["remove"]);
});

test("B55 representative selection is deterministic by category", () => {
  const rows = [
    { ident: "s", expected: { classification: { category: "series" }, parser: { title: "Series" } }, owner: { media: { id: 2, media_type: "tv" }, file: { needs_file_link: true }, root: { id: 2 }, episode: { season_number: 1, episode_number: 2, tvshow_id: 2 } } },
    { ident: "m", expected: { classification: { category: "movies" }, parser: { title: "Movie" } }, owner: { media: { id: 1, media_type: "movie" }, file: { needs_file_link: true }, root: { id: 1 } } },
    { ident: "sp", expected: { classification: { category: "sports" }, parser: { title: "Sport" } }, owner: { media: { id: 3, media_type: "sports" }, file: { needs_file_link: true }, root: { id: 3 } } },
  ];
  assert.deepEqual(a.representativeRows({ records: rows }).map((x) => x.category), ["movies", "series", "sports"]);
});

test("secondary GitHub rate limits fail fast instead of retrying uploads", () => {
  assert.equal(a.isSecondaryRateLimitError({ detail: "HTTP 403: You have exceeded a secondary rate limit." }), true);
  assert.equal(a.isSecondaryRateLimitError({ detail: "temporary network failure" }), false);
});
