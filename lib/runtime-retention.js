"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GIB = 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = 50 * GIB;
const SNAPSHOT_HEADROOM_BYTES = 20 * GIB;
const DEFAULT_COMPLETE_CYCLES = 7;
const DEFAULT_STALE_COMPLETE_RUNS = 2;

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) {
      try { total += fs.statSync(child).size; } catch {}
    }
  }
  return total;
}

function statFreeBytes(directory) {
  const statfs = fs.statfsSync || fs.statfs;
  if (!statfs) return null;
  try {
    const value = statfs(directory);
    return Number(value.bavail) * Number(value.bsize);
  } catch { return null; }
}

function requiredFreeBytes(databaseBytes, minimumFreeBytes = DEFAULT_MIN_FREE_BYTES) {
  return Math.max(minimumFreeBytes, (2 * Math.max(databaseBytes, 0)) + SNAPSHOT_HEADROOM_BYTES);
}

function diskSpacePreflight({ databasePath, runtimePath = ".", minimumFreeBytes = DEFAULT_MIN_FREE_BYTES } = {}) {
  let databaseBytes = 0;
  try { databaseBytes = fs.statSync(databasePath).size; } catch (error) {
    return { ok: false, code: "DISK_GUARD_DATABASE_UNREADABLE", freeBytes: null, requiredBytes: null, error: String(error?.message || error) };
  }
  // Small test/config databases cannot cause a material snapshot spike.
  if (databaseBytes < GIB) return { ok: true, skipped: "small_database", databaseBytes, freeBytes: statFreeBytes(runtimePath), requiredBytes: 0 };
  const freeBytes = statFreeBytes(runtimePath);
  const requiredBytes = requiredFreeBytes(databaseBytes, minimumFreeBytes);
  if (freeBytes === null) return { ok: false, code: "DISK_GUARD_STATFS_UNAVAILABLE", databaseBytes, freeBytes, requiredBytes };
  return { ok: freeBytes >= requiredBytes, code: freeBytes >= requiredBytes ? null : "DISK_GUARD_BLOCKED", databaseBytes, freeBytes, requiredBytes };
}

function completeCycleRows(root, kind) {
  const resolvedRoot = path.resolve(root);
  // Stale runs are stored below runtime/stale-weekly/runs. Keep accepting a
  // flat root for older installations and tests, but prefer the real run
  // directory whenever it exists.
  const enumerationRoot = kind === "stale" && fs.existsSync(path.join(resolvedRoot, "runs")) && fs.statSync(path.join(resolvedRoot, "runs")).isDirectory()
    ? path.join(resolvedRoot, "runs")
    : resolvedRoot;
  if (!fs.existsSync(enumerationRoot)) return [];
  return fs.readdirSync(enumerationRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const directory = path.join(enumerationRoot, entry.name);
    const state = kind === "stale" ? readJson(path.join(directory, "result.json")) : readJson(path.join(directory, "state.json"));
    const complete = kind === "stale" ? state?.status === "COMPLETED" : state?.state === "COMPLETE";
    if (!complete) return null;
    const updated = kind === "stale" ? state.finished_at || state.completed_at || state.created_at : state.updated_at || state.completed_at || state.created_at;
    return { name: entry.name, directory, updated: updated || "", bytes: directoryBytes(directory) };
  }).filter(Boolean).sort((a, b) => b.updated.localeCompare(a.updated) || b.name.localeCompare(a.name));
}

function supersededCycleRows(root) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];
  return fs.readdirSync(resolvedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const directory = path.join(resolvedRoot, entry.name);
    const state = readJson(path.join(directory, "state.json"));
    if (state?.failure?.superseded !== true) return null;
    return {
      name: entry.name,
      directory,
      updated: state.updated_at || state.failure.superseded_at || state.created_at || "",
      bytes: directoryBytes(directory),
      superseded: true,
      reason: state.failure.reason || "explicitly_superseded",
    };
  }).filter(Boolean).sort((a, b) => b.updated.localeCompare(a.updated) || b.name.localeCompare(a.name));
}

function containsGeneration(directory, generationId) {
  if (!generationId) return false;
  for (const name of ["state.json", "cycle.json", "publication-result.json", "publication-plan.json", "apply-result.json", "result.json", "run.json"]) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    try { if (fs.readFileSync(file, "utf8").includes(generationId)) return true; } catch {}
  }
  return false;
}

function isRecoveryEvidence(name) {
  return /(?:recovery|reconciliation|rollback|^b54-)/iu.test(name);
}

function retentionPlan({ maintenanceRoot, staleRoot, publicRepository, keepComplete = DEFAULT_COMPLETE_CYCLES, keepStaleComplete = DEFAULT_STALE_COMPLETE_RUNS } = {}) {
  const keepCycles = Number.isInteger(keepComplete) ? keepComplete : DEFAULT_COMPLETE_CYCLES;
  const keepStale = Number.isInteger(keepStaleComplete) ? keepStaleComplete : DEFAULT_STALE_COMPLETE_RUNS;
  const pointer = readJson(path.join(path.resolve(publicRepository || "."), "catalog/v1/current.json"));
  const generationId = pointer?.generation_id || null;
  const cycles = completeCycleRows(path.resolve(maintenanceRoot), "maintenance");
  const superseded = supersededCycleRows(path.resolve(maintenanceRoot));
  const stale = completeCycleRows(path.resolve(staleRoot), "stale");
  const cycleDelete = [
    ...cycles.slice(Math.max(keepCycles, 0)).filter((row) => !isRecoveryEvidence(row.name)),
    ...superseded,
  ].filter((row) => !containsGeneration(row.directory, generationId));
  const staleDelete = stale.slice(Math.max(keepStale, 0)).filter((row) => !containsGeneration(row.directory, generationId));
  const deleteDirectories = new Set([...cycleDelete, ...staleDelete].map((row) => row.directory));
  return {
    generationId,
    delete: [...cycleDelete, ...staleDelete],
    kept: [...cycles.slice(0, Math.max(keepCycles, 0)), ...stale.slice(0, Math.max(keepStale, 0))],
    skipped_referenced: [...cycles.slice(Math.max(keepCycles, 0)), ...superseded, ...stale.slice(Math.max(keepStale, 0))].filter((row) => !deleteDirectories.has(row.directory) && (isRecoveryEvidence(row.name) || containsGeneration(row.directory, generationId))),
  };
}

function applyRetention(plan) {
  const deleted = [];
  for (const row of plan.delete || []) {
    if (!fs.existsSync(row.directory)) continue;
    fs.rmSync(row.directory, { recursive: true, force: false });
    deleted.push(row);
  }
  return { ...plan, delete: plan.delete || [], deleted };
}

module.exports = {
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_COMPLETE_CYCLES,
  DEFAULT_STALE_COMPLETE_RUNS,
  SNAPSHOT_HEADROOM_BYTES,
  applyRetention,
  diskSpacePreflight,
  requiredFreeBytes,
  retentionPlan,
};
