"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runObservation } = require("./daily-observation");
const maintenance = require("./maintenance-cycle");
const { writeJsonAtomic } = require("./daily-maintenance");

const DEFAULT_DATABASE = "data/catalog.sqlite";
const DEFAULT_OBSERVATION_ROOT = "runtime/daily-observation";
const DEFAULT_SIDECAR = "runtime/maintenance/history/b39-purged-idents.json";
const DEFAULT_PUBLIC_REPOSITORY = "/home/radeco/ag";
const DEFAULT_STATUS_ROOT = "runtime/production-maintenance";
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCHES = 100;
const CONTINUOUS_OBSERVATION_TARGET = 36500;
const PUBLIC_POINTER_URL = "https://raw.githubusercontent.com/radovanivanic-oss/AG_repo/main/catalog/v1/current.json";

function runId(now = new Date().toISOString()) {
  return now.replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
}

function repositoryCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeStatus(root, value) {
  writeJsonAtomic(path.join(root, "latest.json"), value);
  return value;
}

function safeError(error, stage, cycleId = null) {
  const raw = String(error?.code || error?.message || "PRODUCTION_MAINTENANCE_FAILED");
  const code = raw.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 160) || "PRODUCTION_MAINTENANCE_FAILED";
  return { stage, code, cycle_id: cycleId, at: new Date().toISOString() };
}

function readPointer(repository) {
  const file = path.join(path.resolve(repository), "catalog/v1/current.json");
  const pointer = readJson(file);
  return pointer ? { ...pointer, path: file, url: PUBLIC_POINTER_URL } : { generation_id: null, manifest_sha256: null, path: file, url: PUBLIC_POINTER_URL };
}

function publicSourceStatus(repository, generationId, productionDigest, maintenanceRoot = null) {
  if (!generationId) return { behind: null, source_database_digest: null };
  const manifestPath = path.join(path.resolve(repository), "catalog/v1/generations", generationId, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { behind: null, source_database_digest: null };
  const manifest = readJson(manifestPath);
  let sourceDigest = manifest?.source_database_digest || null;
  const roots = [maintenanceRoot, path.resolve("runtime/stale-weekly/runs")].filter((root, index, all) => root && fs.existsSync(root) && all.indexOf(root) === index);
  if (!sourceDigest) {
    for (const root of roots) {
      for (const name of fs.readdirSync(root)) {
        for (const relative of [path.join(name, "publication-plan.json"), path.join(name, "publication-cycle", "publication-plan.json")]) {
          const plan = readJson(path.join(root, relative));
          if (plan?.generation_id === generationId && plan.source_database_digest) sourceDigest = plan.source_database_digest;
        }
      }
    }
  }
  return { behind: Boolean(productionDigest && sourceDigest && productionDigest !== sourceDigest), source_database_digest: sourceDigest };
}

function latestSuccessfulObservation(observationRoot) {
  const series = readJson(path.join(path.resolve(observationRoot), "series.json"));
  const ref = [...(series?.observations || [])].sort((a, b) => (a.observation_finished_at || "").localeCompare(b.observation_finished_at || "")).at(-1);
  if (!ref) return null;
  const runDir = path.join(path.resolve(observationRoot), ref.artifact_dir);
  const manifest = readJson(path.join(runDir, "manifest.json"));
  if (!manifest) return null;
  return { manifest, summary: readJson(path.join(runDir, "summary.json")), runDir, reused: true };
}

function pendingPublicationCycle(maintenanceRoot) {
  const root = path.resolve(maintenanceRoot);
  if (!fs.existsSync(root)) return null;
  const candidates = [];
  for (const name of fs.readdirSync(root)) {
    const cycleRoot = path.join(root, name);
    let cycleStat;
    try { cycleStat = fs.statSync(cycleRoot); } catch { continue; }
    if (!cycleStat.isDirectory()) continue;
    const cycleState = readJson(path.join(cycleRoot, "state.json"));
    const resumable = cycleState?.state === maintenance.STATES.PUBLICATION_AUTHORIZATION_REQUIRED || cycleState?.state === maintenance.STATES.PUBLICATION_FAILED;
    if (!resumable) continue;
    if (cycleState.state === maintenance.STATES.PUBLICATION_FAILED && (!cycleState.failure || cycleState.failure.rollback !== null)) continue;
    if (!readJson(path.join(cycleRoot, "publication-plan.json")) || !readJson(path.join(cycleRoot, "apply-result.json"))) continue;
    candidates.push({ cycleId: name, cycleRoot, updatedAt: cycleState.updated_at || "" });
  }
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.cycleId.localeCompare(a.cycleId))[0] || null;
}

function timerState() {
  try {
    const output = execFileSync("systemctl", ["show", "webshare-daily-observation.timer", "--property=ActiveState,UnitFileState,NextElapseUSecRealtime"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const fields = Object.fromEntries(output.trim().split(/\r?\n/u).map((line) => line.split("=", 2)));
    let service = {};
    try {
      const serviceOutput = execFileSync("systemctl", ["show", "webshare-daily-observation.service", "--property=ActiveState,Result"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      service = Object.fromEntries(serviceOutput.trim().split(/\r?\n/u).map((line) => line.split("=", 2)));
    } catch {}
    return { enabled: fields.UnitFileState === "enabled", active: fields.ActiveState === "active", next_run: fields.NextElapseUSecRealtime || null, service_state: service.ActiveState || null, service_result: service.Result || null };
  } catch {
    return { enabled: null, active: null, next_run: null, service_state: null, service_result: null };
  }
}

function maintenanceCronState() {
  try {
    const output = execFileSync("systemctl", ["show", "webshare-production-maintenance.timer", "--property=ActiveState,UnitFileState,NextElapseUSecRealtime"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const fields = Object.fromEntries(output.trim().split(/\r?\n/u).map((line) => line.split("=", 2)));
    if (!fields.UnitFileState) throw new Error("production timer not installed");
    return { enabled: fields.UnitFileState === "enabled", active: fields.ActiveState === "active", next_run: fields.NextElapseUSecRealtime || null, schedule: "03:47", timezone: "Europe/Bratislava", mechanism: "systemd" };
  } catch {}
  const summerMarker = "47 1 * 3-10 * TZ=Europe/Bratislava";
  const winterMarker = "47 2 * 11-12,1-2 * TZ=Europe/Bratislava";
  try {
    const crontab = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = crontab.split(/\r?\n/u);
    const enabled = lines.some((line) => line.includes(summerMarker)) && lines.some((line) => line.includes(winterMarker));
    return { enabled, active: null, next_run: null, schedule: "03:47", timezone: "Europe/Bratislava", mechanism: enabled ? "cron-seasonal-tz-guard" : "cron-legacy" };
  } catch {
    return { enabled: false, active: null, next_run: null, schedule: "03:47", timezone: "Europe/Bratislava", mechanism: "cron-legacy" };
  }
}

function latestProductionActivity(maintenanceRoot) {
  const root = path.resolve(maintenanceRoot);
  if (!fs.existsSync(root)) return { apply: null, publication: null };
  const rows = fs.readdirSync(root).map((name) => {
    const cycleRoot = path.join(root, name);
    if (!fs.statSync(cycleRoot).isDirectory()) return null;
    const state = readJson(path.join(cycleRoot, "state.json"));
    const apply = readJson(path.join(cycleRoot, "apply-result.json"));
    const publication = readJson(path.join(cycleRoot, "publication-result.json"));
    const plan = readJson(path.join(cycleRoot, "plan.json"));
    const applyAuthorization = readJson(path.join(cycleRoot, "apply-authorization.json"));
    const publicationAuthorization = readJson(path.join(cycleRoot, "publication-authorization.json")) || readJson(path.join(cycleRoot, "publication-authorization-2.json"));
    return state && apply && publication ? { cycleRoot, state, apply, publication, plan, applyAuthorization, publicationAuthorization } : null;
  }).filter(Boolean).sort((a, b) => (a.publication.created_at || a.apply.created_at || "").localeCompare(b.publication.created_at || b.apply.created_at || ""));
  const row = rows.at(-1);
  if (!row) return { apply: null, publication: null };
  const preMedia = Number(row.apply.preflight?.snapshot?.media || 0);
  const postMedia = Number(row.apply.postflight?.snapshot?.media || 0);
  const result = row.publication.result || {};
  return {
    apply: {
      at: row.apply.created_at || null,
      cycle_id: row.apply.cycle_id,
      files_added: Number(row.apply.inserted_files || 0),
      media_added: Math.max(0, postMedia - preMedia),
      candidates: Number(row.apply.attempted || 0),
      categories: row.plan?.counters || {},
      automatic: row.applyAuthorization?.automatic === true,
    },
    publication: {
      at: row.publication.created_at || null,
      cycle_id: row.publication.cycle_id,
      generation_id: result.generation_id || null,
      release_id: result.release_id || null,
      pointer: result.remote_pointer || null,
      automatic: row.publicationAuthorization?.automatic === true,
      categories: result.b53_to_b55_delta || null,
    },
  };
}

function productionStatus(options = {}) {
  const databasePath = path.resolve(options.database || DEFAULT_DATABASE);
  const observationRoot = path.resolve(options.observationRoot || DEFAULT_OBSERVATION_ROOT);
  const sidecarPath = path.resolve(options.sidecar || DEFAULT_SIDECAR);
  const publicRepository = path.resolve(options.publicRepository || DEFAULT_PUBLIC_REPOSITORY);
  const statusRoot = path.resolve(options.statusRoot || DEFAULT_STATUS_ROOT);
  const maintenanceRoot = path.resolve(options.maintenanceRoot || "runtime/maintenance-cycles");
  const persisted = readJson(path.join(statusRoot, "latest.json")) || {};
  const series = readJson(path.join(observationRoot, "series.json")) || {};
  let health = { snapshot: null, production_baseline_sha256: null, error: null };
  try { health = maintenance.productionHealth(databasePath, sidecarPath); } catch (error) { health.error = safeError(error, "status"); }
  const latestFailure = Array.isArray(series.failures) ? series.failures.at(-1) : null;
  const pointer = readPointer(publicRepository);
  const publicSource = health.snapshot ? publicSourceStatus(publicRepository, pointer.generation_id, health.production_baseline_sha256, path.resolve(options.maintenanceRoot || "runtime/maintenance-cycles")) : { behind: null, source_database_digest: null };
  const frontier = readJson(path.join(observationRoot, "frontier-state.json")) || {};
  const activity = latestProductionActivity(maintenanceRoot);
  const lastError = persisted.last_error || (!persisted.finished_at && latestFailure ? { stage: "discovery", code: latestFailure.error_code, at: latestFailure.observation_finished_at } : null);
  return {
    status: persisted.state === "FAILED" || persisted.state === "DISCOVERY_FAILED" ? "DEGRADED" : "OK",
    last_discovery: series.latest_at || null,
    last_discovery_date: series.observations?.at(-1)?.local_calendar_date || null,
    last_successful_apply: persisted.last_successful_apply || activity.apply,
    files_added: persisted.files_added ?? 0,
    media_added: persisted.media_added ?? 0,
    last_publication: persisted.last_publication || activity.publication,
    current_production_file_count: health.snapshot?.files ?? null,
    current_production_media_count: health.snapshot?.media ?? null,
    current_public_generation: pointer.generation_id,
    public_catalog_behind_production: publicSource.behind,
    public_catalog_source_database_digest: publicSource.source_database_digest,
    public_pointer: pointer.url,
    daily_timer: timerState(),
    daily_maintenance: maintenanceCronState(),
    last_error: lastError,
    last_discovery_failure: latestFailure,
    frontier: { run_count: frontier.run_count || 0, node_count: Object.keys(frontier.nodes || {}).length, saturated_prefixes: Object.values(frontier.nodes || {}).filter((x) => x.saturated).length, expanded_prefixes: Object.values(frontier.nodes || {}).filter((x) => x.children_generated && x.saturated && x.depth < 3).length, backlog: Object.values(frontier.nodes || {}).filter((x) => !x.checked || (x.saturated && !x.children_generated)).length },
    last_run: persisted.finished_at ? { run_id: persisted.run_id, state: persisted.state, started_at: persisted.started_at, finished_at: persisted.finished_at, candidates_processed: persisted.candidates_processed ?? 0, files_added: persisted.files_added ?? 0, media_added: persisted.media_added ?? 0 } : null,
    production_health: health.error ? { error: health.error } : { quick_check: health.quick_check, foreign_key_check: health.foreign_key_check, duplicate_idents: health.duplicate_idents, b39_purged_ident_leakage: health.b39_purged_ident_leakage },
  };
}

function defaultDependencies(options) {
  return {
    observe: (observeOptions) => runObservation(observeOptions),
    prepare: (stageOptions) => maintenance.prepare(stageOptions),
    authorizeApply: (stageOptions) => maintenance.authorizeApply(stageOptions),
    apply: (stageOptions) => maintenance.apply(stageOptions),
    authorizePublication: (stageOptions) => maintenance.authorizePublication(stageOptions),
    publish: (stageOptions) => maintenance.publish(stageOptions),
    supersedeFailedPublication: (stageOptions) => maintenance.supersedeFailedPublication(stageOptions),
    prepareCurrentPublication: (stageOptions) => maintenance.prepareCurrentPublication(stageOptions),
    health: () => maintenance.productionHealth(options.databasePath, options.sidecarPath),
    pointer: () => readPointer(options.publicRepository),
  };
}

async function runAutomaticProductionMaintenance(options = {}) {
  const now = options.now || new Date().toISOString();
  const databasePath = path.resolve(options.database || DEFAULT_DATABASE);
  const observationRoot = path.resolve(options.observationRoot || DEFAULT_OBSERVATION_ROOT);
  const sidecarPath = path.resolve(options.sidecar || DEFAULT_SIDECAR);
  const publicRepository = path.resolve(options.publicRepository || DEFAULT_PUBLIC_REPOSITORY);
  const statusRoot = path.resolve(options.statusRoot || DEFAULT_STATUS_ROOT);
  const maintenanceRoot = path.resolve(options.maintenanceRoot || "runtime/maintenance-cycles");
  const batchSize = Number(options.batchSize || DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) throw new Error("PRODUCTION_BATCH_SIZE_INVALID");
  fs.mkdirSync(statusRoot, { recursive: true, mode: 0o750 });
  const run = `daily-${runId(now)}-${process.pid}`;
  const dependencies = { ...defaultDependencies({ databasePath, sidecarPath, publicRepository }), ...(options.dependencies || {}) };
  let state = { schema_version: 1, kind: "ATLAS_PRODUCTION_MAINTENANCE_STATUS", run_id: run, state: "RUNNING", started_at: now, finished_at: null, last_error: null, files_added: 0, media_added: 0, candidates_processed: 0, cycles: [] };
  writeStatus(statusRoot, state);
  let observation;
  let reusedObservation = false;
  try {
    observation = await dependencies.observe({ seriesRoot: observationRoot, seriesId: options.seriesId || "b46.7-7day-observation", database: databasePath, sidecar: sidecarPath, targetValidObservations: CONTINUOUS_OBSERVATION_TARGET, allowCompletedSeries: true, continuous: true, repositoryCommit: options.repositoryCommit || repositoryCommit() });
  } catch (error) {
    if (error?.code === "OBSERVATION_ALREADY_COMPLETED_FOR_LOCAL_DATE") {
      observation = latestSuccessfulObservation(observationRoot);
      reusedObservation = Boolean(observation);
    }
    if (!observation) {
      state.state = "DISCOVERY_FAILED";
      state.finished_at = new Date().toISOString();
      state.last_error = safeError(error, "discovery");
      writeStatus(statusRoot, state);
      return { status: state.state, run_id: run, last_error: state.last_error };
    }
  }
  state.last_discovery = { observation_finished_at: observation.manifest?.observation_finished_at || observation.summary?.timestamp || null, local_calendar_date: observation.manifest?.local_calendar_date || observation.summary?.local_calendar_date || null, artifact_dir: observation.runDir ? path.relative(process.cwd(), observation.runDir).replaceAll(path.sep, "/") : null, unique_idents: observation.manifest?.discovery?.unique_idents ?? null, accepted: observation.manifest?.plan?.counters?.accepted ?? observation.summary?.accepted ?? null, rejected: observation.manifest?.deep_audit?.rejected ?? observation.summary?.deep_rejected ?? null, reused: reusedObservation };
  writeStatus(statusRoot, state);

  let beforeHealth = null;
  try { beforeHealth = dependencies.health(); } catch (error) { state.last_error = safeError(error, "preflight"); writeStatus(statusRoot, state); throw error; }
  let finalPlan = null;
  let exhausted = false;
  let publishedThisRun = false;
  let failureStage = "apply";
  try {
    const pending = options.resumePublication === false ? null : pendingPublicationCycle(maintenanceRoot);
    if (pending) {
      failureStage = "publication";
      const pendingPlan = readJson(path.join(pending.cycleRoot, "publication-plan.json"));
      const pendingApply = readJson(path.join(pending.cycleRoot, "apply-result.json"));
      const live = dependencies.health();
      let resumed;
      let resumedCycleId = pending.cycleId;
      if (pendingApply.postflight?.production_baseline_sha256 && live.production_baseline_sha256 !== pendingApply.postflight.production_baseline_sha256) {
        await dependencies.supersedeFailedPublication({ cycleId: pending.cycleId, cycleRoot: pending.cycleRoot, reason: "CURRENT_PRODUCTION_SOURCE_ADVANCED" });
        const recoveryId = `${run}-recovery`;
        resumedCycleId = recoveryId;
        const recovery = await dependencies.prepareCurrentPublication({ cycleId: recoveryId, databasePath, sidecarPath, publicRepository, cycleRoot: path.join(maintenanceRoot, recoveryId), createdAt: now });
        const recoveryPlanSha = maintenance.digest(recovery.publicationPlan);
        await dependencies.authorizePublication({ cycleId: recoveryId, cycleRoot: recovery.root, planSha: recoveryPlanSha, confirmation: `AUTHORIZE PUBLICATION ${recoveryId} ${recoveryPlanSha}`, identity: "webshare-atlas-daily", automatic: true });
        resumed = await dependencies.publish({ cycleId: recoveryId, cycleRoot: recovery.root });
      } else {
        const pendingPlanSha = maintenance.digest(pendingPlan);
        await dependencies.authorizePublication({ cycleId: pending.cycleId, cycleRoot: pending.cycleRoot, planSha: pendingPlanSha, confirmation: `AUTHORIZE PUBLICATION ${pending.cycleId} ${pendingPlanSha}`, identity: "webshare-atlas-daily", automatic: true });
        resumed = await dependencies.publish({ cycleId: pending.cycleId, cycleRoot: pending.cycleRoot });
      }
      const resumedResult = resumed.publicationResult?.result || resumed.publicationResult || {};
      state.last_publication = { at: resumed.publicationResult?.created_at || new Date().toISOString(), cycle_id: resumedCycleId, generation_id: resumedResult.generation_id || null, release_id: resumedResult.release_id || null, pointer: resumedResult.remote_pointer || null, automatic: true, resumed: true, fresh_current_snapshot: resumedCycleId !== pending.cycleId, categories: resumedResult.b53_to_b55_delta || null };
      state.cycles.push({ cycle_id: resumedCycleId, superseded_cycle_id: resumedCycleId !== pending.cycleId ? pending.cycleId : null, candidates: resumedCycleId === pending.cycleId ? readJson(path.join(pending.cycleRoot, "apply-result.json"))?.inserted_files || 0 : 0, files_added: 0, generation_id: resumedResult.generation_id || null, resumed_publication: true, fresh_current_snapshot: resumedCycleId !== pending.cycleId });
      publishedThisRun = true;
      writeStatus(statusRoot, state);
      failureStage = "apply";
    }
    for (let index = 0; index < MAX_BATCHES; index += 1) {
      const cycleId = `${run}-${String(index + 1).padStart(3, "0")}`;
      const prepared = await dependencies.prepare({ cycleId, databasePath, observationRoot, sidecarPath, publicRepository, maxCandidates: batchSize, observationCutoff: new Date().toISOString() });
      finalPlan = prepared.plan || null;
      const candidateCount = finalPlan?.discovery_delta?.length || 0;
      state.candidates_processed += candidateCount;
      if (!candidateCount || prepared.state?.state === maintenance.STATES.NO_ELIGIBLE_ITEMS) { exhausted = true; break; }
      failureStage = "apply";
      const applyAuthorization = await dependencies.authorizeApply({ cycleId, cycleRoot: prepared.root, planSha: finalPlan.plan_sha256, candidateSetSha: finalPlan.candidate_set_sha256, confirmation: `AUTHORIZE APPLY ${cycleId} ${finalPlan.plan_sha256}`, identity: "webshare-atlas-daily", automatic: true });
      const applied = await dependencies.apply({ cycleId, cycleRoot: prepared.root });
      const applyResult = applied.result || {};
      const postHealth = applyResult.postflight || dependencies.health();
      const mediaAdded = Number(postHealth.snapshot?.media || postHealth.media || 0) - Number(applyResult.preflight?.snapshot?.media || beforeHealth.snapshot?.media || 0);
      state.files_added += Number(applyResult.inserted_files || 0);
      state.media_added += Math.max(0, mediaAdded);
      state.last_successful_apply = { at: applyResult.created_at || new Date().toISOString(), cycle_id: cycleId, files_added: Number(applyResult.inserted_files || 0), media_added: Math.max(0, mediaAdded), candidates: candidateCount, categories: finalPlan.counters || {}, automatic: applyAuthorization.authorization?.automatic === true || applyAuthorization.state?.state === maintenance.STATES.APPLY_AUTHORIZED };
      writeStatus(statusRoot, state);
      const publicationPlan = applied.publication_plan || readJson(path.join(prepared.root, "publication-plan.json"));
      const publicationPlanSha = maintenance.digest(publicationPlan);
      failureStage = "publication";
      const publicationAuthorization = await dependencies.authorizePublication({ cycleId, cycleRoot: prepared.root, planSha: publicationPlanSha, confirmation: `AUTHORIZE PUBLICATION ${cycleId} ${publicationPlanSha}`, identity: "webshare-atlas-daily", automatic: true });
      const published = await dependencies.publish({ cycleId, cycleRoot: prepared.root });
      const publicationResult = published.publicationResult?.result || published.publicationResult || {};
      state.last_publication = { at: published.publicationResult?.created_at || new Date().toISOString(), cycle_id: cycleId, generation_id: publicationResult.generation_id || null, release_id: publicationResult.release_id || null, pointer: publicationResult.remote_pointer || null, automatic: publicationAuthorization.authorization?.automatic === true, categories: publicationResult.b53_to_b55_delta || null };
      state.cycles.push({ cycle_id: cycleId, candidates: candidateCount, files_added: Number(applyResult.inserted_files || 0), generation_id: publicationResult.generation_id || null });
      writeStatus(statusRoot, state);
      publishedThisRun = true;
      beforeHealth = postHealth;
      failureStage = "apply";
    }
    if (!exhausted) throw new Error("PRODUCTION_BATCH_LIMIT_REACHED");
    const afterHealth = dependencies.health();
    const pointer = dependencies.pointer();
    state.state = state.files_added > 0 || publishedThisRun ? "COMPLETE" : "NO_CHANGES";
    state.finished_at = new Date().toISOString();
    state.current_production = { files: afterHealth.snapshot?.files ?? null, media: afterHealth.snapshot?.media ?? null, digest: afterHealth.production_baseline_sha256 || null };
    state.current_public = { generation_id: pointer.generation_id || null, manifest_sha256: pointer.manifest_sha256 || null, url: pointer.url || PUBLIC_POINTER_URL };
    state.last_error = null;
    writeStatus(statusRoot, state);
    return { status: state.state, run_id: run, observation: state.last_discovery, candidates_processed: state.candidates_processed, files_added: state.files_added, media_added: state.media_added, last_publication: state.last_publication, current_public: state.current_public, final_plan: finalPlan ? { eligible_count: finalPlan.counters?.planned || 0, counters: finalPlan.counters } : null };
  } catch (error) {
    state.state = "FAILED";
    state.finished_at = new Date().toISOString();
    state.last_error = safeError(error, failureStage, state.last_successful_apply?.cycle_id || null);
    writeStatus(statusRoot, state);
    throw error;
  }
}

module.exports = { CONTINUOUS_OBSERVATION_TARGET, DEFAULT_BATCH_SIZE, PUBLIC_POINTER_URL, productionStatus, repositoryCommit, runAutomaticProductionMaintenance, runId, safeError, timerState };
