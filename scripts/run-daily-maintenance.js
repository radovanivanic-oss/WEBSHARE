#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createApiClient, fetchSearchPage, loginAndGetWst, normalizeFile, WebshareSession } = require("../main");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { acquireCrawlerLock, inspectLock } = require("../lib/crawler/lock");
const {
  DEFAULT_POLICY,
  B46_DEFAULT_POLICY,
  B46_QUERY_PORTFOLIO,
  DISCOVERY_STATES,
  applyDailyPlan,
  advanceSentinelState,
  buildDailyPlan,
  discoverRecent,
  discoverRecentSnapshot,
  discoverBestEffortPortfolio,
  readState,
  selectStaleCandidates,
  writeJsonAtomic,
} = require("../lib/daily-maintenance");

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function positive(value, label, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${label} must be 1..${maximum}`);
  return number;
}

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const database = path.resolve(argument(argv, "--database", path.join("data", "catalog.sqlite")));
  const outputDir = path.resolve(argument(argv, "--output-dir", path.join("runtime", `daily-maintenance-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`)));
  const statePath = path.resolve(argument(argv, "--state", path.join("runtime", "daily-maintenance-state.json")));
  const mode = argument(argv, "--mode", "daily-best-effort");
  if (!["daily-best-effort", "weekly-stale", "rolling-snapshot", "prefix"].includes(mode)) throw new Error("mode is invalid");
  const policy = {
    ...(mode === "daily-best-effort" ? B46_DEFAULT_POLICY : DEFAULT_POLICY),
    maxPagesPerPrefix: argument(argv, "--max-pages-per-prefix") ? positive(argument(argv, "--max-pages-per-prefix"), "max-pages-per-prefix", 100) : DEFAULT_POLICY.maxPagesPerPrefix,
    maxPagesPerQuery: argument(argv, "--max-pages-per-query") ? positive(argument(argv, "--max-pages-per-query"), "max-pages-per-query", 100) : B46_DEFAULT_POLICY.maxPagesPerQuery,
    maxRequests: argument(argv, "--max-requests") ? positive(argument(argv, "--max-requests"), "max-requests", 1000) : (mode === "daily-best-effort" ? B46_DEFAULT_POLICY.maxRequests : DEFAULT_POLICY.maxRequests),
    maxDiscoveredItems: argument(argv, "--max-discovered") ? positive(argument(argv, "--max-discovered"), "max-discovered", 100000) : (mode === "daily-best-effort" ? B46_DEFAULT_POLICY.maxDiscoveredItems : DEFAULT_POLICY.maxDiscoveredItems),
    maxStaleChecks: argument(argv, "--max-stale") ? positive(argument(argv, "--max-stale"), "max-stale", 10000) : DEFAULT_POLICY.maxStaleChecks,
  };
  const discoveryMode = argument(argv, "--discovery-mode", mode === "daily-best-effort" ? "best-effort" : "rolling-snapshot");
  if (!["best-effort", "rolling-snapshot", "prefix"].includes(discoveryMode)) throw new Error("discovery-mode is invalid");
  const prefixValue = argument(argv, "--prefixes");
  if (prefixValue) policy.prefixes = prefixValue.split(",").map((value) => value.trim()).filter(Boolean);
  const queriesValue = argument(argv, "--queries");
  const queries = queriesValue ? queriesValue.split(",").map((value) => value.trim()).filter(Boolean) : [...B46_QUERY_PORTFOLIO];
  const batchSize = argument(argv, "--batch-size", "3");
  return { database, outputDir, statePath, policy, mode, discoveryMode, queries, batchSize: positive(batchSize, "batch-size", 50), recentQuery: argument(argv, "--recent-query", ""), captureBaseline: argv.includes("--capture-baseline"), apply: argv.includes("--apply"), verifyStale: argv.includes("--verify-stale"), advanceState: argv.includes("--advance-state"), publicationVerified: argv.includes("--publication-verified"), backupPath: argument(argv, "--backup-path"), expectedPlanSha256: argument(argv, "--expected-plan-sha256") };
}

function usage() {
  return "node scripts/run-daily-maintenance.js --mode daily-best-effort|weekly-stale --database FILE --output-dir DIR [--queries a,b --max-pages-per-query N] [--apply --expected-plan-sha256 HASH --backup-path FILE --advance-state --publication-verified]";
}

async function createLiveDependencies() {
  const client = createApiClient();
  const username = process.env.WEBSHARE_USERNAME;
  const password = process.env.WEBSHARE_PASSWORD;
  if (!username || !password) throw new Error("Protected Webshare credentials are unavailable.");
  const token = await loginAndGetWst({ username, password, client });
  const session = new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { apiClient: client, login: async () => token });
  return {
    async fetchPage({ prefix, offset, limit }) {
      return fetchSearchPage(client, session, { prefix, wildcardSuffix: "*", sort: "recent", category: "video", offset, limit });
    },
    async fetchRecentPage({ query = "", offset, limit }) {
      return fetchSearchPage(client, session, { prefix: query, wildcardSuffix: "", sort: "recent", category: "video", offset, limit });
    },
    async fetchBestEffortPage({ query, offset, limit }) {
      return fetchSearchPage(client, session, { prefix: query, wildcardSuffix: "", sort: "recent", category: "video", offset, limit });
    },
    session,
  };
}

async function main(options = parseArguments(process.argv.slice(2))) {
  if (options.help) { console.log(usage()); return { status: "HELP" }; }
  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o750 });
  const runtimeDir = path.dirname(options.statePath);
  const crawlerLockPath = path.join(runtimeDir, "webshare-crawler.lock");
  const crawlerLock = inspectLock(crawlerLockPath);
  if (crawlerLock.active === true || crawlerLock.exists) throw new Error("DAILY_CONFLICTING_CRAWLER_LOCK");
  const lock = acquireCrawlerLock(path.join(runtimeDir, "webshare-daily-maintenance.lock"), `daily-${process.pid}`);
  let database;
  try {
    const state = readState(options.statePath);
    database = openCatalogDatabase(options.database, { readonly: true, fileMustExist: true });
    const staleCandidates = options.mode === "weekly-stale" ? selectStaleCandidates(database, state, new Date().toISOString(), options.policy) : [];
    const deps = await createLiveDependencies();
    const discovery = options.mode === "weekly-stale"
      ? { mode: "WEEKLY_STALE_VERIFICATION", coverage_declaration: "NOT_APPLICABLE", complete: true, requests: 0, items: [], page_reports: [], stop_reason: "WEEKLY_STALE_ONLY" }
      : options.discoveryMode === "best-effort"
        ? await discoverBestEffortPortfolio({ queries: options.queries, fetchPage: ({ query, offset, limit }) => deps.fetchBestEffortPage({ query, offset, limit }), normalize: normalizeFile, policy: options.policy })
        : options.discoveryMode === "rolling-snapshot"
      ? await discoverRecentSnapshot({
        state,
        fetchPage: ({ offset, limit }) => deps.fetchRecentPage({ query: options.recentQuery, offset, limit }),
        queryContract: { name: "webshare-search", what: options.recentQuery, sort: "recent", category: "video", coverage: options.recentQuery ? "query-slice" : "global" },
        normalize: normalizeFile,
        policy: options.policy,
      })
      : await discoverRecent({ prefixes: options.policy.prefixes, state, fetchPage: deps.fetchPage, normalize: normalizeFile, policy: options.policy });
    if (discovery.items.length > options.policy.maxDiscoveredItems) discovery.complete = false;
    let verificationOutcomes = [];
    if (options.mode === "weekly-stale" && staleCandidates.length > 0) {
      for (let index = 0; index < staleCandidates.length; index += options.batchSize) {
        const batch = staleCandidates.slice(index, index + options.batchSize);
        try {
          const result = typeof deps.session.filesExistBatch === "function"
            ? await deps.session.filesExistBatch(batch.map((candidate) => candidate.ident))
            : null;
          if (result) {
            const byIdent = new Map(result.files.map((row) => [row.ident, row]));
            for (const candidate of batch) {
              const row = byIdent.get(candidate.ident);
              if (!row) throw new Error("INCOMPLETE_FILES_EXIST_BATCH");
              verificationOutcomes.push({ ident: candidate.ident, result: row.exists ? "present" : "definitive_missing" });
            }
          } else {
            for (const candidate of batch) {
              const row = await deps.session.filesExist(candidate.ident);
              verificationOutcomes.push({ ident: candidate.ident, result: row.exists ? "present" : "definitive_missing" });
            }
          }
        } catch (error) {
          for (const candidate of batch) verificationOutcomes.push({ ident: candidate.ident, result: "error", error_code: error.code || "TRANSPORT_ERROR" });
        }
      }
    }
    database.close(); database = null;
    database = openCatalogDatabase(options.database, { readonly: true, fileMustExist: true });
    const plan = buildDailyPlan({ database, items: discovery.items, staleCandidates, verificationOutcomes, state, policy: options.policy, discovery, operation: options.mode, now: new Date().toISOString() });
    if (options.expectedPlanSha256 && options.expectedPlanSha256 !== plan.plan_sha256) throw new Error("DAILY_EXPECTED_PLAN_SHA256_MISMATCH");
    const planPath = path.join(options.outputDir, "daily-plan.json");
    writeJsonAtomic(planPath, plan);
    const report = { schema_version: 1, status: plan.status, operation: options.mode, coverage_declaration: options.mode === "daily-best-effort" ? "BEST_EFFORT" : "NOT_APPLICABLE", plan_sha256: plan.plan_sha256, discovery: { mode: discovery.mode || null, coverage_declaration: discovery.coverage_declaration || null, complete: plan.discovery.complete, requests: plan.discovery.requests, raw_records: discovery.raw_records || null, unique_idents: discovery.unique_idents || null, queries: discovery.queries || null, page_reports: plan.discovery.page_reports, stop_reason: plan.discovery.stop_reason, observed_items: plan.discovery.observed_items }, counters: plan.counters, blocked_reasons: plan.blocked_reasons, stale_candidates: staleCandidates.length, verification_outcomes: verificationOutcomes.length, safety: plan.safety, plan_path: planPath };
    report.discovery.state = discovery.state || state.discovery_state || DISCOVERY_STATES.UNINITIALIZED;
    report.discovery.snapshot = discovery.snapshot ? { unique_count: discovery.snapshot.unique_count, ordered_idents_sha256: discovery.snapshot.ordered_idents_sha256, idents_sha256: discovery.snapshot.idents_sha256 } : null;
    if (options.captureBaseline) {
      if (discovery.stop_reason !== "BASELINE_ONLY") throw new Error("DAILY_BASELINE_CAPTURE_REQUIRES_BASELINE_ONLY");
      writeJsonAtomic(options.statePath, advanceSentinelState(state, discovery, { allowBaseline: true }));
      report.safety.discovery_state_advanced = true;
    }
    if (options.apply) {
      if (!options.expectedPlanSha256) throw new Error("DAILY_APPLY_REQUIRES_EXPECTED_PLAN_SHA256");
      if (plan.plan_sha256 !== options.expectedPlanSha256) throw new Error("DAILY_PLAN_DIGEST_MISMATCH");
      if (!["READY_FOR_REVIEW", "NO_CHANGES"].includes(plan.status)) throw new Error("DAILY_PLAN_NOT_READY");
      if (!options.advanceState || !options.publicationVerified) throw new Error("DAILY_APPLY_REQUIRES_POST_PUBLICATION_STATE_GATE");
      const applied = plan.status === "READY_FOR_REVIEW"
        ? await applyDailyPlan({ databasePath: options.database, plan, backupPath: options.backupPath, policy: options.policy })
        : { result: { inserted: 0, updated: 0, deactivated: 0 }, post: plan.baseline, no_change: true };
      report.applied = applied;
      report.safety = { ...report.safety, sqlite_write_performed: applied.no_change !== true, import_performed: applied.result.inserted > 0, deactivation_performed: applied.result.deactivated > 0 };
      if (options.advanceState) writeJsonAtomic(options.statePath, { ...plan.next_state, last_success_at: new Date().toISOString(), frontiers: plan.discovery.proposed_frontiers });
    }
    writeJsonAtomic(path.join(options.outputDir, "daily-report.json"), report);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (database) database.close();
    lock.release();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { createLiveDependencies, main, parseArguments, usage };
