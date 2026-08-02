"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), test = require("node:test");
const { createDiscoveryConfig, runHybridDiscovery } = require("../lib/discovery/hybrid-discovery");
const { createFilesExistConfig, runFilesExistEvidence } = require("../lib/discovery/files-exist-port");
const { createCandidateDecisionConfig, runCandidateDecision } = require("../lib/discovery/candidate-decision");
const { createCatalogClassificationConfig, runCatalogClassification, inputDigest, configDigest } = require("../lib/discovery/catalog-classification");
const { createImportPlanningConfig, runImportPlanning, digest: planDigest } = require("../lib/discovery/import-planning");
const { createSimulationConfig, runImportSimulation, digest: simulationDigest } = require("../lib/discovery/import-simulation");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const ids = (records) => records.map((record) => record.ident);
const fixture = (t) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-e2e-")); fs.mkdirSync(path.join(root, "runtime")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const safe = (value) => JSON.parse(JSON.stringify(value, (key, item) => /^(run_id|started|finished|checked_at|decision_timestamp|classified_at|planned_at|simulated_at|duration_ms|processing_duration|total_duration|cumulative_timing_ms|input_digest|configuration_digest|source_plan_digest)$/u.test(key) ? undefined : item));

async function pipeline(t) {
  const root = fixture(t), discovery = createDiscoveryConfig({ projectRoot: root, stagingDir: path.join(root, "runtime", "hybrid-discovery-e2e"), what: "fixture", limits: { pageSize: 2, maxPages: 2, maxRequests: 4, maxNewIdents: 3, maxDurationMs: 10000 } });
  const pages = new Map([[0, ["alpha", "beta"]], [2, ["beta", "gamma"]]]);
  await runHybridDiscovery(discovery, { authenticate: async ({ requestMeter }) => { requestMeter.beforeRequest("login", "salt"); requestMeter.afterRequest(); requestMeter.beforeRequest("login", "login"); requestMeter.afterRequest(); return "mock-wst"; }, fetchSearchPage: async ({ offset, requestMeter }) => { requestMeter.beforeRequest("search", "search"); requestMeter.afterRequest(); return { files: (pages.get(offset) || []).map((ident) => ({ ident: [ident] })) }; } }, { wallNow: () => new Date("2026-01-01T00:00:00.000Z"), monotonicNowMs: () => 0, secrets: ["mock-wst"] });
  const discovered = json(discovery.paths.idents), discoveryManifest = json(discovery.paths.manifest), discoveryCheckpoint = json(discovery.paths.checkpoint);
  fs.mkdirSync(path.join(root, "files")); const files = createFilesExistConfig({ root: path.join(root, "files"), idents: discovered.idents, limits: { maxIdents: 3, maxRequests: 3, maxDurationMs: 10000 } });
  await runFilesExistEvidence(files, { filesExist: async (ident) => { if (ident === "gamma") throw Object.assign(new Error("mock network"), { code: "NETWORK_ERROR", retryable: true }); return { exists: ident === "alpha", status: 200 }; } }, { wallNow: () => new Date("2026-01-01T00:00:00.000Z"), monotonicNowMs: () => 0 });
  const evidence = json(files.paths.evidence), filesManifest = json(files.paths.manifest), filesCheckpoint = json(files.paths.checkpoint);
  fs.mkdirSync(path.join(root, "decision")); const decision = createCandidateDecisionConfig({ root: path.join(root, "decision"), discoverySummary: { idents: discovered.idents }, filesExistEvidence: { records: evidence.records, requests_reserved: filesManifest.requests_reserved, requests_completed: filesManifest.requests_completed }, limits: { maxCandidates: 3, maxDurationMs: 10000 } });
  await runCandidateDecision(decision, { wallNow: () => new Date("2026-01-01T00:00:00.000Z"), monotonicNowMs: () => 0 });
  const decisions = json(decision.paths.decisions), decisionManifest = json(decision.paths.manifest), decisionCheckpoint = json(decision.paths.checkpoint);
  const lookup = { snapshotIdentity: () => ({ fixture: "catalog-v1", rows: 0 }), lookupIdent: (ident) => ({ ident, match_count: 0, states: [] }) };
  const classification = createCatalogClassificationConfig({ root: path.join(root, "classification"), candidates: decisions.records, lookup, limits: { maxCandidates: 3, maxCatalogQueries: 3, maxDurationMs: 10000 } });
  const classificationManifest = runCatalogClassification(classification), classifications = json(classification.paths.records), classificationCheckpoint = json(classification.paths.checkpoint);
  const planning = createImportPlanningConfig({ root: path.join(root, "planning"), records: classifications.records, catalogSnapshotDigest: classificationManifest.catalog_snapshot_digest, limits: { maxRecords: 3, maxDurationMs: 10000 } });
  const planningManifest = runImportPlanning(planning), plan = json(planning.paths.plan), planningCheckpoint = json(planning.paths.checkpoint);
  const simulation = createSimulationConfig({ root: path.join(root, "simulation"), planRecords: plan.records, sourcePlanDigest: simulationDigest(plan.records), catalogSnapshotDigest: classificationManifest.catalog_snapshot_digest, limits: { maxRecords: 3, maxDurationMs: 10000 } });
  const simulationManifest = runImportSimulation(simulation), simulationRecords = json(simulation.paths.records), simulationCheckpoint = json(simulation.paths.checkpoint);
  return { root, discovery, files, decision, classification, planning, simulation, discovered, discoveryManifest, discoveryCheckpoint, evidence, filesManifest, filesCheckpoint, decisions, decisionManifest, decisionCheckpoint, classifications, classificationManifest, classificationCheckpoint, plan, planningManifest, planningCheckpoint, simulationRecords, simulationManifest, simulationCheckpoint };
}

test("B.17 executes the complete mocked read-only pipeline with exact contracts", async (t) => {
  const out = await pipeline(t), expected = ["alpha", "beta", "gamma"];
  for (const records of [out.discovered.idents, ids(out.evidence.records), ids(out.decisions.records), ids(out.classifications.records), ids(out.plan.records), ids(out.simulationRecords.records)]) { assert.deepEqual(records, expected); assert.equal(new Set(records).size, records.length); }
  assert.equal(out.discoveryManifest.new_idents, 3); assert.equal(out.discoveryManifest.duplicate_idents, 1); assert.equal(out.filesManifest.checked, 3); assert.equal(out.decisionManifest.processed_candidates, 3); assert.equal(out.classificationManifest.processed, 3); assert.equal(out.planningManifest.processed, 3); assert.equal(out.simulationManifest.processed, 3);
  assert.equal(out.decisionManifest.input_digest, out.decisionCheckpoint.input_digest); assert.equal(out.decisionManifest.configuration_digest, out.decisionCheckpoint.configuration_digest); assert.equal(out.classificationManifest.input_digest, inputDigest(out.decisions.records)); assert.equal(out.classificationManifest.configuration_digest, configDigest(out.classification)); assert.equal(out.planningManifest.input_digest, out.planningCheckpoint.input_digest); assert.equal(out.planningManifest.configuration_digest, out.planningCheckpoint.configuration_digest); assert.equal(out.simulationManifest.input_digest, out.simulationCheckpoint.input_digest); assert.equal(out.simulationManifest.configuration_digest, out.simulationCheckpoint.configuration_digest); assert.equal(out.simulationManifest.catalog_snapshot_digest, out.classificationManifest.catalog_snapshot_digest); assert.equal(out.simulationManifest.source_plan_digest, simulationDigest(out.plan.records));
  assert.deepEqual(out.plan.records.map((record) => record.planned_action), out.simulationRecords.records.map((record) => record.planned_action));
  for (const manifest of [out.discoveryManifest, out.filesManifest, out.decisionManifest, out.classificationManifest, out.planningManifest, out.simulationManifest]) assert.doesNotMatch(JSON.stringify(manifest), /import_performed":true|publication_performed":true|reconciliation_performed":true|sqlite_write_performed":true/i);
  for (const file of [out.discovery.paths.idents, out.discovery.paths.checkpoint, out.discovery.paths.manifest, out.files.paths.evidence, out.files.paths.checkpoint, out.files.paths.manifest, out.decision.paths.decisions, out.decision.paths.checkpoint, out.decision.paths.manifest, out.classification.paths.records, out.classification.paths.checkpoint, out.classification.paths.manifest, out.planning.paths.plan, out.planning.paths.checkpoint, out.planning.paths.manifest, out.simulation.paths.records, out.simulation.paths.checkpoint, out.simulation.paths.manifest]) assert.ok(fs.statSync(file).size < 1024 * 1024);
});

test("B.17 semantic outputs are deterministic across two mocked pipeline runs", async (t) => { const left = await pipeline(t), right = await pipeline(t); assert.deepEqual(safe({ d: left.discovered, e: left.evidence, c: left.decisions, x: left.classifications, p: left.plan, s: left.simulationRecords, m: [left.discoveryManifest, left.filesManifest, left.decisionManifest, left.classificationManifest, left.planningManifest, left.simulationManifest] }), safe({ d: right.discovered, e: right.evidence, c: right.decisions, x: right.classifications, p: right.plan, s: right.simulationRecords, m: [right.discoveryManifest, right.filesManifest, right.decisionManifest, right.classificationManifest, right.planningManifest, right.simulationManifest] })); });

test("B.17 corrupt, missing, mismatched, duplicate, missing and reordered contracts fail closed", async (t) => {
  const out = await pipeline(t), mutate = (file, change) => { const value = json(file); change(value); fs.writeFileSync(file, JSON.stringify(value)); };
  fs.unlinkSync(out.planning.paths.plan); assert.throws(() => runImportPlanning(out.planning, { resume: true }));
  mutate(out.simulation.paths.manifest, (v) => { v.input_digest = "bad"; }); assert.throws(() => runImportSimulation(out.simulation, { resume: true }), /mismatch/);
  mutate(out.classification.paths.checkpoint, (v) => { v.configuration_digest = "bad"; }); assert.throws(() => runCatalogClassification(out.classification, { resume: true }), /mismatch/);
  mutate(out.decision.paths.decisions, (v) => { v.records[0].decision = "BROKEN"; }); await assert.rejects(runCandidateDecision(out.decision, { resume: true }), /checkpoint|invariant/);
  assert.throws(() => createImportPlanningConfig({ root: path.join(out.root, "bad-plan"), records: [out.classifications.records[0], out.classifications.records[0]], catalogSnapshotDigest: out.classificationManifest.catalog_snapshot_digest }), /duplicate/);
  const wrongCatalog = createSimulationConfig({ root: out.simulation.paths.root, planRecords: out.plan.records, sourcePlanDigest: simulationDigest(out.plan.records), catalogSnapshotDigest: "wrong" }); assert.throws(() => runImportSimulation(wrongCatalog, { resume: true }), /mismatch/);
  const reordered = [...out.classifications.records].reverse(); assert.notEqual(planDigest(reordered), out.planningManifest.input_digest);
});
