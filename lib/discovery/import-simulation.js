"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createPathGuard, atomicWriteJson, appendLog, readJson, acquireLock, releaseLock } = require("./staging-store");
const ACTIONS = Object.freeze({ PLAN_INSERT: "WOULD_INSERT", SKIP_ALREADY_ACTIVE: "WOULD_SKIP_ACTIVE", REVIEW_INACTIVE: "WOULD_REQUIRE_REVIEW", BLOCK_CONFLICT: "BLOCKED", SKIP_NOT_ELIGIBLE: "BLOCKED", BLOCK_INVALID: "BLOCKED" });
const SAFETY = Object.freeze({ simulation_only: true, catalog_read_only: true, sql_executed: false, sqlite_write_performed: false, import_performed: false, reactivation_performed: false, deactivation_performed: false, reconciliation_performed: false, publication_performed: false });
const REQUIRED_FIELDS = Object.freeze(["ident", "original_name", "normalized_name", "first_seen_at", "last_seen_at", "parse_version", "raw_json"]);
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
const digest = (v) => crypto.createHash("sha256").update(stable(v)).digest("hex");
const validIdent = (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf8") <= 256;

function createSimulationConfig({ root, planRecords, sourcePlanDigest, catalogSnapshotDigest, limits = {} } = {}) {
  if (!Array.isArray(planRecords) || planRecords.length > 10000 || planRecords.some((r) => !r || !validIdent(r.ident) || typeof r.planned_action !== "string" || !ACTIONS[r.planned_action] || typeof r.reason !== "string" || typeof r.catalog_snapshot_digest !== "string") || new Set(planRecords.map((r) => r.ident)).size !== planRecords.length) throw new Error("invalid simulation input");
  if (typeof sourcePlanDigest !== "string" || typeof catalogSnapshotDigest !== "string") throw new Error("simulation digests required");
  const resolved = path.resolve(root); if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
  const paths = { root: resolved, records: path.join(resolved, "simulation.json"), readiness: path.join(resolved, "schema-readiness.json"), sql: path.join(resolved, "sql-plan.json"), manifest: path.join(resolved, "simulation.manifest.json"), checkpoint: path.join(resolved, "simulation.checkpoint.json"), log: path.join(resolved, "simulation.log"), lock: path.join(resolved, "simulation.lock") };
  const boundedLimits = { maxRecords: limits.maxRecords ?? 25, maxDurationMs: limits.maxDurationMs ?? 60000 };
  if (!Number.isSafeInteger(boundedLimits.maxRecords) || boundedLimits.maxRecords < 1 || boundedLimits.maxRecords > 10000 || !Number.isSafeInteger(boundedLimits.maxDurationMs) || boundedLimits.maxDurationMs < 1) throw new Error("invalid simulation limits");
  return Object.freeze({ paths, records: Object.freeze(planRecords), sourcePlanDigest, catalogSnapshotDigest, limits: Object.freeze(boundedLimits), inputDigest: digest(planRecords), configurationDigest: digest({ limits: boundedLimits, sourcePlanDigest }) });
}

function runImportSimulation(config, { resume = false } = {}) {
  const guard = createPathGuard(config.paths.root), runId = crypto.randomUUID(), started = new Date().toISOString();
  let index = 0, results = [], readiness = [], counters = { would_insert: 0, would_skip_active: 0, would_require_review: 0, blocked: 0, insert_ready: 0, missing_required_fields: 0, schema_conflict: 0 };
  if (resume) {
    const checkpoint = readJson(config.paths.checkpoint, guard, "simulation checkpoint"), manifest = readJson(config.paths.manifest, guard, "simulation manifest"), records = readJson(config.paths.records, guard, "simulation records");
    if (checkpoint.input_digest !== config.inputDigest || checkpoint.configuration_digest !== config.configurationDigest || checkpoint.catalog_snapshot_digest !== config.catalogSnapshotDigest || manifest.input_digest !== config.inputDigest || manifest.configuration_digest !== config.configurationDigest || manifest.catalog_snapshot_digest !== config.catalogSnapshotDigest || !Array.isArray(records.records) || Object.keys(SAFETY).some((key) => checkpoint[key] !== SAFETY[key] || manifest[key] !== SAFETY[key])) throw new Error("simulation resume mismatch");
    index = checkpoint.next_index; results = records.records; counters = checkpoint.counters;
  }
  const lock = acquireLock(config.paths.lock, runId, guard);
  try {
    while (index < config.records.length) {
      if (index >= config.limits.maxRecords || Date.now() - Date.parse(started) >= config.limits.maxDurationMs) break;
      const record = config.records[index++], simulationAction = ACTIONS[record.planned_action], ready = record.planned_action === "PLAN_INSERT" ? (REQUIRED_FIELDS.length === 1 ? "INSERT_READY" : "MISSING_REQUIRED_FIELDS") : "INSERT_READY";
      if (simulationAction === "WOULD_INSERT") counters.would_insert++; else if (simulationAction === "WOULD_SKIP_ACTIVE") counters.would_skip_active++; else if (simulationAction === "WOULD_REQUIRE_REVIEW") counters.would_require_review++; else counters.blocked++;
      if (simulationAction === "WOULD_INSERT") { if (ready === "INSERT_READY") counters.insert_ready++; else counters.missing_required_fields++; }
      const out = { ident: record.ident, planned_action: record.planned_action, simulation_action: simulationAction, reason: record.reason, catalog_snapshot_digest: record.catalog_snapshot_digest, simulated_at: new Date().toISOString() };
      results.push(out); readiness.push({ ident: record.ident, readiness: ready, missing_required_fields: ready === "MISSING_REQUIRED_FIELDS" ? REQUIRED_FIELDS.slice(1) : [], schema_conflict: false }); appendLog(config.paths.log, JSON.stringify({ at: out.simulated_at, index, simulation_action: simulationAction }), guard);
    }
    const manifest = { ...SAFETY, run_id: runId, source_plan_digest: config.sourcePlanDigest, catalog_snapshot_digest: config.catalogSnapshotDigest, total_input: config.records.length, processed: results.length, would_insert: counters.would_insert, would_skip_active: counters.would_skip_active, would_require_review: counters.would_require_review, blocked: counters.blocked, insert_ready: counters.insert_ready, missing_required_fields: counters.missing_required_fields, schema_conflict: counters.schema_conflict, finished_reason: results.length === config.records.length ? "completed" : "limit_reached", input_digest: config.inputDigest, configuration_digest: config.configurationDigest };
    atomicWriteJson(config.paths.records, { schema_version: 1, run_id: runId, records: results }, guard); atomicWriteJson(config.paths.readiness, { schema_version: 1, run_id: runId, required_fields: REQUIRED_FIELDS, records: readiness }, guard); atomicWriteJson(config.paths.sql, { schema_version: 1, run_id: runId, statement_template: "INSERT INTO files (ident, original_name, normalized_name, first_seen_at, last_seen_at, parse_version, raw_json) VALUES (:ident, :original_name, :normalized_name, :first_seen_at, :last_seen_at, :parse_version, :raw_json)", parameter_names: REQUIRED_FIELDS, record_count: counters.would_insert, transaction_boundaries: "none; simulation only", conflict_behavior: "not executed" }, guard); atomicWriteJson(config.paths.manifest, manifest, guard); atomicWriteJson(config.paths.checkpoint, { schema_version: 1, ...SAFETY, run_id: runId, next_index: index, processed: results.length, counters, input_digest: config.inputDigest, configuration_digest: config.configurationDigest, catalog_snapshot_digest: config.catalogSnapshotDigest, finished_reason: manifest.finished_reason }, guard);
    return manifest;
  } finally { releaseLock(config.paths.lock, lock, guard); }
}

module.exports = { ACTIONS, SAFETY, REQUIRED_FIELDS, createSimulationConfig, runImportSimulation, digest, stable };
