#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r"); const buffer = Buffer.allocUnsafe(4 * 1024 * 1024); let position = 0;
  try { while (true) { const read = fs.readSync(fd, buffer, 0, buffer.length, position); if (!read) break; hash.update(buffer.subarray(0, read)); position += read; } } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--apply") out.apply = true;
    else if (["--database", "--plan", "--values", "--expected-plan-sha256", "--expected-values-sha256", "--backup", "--output-dir"].includes(key)) out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  for (const required of ["database", "plan", "values", "expectedPlanSha256", "expectedValuesSha256", "backup", "outputDir"]) if (!out[required]) throw new Error(`missing --${required}`);
  if (!out.apply) throw new Error("--apply is required for the production write");
  return out;
}
function normalizePlan(plan) { return Array.isArray(plan.records) ? plan.records : []; }
function normalizeValues(values) { return Array.isArray(values.records) ? values.records : []; }
function baseline(db) {
  return {
    files: db.prepare("SELECT COUNT(*) n FROM files").get().n,
    active_files: db.prepare("SELECT COUNT(*) n FROM files WHERE is_active=1").get().n,
    active_playable: db.prepare("SELECT COUNT(*) n FROM files WHERE is_active=1 AND is_playable_video=1").get().n,
    media: db.prepare("SELECT COUNT(*) n FROM media").get().n,
    unclassified: db.prepare("SELECT COUNT(*) n FROM media WHERE category IN ('unclassified','unknown')").get().n,
    categories: db.prepare("SELECT category,COUNT(*) count,SUM(is_active=1) active FROM media GROUP BY category ORDER BY category").all(),
    quick_check: db.pragma("quick_check", { simple: true }),
    foreign_key_check: db.pragma("foreign_key_check"),
  };
}
function fieldValue(value, field) {
  if (field === "genres") return JSON.stringify(value.genres || []);
  if (field === "overview") return value.overview;
  if (field === "poster") return value.poster_url;
  if (field === "backdrop") return value.backdrop_url;
  if (field === "release_date") return value.release_date;
  if (field === "original_title") return value.original_title;
  throw new Error(`unsupported field: ${field}`);
}
const columns = { overview: "overview", poster: "poster_url", backdrop: "backdrop_url", genres: "genres_json", release_date: "release_date", original_title: "original_title" };

async function apply(options) {
  const plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), "utf8"));
  const valuesFile = JSON.parse(fs.readFileSync(path.resolve(options.values), "utf8"));
  const records = normalizePlan(plan); const values = normalizeValues(valuesFile);
  const planDigest = digest(records); const valuesDigest = digest(values);
  if (planDigest !== options.expectedPlanSha256 || plan.deterministic_sha256 !== planDigest) throw new Error("PLAN_DIGEST_MISMATCH");
  if (valuesDigest !== options.expectedValuesSha256 || valuesFile.deterministic_sha256 !== valuesDigest) throw new Error("VALUES_DIGEST_MISMATCH");
  if (new Set(records.map(r => r.media_id)).size !== records.length || new Set(values.map(r => r.media_id)).size !== values.length) throw new Error("DUPLICATE_PLAN_ID");
  const valuesById = new Map(values.map(value => [Number(value.media_id), value]));
  for (const record of records) if (!valuesById.has(Number(record.media_id))) throw new Error(`MISSING_VALUES:${record.media_id}`);
  const db = new Database(path.resolve(options.database), { fileMustExist: true });
  const out = path.resolve(options.outputDir); fs.mkdirSync(out, { recursive: true });
  try {
    const before = baseline(db);
    if (before.quick_check !== "ok" || before.foreign_key_check.length) throw new Error("PREWRITE_INTEGRITY_FAILURE");
    const backupPath = path.resolve(options.backup); fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    if (fs.existsSync(backupPath)) throw new Error("BACKUP_ALREADY_EXISTS");
    await db.backup(backupPath);
    const backup = { path: backupPath, size: fs.statSync(backupPath).size, sha256: sha256File(backupPath), quick_check: null, foreign_key_check: null, baseline: before };
    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    backup.quick_check = backupDb.pragma("quick_check", { simple: true }); backup.foreign_key_check = backupDb.pragma("foreign_key_check"); backupDb.close();
    if (backup.quick_check !== "ok" || backup.foreign_key_check.length) throw new Error("BACKUP_INTEGRITY_FAILURE");
    writeJson(path.join(out, "preflight.json"), { plan_sha256: planDigest, values_sha256: valuesDigest, baseline: before, sqlite_write_performed: false });
    writeJson(path.join(out, "backup.json"), backup);
    const started = Date.now(); const changed = [];
    const transaction = db.transaction(() => {
      const select = db.prepare("SELECT id,media_type,category,external_source,external_id,metadata_status,metadata_confidence,overview,poster_url,backdrop_url,genres_json,release_date,original_title FROM media WHERE id=?");
      for (const record of records) {
        const id = Number(record.media_id); const row = select.get(id); const value = valuesById.get(id);
        if (!row || row.media_type !== record.media_type || row.category !== record.category || row.external_source !== record.provider || String(row.external_id) !== String(record.provider_id) || row.metadata_status !== "matched" || Number(row.metadata_confidence || 0) < 0.8) throw new Error(`IDENTITY_DRIFT:${id}`);
        const fields = [...record.fields_to_fill].sort(); if (!fields.length || fields.some(field => !columns[field])) throw new Error(`INVALID_FIELDS:${id}`);
        for (const field of fields) if (row[columns[field]] !== null && String(row[columns[field]]).trim() !== "" && !(field === "genres" && String(row[columns[field]]) === "[]")) throw new Error(`NONEMPTY_FIELD_DRIFT:${id}:${field}`);
        const assignments = fields.map(field => `${columns[field]}=?`); const params = fields.map(field => fieldValue(value, field));
        if (fields.includes("overview") && value.selected_overview_language) { assignments.push("metadata_language=?"); params.push(value.selected_overview_language); }
        assignments.push("metadata_updated_at=?", "updated_at=?"); const now = new Date().toISOString(); params.push(now, now, id);
        const result = db.prepare(`UPDATE media SET ${assignments.join(", ")} WHERE id=?`).run(...params);
        if (result.changes !== 1) throw new Error(`UNEXPECTED_UPDATE_COUNT:${id}:${result.changes}`);
        changed.push({ media_id: id, fields, selected_overview_language: value.selected_overview_language || null });
      }
      const afterInside = baseline(db); if (afterInside.files !== before.files || afterInside.active_files !== before.active_files || afterInside.active_playable !== before.active_playable || afterInside.media !== before.media || afterInside.unclassified !== before.unclassified || afterInside.foreign_key_check.length) throw new Error("NON_METADATA_INVARIANT_FAILURE");
    });
    transaction();
    const after = baseline(db); const duration_ms = Date.now() - started;
    writeJson(path.join(out, "transaction.json"), { committed: true, duration_ms, plan_sha256: planDigest, values_sha256: valuesDigest, changed });
    writeJson(path.join(out, "postflight.json"), { before, after, plan_sha256: planDigest, changed_count: changed.length, sqlite_write_performed: true });
    return { committed: true, changed_count: changed.length, duration_ms, before, after, backup };
  } finally { db.close(); }
}

if (require.main === module) apply(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { apply, baseline, digest, parseArgs, sha256File };
