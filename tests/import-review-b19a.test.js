"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const Database = require("better-sqlite3");
const test = require("node:test");
const { INSERT_COLUMNS, INSERT_ONLY_SQL_DESCRIPTION, PAYLOAD_FIELDS, SOURCE_TYPES, run, sourceMap, streamFileHash } = require("../scripts/run-import-review-b19a");
const { parseMediaName } = require("../lib/media-name-parser");

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function record(index, name = "Example Movie 2024 1080p.mkv") {
  const ident = `id-${index}`;
  return { ident, original_name: name, normalized_name: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), extension: "mkv", size_bytes: 100 + index, mime: "video/x-matroska", webshare_category: "video", available: true, removed: false, checked_at: "2026-08-02T20:47:27.000Z", first_seen_at: "2026-07-31T15:57:37.000Z", last_seen_at: "2026-08-02T20:47:27.000Z", parse_version: "1.0.0", raw_json: JSON.stringify({ ident, name, extension: "mkv", size_bytes: 100 + index }), metadata_status: "METADATA_READY", transport_error: null, retryable: false };
}
function fixture(t, changes = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "b19a-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, "metadata"), runtime = path.join(base, "runtime"), dbFile = path.join(base, "catalog.sqlite"); fs.mkdirSync(source); fs.mkdirSync(runtime);
  const records = Array.from({ length: 22 }, (_, index) => record(index, changes.name ? changes.name(index) : `Example Movie ${2020 + index} 1080p.mkv`));
  if (changes.records) changes.records(records);
  fs.writeFileSync(path.join(source, "metadata.json"), JSON.stringify({ schema_version: 1, records }));
  fs.writeFileSync(path.join(source, "metadata.manifest.json"), JSON.stringify({ metadata_only: true, metadata_ready: 22 }));
  fs.writeFileSync(path.join(source, "metadata.checkpoint.json"), JSON.stringify({ counters: { metadata_ready: 22 } }));
  fs.writeFileSync(path.join(source, "runner.manifest.json"), JSON.stringify({ metadata_only: true, total_requests_completed: 24, file_info_completed: 22, authentication_completed: 2 }));
  fs.writeFileSync(path.join(source, "source-reference.json"), "{}"); fs.writeFileSync(path.join(source, "metadata.log"), "{}\n");
  const db = new Database(dbFile); db.exec("CREATE TABLE files(id INTEGER PRIMARY KEY, ident TEXT); CREATE TABLE candidates(id INTEGER PRIMARY KEY, candidate_key TEXT, media_id INTEGER);"); db.close();
  return { source, runtime, dbFile };
}
function execute(f, timestamp = "20260803T100000Z") { return run({ sourceMetadataDir: f.source, catalogDb: f.dbFile, outputDir: path.join(f.runtime, `import-review-b19a-${timestamp}`) }); }

test("B19A builds a deterministic allowlisted candidate payload from the production field contract", async t => {
  const f = fixture(t); const sourceHashes = Object.fromEntries(fs.readdirSync(f.source).map(name => [name, hash(path.join(f.source, name))]));
  const databaseHash = hash(f.dbFile); const first = await execute(f); const out = path.join(f.runtime, "import-review-b19a-20260803T100000Z"); const payload = JSON.parse(fs.readFileSync(path.join(out, "import-candidate-payload.json")));
  assert.equal(first.import_ready, 22); assert.deepEqual(payload.fields, PAYLOAD_FIELDS); assert.deepEqual(payload.insert_columns, INSERT_COLUMNS); assert.equal(payload.records.length, 22);
  assert.deepEqual(Object.keys(payload.records[0]).sort(), [...PAYLOAD_FIELDS].sort()); assert.ok(!JSON.stringify(payload).match(/hunter2|wst=|token=|https?:\/\/|<response/i));
  for (const [name, before] of Object.entries(sourceHashes)) assert.equal(hash(path.join(f.source, name)), before);
  const second = await execute(f, "20260803T100001Z"); const secondPayload = JSON.parse(fs.readFileSync(path.join(f.runtime, "import-review-b19a-20260803T100001Z", "import-candidate-payload.json")));
  assert.equal(second.canonical_payload_digest, first.canonical_payload_digest); assert.equal(secondPayload.payload_digest, payload.payload_digest);
  assert.equal(hash(f.dbFile), databaseHash);
});

test("B19A strict review reasons block or review ambiguous unsafe metadata without fabricating fields", async t => {
  const f = fixture(t, { records(records) { records[0] = record(0, "Test Movie 2024 1080p.mkv"); records[1] = record(1, "Same Movie 2024 1080p.mkv"); records[2] = record(2, "Same Movie 2024 720p.mkv"); records[3].size_bytes = null; records[4] = record(4, "Unknown title.mkv"); } });
  await execute(f); const review = JSON.parse(fs.readFileSync(path.join(f.runtime, "import-review-b19a-20260803T100000Z", "review-records.json")));
  const byIdent = new Map(review.records.map(value => [value.ident, value]));
  assert.ok(byIdent.get("id-0").review_reasons.includes("TEST_LIKE_CONTENT"));
  assert.ok(byIdent.get("id-1").review_reasons.includes("MULTI_VERSION_AMBIGUITY")); assert.ok(byIdent.get("id-2").review_reasons.includes("MULTI_VERSION_AMBIGUITY"));
  assert.equal(byIdent.get("id-3").review_decision, "BLOCKED"); assert.ok(byIdent.get("id-3").review_reasons.includes("MISSING_REQUIRED_FIELD"));
  assert.equal(byIdent.get("id-4").review_decision, "BLOCKED"); assert.ok(byIdent.get("id-4").review_reasons.includes("UNSUPPORTED_MEDIA_CLASSIFICATION"));
});

test("field sources, parser playability and insert-only description are explicit", () => {
  const parsed = parseMediaName("Example Movie 2024 1080p.mkv", { extension: "mkv" }); const sources = sourceMap(record(0), parsed, { candidate_id: null, media_id: null });
  assert.deepEqual(new Set(SOURCE_TYPES), new Set(["B18_METADATA", "DETERMINISTIC_PARSER", "SCHEMA_DEFAULT", "IMPORT_TIMESTAMP", "CATALOG_LOOKUP", "UNAVAILABLE"]));
  assert.equal(sources.ident, "B18_METADATA"); assert.equal(sources.normalized_name, "DETERMINISTIC_PARSER"); assert.equal(sources.is_playable_video, "DETERMINISTIC_PARSER"); assert.equal(sources.created_at, "IMPORT_TIMESTAMP"); assert.equal(sources.candidate_id, "UNAVAILABLE");
  assert.equal(INSERT_ONLY_SQL_DESCRIPTION.operation, "INSERT"); assert.ok(INSERT_ONLY_SQL_DESCRIPTION.parameters.every(value => value.startsWith("@"))); assert.ok(INSERT_ONLY_SQL_DESCRIPTION.prohibited.includes("UPSERT"));
});

test("B19A rejects corrupt source state and unsafe output roots before creating artifacts", async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, "metadata.checkpoint.json"), JSON.stringify({ counters: { metadata_ready: 21 } }));
  await assert.rejects(() => execute(f), /metadata source/); assert.equal(fs.readdirSync(f.runtime).length, 0);
  await assert.rejects(() => run({ sourceMetadataDir: f.source, catalogDb: f.dbFile, outputDir: path.join(f.runtime, "bad") }), /unsafe output root/);
});

test("streamed catalog hash is bounded, deterministic and matches ordinary SHA-256", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "b19a-hash-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "fixture.bin"); fs.writeFileSync(file, Buffer.alloc(256 * 1024 + 37, 0x5a));
  const expected = hash(file); const actual = await streamFileHash(file);
  assert.equal(actual, expected); assert.equal(await streamFileHash(file), expected);
  const original = fs.readFileSync; fs.readFileSync = () => { throw new Error("whole-file read forbidden"); };
  try { assert.equal(await streamFileHash(file), expected); } finally { fs.readFileSync = original; }
});

test("streamed hash rejects missing, failing and changed inputs before review artifacts", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "b19a-hash-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "fixture.bin"); fs.writeFileSync(file, Buffer.alloc(128 * 1024, 1));
  await assert.rejects(() => streamFileHash(path.join(base, "missing")), /ENOENT/);
  await assert.rejects(() => streamFileHash(file, { createReadStream: () => Readable.from((async function* () { throw new Error("simulated stream fault"); })()) }), /stream failed/);
  await assert.rejects(() => streamFileHash(file, { onChunk: async () => fs.appendFileSync(file, "x") }), /changed while hashing/);
  const f = fixture(t); await assert.rejects(() => run({ sourceMetadataDir: f.source, catalogDb: f.dbFile, outputDir: path.join(f.runtime, "import-review-b19a-20260803T100000Z"), hashOptions: { createReadStream: () => { throw new Error("simulated stream fault"); } } }), /stream failed/);
  assert.equal(fs.readdirSync(f.runtime).length, 0);
});
