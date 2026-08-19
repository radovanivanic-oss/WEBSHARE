"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const Database = require("better-sqlite3");

const PROVENANCE_SCHEMA_VERSION = 1;
const PURGED_SIDECAR_KIND = "B39_PURGED_IDENT_SET";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function digestIdents(idents) {
  return sha256((idents || []).join("\n"));
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, filePath);
}

function openReadonly(databasePath) {
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function assertQuickCheck(database, label) {
  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error(`${label}_QUICK_CHECK_FAILED:${quickCheck}`);
  const foreignKeys = database.pragma("foreign_key_check");
  if (foreignKeys.length) throw new Error(`${label}_FOREIGN_KEY_CHECK_FAILED:${foreignKeys.length}`);
}

function countFiles(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM files").get().count;
}

function planDigest(plan) {
  const copy = { ...plan };
  delete copy.created_at;
  delete copy.plan_sha256;
  return sha256(copy);
}

function validateDailyPlan(plan, { allowDigestMismatch = false } = {}) {
  if (!plan || !Array.isArray(plan.discovery_delta)) throw new Error("INVALID_DAILY_PLAN");
  if (!plan.plan_sha256 && !allowDigestMismatch) throw new Error("DAILY_PLAN_DIGEST_MISSING");
  if (plan.plan_sha256 && planDigest(plan) !== plan.plan_sha256 && !allowDigestMismatch) throw new Error("DAILY_PLAN_DIGEST_MISMATCH");
  const idents = plan.discovery_delta.map((record) => record.ident);
  if (idents.some((ident) => typeof ident !== "string" || !ident)) throw new Error("DAILY_PLAN_INVALID_IDENT");
  if (new Set(idents).size !== idents.length) throw new Error("DAILY_PLAN_DUPLICATE_IDENT");
  return plan;
}

function readJsonlCandidates(filePath, candidateIdents) {
  return (async () => {
    const found = new Set();
    let lines = 0;
    let parseErrors = 0;
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      lines += 1;
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const ident = String(item.ident || item.id || "");
        if (candidateIdents.has(ident)) found.add(ident);
      } catch {
        parseErrors += 1;
      }
    }
    return { file: filePath, lines, found, parseErrors };
  })();
}

function classifyCurrentAndB39({ plan, currentDatabasePath, b39DatabasePath }) {
  const current = openReadonly(currentDatabasePath);
  const b39 = openReadonly(b39DatabasePath);
  try {
    assertQuickCheck(current, "CURRENT_DATABASE");
    assertQuickCheck(b39, "B39_DATABASE");
    const currentLookup = current.prepare("SELECT id, media_id, is_active FROM files WHERE ident = ?");
    const b39Lookup = b39.prepare(`
      SELECT f.id AS file_id, f.ident, f.original_name, f.media_id,
             f.parse_confidence, f.parse_reason, f.parse_version,
             m.category, m.media_type, m.title, m.year, m.classifier_version
      FROM files f LEFT JOIN media m ON m.id = f.media_id WHERE f.ident = ?
    `);
    const records = [];
    for (const record of plan.discovery_delta) {
      const currentRow = currentLookup.get(record.ident) || null;
      const historicalRow = b39Lookup.get(record.ident) || null;
      records.push({
        ident: record.ident,
        action: record.action,
        current_known: Boolean(currentRow),
        current_row: currentRow,
        b39_purged: !currentRow && Boolean(historicalRow),
        b39_row: historicalRow,
        classification: record.classification || null,
        parser: record.parser || null,
        item: record.item || null,
      });
    }
    return { records, current_file_count: countFiles(current), b39_file_count: countFiles(b39) };
  } finally {
    current.close();
    b39.close();
  }
}

function increment(map, key) {
  const normalized = key === undefined || key === null || key === "" ? "NULL" : String(key);
  map[normalized] = (map[normalized] || 0) + 1;
}

function summarize(records, historicalMatchesByIdent) {
  const provenance = { CURRENT_KNOWN: 0, B39_PURGED: 0, HISTORICAL_KNOWN_OTHER: 0, GENUINELY_UNSEEN: 0, PROVENANCE_UNKNOWN: 0 };
  const accepted = { CURRENT_KNOWN: 0, B39_PURGED: 0, HISTORICAL_KNOWN_OTHER: 0, GENUINELY_UNSEEN: 0, PROVENANCE_UNKNOWN: 0 };
  const quarantined = { CURRENT_KNOWN: 0, B39_PURGED: 0, HISTORICAL_KNOWN_OTHER: 0, GENUINELY_UNSEEN: 0, PROVENANCE_UNKNOWN: 0 };
  const currentCategories = {};
  const currentReasons = {};
  const currentConfidence = {};
  const b39Categories = {};
  const b39ClassifierVersions = {};
  const b39ParseVersions = {};
  const output = [];
  for (const record of records) {
    let category;
    if (record.current_known) category = "CURRENT_KNOWN";
    else if (record.b39_purged) category = "B39_PURGED";
    else if (historicalMatchesByIdent.has(record.ident)) category = "HISTORICAL_KNOWN_OTHER";
    else category = "GENUINELY_UNSEEN";
    provenance[category] += 1;
    if (record.action === "INSERT") accepted[category] += 1;
    if (record.action === "QUARANTINE_UNCLASSIFIED") quarantined[category] += 1;
    if (record.action === "INSERT") {
      increment(currentCategories, record.classification?.category);
      increment(currentReasons, record.classification?.reason);
      increment(currentConfidence, record.classification?.confidence);
    }
    if (record.b39_row) {
      increment(b39Categories, record.b39_row.category);
      increment(b39ClassifierVersions, record.b39_row.classifier_version);
      increment(b39ParseVersions, record.b39_row.parse_version);
    }
    output.push({
      ident: record.ident,
      action: record.action,
      provenance: category,
      classification: record.classification,
      parser: record.parser,
      current_row: record.current_row,
      b39_row: record.b39_row,
      historical_sources: historicalMatchesByIdent.get(record.ident) || [],
      item: record.item,
    });
  }
  return { records: output.sort((a, b) => a.ident.localeCompare(b.ident)), provenance, accepted, quarantined, currentCategories, currentReasons, currentConfidence, b39Categories, b39ClassifierVersions, b39ParseVersions };
}

function buildPurgedSidecar({ currentDatabasePath, b39DatabasePath, sourceSha256 = null, outputPath }) {
  const current = openReadonly(currentDatabasePath);
  const b39 = openReadonly(b39DatabasePath);
  try {
    assertQuickCheck(current, "CURRENT_DATABASE");
    assertQuickCheck(b39, "B39_DATABASE");
    const currentLookup = current.prepare("SELECT 1 AS present FROM files WHERE ident = ? LIMIT 1");
    const idents = [];
    for (const row of b39.prepare("SELECT ident FROM files WHERE ident IS NOT NULL ORDER BY id").iterate()) {
      if (!currentLookup.get(row.ident)) idents.push(row.ident);
    }
    idents.sort();
    const sidecar = {
      schema_version: PROVENANCE_SCHEMA_VERSION,
      kind: PURGED_SIDECAR_KIND,
      source: { database_path: b39DatabasePath, sha256: sourceSha256, file_count: countFiles(b39) },
      current_snapshot: { database_path: currentDatabasePath, file_count: countFiles(current) },
      ident_count: idents.length,
      idents_sha256: digestIdents(idents),
      idents,
    };
    const content = `${JSON.stringify(sidecar, null, 2)}\n`;
    if (outputPath) writeAtomic(outputPath, content);
    return { ...sidecar, output_path: outputPath || null, bytes: Buffer.byteLength(content) };
  } finally {
    current.close();
    b39.close();
  }
}

function readAndValidatePurgedSidecar(filePath) {
  const sidecar = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (sidecar.schema_version !== PROVENANCE_SCHEMA_VERSION || sidecar.kind !== PURGED_SIDECAR_KIND || !Array.isArray(sidecar.idents)) throw new Error("INVALID_PURGED_IDENT_SIDECAR");
  if (sidecar.idents.some((ident) => typeof ident !== "string") || sidecar.idents_sha256 !== digestIdents(sidecar.idents)) throw new Error("PURGED_IDENT_SIDECAR_DIGEST_MISMATCH");
  return sidecar;
}

async function auditDailyCandidateProvenance({ planPath, currentDatabasePath, b39DatabasePath, historicalJsonlPaths = [], outputDir, b39SidecarPath, b39SourceSha256 = null, allowPlanDigestMismatch = false }) {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const storedPlanSha256 = plan.plan_sha256 || null;
  const recomputedPlanSha256 = planDigest(plan);
  validateDailyPlan(plan, { allowDigestMismatch: allowPlanDigestMismatch });
  const compared = classifyCurrentAndB39({ plan, currentDatabasePath, b39DatabasePath });
  const candidateIdents = new Set(compared.records.filter((record) => !record.current_known).map((record) => record.ident));
  const historicalMatchesByIdent = new Map();
  const sources = [];
  for (const filePath of historicalJsonlPaths) {
    const result = await readJsonlCandidates(filePath, candidateIdents);
    const source = { file: result.file, lines: result.lines, matches: result.found.size, parse_errors: result.parseErrors };
    sources.push(source);
    for (const ident of result.found) {
      const list = historicalMatchesByIdent.get(ident) || [];
      list.push(filePath);
      historicalMatchesByIdent.set(ident, list);
    }
  }
  const summary = summarize(compared.records, historicalMatchesByIdent);
  const genuinelyUnseen = summary.records.filter((record) => record.provenance === "GENUINELY_UNSEEN");
  const proposed = genuinelyUnseen.filter((record) => record.action === "INSERT");
  const validatedSidecar = b39SidecarPath ? readAndValidatePurgedSidecar(b39SidecarPath) : null;
  const report = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    audit_policy_version: "B46.1-daily-candidate-provenance-v1",
    plan_path: planPath,
    plan_sha256: storedPlanSha256,
    plan_sha256_recomputed: recomputedPlanSha256,
    plan_digest_valid: Boolean(storedPlanSha256 && storedPlanSha256 === recomputedPlanSha256),
    plan_status: plan.status,
    source_completeness_note: "GENUINELY_UNSEEN means absent from the complete historical sources supplied; it does not prove upload recency.",
    historical_sources: sources,
    b39_sidecar: validatedSidecar ? {
      path: b39SidecarPath,
      schema_version: validatedSidecar.schema_version,
      kind: validatedSidecar.kind,
      source: validatedSidecar.source,
      current_snapshot: validatedSidecar.current_snapshot,
      ident_count: validatedSidecar.ident_count,
      idents_sha256: validatedSidecar.idents_sha256,
    } : null,
    baseline: { current_files: compared.current_file_count, b39_files: compared.b39_file_count },
    counts: { plan_records: plan.discovery_delta.length, current_known: summary.provenance.CURRENT_KNOWN, current_unknown: candidateIdents.size, accepted: plan.counters.accepted, quarantined: plan.counters.ignored_unclassified, proposed_safe_daily_delta: proposed.length },
    provenance: summary.provenance,
    accepted_by_provenance: summary.accepted,
    quarantined_by_provenance: summary.quarantined,
    current_classification: { categories: summary.currentCategories, reasons: summary.currentReasons, confidence: summary.currentConfidence },
    b39_classification: { categories: summary.b39Categories, classifier_versions: summary.b39ClassifierVersions, parse_versions: summary.b39ParseVersions },
    historical_reclassification_candidates: summary.records.filter((record) => record.provenance === "B39_PURGED" && record.action === "INSERT").length,
    proposed_daily_delta: { policy: "GENUINELY_UNSEEN + action INSERT only; exclude B39_PURGED, HISTORICAL_KNOWN_OTHER, PROVENANCE_UNKNOWN and quarantine", count: proposed.length, blocked_by_existing_b46_maxAcceptedItems: proposed.length > 1000 },
  };
  const reducedPlan = { source_plan_sha256: storedPlanSha256, policy_version: report.audit_policy_version, records: proposed.map((record) => ({ ident: record.ident, action: record.action, provenance: record.provenance, classification: record.classification, parser: record.parser, item: record.item })) };
  reducedPlan.plan_sha256 = sha256(reducedPlan);
  report.proposed_plan_sha256 = reducedPlan.plan_sha256;
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
    writeAtomic(path.join(outputDir, "provenance-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeAtomic(path.join(outputDir, "provenance-candidates.jsonl"), `${summary.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    writeAtomic(path.join(outputDir, "genuinely-unseen-candidates.jsonl"), `${genuinelyUnseen.map((record) => JSON.stringify(record)).join("\n")}\n`);
    writeAtomic(path.join(outputDir, "historical-reclassification-candidates.jsonl"), `${summary.records.filter((record) => record.provenance === "B39_PURGED").map((record) => JSON.stringify(record)).join("\n")}\n`);
    writeAtomic(path.join(outputDir, "proposed-safe-daily-delta.json"), `${JSON.stringify(reducedPlan, null, 2)}\n`);
  }
  return { report, plan: reducedPlan, records: summary.records };
}

module.exports = {
  PROVENANCE_SCHEMA_VERSION,
  PURGED_SIDECAR_KIND,
  stableJson,
  sha256,
  digestIdents,
  planDigest,
  validateDailyPlan,
  buildPurgedSidecar,
  readAndValidatePurgedSidecar,
  auditDailyCandidateProvenance,
};
