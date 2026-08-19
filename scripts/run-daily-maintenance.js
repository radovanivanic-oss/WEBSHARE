#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createApiClient, fetchSearchPage, loginAndGetWst, normalizeFile, WebshareSession } = require("../main");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { acquireCrawlerLock, inspectLock } = require("../lib/crawler/lock");
const {
  DEFAULT_POLICY,
  applyDailyPlan,
  buildDailyPlan,
  discoverRecent,
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
  const policy = {
    ...DEFAULT_POLICY,
    maxPagesPerPrefix: argument(argv, "--max-pages-per-prefix") ? positive(argument(argv, "--max-pages-per-prefix"), "max-pages-per-prefix", 100) : DEFAULT_POLICY.maxPagesPerPrefix,
    maxRequests: argument(argv, "--max-requests") ? positive(argument(argv, "--max-requests"), "max-requests", 1000) : DEFAULT_POLICY.maxRequests,
    maxDiscoveredItems: argument(argv, "--max-discovered") ? positive(argument(argv, "--max-discovered"), "max-discovered", 100000) : DEFAULT_POLICY.maxDiscoveredItems,
    maxStaleChecks: argument(argv, "--max-stale") ? positive(argument(argv, "--max-stale"), "max-stale", 10000) : DEFAULT_POLICY.maxStaleChecks,
  };
  const prefixValue = argument(argv, "--prefixes");
  if (prefixValue) policy.prefixes = prefixValue.split(",").map((value) => value.trim()).filter(Boolean);
  return { database, outputDir, statePath, policy, apply: argv.includes("--apply"), verifyStale: argv.includes("--verify-stale"), advanceState: argv.includes("--advance-state"), publicationVerified: argv.includes("--publication-verified"), backupPath: argument(argv, "--backup-path"), expectedPlanSha256: argument(argv, "--expected-plan-sha256") };
}

function usage() {
  return "node scripts/run-daily-maintenance.js --database FILE --output-dir DIR [--prefixes a,b] [--verify-stale] [--apply --expected-plan-sha256 HASH --backup-path FILE --advance-state --publication-verified]";
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
    const staleCandidates = selectStaleCandidates(database, state, new Date().toISOString(), options.policy);
    const deps = await createLiveDependencies();
    const discovery = await discoverRecent({ prefixes: options.policy.prefixes, state, fetchPage: deps.fetchPage, normalize: normalizeFile, policy: options.policy });
    if (discovery.items.length > options.policy.maxDiscoveredItems) discovery.complete = false;
    let verificationOutcomes = [];
    if (options.verifyStale && staleCandidates.length > 0) {
      for (const candidate of staleCandidates) {
        try {
          const result = await deps.session.filesExist(candidate.ident);
          verificationOutcomes.push({ ident: candidate.ident, result: result.exists ? "present" : "definitive_missing" });
        } catch (error) {
          verificationOutcomes.push({ ident: candidate.ident, result: "error", error_code: error.code || "TRANSPORT_ERROR" });
        }
      }
    }
    database.close(); database = null;
    database = openCatalogDatabase(options.database, { readonly: true, fileMustExist: true });
    const plan = buildDailyPlan({ database, items: discovery.items, staleCandidates, verificationOutcomes, state, policy: options.policy, discovery, now: new Date().toISOString() });
    if (options.expectedPlanSha256 && options.expectedPlanSha256 !== plan.plan_sha256) throw new Error("DAILY_EXPECTED_PLAN_SHA256_MISMATCH");
    const planPath = path.join(options.outputDir, "daily-plan.json");
    writeJsonAtomic(planPath, plan);
    const report = { schema_version: 1, status: plan.status, plan_sha256: plan.plan_sha256, discovery: { complete: plan.discovery.complete, requests: plan.discovery.requests, page_reports: plan.discovery.page_reports, stop_reason: plan.discovery.stop_reason, observed_items: plan.discovery.observed_items }, counters: plan.counters, blocked_reasons: plan.blocked_reasons, stale_candidates: staleCandidates.length, verification_outcomes: verificationOutcomes.length, safety: plan.safety, plan_path: planPath };
    if (options.apply) {
      if (!options.expectedPlanSha256) throw new Error("DAILY_APPLY_REQUIRES_EXPECTED_PLAN_SHA256");
      if (plan.plan_sha256 !== options.expectedPlanSha256) throw new Error("DAILY_PLAN_DIGEST_MISMATCH");
      if (plan.status !== "READY_FOR_REVIEW") throw new Error("DAILY_PLAN_NOT_READY");
      if (!options.advanceState || !options.publicationVerified) throw new Error("DAILY_APPLY_REQUIRES_POST_PUBLICATION_STATE_GATE");
      const applied = await applyDailyPlan({ databasePath: options.database, plan, backupPath: options.backupPath, policy: options.policy });
      report.applied = applied;
      report.safety = { ...report.safety, sqlite_write_performed: true, import_performed: applied.result.inserted > 0, deactivation_performed: applied.result.deactivated > 0 };
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
