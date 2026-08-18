const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { readCounts, schemaVersion } = require("./unclassified-purge");

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function physicalState(filePath, database) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    sha256: await sha256File(filePath),
    page_count: database.pragma("page_count", { simple: true }),
    page_size: database.pragma("page_size", { simple: true }),
    freelist_count: database.pragma("freelist_count", { simple: true }),
  };
}

function assertExpected(database, expected) {
  if (database.pragma("quick_check", { simple: true }) !== "ok") throw new Error("compaction-source-quick-check-failed");
  if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("compaction-source-foreign-key-failed");
  if (expected.schema_version !== undefined && schemaVersion(database) !== expected.schema_version) throw new Error("compaction-schema-drift");
  const actual = readCounts(database);
  for (const [key, value] of Object.entries(expected.counts || expected)) {
    if (actual[key] !== value) throw new Error(`compaction-count-drift:${key}:${actual[key]}!=${value}`);
  }
  return actual;
}

function vacuumInto(database, destination) {
  const escaped = destination.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escaped}'`);
}

async function compactCatalog(options) {
  const databasePath = path.resolve(options.databasePath);
  const outputDir = path.resolve(options.outputDir);
  const compactPath = path.resolve(options.compactPath || path.join(outputDir, "catalog.sqlite.compact"));
  if (compactPath === databasePath) throw new Error("compact-path-equals-database");
  if (fs.existsSync(compactPath)) throw new Error("compact-output-exists");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
  const expected = options.expected || {};
  const source = openCatalogDatabase(databasePath, { fileMustExist: true });
  let before;
  let physicalBefore;
  try {
    before = assertExpected(source, expected);
    physicalBefore = await physicalState(databasePath, source);
    vacuumInto(source, compactPath);
  } finally { source.close(); }
  const compact = openCatalogDatabase(compactPath, { readonly: true, fileMustExist: true });
  let after;
  let physicalAfter;
  try {
    after = assertExpected(compact, expected);
    physicalAfter = await physicalState(compactPath, compact);
  } finally { compact.close(); }
  let replacement = null;
  if (options.replace) {
    if (!options.maintenanceConfirmed) throw new Error("maintenance-confirmation-required");
    const runId = options.runId || new Date().toISOString().replace(/[:.]/g, "-");
    const oldPath = `${databasePath}.precompact-${runId}`;
    if (fs.existsSync(oldPath)) throw new Error("precompact-path-exists");
    const movedSidecars = [];
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        const destination = path.join(outputDir, `catalog.sqlite${suffix}.precompact-${runId}`);
        fs.renameSync(sidecar, destination);
        movedSidecars.push({ sidecar, destination });
      }
    }
    fs.renameSync(databasePath, oldPath);
    try {
      fs.renameSync(compactPath, databasePath);
      replacement = { old_path: oldPath, compact_path: compactPath, moved_sidecars: movedSidecars };
    } catch (error) {
      fs.renameSync(oldPath, databasePath);
      for (const item of movedSidecars.reverse()) fs.renameSync(item.destination, item.sidecar);
      throw error;
    }
  }
  return { database_path: databasePath, compact_path: compactPath, before, after, physical_before: physicalBefore, physical_after: physicalAfter, replacement };
}

module.exports = { compactCatalog, physicalState, sha256File };
