"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GIB = 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = 50 * GIB;
const SNAPSHOT_HEADROOM_BYTES = 20 * GIB;
const DEFAULT_COMPLETE_CYCLES = 7;
const DEFAULT_STALE_COMPLETE_RUNS = 2;
const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_TERMINAL_STATES = Object.freeze(["COMPLETE", "NO_ELIGIBLE_ITEMS"]);
const STALE_TERMINAL_STATUSES = Object.freeze(["COMPLETED", "NO_CHANGES"]);
const REFERENCE_FILES = Object.freeze([
  "state.json",
  "result.json",
  "run.json",
  "cycle.json",
  "plan.json",
  "publication-plan.json",
  "publication-result.json",
  "apply-result.json",
  "authorization.json",
  "failure.json",
  "publication-cycle/state.json",
  "publication-cycle/result.json",
  "publication-cycle/run.json",
  "publication-cycle/cycle.json",
  "publication-cycle/plan.json",
  "publication-cycle/publication-plan.json",
  "publication-cycle/publication-result.json",
  "publication-cycle/apply-result.json",
  "publication-cycle/authorization.json",
  "publication-cycle/failure.json",
  "publication-candidate/catalog/v1/current.json",
  "publication-cycle/publication-candidate/catalog/v1/current.json",
]);

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function readReferenceText(directory) {
  let text = "";
  for (const relative of REFERENCE_FILES) {
    const file = path.join(directory, relative);
    try {
      if (fs.existsSync(file)) text += "\n" + fs.readFileSync(file, "utf8");
    } catch {}
  }
  return text;
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

function staleMetadata(directory) {
  const result = readJson(path.join(directory, "result.json"));
  const failure = readJson(path.join(directory, "failure.json"));
  const publicationState = readJson(path.join(directory, "publication-cycle", "state.json"));
  const run = readJson(path.join(directory, "run.json"));
  const status = result?.status || null;
  const state = publicationState?.state || null;
  const terminal = !failure && (STALE_TERMINAL_STATUSES.includes(status) || state === "COMPLETE");
  if (!terminal) return null;
  return {
    status,
    state,
    updated: result?.finished_at || result?.completed_at || publicationState?.updated_at || publicationState?.completed_at || publicationState?.created_at || run?.created_at || "",
  };
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
    if (kind === "stale") {
      const metadata = staleMetadata(directory);
      if (!metadata) return null;
      return { name: entry.name, directory, updated: metadata.updated, status: metadata.status, state: metadata.state, bytes: directoryBytes(directory) };
    }
    const state = readJson(path.join(directory, "state.json"));
    if (!MAINTENANCE_TERMINAL_STATES.includes(state?.state)) return null;
    return { name: entry.name, directory, updated: state.updated_at || state.completed_at || state.created_at || "", state: state.state, bytes: directoryBytes(directory) };
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

function uniqueRows(rows) {
  return [...new Map(rows.map((row) => [row.directory, row])).values()];
}

function retentionCutoff(now, retentionDays) {
  if (retentionDays === null || retentionDays === undefined) return null;
  if (!Number.isInteger(retentionDays) || retentionDays < 0) throw new Error("RETENTION_DAYS_INVALID");
  const nowMs = Date.parse(now || new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error("RETENTION_NOW_INVALID");
  return nowMs - (retentionDays * DAY_MS);
}

function olderThanCutoff(row, cutoff) {
  if (cutoff === null) return false;
  const updatedMs = Date.parse(row.updated || "");
  return Number.isFinite(updatedMs) && updatedMs < cutoff;
}

function containsGeneration(directory, generationId) {
  if (!generationId) return false;
  return directory.includes(generationId) || readReferenceText(directory).includes(generationId);
}

function referencedCycleNames(roots, candidateRows) {
  const candidates = new Map(candidateRows.map((row) => [row.name, row.directory]));
  const referenced = new Set();
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot)) continue;
    for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDirectory = path.join(resolvedRoot, entry.name);
      const text = readReferenceText(sourceDirectory);
      for (const [name, directory] of candidates) {
        if (directory !== sourceDirectory && text.includes(name)) referenced.add(name);
      }
    }
  }
  return referenced;
}

function retentionPlan({ maintenanceRoot, staleRoot, publicRepository, keepComplete = DEFAULT_COMPLETE_CYCLES, keepStaleComplete = DEFAULT_STALE_COMPLETE_RUNS, retentionDays = null, now = new Date().toISOString() } = {}) {
  const keepCycles = Number.isInteger(keepComplete) ? keepComplete : DEFAULT_COMPLETE_CYCLES;
  const keepStale = Number.isInteger(keepStaleComplete) ? keepStaleComplete : DEFAULT_STALE_COMPLETE_RUNS;
  const cutoff = retentionCutoff(now, retentionDays);
  const pointer = readJson(path.join(path.resolve(publicRepository || "."), "catalog/v1/current.json"));
  const generationId = pointer?.generation_id || null;
  const cycles = completeCycleRows(path.resolve(maintenanceRoot), "maintenance");
  const superseded = supersededCycleRows(path.resolve(maintenanceRoot));
  const stale = completeCycleRows(path.resolve(staleRoot), "stale");
  const allRows = uniqueRows([...cycles, ...superseded, ...stale]);
  const referenced = referencedCycleNames([maintenanceRoot, staleRoot], allRows);
  const protectedRows = allRows.filter((row) => referenced.has(row.name) || containsGeneration(row.directory, generationId));
  // A missing pointer is a safety failure: never prune without knowing which
  // published generation must remain available.
  if (!generationId) {
    return { generationId: null, pointer_unavailable: true, delete: [], kept: [], skipped_referenced: protectedRows };
  }
  const safeCycles = cycles.filter((row) => !referenced.has(row.name) && !containsGeneration(row.directory, generationId));
  const safeSuperseded = superseded.filter((row) => !referenced.has(row.name) && !containsGeneration(row.directory, generationId));
  const safeStale = stale.filter((row) => !referenced.has(row.name) && !containsGeneration(row.directory, generationId));
  const keptCycles = cutoff === null
    ? safeCycles.slice(0, Math.max(keepCycles, 0))
    : safeCycles.filter((row) => !olderThanCutoff(row, cutoff));
  const cycleDelete = cutoff === null
    ? uniqueRows([...safeSuperseded, ...safeCycles.slice(Math.max(keepCycles, 0))])
    : uniqueRows([...safeSuperseded, ...safeCycles.filter((row) => olderThanCutoff(row, cutoff))]);
  const keptStale = cutoff === null
    ? safeStale.slice(0, Math.max(keepStale, 0))
    : safeStale.filter((row) => !olderThanCutoff(row, cutoff));
  const staleDelete = cutoff === null
    ? safeStale.slice(Math.max(keepStale, 0))
    : safeStale.filter((row) => olderThanCutoff(row, cutoff));
  const deleteDirectories = new Set([...cycleDelete, ...staleDelete].map((row) => row.directory));
  return {
    generationId,
    delete: [...cycleDelete, ...staleDelete],
    kept: [...keptCycles, ...keptStale],
    skipped_referenced: [...protectedRows, ...allRows.filter((row) => !deleteDirectories.has(row.directory) && !protectedRows.includes(row) && !keptCycles.includes(row) && !keptStale.includes(row))],
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
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STALE_COMPLETE_RUNS,
  MAINTENANCE_TERMINAL_STATES,
  SNAPSHOT_HEADROOM_BYTES,
  STALE_TERMINAL_STATUSES,
  applyRetention,
  diskSpacePreflight,
  requiredFreeBytes,
  retentionPlan,
};
