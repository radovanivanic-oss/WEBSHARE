"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildCandidate } = require("./candidate-grouper");
const { classifyItem, sha256, stableJson, snapshotDatabase } = require("./daily-maintenance");
const { parseMediaName } = require("./media-name-parser");

const BOOTSTRAP_POLICY_VERSION = "b46.3-bootstrap-v1";
const MAX_BATCH_SIZE = 500;

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function logicalDigest(value) {
  return sha256(value);
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, filePath);
}

function hasEpisodeMarker(name) {
  return /(?:^|[^a-z0-9])s\d{1,2}[ ._-]*e\d{1,3}(?:[^a-z0-9]|$)/i.test(name)
    || /(?:^|[^a-z0-9])\d{1,2}x\d{1,3}(?:[^a-z0-9]|$)/i.test(name)
    || /\b(?:season|episode|ep)\s*[-._ ]*\d+/i.test(name);
}

function hasResolutionYearCollision(name, year) {
  const match = String(name).match(/(?:^|[^0-9])(\d{3,4})x(\d{3,4})(?:[^0-9]|$)/i);
  return Boolean(match && Number.parseInt(match[1], 10) === Number(year));
}

function hasNonFeatureMarker(name) {
  return /\b(?:sample|trailer|teaser|featurette|behind[ ._-]?the[ ._-]?scenes|audiobook|podcast|archive)\b/i.test(name);
}

function categoryCandidateType(category) {
  return { movies: "movie", series: "episode", sports: "sports", concerts: "concert" }[category] || null;
}

function queryCandidate(database, candidateKey) {
  return database.prepare(`
    SELECT c.id, c.media_id, c.candidate_key, c.candidate_type,
           m.category AS media_category, m.media_type, m.title AS media_title
    FROM candidates c LEFT JOIN media m ON m.id = c.media_id
    WHERE c.candidate_key = ?
  `).get(candidateKey) || null;
}

function querySeries(database, seriesKey) {
  return database.prepare("SELECT id, category, media_type, title FROM media WHERE media_key = ?").get(`local:${seriesKey}`) || null;
}

function auditRecord(row, database, purgedIdents) {
  const reasons = [];
  const item = row.item;
  if (!item || row.action !== "INSERT") reasons.push("SOURCE_NOT_INSERT");
  if (purgedIdents.has(row.ident)) reasons.push("B39_PURGED_IDENT");
  const existingFile = item && database.prepare("SELECT id, media_id, is_active FROM files WHERE ident = ?").get(row.ident);
  if (existingFile) reasons.push("CURRENT_KNOWN_IDENT");

  let parsed = null;
  let candidate = null;
  let decision = null;
  if (item) {
    decision = classifyItem(item);
    parsed = parseMediaName(item.name, { extension: item.extension || item.type });
    candidate = buildCandidate(parsed);
    if (!decision.eligible) reasons.push("RECLASSIFICATION_NOT_ELIGIBLE");
    if (decision.classification?.category !== row.classification?.category) reasons.push("CLASSIFICATION_CHANGED");
    if (decision.parsed?.candidateType !== row.parser?.candidate_type) reasons.push("PARSER_TYPE_CHANGED");
    const expectedType = categoryCandidateType(row.classification?.category);
    if (expectedType && parsed.candidateType !== expectedType) reasons.push("CATEGORY_TYPE_CONFLICT");
    if (!parsed.isVideoExtension) reasons.push("NON_VIDEO_EXTENSION");
    if (!parsed.title || parsed.title.trim().length < 3) reasons.push("MISSING_OR_SHORT_TITLE");
    if (row.classification?.category === "movies") {
      if (hasEpisodeMarker(item.name)) reasons.push("MOVIE_EPISODIC_MARKER");
      if (hasNonFeatureMarker(item.name)) reasons.push("MOVIE_NON_FEATURE_MARKER");
      if (hasResolutionYearCollision(item.name, parsed.year)) reasons.push("MOVIE_RESOLUTION_PARSED_AS_YEAR");
    }
    if (row.classification?.category === "series" && (!Number.isInteger(parsed.season) || parsed.season < 1 || !Number.isInteger(parsed.episode) || parsed.episode < 1)) reasons.push("INVALID_EPISODE_COORDINATES");
    if (["sports", "concerts"].includes(row.classification?.category) && hasEpisodeMarker(item.name)) reasons.push("SPECIAL_CATEGORY_EPISODIC_MARKER");
  }

  if (candidate) {
    const existingCandidate = queryCandidate(database, candidate.candidateKey);
    if (existingCandidate?.media_category && existingCandidate.media_category !== row.classification.category) reasons.push("EXISTING_MEDIA_CATEGORY_CONFLICT");
    if (candidate.seriesKey) {
      const existingSeries = querySeries(database, candidate.seriesKey);
      if (existingSeries && existingSeries.category !== "series") reasons.push("EXISTING_SERIES_CATEGORY_CONFLICT");
    }
  }

  return { safe: reasons.length === 0, reasons, parsed, candidate, existingFile: existingFile || null };
}

function freezeAcceptedPlan({ plan, database, purgedIdents, sourcePlanSha256, outputDir }) {
  const accepted = plan.discovery_delta
    .filter((row) => row.action === "INSERT")
    .sort((left, right) => left.ident.localeCompare(right.ident));
  const records = accepted.map((row) => ({
    ident: row.ident,
    classification: row.classification,
    parser: row.parser,
    item: row.item,
  }));
  const artifact = {
    schema_version: 1,
    kind: "BOOTSTRAP_DISCOVERY_BACKLOG_SOURCE",
    policy_version: BOOTSTRAP_POLICY_VERSION,
    source_plan_sha256: sourcePlanSha256,
    created_at: new Date().toISOString(),
    candidate_count: records.length,
    logical_digest: logicalDigest(records),
    records,
  };
  writeAtomic(path.join(outputDir, "bootstrap-freeze.json"), artifact);
  return artifact;
}

function auditFrozenRecords({ freeze, database, purgedIdents, outputDir }) {
  const audited = [];
  const rejections = [];
  const seen = new Set();
  for (const record of freeze.records) {
    if (seen.has(record.ident)) {
      rejections.push({ ident: record.ident, reasons: ["DUPLICATE_IDENT"] });
      continue;
    }
    seen.add(record.ident);
    const result = auditRecord({ ...record, action: "INSERT" }, database, purgedIdents);
    const output = { ...record, candidate: result.candidate, audit_reasons: result.reasons };
    if (result.safe) audited.push(output);
    else rejections.push({ ...output, reasons: result.reasons });
  }
  const sorted = audited.sort((left, right) => left.ident.localeCompare(right.ident));
  const categories = Object.fromEntries([...new Set(sorted.map((row) => row.classification.category))].map((category) => [category, sorted.filter((row) => row.classification.category === category).length]));
  const audit = {
    schema_version: 1,
    policy_version: BOOTSTRAP_POLICY_VERSION,
    source_freeze_digest: freeze.logical_digest,
    source_candidate_count: freeze.records.length,
    approved_count: sorted.length,
    rejected_count: rejections.length,
    category_counts: categories,
    rejection_counts: Object.fromEntries([...new Set(rejections.flatMap((row) => row.reasons))].map((reason) => [reason, rejections.filter((row) => row.reasons.includes(reason)).length])),
    approved_logical_digest: logicalDigest(sorted),
    approved_records: sorted,
    rejected_records: rejections.sort((left, right) => left.ident.localeCompare(right.ident)),
  };
  writeAtomic(path.join(outputDir, "bootstrap-audit.json"), audit);
  writeAtomic(path.join(outputDir, "historical-reclassification-candidates.jsonl"), `${rejections.map((row) => JSON.stringify(row)).join("\n")}${rejections.length ? "\n" : ""}`);
  return audit;
}

function partitionBatches(records, { batchSize = MAX_BATCH_SIZE } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error("BOOTSTRAP_BATCH_SIZE_INVALID");
  const batches = [];
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batchRecords = records.slice(offset, offset + batchSize);
    batches.push({
      schema_version: 1,
      kind: "BOOTSTRAP_DISCOVERY_BACKLOG_BATCH",
      policy_version: BOOTSTRAP_POLICY_VERSION,
      batch_number: batches.length + 1,
      candidate_count: batchRecords.length,
      source_logical_digest: logicalDigest(records),
      first_ident: batchRecords[0]?.ident || null,
      last_ident: batchRecords[batchRecords.length - 1]?.ident || null,
      logical_digest: logicalDigest(batchRecords),
      records: batchRecords,
    });
  }
  const union = batches.flatMap((batch) => batch.records);
  if (union.length !== records.length || new Set(union.map((row) => row.ident)).size !== records.length || logicalDigest(union) !== logicalDigest(records)) throw new Error("BOOTSTRAP_BATCH_UNION_MISMATCH");
  return batches;
}

function writeBatches(audit, outputDir, batchSize = MAX_BATCH_SIZE) {
  const batches = partitionBatches(audit.approved_records, { batchSize });
  const batchDir = path.join(outputDir, "batches");
  for (const batch of batches) writeAtomic(path.join(batchDir, `batch-${String(batch.batch_number).padStart(4, "0")}.json`), batch);
  const manifest = {
    schema_version: 1,
    kind: "BOOTSTRAP_DISCOVERY_BACKLOG",
    policy_version: BOOTSTRAP_POLICY_VERSION,
    source_plan_sha256: audit.source_freeze_digest,
    source_freeze_digest: audit.source_freeze_digest,
    candidate_count: audit.approved_count,
    logical_digest: audit.approved_logical_digest,
    batch_size: batchSize,
    batch_count: batches.length,
    category_counts: audit.category_counts,
    rejection_counts: audit.rejection_counts,
    batches: batches.map((batch) => ({ batch_number: batch.batch_number, candidate_count: batch.candidate_count, first_ident: batch.first_ident, last_ident: batch.last_ident, logical_digest: batch.logical_digest })),
  };
  writeAtomic(path.join(outputDir, "bootstrap-backlog.json"), manifest);
  writeAtomic(path.join(outputDir, "bootstrap-backlog.jsonl"), `${audit.approved_records.map((row) => JSON.stringify(row)).join("\n")}${audit.approved_records.length ? "\n" : ""}`);
  return { manifest, batches };
}

module.exports = {
  BOOTSTRAP_POLICY_VERSION,
  MAX_BATCH_SIZE,
  auditFrozenRecords,
  categoryCandidateType,
  fileSha256,
  freezeAcceptedPlan,
  hasEpisodeMarker,
  hasNonFeatureMarker,
  hasResolutionYearCollision,
  logicalDigest,
  partitionBatches,
  stableJson,
  writeBatches,
};
