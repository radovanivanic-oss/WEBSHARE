"use strict";

const crypto = require("node:crypto");

const CERTIFICATE_SCHEMA_VERSION = 1;

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

function validateMinimalRecord(record) {
  return record && typeof record === "object"
    && typeof record.ident === "string" && record.ident.length > 0 && Buffer.byteLength(record.ident, "utf8") <= 256
    && typeof record.name === "string" && record.name.length > 0;
}

function toMinimalRecord(record, { runId = null, partition = null } = {}) {
  if (!validateMinimalRecord(record)) return null;
  return {
    ident: record.ident,
    name: record.name,
    size: record.size === undefined ? null : String(record.size),
    extension: record.extension || record.type || null,
    type: record.type || null,
    partition,
    run_id: runId,
  };
}

function createKnownIdentIndex(database) {
  const startedAt = Date.now();
  const memoryBefore = process.memoryUsage();
  const idents = new Set();
  for (const row of database.prepare("SELECT ident FROM files WHERE ident IS NOT NULL").iterate()) idents.add(row.ident);
  const memoryAfter = process.memoryUsage();
  return {
    idents,
    count: idents.size,
    metrics: {
      duration_ms: Date.now() - startedAt,
      heap_delta_bytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rss_delta_bytes: memoryAfter.rss - memoryBefore.rss,
    },
  };
}

function compareIdentSets({ knownIdents, observedIdents, complete = false, coverageStatus = "UNPROVEN" }) {
  const observed = observedIdents instanceof Set ? observedIdents : new Set(observedIdents || []);
  let knownObserved = 0;
  for (const ident of observed) if (knownIdents.has(ident)) knownObserved += 1;
  const newIdents = [];
  for (const ident of observed) if (!knownIdents.has(ident)) newIdents.push(ident);
  const eligible = complete === true && coverageStatus === "PROVEN_COMPLETE";
  let notSeen = null;
  if (eligible) {
    notSeen = [];
    for (const ident of knownIdents) if (!observed.has(ident)) notSeen.push(ident);
    notSeen.sort();
  }
  return {
    observed_unique: observed.size,
    known_observed: knownObserved,
    new_idents: newIdents.sort(),
    not_seen_idents: notSeen,
    absence_comparison_eligible: eligible,
  };
}

function buildEnumerationCertificate({
  runId,
  startedAt,
  finishedAt,
  queryContract,
  partitions,
  completionStatus,
  coverageStatus,
  rawRecords,
  uniqueIdents,
  duplicateCount,
  malformedCount,
  errors = [],
  knownIndex,
  comparison,
}) {
  const complete = completionStatus === "COMPLETE";
  const proven = coverageStatus === "PROVEN_COMPLETE";
  const snapshotDigest = sha256([...uniqueIdents].sort());
  const digestInput = {
    schema_version: CERTIFICATE_SCHEMA_VERSION,
    run_id: runId,
    query_contract: queryContract,
    partitions,
    completion_status: completionStatus,
    coverage_status: coverageStatus,
    raw_records: rawRecords,
    unique_idents: uniqueIdents.size,
    duplicate_count: duplicateCount,
    malformed_count: malformedCount,
    errors,
    snapshot_sha256: snapshotDigest,
    absence_comparison_eligible: complete && proven,
  };
  return {
    schema_version: CERTIFICATE_SCHEMA_VERSION,
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    query_contract: queryContract,
    partitions,
    completion_status: completionStatus,
    coverage_status: coverageStatus,
    raw_records: rawRecords,
    unique_idents: uniqueIdents.size,
    duplicate_count: duplicateCount,
    malformed_count: malformedCount,
    errors,
    snapshot_sha256: snapshotDigest,
    known_catalog_idents: knownIndex?.count ?? null,
    known_observed: comparison?.known_observed ?? null,
    new_ident_count: comparison?.new_idents?.length ?? null,
    not_seen_count: complete && proven ? comparison?.not_seen_idents?.length ?? null : null,
    absence_comparison_eligible: complete && proven,
    certificate_sha256: sha256(digestInput),
  };
}

function validateCompletenessCertificate(certificate) {
  if (!certificate || certificate.schema_version !== CERTIFICATE_SCHEMA_VERSION) throw new Error("ENUMERATION_CERTIFICATE_SCHEMA_MISMATCH");
  if (certificate.completion_status !== "COMPLETE" || certificate.coverage_status !== "PROVEN_COMPLETE" || certificate.absence_comparison_eligible !== true) {
    throw new Error("ENUMERATION_CERTIFICATE_NOT_COMPLETE");
  }
  if (certificate.errors?.length || certificate.malformed_count) throw new Error("ENUMERATION_CERTIFICATE_HAS_ERRORS");
  return true;
}

function validatePartitionProof(proof) {
  if (!proof || proof.coverage_status !== "PROVEN_COMPLETE" || proof.partition_complete !== true || proof.catch_all !== true || !Array.isArray(proof.partitions) || proof.partitions.length === 0) {
    throw new Error("ENUMERATION_PARTITION_PROOF_INVALID");
  }
  if (proof.partitions.some((partition) => !partition || typeof partition.id !== "string" || partition.coverage_proven !== true)) throw new Error("ENUMERATION_PARTITION_PROOF_INVALID");
  return proof;
}

module.exports = {
  CERTIFICATE_SCHEMA_VERSION,
  buildEnumerationCertificate,
  compareIdentSets,
  createKnownIdentIndex,
  sha256,
  stableJson,
  toMinimalRecord,
  validateCompletenessCertificate,
  validatePartitionProof,
  validateMinimalRecord,
};
