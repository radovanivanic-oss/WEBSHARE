"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openCatalogDatabase } = require("../../src/db/catalog-db");
const { createPathGuard, atomicWriteJson, appendLog, readJson } = require("./staging-store");

const CLASSIFICATIONS = Object.freeze(["NEW_CANDIDATE", "ALREADY_ACTIVE", "ALREADY_INACTIVE", "CATALOG_CONFLICT", "NOT_ELIGIBLE", "INVALID_INPUT"]);
const SAFETY = Object.freeze({ classification_only: true, catalog_read_only: true, sqlite_write_performed: false, import_performed: false, reactivation_performed: false, deactivation_performed: false, reconciliation_performed: false, publication_performed: false });
const now = () => new Date().toISOString();
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validIdent = (v) => typeof v === "string" && v.length > 0 && v.length <= 1024;

function createReadOnlyCatalogLookup(databasePath) {
  if (typeof databasePath !== "string" || !path.isAbsolute(databasePath)) throw new TypeError("databasePath must be absolute");
  const db = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  if (db.readonly !== true) { db.close(); throw new Error("read-only enforcement could not be proven"); }
  const query = db.prepare("SELECT ident, is_active FROM files WHERE ident = ? ORDER BY id");
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name").all();
  const counts = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END),0) AS active, COALESCE(SUM(CASE WHEN is_active=0 THEN 1 ELSE 0 END),0) AS inactive FROM files").get();
  function snapshotIdentity() {
    const stat = fs.statSync(databasePath);
    return { schema, counts, database_size: stat.size, database_mtime_ms: stat.mtimeMs, database_ctime_ms: stat.ctimeMs, database_inode: stat.ino };
  }
  return Object.freeze({
    lookupIdent(ident) {
      if (!validIdent(ident)) throw new TypeError("invalid ident");
      const rows = query.all(ident);
      return { ident, match_count: rows.length, states: rows.map((r) => r.is_active === 1 ? "active" : r.is_active === 0 ? "inactive" : String(r.is_active)) };
    },
    snapshotIdentity,
    close() { db.close(); },
  });
}

function createConfig({ root, candidates, lookup, limits = {} }) {
  if (!lookup || typeof lookup.lookupIdent !== "function" || typeof lookup.snapshotIdentity !== "function") throw new TypeError("read-only lookup port required");
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const paths = { checkpoint: path.join(root, "checkpoint.json"), manifest: path.join(root, "manifest.json"), records: path.join(root, "classification.json"), log: path.join(root, "classification.log") };
  return { root: path.resolve(root), paths, candidates, lookup, limits: { maxCandidates: 1000, maxCatalogQueries: 1000, maxDurationMs: 60000, ...limits } };
}

function inputDigest(candidates) { return digest((Array.isArray(candidates) ? candidates : []).map((c) => c && ({ ident: c.ident, decision: c.decision, reason: c.reason, decision_timestamp: c.decision_timestamp, evidence_digest: c.evidence_digest }))); }
function configDigest(config) { return digest({ maxCandidates: config.limits.maxCandidates, maxCatalogQueries: config.limits.maxCatalogQueries, maxDurationMs: config.limits.maxDurationMs }); }

function runCatalogClassification(config, options = {}) {
  const guard = createPathGuard(config.root);
  const input = Array.isArray(config.candidates) ? config.candidates : [];
  const inDigest = inputDigest(input); const cfgDigest = configDigest(config);
  const snapDigest = digest(config.lookup.snapshotIdentity());
  let index = 0; let records = []; let counters = Object.fromEntries(CLASSIFICATIONS.map((k) => [k.toLowerCase(), 0])); let queries = 0; const started = Date.now();
  if (options.resume) {
    const cp = readJson(config.paths.checkpoint, guard, "classification checkpoint"); const mf = readJson(config.paths.manifest, guard, "classification manifest"); const rs = readJson(config.paths.records, guard, "classification snapshot");
    if (cp.input_digest !== inDigest || cp.configuration_digest !== cfgDigest || cp.catalog_snapshot_digest !== snapDigest || mf.input_digest !== inDigest || mf.configuration_digest !== cfgDigest || mf.catalog_snapshot_digest !== snapDigest || !Array.isArray(rs.records) || Object.keys(SAFETY).some((key) => cp[key] !== SAFETY[key] || mf[key] !== SAFETY[key])) throw new Error("classification resume state mismatch");
    index = cp.next_candidate_index; records = rs.records; counters = cp.counters; queries = cp.catalog_queries;
    const recomputed = Object.fromEntries(CLASSIFICATIONS.map((k) => [k.toLowerCase(), 0])); records.forEach((r) => { if (!r || !CLASSIFICATIONS.includes(r.classification)) throw new Error("classification snapshot schema mismatch"); recomputed[r.classification.toLowerCase()]++; });
    if (JSON.stringify(recomputed) !== JSON.stringify(counters) || cp.processed_count !== records.length || mf.processed !== records.length) throw new Error("classification counters mismatch");
  }
  function persist(finishedReason = null) {
    const processed = records.length; const manifest = { ...SAFETY, total_input: input.length, processed, remaining: Math.max(0, input.length - index), new_candidate: counters.new_candidate || 0, already_active: counters.already_active || 0, already_inactive: counters.already_inactive || 0, catalog_conflict: counters.catalog_conflict || 0, not_eligible: counters.not_eligible || 0, invalid_input: counters.invalid_input || 0, catalog_queries: queries, processing_duration: Date.now() - started, catalog_snapshot_digest: snapDigest, input_digest: inDigest, configuration_digest: cfgDigest, finished_reason: finishedReason };
    atomicWriteJson(config.paths.records, { schema_version: 1, records }, guard); atomicWriteJson(config.paths.manifest, manifest, guard); atomicWriteJson(config.paths.checkpoint, { schema_version: 1, ...SAFETY, next_candidate_index: index, processed_count: processed, remaining_count: Math.max(0, input.length - index), counters, catalog_queries: queries, input_digest: inDigest, configuration_digest: cfgDigest, catalog_snapshot_digest: snapDigest, run_state: finishedReason ? "finished" : "running", finished_reason: finishedReason, cumulative_timing_ms: Date.now() - started }, guard); return manifest;
  }
  let reason = "completed";
  while (index < input.length) {
    if (index >= config.limits.maxCandidates) { reason = "max_candidates"; break; }
    if (Date.now() - started >= config.limits.maxDurationMs) { reason = "max_duration"; break; }
    const candidate = input[index++]; let out;
    if (!candidate || !validIdent(candidate.ident) || typeof candidate.decision !== "string") { out = { ident: candidate && candidate.ident || null, classification: "INVALID_INPUT", reason: "malformed_candidate", decision: candidate && candidate.decision || null, evidence_digest: candidate && candidate.evidence_digest || null, catalog_match_count: 0, catalog_state: null, classified_at: now(), catalog_snapshot_digest: snapDigest }; }
    else if (candidate.decision !== "ELIGIBLE") { out = { ident: candidate.ident, classification: "NOT_ELIGIBLE", reason: "upstream_not_eligible", decision: candidate.decision, evidence_digest: candidate.evidence_digest || null, catalog_match_count: 0, catalog_state: null, classified_at: now(), catalog_snapshot_digest: snapDigest }; }
    else if (queries >= config.limits.maxCatalogQueries) { index--; reason = "max_catalog_queries"; break; }
    else { queries++; let result; try { result = config.lookup.lookupIdent(candidate.ident); } catch { result = null; }
      let classification = "CATALOG_CONFLICT"; let why = "malformed_catalog_result"; let state = null; const count = result && Number.isInteger(result.match_count) ? result.match_count : 0;
      if (result && count === 0 && Array.isArray(result.states)) { classification = "NEW_CANDIDATE"; why = "ident_absent"; }
      else if (result && count === 1 && Array.isArray(result.states) && result.states[0] === "active") { classification = "ALREADY_ACTIVE"; why = "active_match"; state = "active"; }
      else if (result && count === 1 && Array.isArray(result.states) && result.states[0] === "inactive") { classification = "ALREADY_INACTIVE"; why = "inactive_match"; state = "inactive"; }
      out = { ident: candidate.ident, classification, reason: why, decision: candidate.decision, evidence_digest: candidate.evidence_digest || null, catalog_match_count: count, catalog_state: state, classified_at: now(), catalog_snapshot_digest: snapDigest };
    }
    counters[out.classification.toLowerCase()]++; records.push(out); appendLog(config.paths.log, JSON.stringify({ timestamp: now(), index, classification: out.classification }), guard); persist(null);
  }
  return persist(reason);
}

module.exports = { CLASSIFICATIONS, SAFETY, createReadOnlyCatalogLookup, createCatalogClassificationConfig: createConfig, inputDigest, configDigest, runCatalogClassification };
