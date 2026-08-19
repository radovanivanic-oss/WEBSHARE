"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { openCatalogDatabase, nowIso } = require("../src/db/catalog-db");
const { applyImportEntries, prepareStatements, rebuildCatalogIndexesAndCounts, rebuildMediaVisibility } = require("./import-catalog-jsonl");
const { sha256, snapshotDatabase } = require("../lib/daily-maintenance");
const { logicalDigest } = require("../lib/bootstrap-backlog");

function argument(argv, name, fallback = null) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] || fallback : fallback; }
function parseArguments(argv) {
  return { mode: argument(argv, "--mode"), database: argument(argv, "--database"), manifest: argument(argv, "--manifest"), outputDir: argument(argv, "--output-dir"), stagingDb: argument(argv, "--staging-db"), backupPath: argument(argv, "--backup-path"), validatedBackup: argument(argv, "--validated-backup"), serviceName: argument(argv, "--service-name", "webshare-catalog-api.service"), writerApproved: argv.includes("--writer-approved"), stagingReady: argv.includes("--staging-ready") };
}
function required(value, name) { if (!value) throw new Error(`${name}_REQUIRED`); return path.resolve(value); }
function writeAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 }); const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 }); fs.renameSync(temporary, filePath); }
function loadManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.kind !== "BOOTSTRAP_DISCOVERY_BACKLOG" || manifest.batch_size > 500) throw new Error("BOOTSTRAP_MANIFEST_INVALID");
  const batchDir = path.join(path.dirname(manifestPath), "batches");
  const batches = manifest.batches.map((meta) => {
    const filePath = path.join(batchDir, `batch-${String(meta.batch_number).padStart(4, "0")}.json`);
    const batch = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (batch.candidate_count > 500 || batch.logical_digest !== logicalDigest(batch.records) || batch.logical_digest !== meta.logical_digest) throw new Error(`BOOTSTRAP_BATCH_INVALID:${meta.batch_number}`);
    return { ...batch, file_path: filePath };
  });
  const records = batches.flatMap((batch) => batch.records);
  if (records.length !== manifest.candidate_count || new Set(records.map((row) => row.ident)).size !== records.length || logicalDigest(records) !== manifest.logical_digest) throw new Error("BOOTSTRAP_MANIFEST_UNION_MISMATCH");
  return { manifest, batches, records };
}
function assertIntegrity(database, label) {
  const quick = database.pragma("quick_check", { simple: true });
  const foreignKeys = database.pragma("foreign_key_check");
  const duplicateIdents = database.prepare("SELECT COUNT(*) AS count FROM (SELECT ident FROM files GROUP BY ident HAVING COUNT(*) > 1)").get().count;
  const duplicateOwnership = database.prepare("SELECT COUNT(*) AS count FROM (SELECT ident, media_id FROM files GROUP BY ident, media_id HAVING COUNT(*) > 1)").get().count;
  const unclassified = database.prepare("SELECT COUNT(*) AS count FROM media WHERE category IN ('unknown','unclassified')").get().count;
  if (quick !== "ok" || foreignKeys.length || duplicateIdents || duplicateOwnership || unclassified) throw new Error(`${label}_INTEGRITY_FAILED`);
  return { quick_check: quick, foreign_key_check: foreignKeys.length, duplicate_idents: duplicateIdents, duplicate_ownership: duplicateOwnership, unclassified };
}
async function backupDatabase(sourcePath, targetPath) {
  if (fs.existsSync(targetPath)) throw new Error("BOOTSTRAP_BACKUP_ALREADY_EXISTS");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o750 });
  const source = openCatalogDatabase(sourcePath, { readonly: true, fileMustExist: true });
  try { await source.backup(targetPath); } finally { source.close(); }
  const check = openCatalogDatabase(targetPath, { readonly: true, fileMustExist: true });
  try { assertIntegrity(check, "BOOTSTRAP_BACKUP"); } finally { check.close(); }
  return { path: targetPath, size: fs.statSync(targetPath).size, sha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex") };
}
function applyOneBatch(database, batch, runId) {
  const existing = database.prepare("SELECT ident, media_id, is_active FROM files WHERE ident IN (" + batch.records.map(() => "?").join(",") + ")").all(batch.records.map((row) => row.ident));
  if (existing.length) {
    if (existing.length === batch.records.length && existing.every((row) => row.media_id !== null && row.is_active === 1)) return { status: "ALREADY_APPLIED", inserted: 0, updated: existing.length, media_created: 0 };
    throw new Error(`BOOTSTRAP_PARTIAL_BATCH_STATE:${batch.batch_number}`);
  }
  const before = snapshotDatabase(database);
  const result = database.transaction(() => {
    const now = nowIso();
    const crawlRunId = database.prepare(`INSERT INTO crawl_runs(started_at,status,is_full,items_seen,source_manifest,created_at,updated_at) VALUES (?, 'running', 0, ?, ?, ?, ?)`).run(now, batch.records.length, JSON.stringify({ bootstrap_batch: batch.batch_number, bootstrap_digest: batch.logical_digest, run_id: runId }), now, now).lastInsertRowid;
    const statements = prepareStatements(database);
    const imported = applyImportEntries(database, statements, batch.records.map((row) => ({ item: row.item, rawJson: JSON.stringify(row.item) })), { crawlRunId });
    rebuildCatalogIndexesAndCounts(database);
    rebuildMediaVisibility(database);
    database.prepare("UPDATE crawl_runs SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, crawlRunId);
    return { crawlRunId, ...imported };
  })();
  const after = snapshotDatabase(database);
  if (after.files - before.files !== batch.records.length || after.active_playable_files - before.active_playable_files !== batch.records.length) throw new Error(`BOOTSTRAP_BATCH_DELTA_MISMATCH:${batch.batch_number}`);
  return { status: "COMMITTED", ...result, before, after };
}
function assertServiceStopped(serviceName) {
  try { const state = execFileSync("systemctl", ["is-active", serviceName], { encoding: "utf8" }).trim(); if (state === "active") throw new Error("BOOTSTRAP_SERVICE_MUST_BE_STOPPED"); } catch (error) { if (error.message === "BOOTSTRAP_SERVICE_MUST_BE_STOPPED") throw error; }
}
async function main(options = parseArguments(process.argv.slice(2))) {
  if (!["dry-run", "apply"].includes(options.mode)) throw new Error("BOOTSTRAP_MODE_INVALID");
  const databasePath = required(options.database, "DATABASE"); const manifestPath = required(options.manifest, "MANIFEST"); const outputDir = required(options.outputDir, "OUTPUT_DIR");
  const loaded = loadManifest(manifestPath); fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
  const targetDb = options.mode === "dry-run" ? required(options.stagingDb, "STAGING_DB") : databasePath;
  let backup = null;
  if (options.mode === "dry-run") backup = options.stagingReady ? { path: targetDb, size: fs.statSync(targetDb).size, prebuilt: true } : await backupDatabase(databasePath, targetDb);
  if (options.mode === "apply") {
    if (!options.writerApproved) throw new Error("BOOTSTRAP_WRITER_APPROVAL_REQUIRED");
    assertServiceStopped(options.serviceName);
    if (options.validatedBackup) {
      const validatedPath = required(options.validatedBackup, "VALIDATED_BACKUP");
      if (!fs.existsSync(validatedPath)) throw new Error("BOOTSTRAP_VALIDATED_BACKUP_MISSING");
      const check = openCatalogDatabase(validatedPath, { readonly: true, fileMustExist: true });
      try { assertIntegrity(check, "BOOTSTRAP_VALIDATED_BACKUP"); } finally { check.close(); }
      backup = { path: validatedPath, size: fs.statSync(validatedPath).size, sha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(validatedPath)).digest("hex"), prevalidated: true };
    } else {
      backup = await backupDatabase(databasePath, required(options.backupPath, "BACKUP_PATH"));
    }
  }
  const database = openCatalogDatabase(targetDb, { readonly: false, fileMustExist: true }); const runId = `b46.3-${Date.now()}`; const executions = [];
  try {
    for (const batch of loaded.batches) {
      const execution = applyOneBatch(database, batch, runId); const integrity = assertIntegrity(database, `BOOTSTRAP_BATCH_${batch.batch_number}`); executions.push({ batch_number: batch.batch_number, candidate_count: batch.candidate_count, logical_digest: batch.logical_digest, ...execution, integrity });
      writeAtomic(path.join(outputDir, `batch-${String(batch.batch_number).padStart(4, "0")}-execution.json`), executions[executions.length - 1]);
    }
    const final = snapshotDatabase(database); const integrity = assertIntegrity(database, "BOOTSTRAP_FINAL");
    const summary = { schema_version: 1, mode: options.mode, run_id: runId, manifest: manifestPath, manifest_sha256: sha256(loaded.manifest), backup, batches_attempted: loaded.batches.length, batches_committed: executions.filter((row) => row.status === "COMMITTED").length, batches_already_applied: executions.filter((row) => row.status === "ALREADY_APPLIED").length, files_inserted: executions.reduce((n, row) => n + row.inserted, 0), final, integrity };
    writeAtomic(path.join(outputDir, "bootstrap-execution-summary.json"), summary); console.log(JSON.stringify(summary, null, 2)); return summary;
  } finally { database.close(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertIntegrity, loadManifest, main };
