"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { INSERT_COLUMNS, canonical, sha256, streamFileHash, writeAtomic } = require("./run-import-review-b19a");

const FILES = Object.freeze(["source-reference.json", "review-records.json", "import-candidate-payload.json", "review.manifest.json", "review.log"]);
const SAFETY = Object.freeze({ dry_run_only: true, sql_executed: false, sqlite_write_performed: false, import_performed: false, publication_performed: false, reconciliation_performed: false, reactivation_performed: false, deactivation_performed: false });
const statement = `INSERT INTO files (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(column => `@${column}`).join(", ")})`;
const statementDigest = sha256(statement);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const fileHash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function args(argv) { const result = {}; for (let index = 0; index < argv.length; index += 1) { if (!['--source-review-dir', '--output-dir', '--catalog-db'].includes(argv[index]) || !argv[index + 1]) throw new Error("usage: --source-review-dir DIR --output-dir DIR --catalog-db FILE"); result[argv[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(argv[++index]); } if (!result.sourceReviewDir || !result.outputDir || !result.catalogDb) throw new Error("missing required arguments"); return result; }
function guard(output) { if (path.basename(path.dirname(output)) !== "runtime" || !/^import-dryrun-b25-\d{8}T\d{6}Z$/u.test(path.basename(output)) || fs.existsSync(output)) throw new Error("unsafe output root"); }
function validateSource(source) {
  for (const file of FILES) if (!fs.existsSync(path.join(source, file))) throw new Error(`missing review artifact: ${file}`);
  const reference = read(path.join(source, FILES[0])), review = read(path.join(source, FILES[1])), payload = read(path.join(source, FILES[2])), manifest = read(path.join(source, FILES[3]));
  if ([reference, review, payload, manifest].some(value => value.schema_version !== 2) || manifest.run_id !== review.run_id || manifest.run_id !== payload.run_id || manifest.total_input !== 25 || manifest.import_ready !== 25 || manifest.review_required !== 0 || manifest.blocked !== 0 || !manifest.review_only || manifest.sql_executed !== false || manifest.sqlite_write_performed !== false || manifest.import_performed !== false) throw new Error("invalid B24 review contract");
  if (!Array.isArray(review.records) || review.records.length !== 25 || new Set(review.records.map(record => record.ident)).size !== 25 || !Array.isArray(payload.records) || payload.records.length !== 25 || new Set(payload.records.map(record => record.ident)).size !== 25 || !payload.records.every(record => record.review_decision === "IMPORT_READY" && record.review_reasons.length === 0 && record.file && Object.keys(record.file).length === INSERT_COLUMNS.length && INSERT_COLUMNS.every(column => Object.hasOwn(record.file, column))) || JSON.stringify(payload.insert_columns) !== JSON.stringify(INSERT_COLUMNS) || payload.payload_digest !== sha256(canonical(payload.records)) || manifest.canonical_payload_digest !== payload.payload_digest || reference.source_metadata_digest !== manifest.source_metadata_digest || reference.catalog_snapshot_digest !== manifest.source_catalog_snapshot_digest) throw new Error("corrupt reviewed payload");
  return { reference, review, payload, manifest, hashes: Object.fromEntries(FILES.map(file => [file, fileHash(path.join(source, file))])) };
}
function affinity(type) { const text = String(type || "").toUpperCase(); return /INT/.test(text) ? "INTEGER" : /CHAR|CLOB|TEXT/.test(text) ? "TEXT" : /REAL|FLOA|DOUB/.test(text) ? "REAL" : "NUMERIC"; }
function valueMatches(value, type) { if (value === null) return true; const kind = affinity(type); return kind === "INTEGER" ? Number.isInteger(value) : kind === "REAL" ? typeof value === "number" && Number.isFinite(value) : kind === "TEXT" ? typeof value === "string" : true; }
async function run(options) {
  guard(options.outputDir); const source = validateSource(options.sourceReviewDir);
  if (!fs.existsSync(options.catalogDb) || fs.lstatSync(options.catalogDb).isSymbolicLink()) throw new Error("unsafe catalog database");
  const database = new Database(options.catalogDb, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare("PRAGMA table_info(files)").all(), columnByName = new Map(columns.map(column => [column.name, column]));
    if (INSERT_COLUMNS.some(column => !columnByName.has(column))) throw new Error("insert column missing from production schema");
    const simulatedTimestamp = new Date().toISOString(), records = [], conflicts = [];
    let queryCount = 1;
    for (const candidate of source.payload.records) {
      const values = { ...candidate.file, created_at: simulatedTimestamp, updated_at: simulatedTimestamp };
      const missing = columns.filter(column => column.notnull && column.dflt_value === null && (values[column.name] === null || values[column.name] === undefined || values[column.name] === "")).map(column => column.name);
      const affinityErrors = INSERT_COLUMNS.filter(column => !valueMatches(values[column], columnByName.get(column).type));
      const checks = ["is_active", "is_playable_video", "parsed_hdr", "parsed_dolby_vision", "parsed_has_dubbing", "parsed_has_subtitles", "password_protected"].filter(column => values[column] !== null && ![0, 1].includes(values[column]));
      const duplicate = Boolean(database.prepare("SELECT 1 FROM files WHERE ident = ?").get(values.ident)); queryCount += 1;
      const foreign = [];
      for (const [column, table] of [["candidate_id", "candidates"], ["media_id", "media"]]) if (values[column] !== null && !database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(values[column])) foreign.push(column);
      queryCount += [values.candidate_id, values.media_id].filter(value => value !== null).length;
      database.prepare(statement).bind(values); // Binding only: never run/get/all/iterate this INSERT statement.
      const errors = { missing, affinity: affinityErrors, check: checks, duplicate, foreign };
      if (missing.length || affinityErrors.length || checks.length || duplicate || foreign.length) conflicts.push(values.ident);
      records.push({ ident: values.ident, valid: !(missing.length || affinityErrors.length || checks.length || duplicate || foreign.length), ...errors });
    }
    const catalogDigest = await streamFileHash(options.catalogDb, options.hashOptions);
    if (catalogDigest !== source.reference.catalog_snapshot_digest) throw new Error("catalog digest mismatch");
    const runId = crypto.randomUUID(), summary = { schema_version: 1, run_id: runId, total_records: records.length, validated_records: records.filter(record => record.valid).length, rejected_records: conflicts.length, missing_required_fields: records.reduce((total, record) => total + record.missing.length, 0), schema_conflicts: records.reduce((total, record) => total + record.affinity.length + record.check.length + record.foreign.length, 0), duplicate_constraints: records.filter(record => record.duplicate).length, parameter_count: INSERT_COLUMNS.length, insert_column_order: INSERT_COLUMNS, statement_digest: statementDigest, sql_execution_count: 0, catalog_read_only_query_count: queryCount };
    fs.mkdirSync(options.outputDir, { mode: 0o750 });
    writeAtomic(path.join(options.outputDir, "source-reference.json"), { schema_version: 1, source_review_run_id: source.manifest.run_id, source_hashes: source.hashes, source_payload_digest: source.payload.payload_digest, catalog_snapshot_digest: catalogDigest });
    writeAtomic(path.join(options.outputDir, "dryrun.json"), { schema_version: 1, run_id: runId, records });
    writeAtomic(path.join(options.outputDir, "schema-validation.json"), { schema_version: 1, run_id: runId, table: "files", column_affinities: Object.fromEntries(INSERT_COLUMNS.map(column => [column, affinity(columnByName.get(column).type)])), not_null_columns: columns.filter(column => column.notnull).map(column => column.name), defaults: Object.fromEntries(columns.filter(column => column.dflt_value !== null).map(column => [column.name, column.dflt_value])), statement_digest: statementDigest });
    writeAtomic(path.join(options.outputDir, "dryrun.manifest.json"), { schema_version: 1, ...SAFETY, ...summary, source_review_digest: source.payload.payload_digest, catalog_snapshot_digest: catalogDigest, finished_reason: conflicts.length ? "validation_failed" : "completed" });
    writeAtomic(path.join(options.outputDir, "dryrun.log"), { run_id: runId, total_records: records.length, sql_execution_count: 0, finished_reason: conflicts.length ? "validation_failed" : "completed" });
    return summary;
  } finally { database.close(); }
}
if (require.main === module) run(args(process.argv.slice(2))).then(result => console.log(JSON.stringify({ run_id: result.run_id, validated_records: result.validated_records, rejected_records: result.rejected_records }))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { args, run, statement, statementDigest, validateSource };
