
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { acquireCrawlerLock } = require("./crawler/lock");
const { B46_DEFAULT_POLICY, applyDailyPlan, snapshotDatabase, stableJson: dbJson } = require("./daily-maintenance");
const { buildObservationContract, compatibleObservationContracts, digestIdents, readManifest, semanticContractId, sha256, stableJson } = require("./daily-observation");
const { B47_DEEP_AUDIT_POLICY_VERSION, HARD_MAX_ACCEPTED_ITEMS, MIN_INDEPENDENT_OBSERVATIONS, buildEligibilityArtifact, buildPilotPlan, derivePersistenceLedger } = require("./b47-persistence");
const { readAndValidatePurgedSidecar } = require("./daily-candidate-provenance");
const { buildPublicCatalog, validatePublicCatalog } = require("./public-catalog");

const CONTRACT_VERSION = "webshare-maintenance-cycle/v1";
const DEFAULT_PLAN_SIZE = 500;
const HARD_PLAN_SIZE = 1000;
const DEFAULT_DB = "data/catalog.sqlite";
const DEFAULT_OBSERVATIONS = "runtime/daily-observation";
const DEFAULT_SIDECAR = "runtime/maintenance/history/b39-purged-idents.json";
const DEFAULT_PUBLIC_REPOSITORY = "/home/radeco/ag";
const LOCK_PATH = "runtime/maintenance-cycles/.maintenance-cycle.lock";

const STATES = Object.freeze({
  CREATED: "CREATED", OBSERVATIONS_SELECTED: "OBSERVATIONS_SELECTED", PERSISTENCE_REFRESHED: "PERSISTENCE_REFRESHED",
  ELIGIBILITY_READY: "ELIGIBILITY_READY", PLAN_READY: "PLAN_READY", APPLY_AUTHORIZATION_REQUIRED: "APPLY_AUTHORIZATION_REQUIRED",
  APPLY_AUTHORIZED: "APPLY_AUTHORIZED", APPLY_RUNNING: "APPLY_RUNNING", APPLY_VERIFIED: "APPLY_VERIFIED",
  PUBLICATION_AUTHORIZATION_REQUIRED: "PUBLICATION_AUTHORIZATION_REQUIRED", PUBLICATION_AUTHORIZED: "PUBLICATION_AUTHORIZED",
  PUBLICATION_RUNNING: "PUBLICATION_RUNNING", PUBLICATION_VERIFIED: "PUBLICATION_VERIFIED", COMPLETE: "COMPLETE",
  NO_ELIGIBLE_ITEMS: "NO_ELIGIBLE_ITEMS", BLOCKED: "BLOCKED", APPLY_FAILED: "APPLY_FAILED", APPLY_ROLLED_BACK: "APPLY_ROLLED_BACK",
  PUBLICATION_FAILED: "PUBLICATION_FAILED", PUBLICATION_ROLLED_BACK: "PUBLICATION_ROLLED_BACK",
});
const TERMINAL_STATES = new Set([STATES.COMPLETE, STATES.NO_ELIGIBLE_ITEMS, STATES.APPLY_ROLLED_BACK, STATES.PUBLICATION_ROLLED_BACK]);
const TRANSITIONS = Object.freeze({
  CREATED: new Set(["OBSERVATIONS_SELECTED", "BLOCKED"]),
  OBSERVATIONS_SELECTED: new Set(["PERSISTENCE_REFRESHED", "BLOCKED"]),
  PERSISTENCE_REFRESHED: new Set(["ELIGIBILITY_READY", "BLOCKED"]),
  ELIGIBILITY_READY: new Set(["PLAN_READY", "BLOCKED"]),
  PLAN_READY: new Set(["APPLY_AUTHORIZATION_REQUIRED", "NO_ELIGIBLE_ITEMS", "BLOCKED"]),
  APPLY_AUTHORIZATION_REQUIRED: new Set(["APPLY_AUTHORIZED", "BLOCKED"]),
  APPLY_AUTHORIZED: new Set(["APPLY_RUNNING", "BLOCKED"]),
  APPLY_RUNNING: new Set(["APPLY_VERIFIED", "APPLY_FAILED", "APPLY_ROLLED_BACK"]),
  APPLY_VERIFIED: new Set(["PUBLICATION_AUTHORIZATION_REQUIRED", "BLOCKED"]),
  PUBLICATION_AUTHORIZATION_REQUIRED: new Set(["PUBLICATION_AUTHORIZED", "BLOCKED"]),
  PUBLICATION_AUTHORIZED: new Set(["PUBLICATION_RUNNING", "BLOCKED"]),
  PUBLICATION_RUNNING: new Set(["PUBLICATION_VERIFIED", "PUBLICATION_FAILED", "PUBLICATION_ROLLED_BACK"]),
  PUBLICATION_VERIFIED: new Set(["COMPLETE", "PUBLICATION_FAILED"]),
  COMPLETE: new Set(), NO_ELIGIBLE_ITEMS: new Set(), BLOCKED: new Set(["APPLY_ROLLED_BACK", "PUBLICATION_ROLLED_BACK"]),
  APPLY_FAILED: new Set(["APPLY_ROLLED_BACK", "BLOCKED"]), APPLY_ROLLED_BACK: new Set(),
  PUBLICATION_FAILED: new Set(["PUBLICATION_ROLLED_BACK", "BLOCKED"]), PUBLICATION_ROLLED_BACK: new Set(),
});
const RANKING_POLICY = Object.freeze({ id: "b47-persistence-strength-v1", order: ["observation_count DESC", "consecutive_observation_count DESC", "deep_audit_approved_observations DESC", "ident ASC"], upload_dates_used: false });

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function gitHead(cwd = process.cwd()) { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; } }
function safeId(id) { if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id.includes("..")) throw new Error("CYCLE_ID_INVALID"); return id; }
function runId(now = new Date().toISOString()) { return now.replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z"); }
function digest(value) { return sha256(value); }
function rawDigest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileDigest(file) { const h = crypto.createHash("sha256"); return new Promise((resolve, reject) => { const s = fs.createReadStream(file); s.on("data", (c) => h.update(c)); s.on("error", reject); s.on("end", () => resolve(h.digest("hex"))); }); }
function writeNew(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 }); const fd = fs.openSync(file, "wx", 0o640); try { fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeAtomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 }); const tmp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp"; writeNew(tmp, value); fs.renameSync(tmp, file); }
function writeImmutable(file, value) { if (fs.existsSync(file)) throw new Error("IMMUTABLE_ARTIFACT_EXISTS:" + file); assertNoSecrets(value); writeNew(file, value); }
function assertNoSecrets(value) { if (/(?:wst|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]/iu.test(JSON.stringify(value))) throw new Error("SECRET_MATERIAL_IN_ARTIFACT"); }
function state(root) { return readJson(path.join(root, "state.json")); }
function history(root, value) { fs.appendFileSync(path.join(root, "state-history.jsonl"), JSON.stringify(value) + "\n", { mode: 0o640 }); }
function transition(root, next, details = {}) { const current = state(root); if (!(TRANSITIONS[current.state] || new Set()).has(next)) throw new Error("ILLEGAL_CYCLE_TRANSITION:" + current.state + "->" + next); const value = { ...current, ...details, state: next, updated_at: new Date().toISOString() }; writeAtomic(path.join(root, "state.json"), value); history(root, value); return value; }
function lock(cycleId, stage) { return acquireCrawlerLock(path.resolve(LOCK_PATH), "maintenance-" + cycleId + "-" + stage, { recoverStale: true }); }

function publicBaseline(repository) {
  const root = path.resolve(repository), file = path.join(root, "catalog/v1/current.json");
  if (!fs.existsSync(file)) return { repository: root, pointer_path: file, status: "UNAVAILABLE" };
  const bytes = fs.readFileSync(file), pointer = JSON.parse(bytes);
  let branch = "unknown"; try { branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(); } catch {}
  return { repository: root, branch, commit: gitHead(root), pointer_path: file, pointer_sha256: rawDigest(bytes), generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, pointer, status: "AVAILABLE" };
}

function productionHealth(databasePath, sidecarPath) {
  const sidecar = readAndValidatePurgedSidecar(path.resolve(sidecarPath));
  const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    const snap = snapshotDatabase(db), fk = db.pragma("foreign_key_check");
    const dupId = Number(db.prepare("SELECT COUNT(*) AS count FROM (SELECT ident FROM files GROUP BY ident HAVING COUNT(*) > 1)").get().count);
    const dupOwn = Number(db.prepare("SELECT COUNT(*) AS count FROM (SELECT ident, media_id FROM files GROUP BY ident, media_id HAVING COUNT(*) > 1)").get().count);
    const tomb = new Set(sidecar.idents); let leakage = 0;
    for (const row of db.prepare("SELECT ident FROM files").iterate()) if (tomb.has(row.ident)) leakage++;
    return { snapshot: snap, quick_check: db.pragma("quick_check", { simple: true }), foreign_key_check: fk.length, duplicate_idents: dupId, duplicate_ownership: dupOwn, unclassified: Number(snap.unclassified), b39_purged_ident_leakage: leakage, b39_sidecar_sha256: sidecar.idents_sha256, production_baseline_sha256: digest(snap) };
  } finally { db.close(); }
}

function inventory(options) {
  const root = path.resolve(options.observationRoot), seriesFile = path.join(root, "series.json");
  if (!fs.existsSync(seriesFile)) throw new Error("OBSERVATION_SERIES_MISSING");
  const series = readJson(seriesFile), refs = new Map((series.observations || []).map((x) => [x.artifact_dir, x])), entries = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name); if (name.startsWith(".") || !fs.statSync(dir).isDirectory()) continue;
    const mp = path.join(dir, "manifest.json"), fp = path.join(dir, "failure.json");
    if (fs.existsSync(mp)) {
      let manifest = null, error = null; try { manifest = readManifest(dir); } catch (e) { error = e.message; }
      if (!manifest) { entries.push({ artifact_dir: name, status: "INVALID", source: refs.has(name) ? "series" : "unreferenced", error }); continue; }
      const compatible = compatibleObservationContracts(options.expectedContract, manifest.contract);
      const diagnostic = Boolean(manifest.diagnostic) || /-diagnostic(?:-|$)/u.test(name);
      entries.push({ artifact_dir: name, status: compatible.compatible ? "SUCCESS_COMPATIBLE" : "SUCCESS_INCOMPATIBLE", source: refs.has(name) ? "series" : "unreferenced", diagnostic, diagnostic_reason: diagnostic ? (manifest.diagnostic ? "MANIFEST_FLAG" : "ARTIFACT_NAME") : null, local_calendar_date: manifest.local_calendar_date || refs.get(name)?.local_calendar_date || null, observation_finished_at: manifest.observation_finished_at || refs.get(name)?.observation_finished_at || null, manifest_sha256: manifest.manifest_sha256, contract_fingerprint: manifest.contract_fingerprint, semantic_contract_id: semanticContractId(manifest.contract), file_sha256: rawDigest(fs.readFileSync(mp)) });
    } else if (fs.existsSync(fp)) {
      let failure = null; try { failure = readJson(fp); } catch {}
      entries.push({ artifact_dir: name, status: "FAILED", source: refs.has(name) ? "series" : "unreferenced", local_calendar_date: failure?.local_calendar_date || refs.get(name)?.local_calendar_date || null, observation_finished_at: failure?.observation_finished_at || null, error_code: failure?.error_code || null, failure_metadata: failure?.failure_metadata || null, file_sha256: rawDigest(fs.readFileSync(fp)) });
    }
  }
  const cutoff = new Date(options.cutoff), eligible = entries.filter((x) => x.status === "SUCCESS_COMPATIBLE" && !x.diagnostic && x.observation_finished_at && new Date(x.observation_finished_at) <= cutoff).sort((a, b) => (a.observation_finished_at || "").localeCompare(b.observation_finished_at || "") || a.artifact_dir.localeCompare(b.artifact_dir));
  const selected = [], excluded = [], dates = new Set();
  for (const entry of eligible) { if (dates.has(entry.local_calendar_date)) excluded.push({ artifact_dir: entry.artifact_dir, local_calendar_date: entry.local_calendar_date, reason: "DUPLICATE_INDEPENDENT_CALENDAR_DATE" }); else { dates.add(entry.local_calendar_date); selected.push(entry); } }
  return { schema_version: 1, kind: "B54_OBSERVATION_INVENTORY", observation_root: root, cutoff: options.cutoff, expected_semantic_contract_id: semanticContractId(options.expectedContract), series: { series_id: series.series_id || null, target_valid_observations: series.target_valid_observations || null, successful_observations: series.successful_observations || 0, failed_observations: series.failed_observations || 0 }, entries, selected, duplicate_date_exclusions: excluded, counts: { total_artifacts: entries.length, compatible_successes: entries.filter((x) => x.status === "SUCCESS_COMPATIBLE").length, incompatible_successes: entries.filter((x) => x.status === "SUCCESS_INCOMPATIBLE").length, failed: entries.filter((x) => x.status === "FAILED").length, invalid: entries.filter((x) => x.status === "INVALID").length, diagnostic_only: entries.filter((x) => x.diagnostic).length, duplicate_date_exclusions: excluded.length, selected_independent_successes: selected.length } };
}

function freezeObservations(inv, root) {
  const sourceRoot = path.join(root, ".source-observations"); if (fs.existsSync(sourceRoot)) throw new Error("SOURCE_OBSERVATION_SNAPSHOT_EXISTS"); fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o750 });
  const refs = [];
  for (const entry of inv.selected) { const target = path.join(sourceRoot, entry.artifact_dir); fs.cpSync(path.join(inv.observation_root, entry.artifact_dir), target, { recursive: true, force: false, errorOnExist: true }); const manifest = readManifest(target); refs.push({ status: "SUCCESS", observation_started_at: manifest.observation_started_at, observation_finished_at: entry.observation_finished_at, local_calendar_date: entry.local_calendar_date, artifact_dir: entry.artifact_dir, manifest_sha256: entry.manifest_sha256, contract_fingerprint: entry.contract_fingerprint, sets: manifest.sets }); }
  const contract = buildObservationContract({ repositoryCommit: gitHead() });
  writeNew(path.join(sourceRoot, "series.json"), { schema_version: 1, kind: "B46.7_DAILY_OBSERVATION_SERIES", series_id: inv.series.series_id || "b54-cycle-series", lifecycle: "FROZEN_FOR_MAINTENANCE_CYCLE", started_at: refs[0]?.observation_started_at || null, latest_at: refs.at(-1)?.observation_finished_at || null, completed_at: null, target_valid_observations: refs.length, successful_observations: refs.length, failed_observations: 0, expected_contract_fingerprint: contract.fingerprint, contract, observations: refs, failures: [], created_at: new Date().toISOString() });
  return { sourceRoot, seriesId: inv.series.series_id || "b54-cycle-series" };
}

function cycleContract(options, health, inv, pub) {
  const c = buildObservationContract({ repositoryCommit: gitHead() });
  return { schema_version: 1, contract_version: CONTRACT_VERSION, kind: "B54_MAINTENANCE_CYCLE", cycle_id: options.cycleId, created_at: options.createdAt, observation_cutoff: options.cutoff, semantic_contract_id: semanticContractId(c), implementation_build_id: "maintenance-orchestrator-v1@" + gitHead(), semantic_contract: { query_portfolio: c.query_portfolio, category: c.category, sort: c.sort, page_size: c.page_size, max_pages_per_query: c.max_pages_per_query, max_requests: c.max_requests, b39_sidecar: c.b39_sidecar, classifier_policy_version: c.classifier_policy_version, deep_audit_policy_version: c.deep_audit_policy_version, production_apply: false, state_advancement: false }, observation_source: { root: path.resolve(options.observationRoot), selected_independent_dates: inv.selected.map((x) => x.local_calendar_date), selected_artifacts: inv.selected.map((x) => x.artifact_dir), duplicate_date_exclusions: inv.duplicate_date_exclusions }, production_database_path: path.resolve(options.databasePath), observation_root: path.resolve(options.observationRoot), sidecar_path: path.resolve(options.sidecarPath), public_repository: path.resolve(options.publicRepository), production_baseline_sha256: health.production_baseline_sha256, production_baseline: health.snapshot, b39_sidecar_sha256: health.b39_sidecar_sha256, public_baseline: pub, deep_audit_policy_version: B47_DEEP_AUDIT_POLICY_VERSION, ranking_policy: RANKING_POLICY, default_plan_size: options.maxCandidates, hard_plan_size: HARD_PLAN_SIZE, authorization_boundaries: { apply: "bound authorization artifact + exact plan + baseline", publication: "bound authorization artifact + exact publication plan + pointer", daily_observation: "independent read-only timer", weekly_stale: "separate disabled track" }, state: STATES.CREATED };
}

function artifactIndex(root, cycle) {
  const names = ["cycle.json", "observation-inventory.json", "persistence-ledger.json", "eligibility.json", "candidate-set.json", "plan.json", "dry-run-validation.json", "apply-authorization.json", "apply-intent.json", "apply-result.json", "publication-plan.json", "publication-authorization.json", "publication-result.json"], artifacts = {};
  for (const name of names) { const file = path.join(root, name); if (fs.existsSync(file)) artifacts[name] = { file_sha256: rawDigest(fs.readFileSync(file)), canonical_sha256: digest(readJson(file)), bytes: fs.statSync(file).size }; }
  const index = { schema_version: 1, kind: "B54_MAINTENANCE_CYCLE_ARTIFACT_INDEX", contract_version: CONTRACT_VERSION, cycle_id: cycle.cycle_id, updated_at: new Date().toISOString(), artifacts, bindings: { semantic_contract_id: cycle.semantic_contract_id, b39_sidecar_sha256: cycle.b39_sidecar_sha256, production_baseline_sha256: cycle.production_baseline_sha256, public_baseline: cycle.public_baseline } };
  assertNoSecrets(index); writeAtomic(path.join(root, "artifact-index.json"), index); return index;
}

function createCycle(options) {
  const cycleId = safeId(options.cycleId), root = path.resolve(options.cycleRoot || path.join("runtime/maintenance-cycles", cycleId));
  if (fs.existsSync(root)) throw new Error("CYCLE_ALREADY_EXISTS"); fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const health = productionHealth(options.databasePath, options.sidecarPath), inv = inventory({ observationRoot: options.observationRoot, cutoff: options.cutoff, expectedContract: buildObservationContract({ repositoryCommit: gitHead() }) }), pub = publicBaseline(options.publicRepository);
  const cycle = cycleContract(options, health, inv, pub); writeImmutable(path.join(root, "cycle.json"), cycle);
  const initial = { schema_version: 1, kind: "B54_MAINTENANCE_CYCLE_STATE", cycle_id: cycleId, state: STATES.CREATED, created_at: options.createdAt, updated_at: options.createdAt, failure: null, next_action: "prepare" };
  writeImmutable(path.join(root, "state.json"), initial); history(root, initial); artifactIndex(root, cycle); return { root, cycle, state: initial };
}

function candidateSet(plan, ledger, cycle) {
  return { schema_version: 1, kind: "B54_CANDIDATE_SET", cycle_id: cycle.cycle_id, semantic_contract_id: cycle.semantic_contract_id, source_observation_ids: cycle.observation_source.selected_artifacts, source_observation_digests: ledger.source_observations, production_baseline_sha256: cycle.production_baseline_sha256, b39_sidecar_sha256: cycle.b39_sidecar_sha256, ranking_policy: RANKING_POLICY, count: plan.discovery_delta.length, identifiers: plan.discovery_delta.map((x) => x.ident), candidate_set_sha256: plan.candidate_set_sha256, classification_counts: plan.counters };
}

function validatePlan(cycle, root, dbPath, sidecarPath) {
  const plan = readJson(path.join(root, "plan.json")), ledger = readJson(path.join(root, "persistence-ledger.json")), candidates = readJson(path.join(root, "candidate-set.json"));
  if (sha256(require("./daily-maintenance").planDigestInput(plan)) !== plan.plan_sha256) throw new Error("CYCLE_PLAN_DIGEST_MISMATCH");
  const planIdentifiers = plan.discovery_delta.map((x) => x.ident);
  if (candidates.candidate_set_sha256 !== plan.candidate_set_sha256 || candidates.identifiers.length !== planIdentifiers.length || new Set(candidates.identifiers).size !== candidates.identifiers.length || digestIdents(candidates.identifiers) !== plan.candidate_set_sha256 || candidates.identifiers.some((ident, index) => ident !== planIdentifiers[index])) throw new Error("CYCLE_CANDIDATE_SET_MISMATCH");
  if (plan.discovery_delta.length > Number(cycle.default_plan_size || DEFAULT_PLAN_SIZE) || plan.discovery_delta.length > HARD_PLAN_SIZE || plan.discovery_delta.length > HARD_MAX_ACCEPTED_ITEMS || plan.discovery_delta.some((x) => x.action !== "INSERT") || plan.deactivations?.length || plan.safety?.deactivation || plan.safety?.deletion || plan.safety?.reconciliation || plan.safety?.publication || plan.safety?.state_advance) throw new Error("CYCLE_PLAN_NOT_SAFE");
  const sidecar = readAndValidatePurgedSidecar(path.resolve(sidecarPath)); if (sidecar.idents_sha256 !== cycle.b39_sidecar_sha256 || plan.b39_sidecar_sha256 !== sidecar.idents_sha256) throw new Error("CYCLE_B39_MISMATCH");
  const records = new Map(ledger.records.map((x) => [x.ident, x]));
  for (const row of plan.discovery_delta) { const r = records.get(row.ident); if (!r || r.state !== "ELIGIBLE" || r.observation_count < MIN_INDEPENDENT_OBSERVATIONS || r.deep_audit_state !== "APPROVED" || r.b39_tombstoned || r.production_known || r.ownership_conflict || r.ambiguous_grouping) throw new Error("CYCLE_CANDIDATE_SAFETY_MISMATCH"); }
  const health = productionHealth(dbPath, sidecarPath); if (dbJson(health.snapshot) !== dbJson(cycle.production_baseline)) throw new Error("CYCLE_DATABASE_BASELINE_DRIFT");
  const db = openCatalogDatabase(path.resolve(dbPath), { readonly: true, fileMustExist: true }); try { const present = plan.discovery_delta.filter((x) => db.prepare("SELECT 1 FROM files WHERE ident = ?").get(x.ident)); if (present.length) throw new Error("CYCLE_CANDIDATE_ALREADY_KNOWN:" + present.length); } finally { db.close(); }
  return { plan, ledger, candidates, health };
}

function prepare(options = {}) {
  const values = { databasePath: path.resolve(options.databasePath || DEFAULT_DB), observationRoot: path.resolve(options.observationRoot || DEFAULT_OBSERVATIONS), sidecarPath: path.resolve(options.sidecarPath || DEFAULT_SIDECAR), publicRepository: path.resolve(options.publicRepository || DEFAULT_PUBLIC_REPOSITORY), createdAt: options.createdAt || new Date().toISOString(), cutoff: options.observationCutoff || new Date().toISOString(), maxCandidates: Number(options.maxCandidates || DEFAULT_PLAN_SIZE), cycleId: safeId(options.cycleId || "cycle-" + runId()) };
  if (!Number.isInteger(values.maxCandidates) || values.maxCandidates < 0 || values.maxCandidates > DEFAULT_PLAN_SIZE) throw new Error("PLAN_SIZE_INVALID");
  const root = path.resolve(options.cycleRoot || path.join("runtime/maintenance-cycles", values.cycleId)), l = lock(values.cycleId, "prepare");
  try {
    if (fs.existsSync(root)) {
      const loaded = readCycle(values.cycleId, root);
      if ([STATES.PLAN_READY, STATES.APPLY_AUTHORIZATION_REQUIRED].includes(loaded.state.state)) {
        try {
          const validation = validatePlan(loaded.cycle, root, loaded.cycle.production_database_path, loaded.cycle.sidecar_path);
          return { ...loaded, resumed: true, validation };
        } catch (error) {
          const blocked = { ...loaded.state, state: STATES.BLOCKED, failure: { stage: "resume-validation", code: error.message }, next_action: "inspect-blocker", updated_at: new Date().toISOString() };
          writeAtomic(path.join(root, "state.json"), blocked); history(root, blocked); throw error;
        }
      }
      if (loaded.state.state === STATES.NO_ELIGIBLE_ITEMS) return { ...loaded, resumed: true };
      throw new Error("CYCLE_EXISTS_NOT_RESUMABLE:" + loaded.state.state);
    }
    const made = createCycle({ ...values, cycleRoot: root }); transition(root, STATES.OBSERVATIONS_SELECTED, { next_action: "persistence-refresh" });
    const inv = inventory({ observationRoot: values.observationRoot, cutoff: values.cutoff, expectedContract: buildObservationContract({ repositoryCommit: gitHead() }) }); writeImmutable(path.join(root, "observation-inventory.json"), inv);
    const frozen = freezeObservations(inv, root), ledger = derivePersistenceLedger({ seriesRoot: frozen.sourceRoot, seriesId: frozen.seriesId, databasePath: values.databasePath, sidecarPath: values.sidecarPath });
    const ledgerFile = { ...ledger, cycle_id: values.cycleId, source_observation_cutoff: values.cutoff, tool_build_identity: { tool: "b54-maintenance-orchestrator", version: "v1", repository_commit: gitHead() } }; writeImmutable(path.join(root, "persistence-ledger.json"), ledgerFile); transition(root, STATES.PERSISTENCE_REFRESHED, { next_action: "eligibility" });
    const eligibility = buildEligibilityArtifact({ ledger: ledgerFile, createdAt: made.cycle.created_at, toolBuildIdentity: ledgerFile.tool_build_identity }); writeImmutable(path.join(root, "eligibility.json"), eligibility); transition(root, STATES.ELIGIBILITY_READY, { next_action: "plan" });
    const plan = buildPilotPlan({ ledger: ledgerFile, eligibilitySha256: eligibility.eligibility_sha256, createdAt: made.cycle.created_at, sourceSeriesRoot: path.relative(process.cwd(), values.observationRoot).replaceAll(path.sep, "/"), toolBuildIdentity: ledgerFile.tool_build_identity, maxCandidates: values.maxCandidates });
    const cs = candidateSet(plan, ledgerFile, made.cycle); writeImmutable(path.join(root, "candidate-set.json"), cs); writeImmutable(path.join(root, "plan.json"), plan);
    const check = validatePlan(made.cycle, root, values.databasePath, values.sidecarPath); writeImmutable(path.join(root, "dry-run-validation.json"), { schema_version: 1, kind: "B54_DRY_RUN_VALIDATION", cycle_id: values.cycleId, plan_sha256: plan.plan_sha256, candidate_set_sha256: plan.candidate_set_sha256, candidate_count: plan.discovery_delta.length, validation: { valid: true, baseline: check.health.production_baseline_sha256 }, safety: { sqlite_write_performed: false, production_apply: false, publication: false, automatic_import: false } });
    if (plan.discovery_delta.length) { transition(root, STATES.PLAN_READY, { next_action: "authorize-apply", plan_sha256: plan.plan_sha256, candidate_set_sha256: plan.candidate_set_sha256, candidate_count: plan.discovery_delta.length }); transition(root, STATES.APPLY_AUTHORIZATION_REQUIRED, { next_action: "authorize-apply" }); } else transition(root, STATES.NO_ELIGIBLE_ITEMS, { next_action: "none", plan_sha256: plan.plan_sha256, candidate_set_sha256: plan.candidate_set_sha256, candidate_count: 0 });
    artifactIndex(root, made.cycle); return { root, cycle: made.cycle, state: state(root), inventory: inv, ledger: ledgerFile, eligibility, plan, validation: check };
  } catch (error) {
    if (fs.existsSync(path.join(root, "state.json"))) { try { const s = state(root); if (!TERMINAL_STATES.has(s.state) && s.state !== STATES.APPLY_AUTHORIZATION_REQUIRED) { const b = { ...s, state: STATES.BLOCKED, failure: { stage: "prepare", code: error.message }, next_action: "inspect-blocker", updated_at: new Date().toISOString() }; writeAtomic(path.join(root, "state.json"), b); history(root, b); } } catch {} }
    throw error;
  } finally { l.release(); }
}

function readCycle(cycleId, cycleRoot) { const id = safeId(cycleId), root = path.resolve(cycleRoot || path.join("runtime/maintenance-cycles", id)); if (!fs.existsSync(path.join(root, "cycle.json")) || !fs.existsSync(path.join(root, "state.json"))) throw new Error("CYCLE_NOT_FOUND"); const cycle = readJson(path.join(root, "cycle.json")); if (cycle.cycle_id !== id) throw new Error("CYCLE_IDENTITY_MISMATCH"); return { root, cycle, state: state(root) }; }
function authPhrase(kind, id, hash) { return "AUTHORIZE " + kind + " " + id + " " + hash; }

function authorizeApply(options) {
  const loaded = readCycle(options.cycleId, options.cycleRoot), l = lock(loaded.cycle.cycle_id, "authorize-apply");
  try {
    if (state(loaded.root).state !== STATES.APPLY_AUTHORIZATION_REQUIRED) throw new Error("APPLY_AUTHORIZATION_NOT_EXPECTED");
    const plan = readJson(path.join(loaded.root, "plan.json")), cs = readJson(path.join(loaded.root, "candidate-set.json"));
    if (options.planSha !== plan.plan_sha256 || (options.candidateSetSha && options.candidateSetSha !== cs.candidate_set_sha256)) throw new Error("APPLY_AUTHORIZATION_IDENTITY_MISMATCH");
    const phrase = authPhrase("APPLY", loaded.cycle.cycle_id, plan.plan_sha256); if (options.confirmation !== phrase) throw new Error("APPLY_AUTHORIZATION_TYPED_CONFIRMATION_MISMATCH");
    const auth = { schema_version: 1, kind: "B54_APPLY_AUTHORIZATION", cycle_id: loaded.cycle.cycle_id, plan_sha256: plan.plan_sha256, candidate_set_sha256: cs.candidate_set_sha256, production_baseline_sha256: loaded.cycle.production_baseline_sha256, candidate_count: plan.discovery_delta.length, authorization_identity: options.identity || "operator", authorized_at: options.authorizedAt || new Date().toISOString(), confirmation_identity: phrase, reusable: false };
    writeImmutable(path.join(loaded.root, "apply-authorization.json"), auth); const next = transition(loaded.root, STATES.APPLY_AUTHORIZED, { next_action: "apply", apply_authorization_sha256: digest(auth) }); artifactIndex(loaded.root, loaded.cycle); return { ...loaded, state: next, authorization: auth };
  } finally { l.release(); }
}

async function backup(databasePath, backupPath, expected) {
  const source = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true }); try { fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o750 }); if (fs.existsSync(backupPath)) throw new Error("BACKUP_ALREADY_EXISTS"); await source.backup(path.resolve(backupPath)); } finally { source.close(); }
  const db = openCatalogDatabase(path.resolve(backupPath), { readonly: true, fileMustExist: true }); try { const snap = snapshotDatabase(db), quick = db.pragma("quick_check", { simple: true }), fk = db.pragma("foreign_key_check").length, raw = await fileDigest(backupPath); if (quick !== "ok" || fk || dbJson(snap) !== dbJson(expected)) throw new Error("BACKUP_VALIDATION_FAILED"); return { path: path.resolve(backupPath), bytes: fs.statSync(backupPath).size, sha256: raw, quick_check: quick, foreign_key_check: fk, snapshot: snap }; } finally { db.close(); }
}
function present(databasePath, plan) { const db = openCatalogDatabase(path.resolve(databasePath), { readonly: true, fileMustExist: true }); try { return plan.discovery_delta.filter((x) => db.prepare("SELECT 1 FROM files WHERE ident = ?").get(x.ident)).map((x) => x.ident); } finally { db.close(); } }

async function apply(options) {
  const loaded = readCycle(options.cycleId, options.cycleRoot), l = lock(loaded.cycle.cycle_id, "apply");
  try {
    const s = state(loaded.root); if ([STATES.PUBLICATION_AUTHORIZATION_REQUIRED, STATES.PUBLICATION_AUTHORIZED, STATES.PUBLICATION_RUNNING, STATES.PUBLICATION_VERIFIED, STATES.COMPLETE].includes(s.state)) return { ...loaded, resumed: true };
    if (s.state !== STATES.APPLY_AUTHORIZED) throw new Error("APPLY_NOT_AUTHORIZED:" + s.state);
    const plan = readJson(path.join(loaded.root, "plan.json")), auth = readJson(path.join(loaded.root, "apply-authorization.json"));
    if (auth.plan_sha256 !== plan.plan_sha256 || auth.candidate_set_sha256 !== plan.candidate_set_sha256 || auth.production_baseline_sha256 !== loaded.cycle.production_baseline_sha256 || auth.candidate_count !== plan.discovery_delta.length) throw new Error("APPLY_AUTHORIZATION_STALE");
    const validation = validatePlan(loaded.cycle, loaded.root, loaded.cycle.production_database_path, loaded.cycle.sidecar_path), backupPath = path.join(loaded.root, "backup/production-before-apply.sqlite"), b = await backup(loaded.cycle.production_database_path, backupPath, loaded.cycle.production_baseline);
    const intent = { schema_version: 1, kind: "B54_APPLY_INTENT", cycle_id: loaded.cycle.cycle_id, repository_commit: gitHead(), semantic_contract_id: loaded.cycle.semantic_contract_id, production_baseline_sha256: loaded.cycle.production_baseline_sha256, backup_sha256: b.sha256, plan_sha256: plan.plan_sha256, candidate_set_sha256: plan.candidate_set_sha256, candidate_count: plan.discovery_delta.length, created_at: new Date().toISOString(), authorization_sha256: digest(auth), explicit_authorization: true };
    writeImmutable(path.join(loaded.root, "apply-intent.json"), intent); if (present(loaded.cycle.production_database_path, plan).length) throw new Error("CYCLE_CANDIDATE_ALREADY_KNOWN"); transition(loaded.root, STATES.APPLY_RUNNING, { next_action: "postflight" });
    const applied = await applyDailyPlan({ databasePath: loaded.cycle.production_database_path, plan, backupPath, prevalidatedBackup: true, policy: { ...B46_DEFAULT_POLICY, maxAcceptedItems: HARD_MAX_ACCEPTED_ITEMS } });
    const post = productionHealth(loaded.cycle.production_database_path, loaded.cycle.sidecar_path), ids = present(loaded.cycle.production_database_path, { discovery_delta: plan.discovery_delta }), unexpected = Number(post.snapshot.files) - Number(loaded.cycle.production_baseline.files) - ids.length;
    if (ids.length !== plan.discovery_delta.length || unexpected !== 0 || applied.result.updated !== 0 || applied.result.deactivated !== 0) throw new Error("APPLY_RESULT_SET_MISMATCH");
    const result = { schema_version: 1, kind: "B54_APPLY_RESULT", cycle_id: loaded.cycle.cycle_id, plan_sha256: plan.plan_sha256, candidate_set_sha256: plan.candidate_set_sha256, apply_intent_sha256: digest(intent), backup: b, transaction: { committed: true, crawl_run_id: applied.result.crawlRunId }, attempted: plan.discovery_delta.length, inserted_files: applied.result.inserted, updated_files: applied.result.updated, deactivated: applied.result.deactivated, deleted: 0, skipped: 0, rejected: 0, conflicts: 0, inserted_identifiers: ids.sort(), inserted_ident_digest: digestIdents(ids), unexpected_inserted_count: unexpected, missing_authorized_count: plan.discovery_delta.length - ids.length, preflight: validation.health, postflight: post, safety: { additive_only: true, sqlite_write_performed: true, deletion: false, deactivation: false, reconciliation: false, publication: false }, created_at: new Date().toISOString() };
    writeImmutable(path.join(loaded.root, "apply-result.json"), result); transition(loaded.root, STATES.APPLY_VERIFIED, { next_action: "prepare-publication", post_apply_digest: post.production_baseline_sha256 });
    await preparePublication({ cycleId: loaded.cycle.cycle_id, cycleRoot: loaded.root, _lock: l }); artifactIndex(loaded.root, loaded.cycle); return { ...loaded, state: state(loaded.root), result, publication_plan: readJson(path.join(loaded.root, "publication-plan.json")) };
  } catch (error) { try { if (state(loaded.root).state === STATES.APPLY_RUNNING) transition(loaded.root, STATES.APPLY_FAILED, { next_action: "rollback-or-inspect", failure: { stage: "apply", code: error.message } }); } catch {} throw error; } finally { l.release(); }
}

function files(root) { const out = []; function visit(dir, prefix) { for (const name of fs.readdirSync(dir).sort()) { const full = path.join(dir, name), rel = prefix ? path.join(prefix, name) : name, st = fs.lstatSync(full); if (st.isSymbolicLink()) throw new Error("SYMLINK_IN_PUBLICATION_OUTPUT"); if (st.isDirectory()) visit(full, rel); else if (st.isFile()) out.push({ path: rel.replaceAll(path.sep, "/"), bytes: st.size }); else throw new Error("UNSUPPORTED_PUBLICATION_OUTPUT_ENTRY"); } } visit(root, ""); return out; }

async function preparePublication(options) {
  const loaded = readCycle(options.cycleId, options.cycleRoot), own = !options._lock, l = options._lock || lock(loaded.cycle.cycle_id, "prepare-publication");
  try {
    if (state(loaded.root).state === STATES.PUBLICATION_AUTHORIZATION_REQUIRED && fs.existsSync(path.join(loaded.root, "publication-plan.json"))) return { ...loaded, resumed: true };
    if (state(loaded.root).state !== STATES.APPLY_VERIFIED) throw new Error("PUBLICATION_PREPARATION_NOT_ALLOWED");
    const applied = readJson(path.join(loaded.root, "apply-result.json")), sourcePath = path.join(loaded.root, "publication-source/catalog.sqlite");
    if (!fs.existsSync(sourcePath)) { const h = productionHealth(loaded.cycle.production_database_path, loaded.cycle.sidecar_path); if (h.production_baseline_sha256 !== applied.postflight.production_baseline_sha256) throw new Error("PUBLICATION_SOURCE_DRIFT"); await backup(loaded.cycle.production_database_path, sourcePath, applied.postflight.snapshot); }
    const gen = options.generationId || "b54-" + runId(), out = path.join(loaded.root, "publication-candidate");
    if (!fs.existsSync(path.join(out, "catalog/v1/current.json"))) buildPublicCatalog({ database: sourcePath, outputDir: out, generationId: gen, buildSourceCommit: gitHead() });
    const publicRoot = path.join(out, "catalog/v1"), validation = validatePublicCatalog(publicRoot), genRoot = path.join(publicRoot, "generations", gen), manifestPath = path.join(genRoot, "manifest.json"), assets = [];
    for (const item of files(genRoot)) assets.push({ ...item, sha256: await fileDigest(path.join(genRoot, item.path)), release_asset_name: path.basename(item.path) });
    const plan = { schema_version: 1, kind: "B54_PUBLICATION_PLAN", cycle_id: loaded.cycle.cycle_id, generation_id: gen, release_id: "atlas-catalog-" + gen, source_database_digest: applied.postflight.production_baseline_sha256, source_snapshot_sha256: await fileDigest(sourcePath), source_snapshot_bytes: fs.statSync(sourcePath).size, apply_result_sha256: digest(applied), manifest_sha256: await fileDigest(manifestPath), manifest_path: path.relative(loaded.root, manifestPath).replaceAll(path.sep, "/"), asset_count: assets.length, assets, previous_public_generation: loaded.cycle.public_baseline, generated_at: new Date().toISOString(), remote_publication: false, pointer_switched: false, local_validation: validation };
    writeImmutable(path.join(loaded.root, "publication-plan.json"), plan); transition(loaded.root, STATES.PUBLICATION_AUTHORIZATION_REQUIRED, { next_action: "authorize-publication", publication_plan_sha256: digest(plan) }); artifactIndex(loaded.root, loaded.cycle); return { ...loaded, state: state(loaded.root), publicationPlan: plan };
  } finally { if (own) l.release(); }
}

function authorizePublication(options) {
  const loaded = readCycle(options.cycleId, options.cycleRoot), l = lock(loaded.cycle.cycle_id, "authorize-publication");
  try {
    if (state(loaded.root).state !== STATES.PUBLICATION_AUTHORIZATION_REQUIRED) throw new Error("PUBLICATION_AUTHORIZATION_NOT_EXPECTED");
    const plan = readJson(path.join(loaded.root, "publication-plan.json")), psha = digest(plan); if (options.planSha !== psha) throw new Error("PUBLICATION_AUTHORIZATION_IDENTITY_MISMATCH");
    const phrase = authPhrase("PUBLICATION", loaded.cycle.cycle_id, psha); if (options.confirmation !== phrase) throw new Error("PUBLICATION_AUTHORIZATION_TYPED_CONFIRMATION_MISMATCH");
    const auth = { schema_version: 1, kind: "B54_PUBLICATION_AUTHORIZATION", cycle_id: loaded.cycle.cycle_id, post_apply_db_digest: plan.source_database_digest, generation_id: plan.generation_id, manifest_sha256: plan.manifest_sha256, publication_plan_sha256: psha, expected_public_pointer_sha256: loaded.cycle.public_baseline.pointer_sha256, rollback_generation_id: loaded.cycle.public_baseline.generation_id, authorization_identity: options.identity || "operator", authorized_at: options.authorizedAt || new Date().toISOString(), confirmation_identity: phrase, reusable: false };
    writeImmutable(path.join(loaded.root, "publication-authorization.json"), auth); const next = transition(loaded.root, STATES.PUBLICATION_AUTHORIZED, { next_action: "publish", publication_authorization_sha256: digest(auth) }); artifactIndex(loaded.root, loaded.cycle); return { ...loaded, state: next, authorization: auth };
  } finally { l.release(); }
}

async function publish(options) {
  const loaded = readCycle(options.cycleId, options.cycleRoot), l = lock(loaded.cycle.cycle_id, "publish");
  try {
    if (state(loaded.root).state !== STATES.PUBLICATION_AUTHORIZED) throw new Error("PUBLICATION_NOT_AUTHORIZED");
    const plan = readJson(path.join(loaded.root, "publication-plan.json")), auth = readJson(path.join(loaded.root, "publication-authorization.json"));
    if (auth.publication_plan_sha256 !== digest(plan) || auth.expected_public_pointer_sha256 !== loaded.cycle.public_baseline.pointer_sha256) throw new Error("PUBLICATION_AUTHORIZATION_STALE");
    const adapterPath = process.env.MAINTENANCE_PUBLICATION_ADAPTER; if (!adapterPath) throw new Error("PUBLICATION_ADAPTER_NOT_CONFIGURED");
    const resolved = path.resolve(adapterPath); if (!resolved.startsWith(path.resolve(process.cwd()) + path.sep)) throw new Error("PUBLICATION_ADAPTER_OUTSIDE_REPOSITORY");
    const adapter = require(resolved); if (typeof adapter.publish !== "function") throw new Error("PUBLICATION_ADAPTER_INVALID");
    transition(loaded.root, STATES.PUBLICATION_RUNNING, { next_action: "post-publication-verification" });
    const result = await adapter.publish({ cycle: loaded.cycle, cycleRoot: loaded.root, plan, authorization: auth }), publicationResult = { schema_version: 1, kind: "B54_PUBLICATION_RESULT", cycle_id: loaded.cycle.cycle_id, publication_plan_sha256: digest(plan), authorization_sha256: digest(auth), result, safety: { sqlite_write_performed: false, production_db_mutated: false, pointer_last: true, automatic_publication: false }, created_at: new Date().toISOString() };
    writeImmutable(path.join(loaded.root, "publication-result.json"), publicationResult); transition(loaded.root, STATES.PUBLICATION_VERIFIED, { next_action: "complete", publication_result_sha256: digest(publicationResult) }); transition(loaded.root, STATES.COMPLETE, { next_action: "none" }); artifactIndex(loaded.root, loaded.cycle); return { ...loaded, state: state(loaded.root), publicationResult };
  } catch (error) { try { if (state(loaded.root).state === STATES.PUBLICATION_RUNNING) transition(loaded.root, STATES.PUBLICATION_FAILED, { next_action: "rollback-publication", failure: { stage: "publication", code: error.message } }); } catch {} throw error; } finally { l.release(); }
}

function status(cycleId, cycleRoot) {
  const x = readCycle(cycleId, cycleRoot), root = x.root, get = (n) => fs.existsSync(path.join(root, n)) ? readJson(path.join(root, n)) : null; let health; try { health = productionHealth(x.cycle.production_database_path, x.cycle.sidecar_path); } catch (e) { health = { error: e.message }; }
  return { cycle_id: x.cycle.cycle_id, state: x.state.state, observation_cutoff: x.cycle.observation_cutoff, independent_observation_dates: x.cycle.observation_source.selected_independent_dates, eligible_count: get("eligibility.json")?.eligible_count || 0, plan_count: get("plan.json")?.discovery_delta?.length || 0, production_baseline: x.cycle.production_baseline_sha256, current_production_digest: health.production_baseline_sha256 || null, public_baseline: { generation_id: x.cycle.public_baseline.generation_id, manifest_sha256: x.cycle.public_baseline.manifest_sha256 }, apply_authorization: Boolean(get("apply-authorization.json")), publication_authorization: Boolean(get("publication-authorization.json")), last_successful_apply: get("apply-result.json")?.created_at || null, publication_ready: Boolean(get("publication-plan.json")), next_required_action: x.state.next_action, blocker: x.state.failure || null };
}

function demonstrate(options = {}) {
  const root = path.resolve(options.demoRoot || path.join("runtime/maintenance-cycle-demos", "fixture-" + runId())); if (fs.existsSync(root)) throw new Error("DEMO_ROOT_EXISTS"); fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const c = { schema_version: 1, contract_version: CONTRACT_VERSION, kind: "B54_DEMO_CYCLE", cycle_id: "demo-" + runId(), semantic_contract_id: "demo-semantic", implementation_build_id: "maintenance-orchestrator-demo", observation_cutoff: "2026-09-01T00:00:00.000Z", production_baseline_sha256: "0".repeat(64), b39_sidecar_sha256: "3".repeat(64), public_baseline: { generation_id: "demo-public", pointer_sha256: "1".repeat(64), manifest_sha256: "2".repeat(64) }, production_baseline: { files: 0, media: 0 }, state: STATES.CREATED };
  writeImmutable(path.join(root, "cycle.json"), c); writeImmutable(path.join(root, "state.json"), { schema_version: 1, cycle_id: c.cycle_id, state: STATES.CREATED, next_action: "select-observations", updated_at: new Date().toISOString() }); history(root, state(root));
  for (const next of [STATES.OBSERVATIONS_SELECTED, STATES.PERSISTENCE_REFRESHED, STATES.ELIGIBILITY_READY, STATES.PLAN_READY, STATES.APPLY_AUTHORIZATION_REQUIRED]) transition(root, next, { next_action: next === STATES.APPLY_AUTHORIZATION_REQUIRED ? "authorize-apply" : "next-demo-stage" });
  artifactIndex(root, c); return { root, cycle_id: c.cycle_id, state: state(root), safety: { production_mutated: false, public_pointer_mutated: false, real_apply: false, real_publication: false } };
}

module.exports = { CONTRACT_VERSION, DEFAULT_PLAN_SIZE, HARD_PLAN_SIZE, STATES, TERMINAL_STATES, TRANSITIONS, RANKING_POLICY, digest, fileDigest, productionHealth, inventory, validatePlan, createCycle, prepare, readCycle, authorizeApply, apply, preparePublication, authorizePublication, publish, status, demonstrate, transition, artifactIndex };
