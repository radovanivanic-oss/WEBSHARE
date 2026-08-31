"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { comparison, readManifest, readSetArtifact, SET_NAMES, stableJson, sha256, compatibleObservationContracts, semanticContractId } = require("./daily-observation");

function loadSeries(seriesRoot, expectedSeriesId = null) {
  const root = path.resolve(seriesRoot);
  const seriesPath = path.join(root, "series.json");
  if (!fs.existsSync(seriesPath)) throw new Error("SERIES_STATE_MISSING");
  const series = JSON.parse(fs.readFileSync(seriesPath, "utf8"));
  if (series.schema_version !== 1 || series.kind !== "B46.7_DAILY_OBSERVATION_SERIES") throw new Error("SERIES_STATE_INVALID");
  if (expectedSeriesId && series.series_id !== expectedSeriesId) throw new Error("SERIES_ID_MISMATCH");
  if (series.expected_contract_fingerprint !== series.contract?.fingerprint) throw new Error("SERIES_MANIFEST_REFERENCE_MISMATCH");
  return { root, series };
}

function loadObservations(root, series) {
  const observations = [...series.observations].sort((left, right) => left.observation_finished_at.localeCompare(right.observation_finished_at));
  const dates = new Set();
  return observations.map((reference) => {
    if (reference.status !== "SUCCESS" || dates.has(reference.local_calendar_date)) throw new Error("SERIES_OBSERVATION_INDEX_INVALID");
    dates.add(reference.local_calendar_date);
    const runDir = path.resolve(root, reference.artifact_dir);
    const manifest = readManifest(runDir);
    if (manifest.contract_fingerprint !== series.expected_contract_fingerprint && !compatibleObservationContracts(manifest.contract, series.contract).compatible) throw new Error("CONTRACT_SEMANTIC_MISMATCH");
    if (reference.manifest_sha256 !== manifest.manifest_sha256) throw new Error("SERIES_MANIFEST_REFERENCE_MISMATCH");
    const sets = Object.fromEntries(SET_NAMES.map((name) => [name, new Set(readSetArtifact(runDir, name, manifest.sets[name].sha256))]));
    return { reference, manifest, sets, runDir };
  });
}

function adjacent(oldSnapshot, newSnapshot, name) {
  return comparison(oldSnapshot.sets[name], newSnapshot.sets[name]);
}

function lifetime(observations, name) {
  const byIdent = new Map();
  observations.forEach((observation, index) => {
    for (const ident of observation.sets[name]) {
      const item = byIdent.get(ident) || { ident, observation_indexes: [], days_present: 0 };
      item.observation_indexes.push(index);
      item.days_present += 1;
      byIdent.set(ident, item);
    }
  });
  const records = [...byIdent.values()].map((item) => {
    let maxStreak = 0;
    let streak = 0;
    let reappeared = false;
    for (let index = 0; index < item.observation_indexes.length; index += 1) {
      if (index > 0 && item.observation_indexes[index] === item.observation_indexes[index - 1] + 1) streak += 1;
      else {
        if (index > 0) reappeared = true;
        streak = 1;
      }
      maxStreak = Math.max(maxStreak, streak);
    }
    return { ...item, first_observation: item.observation_indexes[0] + 1, last_observation: item.observation_indexes.at(-1) + 1, max_consecutive_streak: maxStreak, disappeared_and_reappeared: reappeared };
  });
  const distribution = {};
  for (const record of records) distribution[record.days_present] = (distribution[record.days_present] || 0) + 1;
  const stableCore = {};
  for (let threshold = 1; threshold <= observations.length; threshold += 1) stableCore[`at_least_${threshold}`] = records.filter((record) => record.days_present >= threshold).length;
  return {
    total_identifiers: records.length,
    seen_exactly_days: distribution,
    stable_core: stableCore,
    disappeared_and_reappeared: records.filter((record) => record.disappeared_and_reappeared).length,
    max_consecutive_streak_distribution: records.reduce((counts, record) => { counts[record.max_consecutive_streak] = (counts[record.max_consecutive_streak] || 0) + 1; return counts; }, {}),
    records,
  };
}

function analyzeSeries({ seriesRoot, seriesId = null, allowIncomplete = true }) {
  const loaded = loadSeries(seriesRoot, seriesId);
  const observations = loadObservations(loaded.root, loaded.series);
  const validCount = observations.length;
  const target = loaded.series.target_valid_observations;
  const complete = validCount === target && loaded.series.lifecycle === "COMPLETE";
  if (!allowIncomplete && !complete) throw new Error("SERIES_INCOMPLETE");
  const perDay = observations.map((observation) => ({
    date: observation.reference.local_calendar_date,
    timestamp: observation.manifest.observation_finished_at,
    raw_unique: observation.sets.raw_unique.size,
    post_b39: observation.sets.post_b39.size,
    current_known: observation.sets.current_known.size,
    current_unknown: observation.sets.current_unknown.size,
    accepted: observation.sets.accepted.size,
    deep_approved: observation.sets.deep_approved.size,
    deep_rejected: observation.sets.deep_rejected.size,
    quarantine: observation.sets.quarantine.size,
    rejection_rate: observation.sets.accepted.size ? observation.sets.deep_rejected.size / observation.sets.accepted.size : 0,
    requests: observation.manifest.provider.requests,
    runtime_ms: observation.manifest.runtime_ms,
    contract_fingerprint: observation.manifest.contract_fingerprint,
  }));
  const adjacentComparisons = [];
  for (let index = 1; index < observations.length; index += 1) {
    const oldSnapshot = observations[index - 1];
    const newSnapshot = observations[index];
    adjacentComparisons.push({
      from: oldSnapshot.reference.local_calendar_date,
      to: newSnapshot.reference.local_calendar_date,
      raw_unique: adjacent(oldSnapshot, newSnapshot, "raw_unique"),
      post_b39: adjacent(oldSnapshot, newSnapshot, "post_b39"),
      current_unknown: adjacent(oldSnapshot, newSnapshot, "current_unknown"),
      accepted: adjacent(oldSnapshot, newSnapshot, "accepted"),
      deep_approved: adjacent(oldSnapshot, newSnapshot, "deep_approved"),
      quarantine: adjacent(oldSnapshot, newSnapshot, "quarantine"),
    });
  }
  const populations = Object.fromEntries(["accepted", "deep_approved", "quarantine"].map((name) => [name, lifetime(observations, name)]));
  const deepApproved = populations.deep_approved;
  const hypotheticalGates = Object.fromEntries(Array.from({ length: validCount }, (_, index) => index + 1).map((threshold) => [`seen_at_least_${threshold}_observations`, deepApproved.stable_core[`at_least_${threshold}`] || 0]));
  const report = {
    schema_version: 1,
    kind: "B46.7_DAILY_OBSERVATION_SERIES_ANALYSIS",
    series_id: loaded.series.series_id,
    lifecycle: loaded.series.lifecycle,
    complete,
    target_valid_observations: target,
    valid_observations: validCount,
    failed_observations: loaded.series.failed_observations,
    expected_contract_fingerprint: loaded.series.expected_contract_fingerprint,
    semantic_contract_id: semanticContractId(loaded.series.contract),
    per_day: perDay,
    adjacent_comparisons: adjacentComparisons,
    populations,
    hypothetical_deep_approved_persistence_gates: hypotheticalGates,
    safety: { sqlite_write_performed: false, production_apply: false, publication_performed: false, scheduler_activation_performed: false },
  };
  report.report_sha256 = sha256(report);
  return report;
}

function writeAnalysisReport(options) {
  const report = analyzeSeries(options);
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : path.join(path.resolve(options.seriesRoot), "analysis.json");
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, outputPath);
  return { report, outputPath };
}

module.exports = { analyzeSeries, comparison, lifetime, loadObservations, loadSeries, writeAnalysisReport };
