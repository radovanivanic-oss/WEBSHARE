"use strict";

// Read-only B.19A contract review.  This deliberately does not share the
// production UPSERT path: it produces an insert-only description, not SQL.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { buildCandidate } = require("../lib/candidate-grouper");
const { classifyMedia } = require("../lib/media-classifier");
const { parseMediaName, PARSER_VERSION } = require("../lib/media-name-parser");

const SAFETY = Object.freeze({ review_only: true, sql_executed: false, sqlite_write_performed: false, import_performed: false, reactivation_performed: false, deactivation_performed: false, reconciliation_performed: false, publication_performed: false });
const SOURCE_TYPES = Object.freeze(["B18_METADATA", "DETERMINISTIC_PARSER", "SCHEMA_DEFAULT", "IMPORT_TIMESTAMP", "CATALOG_LOOKUP", "UNAVAILABLE"]);
const OUTPUT_FILES = Object.freeze(["source-reference.json", "review-records.json", "import-candidate-payload.json", "review.manifest.json", "review.log"]);
const METADATA_FILES = Object.freeze(["metadata.json", "metadata.manifest.json", "metadata.checkpoint.json", "runner.manifest.json", "source-reference.json", "metadata.log"]);
const INSERT_COLUMNS = Object.freeze([
  "ident", "original_name", "normalized_name", "extension", "mime", "size_bytes", "webshare_category", "placeholder_url", "first_seen_at", "last_seen_at", "last_seen_run_id", "is_active", "is_playable_video", "candidate_id", "media_id", "parsed_title", "parsed_year", "parsed_season", "parsed_episode", "parsed_resolution", "parsed_source", "parsed_video_codec", "parsed_audio_codec", "parsed_hdr", "parsed_dolby_vision", "parsed_languages_json", "parsed_has_dubbing", "parsed_has_subtitles", "parsed_release_group", "parse_confidence", "parse_reason", "parse_version", "img", "stripe", "stripe_count", "queued", "positive_votes", "negative_votes", "password_protected", "raw_json", "created_at", "updated_at",
]);
const PAYLOAD_FIELDS = Object.freeze(["ident", "file", "parser", "classification", "playability", "catalog_linkage", "field_sources", "source_digests", "review_decision", "review_reasons"]);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const fileHash = file => sha256(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
function statIdentity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
async function streamFileHash(file, options = {}) {
  const stat = options.stat || fs.promises.stat;
  const createReadStream = options.createReadStream || fs.createReadStream;
  const before = await stat(file);
  if (!before.isFile()) throw new Error("catalog snapshot is not a regular file");
  const hash = crypto.createHash("sha256");
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      hash.update(chunk);
      if (options.onChunk) await options.onChunk(chunk);
    }
  } catch (error) { throw new Error(`catalog snapshot stream failed: ${error.message}`); }
  const after = await stat(file);
  if (!sameIdentity(statIdentity(before), statIdentity(after))) throw new Error("catalog snapshot changed while hashing");
  return hash.digest("hex");
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function writeAtomic(file, value) { const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 }); fs.renameSync(temporary, file); }
function parseArgs(argv) {
  const options = {};
  const names = new Set(["--source-metadata-dir", "--output-dir", "--catalog-db"]);
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.has(argv[index]) || !argv[index + 1]) throw new Error("usage: --source-metadata-dir DIR --output-dir DIR --catalog-db FILE");
    options[argv[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(argv[++index]);
  }
  if (!options.sourceMetadataDir || !options.outputDir || !options.catalogDb) throw new Error("missing required arguments");
  return options;
}
function assertOutputRoot(output) {
  const resolved = path.resolve(output), parent = path.dirname(resolved);
  if (path.basename(parent) !== "runtime" || !/^import-review-b19a-\d{8}T\d{6}Z$/u.test(path.basename(resolved)) || fs.existsSync(resolved)) throw new Error("unsafe output root");
  if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error("runtime parent must not be a symlink");
}
function validateMetadataSource(source) {
  for (const name of METADATA_FILES) if (!fs.existsSync(path.join(source, name))) throw new Error(`missing metadata artifact: ${name}`);
  const metadata = readJson(path.join(source, "metadata.json"));
  const manifest = readJson(path.join(source, "metadata.manifest.json"));
  const checkpoint = readJson(path.join(source, "metadata.checkpoint.json"));
  const runner = readJson(path.join(source, "runner.manifest.json"));
  if (!Array.isArray(metadata.records) || metadata.records.length !== 22 || new Set(metadata.records.map(record => record.ident)).size !== 22) throw new Error("invalid metadata ident set");
  if (!metadata.records.every(record => record.metadata_status === "METADATA_READY") || manifest.metadata_ready !== 22 || checkpoint.counters?.metadata_ready !== 22) throw new Error("metadata source is not completely ready");
  if (!manifest.metadata_only || !runner.metadata_only || runner.total_requests_completed !== 24 || runner.file_info_completed !== 22 || runner.authentication_completed !== 2) throw new Error("invalid metadata safety or counters");
  return { metadata, hashes: Object.fromEntries(METADATA_FILES.map(name => [name, fileHash(path.join(source, name))])) };
}
function sourceMap(record, parsed, linkage) {
  const source = {};
  for (const field of ["ident", "original_name", "extension", "mime", "size_bytes", "webshare_category", "first_seen_at", "last_seen_at", "raw_json"]) source[field] = "B18_METADATA";
  for (const field of ["normalized_name", "parsed_title", "parsed_year", "parsed_season", "parsed_episode", "parsed_resolution", "parsed_source", "parsed_video_codec", "parsed_audio_codec", "parsed_hdr", "parsed_dolby_vision", "parsed_languages_json", "parsed_has_dubbing", "parsed_has_subtitles", "parsed_release_group", "parse_confidence", "parse_reason", "parse_version", "is_playable_video"]) source[field] = "DETERMINISTIC_PARSER";
  for (const field of ["is_active", "img", "stripe", "stripe_count", "queued", "positive_votes", "negative_votes", "password_protected", "placeholder_url", "last_seen_run_id"]) source[field] = "SCHEMA_DEFAULT";
  for (const field of ["created_at", "updated_at"]) source[field] = "IMPORT_TIMESTAMP";
  source.candidate_id = linkage.candidate_id === null ? "UNAVAILABLE" : "CATALOG_LOOKUP";
  source.media_id = linkage.media_id === null ? "UNAVAILABLE" : "CATALOG_LOOKUP";
  return source;
}
function sourceValues(record, parsed, linkage) {
  return {
    ident: record.ident, original_name: record.original_name, normalized_name: parsed.normalizedName, extension: record.extension, mime: record.mime || null, size_bytes: record.size_bytes, webshare_category: record.webshare_category || null, placeholder_url: null, first_seen_at: record.first_seen_at, last_seen_at: record.last_seen_at, last_seen_run_id: null, is_active: 1, is_playable_video: parsed.isVideoExtension ? 1 : 0, candidate_id: linkage.candidate_id, media_id: linkage.media_id,
    parsed_title: parsed.title || null, parsed_year: parsed.year, parsed_season: parsed.season, parsed_episode: parsed.episode, parsed_resolution: parsed.resolution, parsed_source: parsed.source, parsed_video_codec: parsed.videoCodec, parsed_audio_codec: parsed.audioCodec, parsed_hdr: parsed.hdr ? 1 : 0, parsed_dolby_vision: parsed.dolbyVision ? 1 : 0, parsed_languages_json: JSON.stringify(parsed.languages), parsed_has_dubbing: parsed.hasDubbing ? 1 : 0, parsed_has_subtitles: parsed.hasSubtitles ? 1 : 0, parsed_release_group: parsed.releaseGroup, parse_confidence: parsed.confidence, parse_reason: parsed.reason, parse_version: parsed.parserVersion,
    img: null, stripe: null, stripe_count: 0, queued: 0, positive_votes: 0, negative_votes: 0, password_protected: 0, raw_json: record.raw_json, created_at: null, updated_at: null,
  };
}
function catalogueLookup(database, parsed, ident) {
  const identConflict = database.prepare("SELECT id FROM files WHERE ident = ?").get(ident);
  const candidate = buildCandidate(parsed);
  const candidateRow = database.prepare("SELECT id, media_id FROM candidates WHERE candidate_key = ?").get(candidate.candidateKey);
  return { ident_conflict: Boolean(identConflict), candidate_key: candidate.candidateKey, lookup_key: candidate.lookupKey, candidate_id: candidateRow?.id ?? null, media_id: candidateRow?.media_id ?? null };
}
function evaluate(record, lookup) {
  const parsed = parseMediaName(record.original_name, { extension: record.extension });
  const classification = classifyMedia({ candidate: { ...buildCandidate(parsed), title: parsed.title }, sampleName: record.original_name });
  const reasons = [];
  for (const field of ["ident", "original_name", "normalized_name", "first_seen_at", "last_seen_at", "parse_version", "raw_json", "extension", "size_bytes"]) if (record[field] === undefined || record[field] === null || record[field] === "") reasons.push("MISSING_REQUIRED_FIELD");
  if (!parsed.isVideoExtension || parsed.candidateType === "unknown" || classification.category === "unknown") reasons.push("UNSUPPORTED_MEDIA_CLASSIFICATION");
  if (parsed.confidence < 0.6 || parsed.parserVersion !== PARSER_VERSION) reasons.push("PARSER_LOW_CONFIDENCE");
  if (/\btest(?:ing|ed)?\b/iu.test(record.original_name)) reasons.push("TEST_LIKE_CONTENT");
  if (lookup.ident_conflict) reasons.push("CATALOG_LINKAGE_UNRESOLVED");
  let raw = null; try { raw = JSON.parse(record.raw_json); } catch { reasons.push("MISSING_REQUIRED_FIELD"); }
  if (!raw || raw.ident !== record.ident || raw.name !== record.original_name || raw.extension !== record.extension || Buffer.byteLength(record.raw_json) > 8192) reasons.push("MISSING_REQUIRED_FIELD");
  if (!Number.isInteger(record.size_bytes) || record.size_bytes < 0 || !Number.isFinite(Date.parse(record.first_seen_at)) || !Number.isFinite(Date.parse(record.last_seen_at)) || Date.parse(record.first_seen_at) > Date.parse(record.last_seen_at)) reasons.push("MISSING_REQUIRED_FIELD");
  return { parsed, classification, reasons: [...new Set(reasons)].sort() };
}
function reviewDecision(reasons) { return reasons.some(reason => ["MISSING_REQUIRED_FIELD", "UNSUPPORTED_MEDIA_CLASSIFICATION"].includes(reason)) ? "BLOCKED" : reasons.length ? "REVIEW_REQUIRED" : "IMPORT_READY"; }
async function run(options) {
  assertOutputRoot(options.outputDir);
  const source = validateMetadataSource(options.sourceMetadataDir);
  if (!fs.existsSync(options.catalogDb) || fs.lstatSync(options.catalogDb).isSymbolicLink()) throw new Error("unsafe catalog database");
  const database = new Database(options.catalogDb, { readonly: true, fileMustExist: true });
  let result;
  try {
    const parsedRecords = source.metadata.records.map(record => {
      const preliminary = parseMediaName(record.original_name, { extension: record.extension });
      return { record, lookup: catalogueLookup(database, preliminary, record.ident) };
    });
    const duplicateKeys = new Set(parsedRecords.map(item => item.lookup.candidate_key).filter((key, _, all) => all.filter(value => value === key).length > 1));
    const records = parsedRecords.map(({ record, lookup }) => {
      const evaluated = evaluate(record, lookup);
      if (duplicateKeys.has(lookup.candidate_key)) evaluated.reasons.push("MULTI_VERSION_AMBIGUITY");
      const reasons = [...new Set(evaluated.reasons)].sort();
      const decision = reviewDecision(reasons);
      const values = sourceValues(record, evaluated.parsed, lookup);
      const fieldSources = sourceMap(record, evaluated.parsed, lookup);
      return { ident: record.ident, review_decision: decision, review_reasons: reasons, parser: { candidate_type: evaluated.parsed.candidateType, confidence: evaluated.parsed.confidence, reason: evaluated.parsed.reason, version: evaluated.parsed.parserVersion }, classification: { category: evaluated.classification.category, confidence: evaluated.classification.confidence, reason: evaluated.classification.reason, version: evaluated.classification.classifierVersion }, catalog_linkage: lookup, values, field_sources: fieldSources };
    });
    const runId = crypto.randomUUID();
    const metadataDigest = source.hashes["metadata.json"];
    const candidates = records.filter(record => record.review_decision === "IMPORT_READY").map(record => ({ ident: record.ident, file: Object.fromEntries(INSERT_COLUMNS.map(column => [column, record.values[column]])), parser: record.parser, classification: record.classification, playability: { is_playable_video: record.values.is_playable_video }, catalog_linkage: record.catalog_linkage, field_sources: record.field_sources, source_digests: { metadata: metadataDigest }, review_decision: record.review_decision, review_reasons: record.review_reasons }));
    const counts = Object.fromEntries(["IMPORT_READY", "REVIEW_REQUIRED", "BLOCKED"].map(decision => [decision, records.filter(record => record.review_decision === decision).length]));
    const reasonCounts = {}; for (const record of records) for (const reason of record.review_reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    // Hash before creating the output root: a failed read leaves no partial review artifact.
    const catalogDigest = await streamFileHash(options.catalogDb, options.hashOptions);
    fs.mkdirSync(options.outputDir, { mode: 0o750 });
    const reference = { schema_version: 2, source_metadata_digest: metadataDigest, source_hashes: source.hashes, catalog_snapshot_digest: catalogDigest, catalog_read_only: true };
    const payload = { schema_version: 2, run_id: runId, fields: PAYLOAD_FIELDS, insert_columns: INSERT_COLUMNS, records: candidates, payload_digest: sha256(canonical(candidates)) };
    const manifest = { schema_version: 2, ...SAFETY, run_id: runId, source_metadata_digest: metadataDigest, source_catalog_snapshot_digest: reference.catalog_snapshot_digest, total_input: records.length, import_ready: counts.IMPORT_READY, review_required: counts.REVIEW_REQUIRED, blocked: counts.BLOCKED, reason_counts: reasonCounts, canonical_payload_digest: payload.payload_digest, finished_reason: "completed" };
    writeAtomic(path.join(options.outputDir, "source-reference.json"), reference);
    writeAtomic(path.join(options.outputDir, "review-records.json"), { schema_version: 2, run_id: runId, records: records.map(({ values, field_sources, ...safe }) => safe) });
    writeAtomic(path.join(options.outputDir, "import-candidate-payload.json"), payload);
    writeAtomic(path.join(options.outputDir, "review.manifest.json"), manifest);
    writeAtomic(path.join(options.outputDir, "review.log"), { run_id: runId, total_input: records.length, finished_reason: "completed" });
    result = manifest;
  } finally { database.close(); }
  return result;
}
const INSERT_ONLY_SQL_DESCRIPTION = Object.freeze({ operation: "INSERT", table: "files", columns: INSERT_COLUMNS, parameters: INSERT_COLUMNS.map(column => `@${column}`), conflict_policy: "ABORT_AND_ROLLBACK_ENTIRE_TRANSACTION", prohibited: ["UPDATE", "UPSERT", "REPLACE", "DELETE"] });
if (require.main === module) { run(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify({ run_id: result.run_id, import_ready: result.import_ready, review_required: result.review_required, blocked: result.blocked }))).catch(error => { console.error(error.message); process.exitCode = 1; }); }
module.exports = { INSERT_COLUMNS, INSERT_ONLY_SQL_DESCRIPTION, OUTPUT_FILES, PAYLOAD_FIELDS, SAFETY, SOURCE_TYPES, evaluate, parseArgs, reviewDecision, run, sourceMap, streamFileHash };
