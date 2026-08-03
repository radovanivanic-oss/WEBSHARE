"use strict";

// B.24 is a schema-v2-only, read-only adapter over the established B.19A
// review policy. It never imports or emits executable SQL.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { parseMediaName, PARSER_VERSION } = require("../lib/media-name-parser");
const { FIELDS } = require("../lib/discovery/candidate-metadata");
const { INSERT_COLUMNS, PAYLOAD_FIELDS, SAFETY, canonical, catalogueLookup, evaluate, fileHash, reviewDecision, sha256, sourceMap, sourceValues, streamFileHash, writeAtomic } = require("./run-import-review-b19a");

const METADATA_FILES = Object.freeze(["metadata.json", "metadata.manifest.json", "metadata.checkpoint.json", "runner.manifest.json", "source-reference.json", "metadata.log"]);
const REQUIRED = Object.freeze(["ident", "original_name", "normalized_name", "first_seen_at", "last_seen_at", "parse_version", "raw_json"]);
const METADATA_SAFETY = Object.freeze({ metadata_only: true, sqlite_write_performed: false, import_performed: false, reactivation_performed: false, deactivation_performed: false, reconciliation_performed: false, publication_performed: false });

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!['--source-metadata-dir', '--output-dir', '--catalog-db'].includes(argv[index]) || !argv[index + 1]) throw new Error("usage: --source-metadata-dir DIR --output-dir DIR --catalog-db FILE");
    result[argv[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(argv[++index]);
  }
  if (!result.sourceMetadataDir || !result.outputDir || !result.catalogDb) throw new Error("missing required arguments");
  return result;
}

function assertOutputRoot(output) {
  const resolved = path.resolve(output), parent = path.dirname(resolved);
  if (path.basename(parent) !== "runtime" || !/^import-review-b24-\d{8}T\d{6}Z$/u.test(path.basename(resolved)) || fs.existsSync(resolved)) throw new Error("unsafe output root");
  if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error("runtime parent must not be a symlink");
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function validRecord(record) { return record && Object.keys(record).length === FIELDS.length && FIELDS.every(field => Object.hasOwn(record, field)); }
function validateSource(source) {
  for (const file of METADATA_FILES) if (!fs.existsSync(path.join(source, file))) throw new Error(`missing metadata artifact: ${file}`);
  const metadata = readJson(path.join(source, "metadata.json")), manifest = readJson(path.join(source, "metadata.manifest.json")), checkpoint = readJson(path.join(source, "metadata.checkpoint.json")), runner = readJson(path.join(source, "runner.manifest.json"));
  const records = metadata.records;
  if ([metadata, manifest, checkpoint, runner].some(item => item.schema_version !== 2) || !Array.isArray(records) || records.length !== 25 || new Set(records.map(record => record.ident)).size !== 25 || !records.every(validRecord)) throw new Error("invalid B23 schema-v2 metadata source");
  if (!records.every(record => record.metadata_status === "METADATA_READY" && record.parse_version === PARSER_VERSION && record.normalized_name === parseMediaName(record.original_name, { extension: record.extension }).normalizedName && REQUIRED.every(field => record[field] !== null && record[field] !== undefined && record[field] !== ""))) throw new Error("B23 metadata normalization or required-field mismatch");
  if (manifest.run_id !== checkpoint.run_id || manifest.run_id !== runner.run_id || manifest.metadata_ready !== 25 || checkpoint.counters?.metadata_ready !== 25 || runner.authentication_completed !== 2 || runner.file_info_completed !== 25 || runner.total_requests_completed !== 27 || !Object.entries(METADATA_SAFETY).every(([key, value]) => manifest[key] === value && runner[key] === value)) throw new Error("invalid B23 metadata safety or counters");
  return { metadata, hashes: Object.fromEntries(METADATA_FILES.map(file => [file, fileHash(path.join(source, file))])) };
}

function unsafe(record) {
  if (/[\u0000-\u001f\u007f]/u.test(record.original_name) || Buffer.byteLength(record.raw_json, "utf8") > 8192) return true;
  try {
    const raw = JSON.parse(record.raw_json), approved = ["ident", "name", "extension", "size", "mime", "category", "available", "removed"];
    return Object.keys(raw).some(key => !approved.includes(key));
  } catch { return true; }
}

async function run(options) {
  assertOutputRoot(options.outputDir);
  const source = validateSource(options.sourceMetadataDir);
  if (!fs.existsSync(options.catalogDb) || fs.lstatSync(options.catalogDb).isSymbolicLink()) throw new Error("unsafe catalog database");
  const database = new Database(options.catalogDb, { readonly: true, fileMustExist: true });
  try {
    let queryCount = 0;
    const catalogRowCount = database.prepare("SELECT COUNT(*) AS count FROM files").get().count; queryCount += 1;
    const parsedRecords = source.metadata.records.map(record => {
      const parsed = parseMediaName(record.original_name, { extension: record.extension });
      queryCount += 2;
      return { record, lookup: catalogueLookup(database, parsed, record.ident) };
    });
    const duplicateCandidates = new Set(parsedRecords.map(item => item.lookup.candidate_key).filter((key, index, all) => all.indexOf(key) !== index));
    const duplicateNormalized = new Set(parsedRecords.map(item => item.record.normalized_name).filter((name, index, all) => all.indexOf(name) !== index));
    const records = parsedRecords.map(({ record, lookup }) => {
      const evaluated = evaluate(record, lookup);
      if (duplicateCandidates.has(lookup.candidate_key)) evaluated.reasons.push("MULTI_VERSION_AMBIGUITY");
      if (duplicateNormalized.has(record.normalized_name)) evaluated.reasons.push("DUPLICATE_NORMALIZED_NAME");
      if (unsafe(record)) evaluated.reasons.push("UNSAFE_METADATA");
      const reasons = [...new Set(evaluated.reasons)].sort(), decision = reviewDecision(reasons), values = sourceValues(record, evaluated.parsed, lookup);
      return { ident: record.ident, review_decision: decision, review_reasons: reasons, parser: { candidate_type: evaluated.parsed.candidateType, confidence: evaluated.parsed.confidence, reason: evaluated.parsed.reason, version: evaluated.parsed.parserVersion }, classification: { category: evaluated.classification.category, confidence: evaluated.classification.confidence, reason: evaluated.classification.reason, version: evaluated.classification.classifierVersion }, catalog_linkage: lookup, values, field_sources: sourceMap(record, evaluated.parsed, lookup) };
    });
    const runId = crypto.randomUUID(), metadataDigest = source.hashes["metadata.json"], catalogDigest = await streamFileHash(options.catalogDb, options.hashOptions);
    const candidates = records.filter(record => record.review_decision === "IMPORT_READY").map(record => ({ ident: record.ident, file: Object.fromEntries(INSERT_COLUMNS.map(column => [column, record.values[column]])), parser: record.parser, classification: record.classification, playability: { is_playable_video: record.values.is_playable_video }, catalog_linkage: record.catalog_linkage, field_sources: record.field_sources, source_digests: { metadata: metadataDigest, catalog: catalogDigest }, review_decision: record.review_decision, review_reasons: record.review_reasons }));
    const count = decision => records.filter(record => record.review_decision === decision).length, reasonCounts = {};
    for (const record of records) for (const reason of record.review_reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    const payload = { schema_version: 2, run_id: runId, fields: PAYLOAD_FIELDS, insert_columns: INSERT_COLUMNS, records: candidates, payload_digest: sha256(canonical(candidates)) };
    const reference = { schema_version: 2, source_metadata_digest: metadataDigest, source_hashes: source.hashes, catalog_snapshot_digest: catalogDigest, catalog_read_only: true, catalog_row_count: catalogRowCount, catalog_read_only_query_count: queryCount };
    const manifest = { schema_version: 2, ...SAFETY, run_id: runId, source_metadata_digest: metadataDigest, source_catalog_snapshot_digest: catalogDigest, catalog_row_count: catalogRowCount, catalog_read_only_query_count: queryCount, total_input: records.length, import_ready: count("IMPORT_READY"), review_required: count("REVIEW_REQUIRED"), blocked: count("BLOCKED"), reason_counts: reasonCounts, canonical_payload_digest: payload.payload_digest, finished_reason: "completed" };
    fs.mkdirSync(options.outputDir, { mode: 0o750 });
    writeAtomic(path.join(options.outputDir, "source-reference.json"), reference);
    writeAtomic(path.join(options.outputDir, "review-records.json"), { schema_version: 2, run_id: runId, records: records.map(({ values, field_sources, ...safe }) => safe) });
    writeAtomic(path.join(options.outputDir, "import-candidate-payload.json"), payload);
    writeAtomic(path.join(options.outputDir, "review.manifest.json"), manifest);
    writeAtomic(path.join(options.outputDir, "review.log"), { run_id: runId, total_input: records.length, finished_reason: "completed" });
    return manifest;
  } finally { database.close(); }
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify({ run_id: result.run_id, import_ready: result.import_ready, review_required: result.review_required, blocked: result.blocked }))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, run, validateSource };
