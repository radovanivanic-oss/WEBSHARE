
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { openCatalogDatabase } = require("../src/db/catalog-db");
const {
  B46_DEFAULT_POLICY,
  applyDailyPlan,
  planDigestInput,
  snapshotDatabase,
} = require("./daily-maintenance");
const {
  SET_NAMES,
  compatibleObservationContracts,
  digestIdents,
  readManifest,
  readSetArtifact,
  semanticContractId,
  sha256,
  stableJson,
  timestampDirectoryName,
} = require("./daily-observation");
const { readAndValidatePurgedSidecar } = require("./daily-candidate-provenance");

const B47_SCHEMA_VERSION = 1;
const B47_POLICY_VERSION = "b47-hybrid-persistence-v1";
const B47_DEEP_AUDIT_POLICY_VERSION = "b46.3-bootstrap-v1";
const MIN_INDEPENDENT_OBSERVATIONS = 3;
const PILOT_MAX_CANDIDATES = 500;
const HARD_MAX_ACCEPTED_ITEMS = 1000;
const SUPPORTED_CATEGORIES = new Set(["movies", "series", "sports", "concerts"]);

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripDigest(value, digestKey) {
  const copy = deepClone(value);
  delete copy[digestKey];
  return copy;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("PERSISTENCE_CLASSIFICATION_MISSING");
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function maxConsecutiveStreak(indexes) {
  let best = 0;
  let current = 0;
  let previous = null;
  for (const index of indexes) {
    current = previous !== null && index === previous + 1 ? current + 1 : 1;
    best = Math.max(best, current);
    previous = index;
  }
  return best;
}

function occurrenceDates(observationIndexes, observations) {
  return observationIndexes.map((index) => observations[index].local_calendar_date);
}

function sourceObservation(root, reference, expectedSemanticId = null) {
  if (reference.status !== "SUCCESS") throw new Error("PERSISTENCE_SOURCE_NOT_SUCCESS");
  const runDir = path.resolve(root, reference.artifact_dir);
  const manifest = readManifest(runDir);
  if (manifest.manifest_sha256 !== reference.manifest_sha256) throw new Error("PERSISTENCE_SOURCE_MANIFEST_DIGEST_MISMATCH");
  if (manifest.contract_fingerprint !== reference.contract_fingerprint) throw new Error("PERSISTENCE_SOURCE_CONTRACT_REFERENCE_MISMATCH");
  const semanticId = semanticContractId(manifest.contract);
  if (expectedSemanticId && semanticId !== expectedSemanticId) throw new Error("PERSISTENCE_SEMANTIC_CONTRACT_MISMATCH");
  const sets = Object.fromEntries(SET_NAMES.map((name) => [name, new Set(readSetArtifact(runDir, name, manifest.sets[name].sha256))]));
  const planPath = path.join(runDir, "plan.json");
  const plan = readJson(planPath);
  if (plan.plan_sha256 !== manifest.plan.sha256 || sha256(planDigestInput(plan)) !== plan.plan_sha256) throw new Error("PERSISTENCE_SOURCE_PLAN_DIGEST_MISMATCH");
  const freezePath = path.join(runDir, "deep-audit", "bootstrap-freeze.json");
  const freeze = readJson(freezePath);
  const auditPath = path.join(runDir, "deep-audit", "bootstrap-audit.json");
  const audit = readJson(auditPath);
  if (freeze.source_plan_sha256 !== plan.plan_sha256 || freeze.candidate_count !== plan.counters.accepted || audit.policy_version !== B47_DEEP_AUDIT_POLICY_VERSION || audit.approved_count !== audit.approved_records.length || audit.rejected_count !== audit.rejected_records.length) throw new Error("PERSISTENCE_SOURCE_DEEP_AUDIT_INVALID");
  if (audit.source_freeze_digest && audit.source_freeze_digest !== freeze.logical_digest) throw new Error("PERSISTENCE_SOURCE_FREEZE_DIGEST_MISMATCH");
  const approved = new Set(audit.approved_records.map((record) => record.ident));
  const rejected = new Set(audit.rejected_records.map((record) => record.ident));
  if (digestIdents([...approved]) !== manifest.sets.deep_approved.sha256 || digestIdents([...rejected]) !== manifest.sets.deep_rejected.sha256) throw new Error("PERSISTENCE_SOURCE_DEEP_SET_MISMATCH");
  const classificationPath = path.join(runDir, "classification.jsonl");
  const classifications = readJsonl(classificationPath);
  return {
    reference,
    runDir,
    local_calendar_date: reference.local_calendar_date,
    observation_started_at: manifest.observation_started_at,
    observation_finished_at: manifest.observation_finished_at,
    manifest,
    sets,
    plan,
    audit,
    classifications,
    audit_approved: approved,
    audit_rejected: rejected,
    source_digest: {
      artifact_dir: reference.artifact_dir,
      manifest_sha256: manifest.manifest_sha256,
      contract_fingerprint: manifest.contract_fingerprint,
      semantic_contract_id: semanticId,
      plan_sha256: plan.plan_sha256,
      classification_sha256: fileSha256(classificationPath),
      freeze_digest: audit.source_freeze_digest || null,
      freeze_sha256: fileSha256(freezePath),
      deep_audit_sha256: fileSha256(auditPath),
      deep_audit_approved_logical_digest: audit.approved_logical_digest || null,
      sets: Object.fromEntries(SET_NAMES.map((name) => [name, manifest.sets[name].sha256])),
    },
  };
}

function validateSourceSeries({ seriesRoot, seriesId }) {
  const root = path.resolve(seriesRoot);
  const seriesPath = path.join(root, "series.json");
  if (!fs.existsSync(seriesPath)) throw new Error("PERSISTENCE_SERIES_MISSING");
  const series = readJson(seriesPath);
  if (series.schema_version !== 1 || series.kind !== "B46.7_DAILY_OBSERVATION_SERIES" || series.series_id !== seriesId) throw new Error("PERSISTENCE_SERIES_INVALID");
  const references = [...series.observations].sort((a, b) => a.observation_finished_at.localeCompare(b.observation_finished_at));
  const dates = new Set();
  let semanticId = null;
  const observations = [];
  for (const reference of references) {
    if (dates.has(reference.local_calendar_date)) throw new Error("PERSISTENCE_DUPLICATE_OBSERVATION_DATE");
    dates.add(reference.local_calendar_date);
    const loaded = sourceObservation(root, reference, semanticId);
    semanticId ||= loaded.source_digest.semantic_contract_id;
    observations.push(loaded);
  }
  if (!observations.length) throw new Error("PERSISTENCE_NO_SUCCESSFUL_OBSERVATIONS");
  if (series.successful_observations !== observations.length) throw new Error("PERSISTENCE_SERIES_COUNT_MISMATCH");
  return { root, series, observations, semantic_contract_id: semanticId };
}

function productionHealth({ databasePath, sidecar }) {
  const database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  try {
    const snapshot = snapshotDatabase(database);
    const quickCheck = database.pragma("quick_check", { simple: true });
    const foreignKeyCheck = database.pragma("foreign_key_check");
    const duplicateIdents = Number(database.prepare("SELECT COUNT(*) AS count FROM (SELECT ident FROM files GROUP BY ident HAVING COUNT(*) > 1)").get().count);
    const duplicateOwnership = Number(database.prepare("SELECT COUNT(*) AS count FROM (SELECT ident, media_id FROM files GROUP BY ident, media_id HAVING COUNT(*) > 1)").get().count);
    const unclassified = Number(database.prepare("SELECT COUNT(*) AS count FROM media WHERE category IN ('unknown', 'unclassified')").get().count);
    const purged = new Set(sidecar.idents);
    let b39Leakage = 0;
    for (const row of database.prepare("SELECT ident FROM files").iterate()) if (purged.has(row.ident)) b39Leakage += 1;
    const health = {
      snapshot,
      quick_check: quickCheck,
      foreign_key_check: foreignKeyCheck.length,
      duplicate_idents: duplicateIdents,
      duplicate_ownership: duplicateOwnership,
      unclassified,
      b39_purged_ident_leakage: b39Leakage,
      production_baseline_sha256: sha256(snapshot),
    };
    if (quickCheck !== "ok" || foreignKeyCheck.length || duplicateIdents || duplicateOwnership || unclassified || b39Leakage) throw new Error("PERSISTENCE_PRODUCTION_HEALTH_FAILED");
    return health;
  } finally {
    database.close();
  }
}

function classificationEvidence(record) {
  const classification = record.classifications.filter((item) => item.action === "INSERT" && item.classification).map((item) => ({
    classification: item.classification,
    parser: item.parser,
    item: item.item,
  }));
  return classification;
}

function addObservationIndex(map, ident, field, index) {
  const record = map.get(ident) || { ident, raw_indexes: [], post_b39_indexes: [], accepted_indexes: [], deep_approved_indexes: [], deep_rejected_indexes: [], classifications: [], approved_records: [], rejected_records: [] };
  if (!record[field].includes(index)) record[field].push(index);
  map.set(ident, record);
}

function derivePersistenceLedger({ seriesRoot, seriesId, databasePath, sidecarPath }) {
  const sidecar = readAndValidatePurgedSidecar(path.resolve(sidecarPath));
  const loaded = validateSourceSeries({ seriesRoot, seriesId });
  const health = productionHealth({ databasePath: path.resolve(databasePath), sidecar });
  const knownDb = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  const knownStatement = knownDb.prepare("SELECT id, ident, media_id, is_active, is_playable_video FROM files WHERE ident = ? ORDER BY id");
  const byIdent = new Map();
  const b39Set = new Set(sidecar.idents);
  const rawUnique = new Set();
  const postB39Unique = new Set();
  const acceptedUnique = new Set();
  try {
    loaded.observations.forEach((observation, index) => {
      for (const ident of observation.sets.raw_unique) {
        rawUnique.add(ident);
        addObservationIndex(byIdent, ident, "raw_indexes", index);
      }
      for (const ident of observation.sets.post_b39) {
        postB39Unique.add(ident);
        addObservationIndex(byIdent, ident, "post_b39_indexes", index);
      }
      for (const ident of observation.sets.accepted) {
        acceptedUnique.add(ident);
        addObservationIndex(byIdent, ident, "accepted_indexes", index);
      }
      for (const ident of observation.sets.deep_approved) addObservationIndex(byIdent, ident, "deep_approved_indexes", index);
      for (const ident of observation.sets.deep_rejected) addObservationIndex(byIdent, ident, "deep_rejected_indexes", index);
      for (const row of observation.classifications) {
        const current = byIdent.get(row.ident) || { ident: row.ident, raw_indexes: [], post_b39_indexes: [], accepted_indexes: [], deep_approved_indexes: [], deep_rejected_indexes: [], classifications: [], approved_records: [], rejected_records: [] };
        current.classifications.push({ observation_index: index, action: row.action, classification: row.classification || null, parser: row.parser || null, item: row.item || null });
        byIdent.set(row.ident, current);
      }
      for (const row of observation.audit.approved_records) {
        const current = byIdent.get(row.ident) || { ident: row.ident, raw_indexes: [], post_b39_indexes: [], accepted_indexes: [], deep_approved_indexes: [], deep_rejected_indexes: [], classifications: [], approved_records: [], rejected_records: [] };
        current.approved_records.push({ observation_index: index, ...row });
        byIdent.set(row.ident, current);
      }
      for (const row of observation.audit.rejected_records) {
        const current = byIdent.get(row.ident) || { ident: row.ident, raw_indexes: [], post_b39_indexes: [], accepted_indexes: [], deep_approved_indexes: [], deep_rejected_indexes: [], classifications: [], approved_records: [], rejected_records: [] };
        current.rejected_records.push({ observation_index: index, ...row });
        byIdent.set(row.ident, current);
      }
    });
    const records = [...byIdent.values()].sort((a, b) => a.ident.localeCompare(b.ident)).map((raw) => {
      const acceptedIndexes = [...raw.accepted_indexes].sort((a, b) => a - b);
      const rawIndexes = [...raw.raw_indexes].sort((a, b) => a - b);
      const productionRows = knownStatement.all(raw.ident);
      const classificationHistory = classificationEvidence(raw);
      const categories = [...new Set(classificationHistory.map((item) => item.classification?.category).filter(Boolean))];
      const classification = classificationHistory.at(-1) || null;
      const approvedRecords = [...raw.approved_records].sort((a, b) => a.observation_index - b.observation_index);
      const rejectedRecords = [...raw.rejected_records].sort((a, b) => a.observation_index - b.observation_index);
      const rejectionReasons = [...new Set(rejectedRecords.flatMap((row) => row.audit_reasons || row.reasons || []))].sort();
      const classificationConflict = categories.length > 1;
      const accepted = acceptedIndexes.length > 0;
      const deepApproved = raw.deep_approved_indexes.length > 0;
      const deepRejected = raw.deep_rejected_indexes.length > 0;
      const deepInconsistent = deepApproved && deepRejected;
      const supported = Boolean(classification?.classification && SUPPORTED_CATEGORIES.has(classification.classification.category)
        && classification.parser?.title && classification.parser.title.length >= 2
        && classification.parser?.candidate_type && classification.parser.candidate_type !== "unknown");
      const ambiguous = accepted && (!deepApproved && !deepRejected || !classification || !supported || !approvedRecords.at(-1)?.candidate?.candidateKey);
      const conflict = classificationConflict || rejectionReasons.some((reason) => ["CATEGORY_TYPE_CONFLICT", "EXISTING_SERIES_CATEGORY_CONFLICT", "INVALID_EPISODE_COORDINATES"].includes(reason));
      const reasons = [...rejectionReasons];
      if (!accepted && raw.classifications.some((item) => item.action === "QUARANTINE_UNCLASSIFIED")) reasons.push("LIGHTWEIGHT_CLASSIFIER_QUARANTINE");
      if (classificationConflict) reasons.push("CLASSIFICATION_CONFLICT");
      if (!supported && accepted) reasons.push("UNSUPPORTED_CLASSIFICATION");
      if (ambiguous) reasons.push("AMBIGUOUS_GROUPING");
      if (deepInconsistent) reasons.push("DEEP_AUDIT_INCONSISTENT");
      if (accepted && !deepApproved && !deepRejected) reasons.push("DEEP_AUDIT_MISSING");
      const reasonList = [...new Set(reasons)].sort();
      let state = "OBSERVED";
      if (b39Set.has(raw.ident)) state = "TOMBSTONED";
      else if (productionRows.length) state = "ALREADY_KNOWN";
      else if (!accepted) state = "OBSERVED";
      else if (deepRejected || conflict || ambiguous || !supported) state = "REJECTED";
      else if (acceptedIndexes.length < MIN_INDEPENDENT_OBSERVATIONS) state = "PENDING";
      else if (deepApproved) state = "ELIGIBLE";
      else state = "REJECTED";
      const firstIndex = rawIndexes[0];
      const lastIndex = rawIndexes.at(-1);
      return {
        ident: raw.ident,
        state,
        first_observed_at: loaded.observations[firstIndex]?.observation_finished_at || null,
        last_observed_at: loaded.observations[lastIndex]?.observation_finished_at || null,
        time_semantics: "observation artifact timestamp; never an upload timestamp",
        observed_dates: occurrenceDates(rawIndexes, loaded.observations),
        post_b39_dates: occurrenceDates([...raw.post_b39_indexes].sort((a, b) => a - b), loaded.observations),
        independent_observation_dates: occurrenceDates(acceptedIndexes, loaded.observations),
        observed_count: rawIndexes.length,
        observation_count: acceptedIndexes.length,
        consecutive_observation_count: maxConsecutiveStreak(acceptedIndexes),
        classification: classification?.classification || null,
        parser: classification?.parser || null,
        classification_history: classificationHistory,
        classification_evidence: classificationHistory.map((item) => item.classification).filter(Boolean),
        deep_audit_state: deepRejected ? "REJECTED" : deepApproved ? "APPROVED" : "NOT_AUDITED",
        deep_audit_evidence: {
          approved_observations: occurrenceDates([...raw.deep_approved_indexes].sort((a, b) => a - b), loaded.observations),
          rejected_observations: occurrenceDates([...raw.deep_rejected_indexes].sort((a, b) => a - b), loaded.observations),
          rejection_reasons: reasonList,
          approved_record: approvedRecords.at(-1) || null,
          rejected_records: rejectedRecords,
        },
        b39_tombstoned: b39Set.has(raw.ident),
        production_known: productionRows.length > 0,
        production_rows: productionRows,
        ownership_conflict: productionRows.length > 1 || conflict,
        ambiguous_grouping: ambiguous,
        rejection_state: state === "REJECTED" ? { rejected: true, reasons: reasonList } : { rejected: false, reasons: [] },
        applied_state: "NOT_PROVABLE_FROM_CURRENT_SNAPSHOT",
        contract_fingerprints: [...new Set(loaded.observations.filter((observation) => raw.raw_indexes.includes(loaded.observations.indexOf(observation))).map((observation) => observation.manifest.contract_fingerprint))],
        semantic_contract_ids: [loaded.semantic_contract_id],
        source_observation_ids: acceptedIndexes.map((index) => loaded.observations[index].reference.artifact_dir),
        item: approvedRecords.at(-1)?.item || classification?.item || null,
      };
    });
    const recurrence = {};
    for (const record of records) recurrence[record.observation_count] = (recurrence[record.observation_count] || 0) + 1;
    const stats = {
      total_unique_observed: rawUnique.size,
      total_unique_post_b39: postB39Unique.size,
      total_unique_accepted: acceptedUnique.size,
      already_known: records.filter((record) => record.state === "ALREADY_KNOWN").length,
      b39_tombstoned: records.filter((record) => record.state === "TOMBSTONED").length,
      observed: records.filter((record) => record.state === "OBSERVED").length,
      pending: records.filter((record) => record.state === "PENDING").length,
      pending_one_observation: records.filter((record) => record.state === "PENDING" && record.observation_count === 1).length,
      pending_two_observations: records.filter((record) => record.state === "PENDING" && record.observation_count === 2).length,
      seen_at_least_three: records.filter((record) => record.observation_count >= MIN_INDEPENDENT_OBSERVATIONS).length,
      eligible: records.filter((record) => record.state === "ELIGIBLE").length,
      rejected: records.filter((record) => record.state === "REJECTED").length,
      deep_approved: records.filter((record) => record.deep_audit_state === "APPROVED").length,
      deep_rejected: records.filter((record) => record.deep_audit_state === "REJECTED").length,
      conflicts: records.filter((record) => record.ownership_conflict).length,
      ambiguous: records.filter((record) => record.ambiguous_grouping).length,
      recurrence_distribution: recurrence,
      disappeared_then_reappeared: records.filter((record) => {
        const indexes = [...byIdent.get(record.ident).accepted_indexes].sort((a, b) => a - b);
        return indexes.some((index, position) => position > 0 && index > indexes[position - 1] + 1);
      }).length,
    };
    const base = {
      schema_version: B47_SCHEMA_VERSION,
      kind: "B47_PERSISTENCE_LEDGER",
      policy_version: B47_POLICY_VERSION,
      series_id: loaded.series.series_id,
      source_series_root: path.relative(process.cwd(), loaded.root).replaceAll(path.sep, "/"),
      successful_observations: loaded.observations.length,
      semantic_contract_id: loaded.semantic_contract_id,
      source_observations: loaded.observations.map((observation) => observation.source_digest),
      b39_sidecar: { ident_count: sidecar.ident_count, sha256: sidecar.idents_sha256 },
      production_baseline: health,
      stats,
      records,
      created_at: null,
    };
    return { ...base, ledger_sha256: sha256(stripDigest(base, "ledger_sha256")) };
  } finally {
    knownDb.close();
  }
}

function rankEligible(left, right) {
  return right.observation_count - left.observation_count
    || right.consecutive_observation_count - left.consecutive_observation_count
    || (right.deep_audit_evidence.approved_observations.length - left.deep_audit_evidence.approved_observations.length)
    || left.ident.localeCompare(right.ident);
}

function categoryKey(record) {
  const category = record.classification?.category;
  if (category === "series") return "series_episodes";
  if (category === "movies") return "movies";
  if (category === "sports") return "sports";
  if (category === "concerts") return "concerts";
  return "other";
}

function buildPilotPlan({ ledger, eligibilitySha256, createdAt = new Date().toISOString(), maxCandidates = PILOT_MAX_CANDIDATES, sourceSeriesRoot, toolBuildIdentity = null }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 0 || maxCandidates > PILOT_MAX_CANDIDATES) throw new Error("B47_PILOT_LIMIT_INVALID");
  const eligible = ledger.records.filter((record) => record.state === "ELIGIBLE").sort(rankEligible);
  const selected = eligible.slice(0, maxCandidates);
  const discoveryDelta = selected.map((record) => ({
    ident: record.ident,
    action: "INSERT",
    media_id: null,
    file_id: null,
    classification: record.classification,
    parser: record.parser,
    item: record.item,
  }));
  const categories = Object.fromEntries(["movies", "series_episodes", "sports", "concerts", "other"].map((key) => [key, selected.filter((record) => categoryKey(record) === key).length]));
  const base = {
    schema_version: B47_SCHEMA_VERSION,
    kind: "B47_HYBRID_PERSISTENCE_CONTROLLED_APPLY_PLAN",
    policy_version: B47_POLICY_VERSION,
    tool_build_identity: toolBuildIdentity,
    operation: "b47-hybrid-pilot",
    created_at: createdAt,
    status: selected.length ? "READY_FOR_REVIEW" : "NO_CHANGES",
    blocked_reasons: [],
    source_series_id: ledger.series_id,
    source_series_root: sourceSeriesRoot || ledger.source_series_root,
    semantic_contract_id: ledger.semantic_contract_id,
    source_observation_ids: ledger.source_observations.map((source) => source.artifact_dir),
    source_observation_digests: ledger.source_observations,
    ledger_sha256: ledger.ledger_sha256,
    eligibility_sha256: eligibilitySha256,
    candidate_set_sha256: digestIdents(selected.map((record) => record.ident)),
    max_candidates: PILOT_MAX_CANDIDATES,
    hard_max_accepted_items: HARD_MAX_ACCEPTED_ITEMS,
    baseline: ledger.production_baseline.snapshot,
    production_baseline_sha256: ledger.production_baseline.production_baseline_sha256,
    b39_sidecar_sha256: ledger.b39_sidecar.sha256,
    deep_audit_policy_version: B47_DEEP_AUDIT_POLICY_VERSION,
    discovery: { coverage: "historical-observation-persistence-gate", guessed_upload_dates_used: false, candidate_count: selected.length, recurrence_minimum: MIN_INDEPENDENT_OBSERVATIONS },
    discovery_delta: discoveryDelta,
    counters: { planned: selected.length, movies: categories.movies, series_episodes: categories.series_episodes, sports: categories.sports, concerts: categories.concerts, other: categories.other },
    deactivations: [],
    next_state: null,
    safety: {
      production_apply: false,
      sqlite_write_performed: false,
      additive_only: true,
      deactivation: false,
      deletion: false,
      reconciliation: false,
      publication: false,
      pointer_switched: false,
      state_advance: false,
    },
  };
  return { ...base, plan_sha256: sha256(planDigestInput(base)) };
}

function buildEligibilityArtifact({ ledger, createdAt = new Date().toISOString(), toolBuildIdentity = null }) {
  const eligibleRecords = ledger.records.filter((record) => record.state === "ELIGIBLE").sort(rankEligible);
  const base = {
    schema_version: B47_SCHEMA_VERSION,
    kind: "B47_PERSISTENCE_ELIGIBILITY",
    policy_version: B47_POLICY_VERSION,
    tool_build_identity: toolBuildIdentity,
    created_at: createdAt,
    series_id: ledger.series_id,
    semantic_contract_id: ledger.semantic_contract_id,
    source_observation_ids: ledger.source_observations.map((source) => source.artifact_dir),
    source_observation_digests: ledger.source_observations,
    ledger_sha256: ledger.ledger_sha256,
    production_baseline_sha256: ledger.production_baseline.production_baseline_sha256,
    b39_sidecar_sha256: ledger.b39_sidecar.sha256,
    deep_audit_policy_version: B47_DEEP_AUDIT_POLICY_VERSION,
    minimum_independent_observations: MIN_INDEPENDENT_OBSERVATIONS,
    eligible_set_sha256: digestIdents(eligibleRecords.map((record) => record.ident)),
    eligible_count: eligibleRecords.length,
    records: eligibleRecords,
  };
  return { ...base, eligibility_sha256: sha256(stripDigest(base, "eligibility_sha256")) };
}

function writeNewJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o640 });
}

function createB47Artifacts({ ledger, outputDir, createdAt = new Date().toISOString(), sourceSeriesRoot, toolBuildIdentity = null, maxCandidates = PILOT_MAX_CANDIDATES }) {
  const out = path.resolve(outputDir);
  fs.mkdirSync(out, { recursive: true, mode: 0o750 });
  const ledgerArtifact = { ...ledger, tool_build_identity: toolBuildIdentity, created_at: createdAt, ledger_sha256: ledger.ledger_sha256 };
  const eligibility = buildEligibilityArtifact({ ledger: ledgerArtifact, createdAt, toolBuildIdentity });
  const plan = buildPilotPlan({ ledger: ledgerArtifact, eligibilitySha256: eligibility.eligibility_sha256, createdAt, sourceSeriesRoot, toolBuildIdentity, maxCandidates });
  writeNewJson(path.join(out, "ledger.json"), ledgerArtifact);
  writeNewJson(path.join(out, "eligibility.json"), eligibility);
  writeNewJson(path.join(out, "pilot-plan.json"), plan);
  const summary = {
    schema_version: B47_SCHEMA_VERSION,
    kind: "B47_PERSISTENCE_REPORT_SUMMARY",
    tool_build_identity: toolBuildIdentity,
    created_at: createdAt,
    series_id: ledger.series_id,
    semantic_contract_id: ledger.semantic_contract_id,
    ledger_sha256: ledgerArtifact.ledger_sha256,
    eligibility_sha256: eligibility.eligibility_sha256,
    pilot_plan_sha256: plan.plan_sha256,
    stats: ledger.stats,
    pilot: { count: plan.discovery_delta.length, counters: plan.counters, candidate_set_sha256: plan.candidate_set_sha256 },
    safety: { production_mutated: false, public_pointer_mutated: false, automatic_import: false },
  };
  writeNewJson(path.join(out, "summary.json"), summary);
  return { outputDir: out, ledger: ledgerArtifact, eligibility, plan, summary };
}

function validatePilotPlan({ plan, databasePath, sidecarPath, seriesRoot, seriesId }) {
  if (!plan || plan.kind !== "B47_HYBRID_PERSISTENCE_CONTROLLED_APPLY_PLAN" || plan.schema_version !== B47_SCHEMA_VERSION) throw new Error("B47_PLAN_INVALID");
  if (sha256(planDigestInput(plan)) !== plan.plan_sha256) throw new Error("B47_PLAN_DIGEST_MISMATCH");
  if (!Array.isArray(plan.discovery_delta) || plan.discovery_delta.length > PILOT_MAX_CANDIDATES || plan.discovery_delta.length > HARD_MAX_ACCEPTED_ITEMS) throw new Error("B47_PLAN_LIMIT");
  if (plan.deactivations?.length || plan.safety?.deactivation || plan.safety?.deletion || plan.safety?.publication || plan.safety?.state_advance) throw new Error("B47_PLAN_NOT_ADDITIVE");
  const sidecar = readAndValidatePurgedSidecar(path.resolve(sidecarPath));
  if (sidecar.idents_sha256 !== plan.b39_sidecar_sha256) throw new Error("B47_B39_DIGEST_MISMATCH");
  const ledger = derivePersistenceLedger({ seriesRoot, seriesId, databasePath, sidecarPath });
  if (ledger.semantic_contract_id !== plan.semantic_contract_id || ledger.ledger_sha256 !== plan.ledger_sha256) throw new Error("B47_SOURCE_LEDGER_MISMATCH");
  const currentIds = plan.discovery_delta.map((record) => record.ident);
  if (new Set(currentIds).size !== currentIds.length || digestIdents(currentIds) !== plan.candidate_set_sha256) throw new Error("B47_CANDIDATE_SET_DIGEST_MISMATCH");
  const eligible = new Map(ledger.records.filter((record) => record.state === "ELIGIBLE").map((record) => [record.ident, record]));
  for (const row of plan.discovery_delta) {
    const record = eligible.get(row.ident);
    if (!record || record.b39_tombstoned || record.production_known || record.deep_audit_state !== "APPROVED" || !record.item || row.action !== "INSERT") throw new Error("B47_CANDIDATE_SAFETY_MISMATCH");
  }
  const health = productionHealth({ databasePath: path.resolve(databasePath), sidecar });
  if (stableJson(health.snapshot) !== stableJson(plan.baseline)) throw new Error("B47_DATABASE_BASELINE_DRIFT");
  const database = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    for (const row of plan.discovery_delta) {
      if (database.prepare("SELECT 1 FROM files WHERE ident = ? LIMIT 1").get(row.ident)) throw new Error("B47_CANDIDATE_ALREADY_KNOWN");
    }
  } finally {
    database.close();
  }
  return { valid: true, plan_sha256: plan.plan_sha256, ledger_sha256: ledger.ledger_sha256, production: health, candidate_count: plan.discovery_delta.length };
}

async function applyPilotPlan({ planPath, databasePath, sidecarPath, seriesRoot, seriesId, backupPath, outputDir, apply = false, confirm = false }) {
  const plan = readJson(path.resolve(planPath));
  const validation = validatePilotPlan({ plan, databasePath, sidecarPath, seriesRoot, seriesId });
  if (!apply) return { status: "DRY_RUN", validation, safety: { sqlite_write_performed: false, production_apply: false } };
  if (!confirm) throw new Error("B47_APPLY_REQUIRES_EXPLICIT_CONFIRMATION");
  if (!backupPath) throw new Error("B47_BACKUP_REQUIRED");
  const result = await applyDailyPlan({ databasePath, plan, backupPath: path.resolve(backupPath), policy: { ...B46_DEFAULT_POLICY, maxAcceptedItems: HARD_MAX_ACCEPTED_ITEMS } });
  const backupDb = openCatalogDatabase(path.resolve(backupPath), { readonly: true, fileMustExist: true });
  let backupHealth;
  try {
    backupHealth = { quick_check: backupDb.pragma("quick_check", { simple: true }), foreign_key_check: backupDb.pragma("foreign_key_check").length };
  } finally {
    backupDb.close();
  }
  if (backupHealth.quick_check !== "ok" || backupHealth.foreign_key_check) throw new Error("B47_BACKUP_INTEGRITY_FAILED");
  const applied = {
    schema_version: B47_SCHEMA_VERSION,
    kind: "B47_HYBRID_PERSISTENCE_APPLY_RESULT",
    policy_version: B47_POLICY_VERSION,
    plan_sha256: plan.plan_sha256,
    backup_path: path.resolve(backupPath),
    backup_sha256: fileSha256(path.resolve(backupPath)),
    backup_health: backupHealth,
    result: result.result,
    post: result.post,
    safety: { sqlite_write_performed: true, additive_only: true, deactivation: false, deletion: false, reconciliation: false, publication: false, pointer_switched: false },
  };
  if (outputDir) writeNewJson(path.join(path.resolve(outputDir), "apply-result.json"), applied);
  return { status: "APPLIED", validation, applied };
}

module.exports = {
  B47_SCHEMA_VERSION,
  B47_POLICY_VERSION,
  B47_DEEP_AUDIT_POLICY_VERSION,
  MIN_INDEPENDENT_OBSERVATIONS,
  PILOT_MAX_CANDIDATES,
  HARD_MAX_ACCEPTED_ITEMS,
  fileSha256,
  semanticContractCompatibility: compatibleObservationContracts,
  derivePersistenceLedger,
  buildEligibilityArtifact,
  buildPilotPlan,
  createB47Artifacts,
  validatePilotPlan,
  applyPilotPlan,
};
