const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CATALOG_MANIFEST_SCHEMA_VERSION = 2;
const FULL_RECONCILIATION_ENV = "CATALOG_ALLOW_FULL_RECONCILIATION";
const RUN_STATUSES = Object.freeze({
  RUNNING: "running",
  COMPLETE: "complete",
  COMPLETE_WITH_FAILURES: "complete_with_failures",
  INCOMPLETE: "incomplete",
  ABORTED: "aborted",
  RECOVERY_REQUIRED: "recovery_required",
});

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function fileFingerprint(inputPath, stat = fs.statSync(inputPath)) {
  const descriptor = fs.openSync(inputPath, "r");
  try {
    const chunkSize = Math.min(65536, stat.size);
    const first = Buffer.alloc(chunkSize);
    const last = Buffer.alloc(chunkSize);
    fs.readSync(descriptor, first, 0, chunkSize, 0);
    fs.readSync(descriptor, last, 0, chunkSize, Math.max(0, stat.size - chunkSize));
    return crypto
      .createHash("sha256")
      .update(String(stat.size))
      .update(":")
      .update(String(Math.trunc(stat.mtimeMs)))
      .update(first)
      .update(last)
      .digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readCatalogManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Manifest sa nepodarilo načítať: ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Manifest nemá objektový JSON formát: ${manifestPath}`);
  }
  return manifest;
}

function validateManifestSource(manifest, manifestPath, inputPath, stat, options = {}) {
  if (!manifest.success) {
    throw new Error(`Manifest nepotvrdzuje úspešné dokončenie procesu: ${manifestPath}`);
  }
  if (Number(manifest.source_size) !== stat.size) {
    throw new Error(`Veľkosť JSONL nesedí s manifestom: ${manifestPath}`);
  }

  const schemaVersion = Number(manifest.schema_version || 1);
  if (options.requireCurrentSchema && schemaVersion !== CATALOG_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Full reconciliation vyžaduje manifest schémy ${CATALOG_MANIFEST_SCHEMA_VERSION}: ${manifestPath}`
    );
  }

  if (schemaVersion >= CATALOG_MANIFEST_SCHEMA_VERSION) {
    if (!manifest.source_fingerprint) {
      throw new Error(`Manifest neobsahuje source_fingerprint: ${manifestPath}`);
    }
    const actualFingerprint = fileFingerprint(inputPath, stat);
    if (manifest.source_fingerprint !== actualFingerprint) {
      throw new Error(`Fingerprint JSONL nesedí s manifestom: ${manifestPath}`);
    }
    if (!Number.isSafeInteger(Number(manifest.items)) || Number(manifest.items) < 0) {
      throw new Error(`Manifest neobsahuje platný počet items: ${manifestPath}`);
    }
  }

  return manifest;
}

function loadAndValidateCatalogManifest(manifestPath, inputPath, stat, options = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  if (!fs.existsSync(resolvedManifestPath)) {
    throw new Error(`Chýba manifest: ${resolvedManifestPath}`);
  }
  const manifest = readCatalogManifest(resolvedManifestPath);
  return validateManifestSource(
    manifest,
    resolvedManifestPath,
    path.resolve(inputPath),
    stat,
    options
  );
}

function isFullReconciliationEnabled(env = process.env) {
  return normalizeBoolean(env[FULL_RECONCILIATION_ENV], false);
}

function isManifestReconciliationSafe(manifest) {
  return (
    normalizeBoolean(manifest?.shadow_mode, false) !== true &&
    manifest?.run_status === RUN_STATUSES.COMPLETE &&
    manifest?.reconciliation_safe === true &&
    manifest?.is_full === true &&
    Number(manifest?.failed_prefixes) === 0
  );
}

function canRunFullReconciliation(manifest, env = process.env) {
  return isManifestReconciliationSafe(manifest) && isFullReconciliationEnabled(env);
}

function assertFullReconciliationAllowed(options, manifest, manifestPath) {
  if (normalizeBoolean(manifest?.shadow_mode, false) === true) {
    throw new Error(
      `Shadow manifest je vždy zablokovaný pre deaktiváciu súborov: ${manifestPath}`
    );
  }
  if (!options.allowDeactivation) {
    throw new Error(
      "Full reconciliation je zablokovaný: chýba explicitný prepínač --allow-deactivation."
    );
  }
  if (!isFullReconciliationEnabled(options.env || process.env)) {
    throw new Error(
      `Full reconciliation je zablokovaný: ${FULL_RECONCILIATION_ENV}=true nie je nastavené.`
    );
  }
  if (!isManifestReconciliationSafe(manifest)) {
    throw new Error(`Manifest nie je bezpečný pre deaktiváciu súborov: ${manifestPath}`);
  }
}

function assertSourceIsNotShadow(inputPath, manifestPath = null) {
  const resolvedInput = path.resolve(inputPath);
  const candidates = new Set();
  if (manifestPath) candidates.add(path.resolve(manifestPath));
  let current = path.dirname(resolvedInput);
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.add(path.join(current, "catalog-items.manifest.json"));
    candidates.add(path.join(current, "shadow-report.json"));
    candidates.add(path.join(current, "report.json"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (normalizeBoolean(value?.shadow_mode, false) === true) {
        throw new Error(
          `Shadow JSONL nemožno regenerovať na full manifest: ${resolvedInput}`
        );
      }
    } catch (error) {
      if (/Shadow JSONL/.test(error.message)) throw error;
      throw new Error(
        `Shadow provenance guard nevie bezpečne prečítať ${candidate}: ${error.message}`
      );
    }
  }
}

function buildUnverifiedCrawlerManifest({ inputPath, stat, items, failedPrefixes }) {
  const failureCount = Number(failedPrefixes) || 0;
  const runStatus = failureCount > 0
    ? RUN_STATUSES.COMPLETE_WITH_FAILURES
    : RUN_STATUSES.INCOMPLETE;
  return {
    schema_version: CATALOG_MANIFEST_SCHEMA_VERSION,
    success: true,
    run_status: runStatus,
    is_full: false,
    reconciliation_safe: false,
    completeness_reason: failureCount > 0
      ? "failed_prefixes_and_unverified_prefix_strategy"
      : "prefix_strategy_not_verified",
    generated_at: new Date().toISOString(),
    source_path: inputPath,
    source_size: stat.size,
    source_mtime_ms: Math.trunc(stat.mtimeMs),
    source_fingerprint: fileFingerprint(inputPath, stat),
    items,
    failed_prefixes: failureCount,
  };
}

function buildManuallyConfirmedManifest({ inputPath, stat, items }) {
  return {
    schema_version: CATALOG_MANIFEST_SCHEMA_VERSION,
    success: true,
    run_status: RUN_STATUSES.COMPLETE,
    is_full: true,
    reconciliation_safe: true,
    completeness_reason: "manually_confirmed_external_validation",
    generated_at: new Date().toISOString(),
    source_path: inputPath,
    source_size: stat.size,
    source_mtime_ms: Math.trunc(stat.mtimeMs),
    source_fingerprint: fileFingerprint(inputPath, stat),
    items,
    failed_prefixes: 0,
    manually_confirmed: true,
  };
}

module.exports = {
  CATALOG_MANIFEST_SCHEMA_VERSION,
  FULL_RECONCILIATION_ENV,
  RUN_STATUSES,
  assertFullReconciliationAllowed,
  assertSourceIsNotShadow,
  buildManuallyConfirmedManifest,
  buildUnverifiedCrawlerManifest,
  canRunFullReconciliation,
  fileFingerprint,
  isFullReconciliationEnabled,
  isManifestReconciliationSafe,
  loadAndValidateCatalogManifest,
  normalizeBoolean,
  readCatalogManifest,
  validateManifestSource,
};
