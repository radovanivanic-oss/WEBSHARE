#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquireCrawlerLock } = require("../lib/crawler/lock");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const {
  applySeriesReconciliation,
  buildSeriesReconciliationPlan,
  stableJson,
} = require("../lib/series-identity");

const LOCK_PATH = path.resolve("runtime/maintenance-cycles/.maintenance-cycle.lock");

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1] || fallback;
}

function has(argv, name) {
  return argv.includes(name);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function planHash(plan) {
  return sha256(stableJson(plan));
}

function writeJson(output, value) {
  if (!output) return;
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true, mode: 0o750 });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
}

async function main(argv = process.argv.slice(2)) {
  const databasePath = path.resolve(argument(argv, "--database", "data/catalog.sqlite"));
  const planPath = argument(argv, "--plan");
  const output = argument(argv, "--output");
  const apply = has(argv, "--apply");
  const confirm = has(argv, "--confirm-series-reconciliation");
  const database = openCatalogDatabase(databasePath, { readonly: !apply, fileMustExist: true });
  let lock = null;
  try {
    let plan;
    if (planPath) {
      plan = JSON.parse(fs.readFileSync(path.resolve(planPath), "utf8"));
    } else {
      plan = buildSeriesReconciliationPlan(database);
    }
    if (!apply) {
      writeJson(output, plan);
      console.log(JSON.stringify({ status: "READ_ONLY_DRY_RUN", plan_sha256: planHash(plan), audit: plan.audit, totals: plan.totals }, null, 2));
      return plan;
    }
    if (!planPath || !confirm) throw new Error("SERIES_APPLY_REQUIRES_PLAN_AND_CONFIRMATION");
    const expectedPlan = argument(argv, "--expected-plan-sha256");
    const actualPlan = planHash(plan);
    if (expectedPlan && expectedPlan !== actualPlan) throw new Error(`SERIES_PLAN_DIGEST_MISMATCH:${actualPlan}`);
    const backupPath = argument(argv, "--backup");
    if (!backupPath) throw new Error("SERIES_BACKUP_REQUIRED");
    lock = acquireCrawlerLock(LOCK_PATH, `series-reconciliation-${process.pid}`, { recoverStale: true });
    fs.mkdirSync(path.dirname(path.resolve(backupPath)), { recursive: true, mode: 0o750 });
    await database.backup(path.resolve(backupPath));
    const result = applySeriesReconciliation(database, plan);
    const envelope = { status: "APPLIED", plan_sha256: actualPlan, backup_path: path.resolve(backupPath), result };
    writeJson(output, envelope);
    console.log(JSON.stringify(envelope, null, 2));
    return envelope;
  } finally {
    try { database.close(); } finally { lock?.release(); }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { argument, main, planHash, sha256 };
