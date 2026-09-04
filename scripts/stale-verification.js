#!/usr/bin/env node
"use strict";

const path = require("node:path");
const stale = require("../lib/stale-verification");
const weekly = require("../lib/weekly-stale-maintenance");

function parse(argv) {
  const command = ["run", "status", "demo"].includes(argv[0]) ? argv[0] : "run";
  const start = command === argv[0] ? 1 : 0;
  const allowed = new Set(["--database", "--sidecar", "--output-root", "--weekly-state-root", "--run-id", "--at", "--bucket", "--batch-size", "--max-retries"]);
  const options = { command };
  for (let index = start; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.has(name) || argv[index + 1] === undefined) throw new Error(`STALE_OPTION_INVALID:${name}`);
    const key = name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    options[key] = argv[++index];
  }
  if (options.database) options.databasePath = path.resolve(options.database);
  if (options.sidecar) options.sidecarPath = path.resolve(options.sidecar);
  if (options.outputRoot) options.outputRoot = path.resolve(options.outputRoot);
  if (options.weeklyStateRoot) options.weeklyStateRoot = path.resolve(options.weeklyStateRoot);
  if (options.bucket !== undefined) options.bucket = Number(options.bucket);
  if (options.batchSize !== undefined) options.batchSize = Number(options.batchSize);
  if (options.maxRetries !== undefined) options.maxRetries = Number(options.maxRetries);
  return options;
}

function usage() {
  return [
    "stale-verification run [--database FILE] [--sidecar FILE] [--output-root DIR] [--run-id ID] [--at ISO] [--bucket 0..51] [--batch-size 1..50] [--max-retries 1..2]",
    "stale-verification status [--output-root DIR] [--weekly-state-root DIR]",
    "stale-verification demo",
  ].join("\n");
}

function demo() {
  const cases = {
    present_present: stale.buildStaleLedger([{ contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-a", local_calendar_date: "2026-01-01", records: [{ ident: "demo", status: stale.STATUS.PRESENT, observed_at: "2026-01-01T00:00:00Z" }] }, { contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-b", local_calendar_date: "2026-01-08", records: [{ ident: "demo", status: stale.STATUS.PRESENT, observed_at: "2026-01-08T00:00:00Z" }] }], [{ ident: "demo", is_active: 1, is_playable_video: 1 }]),
    missing_missing: stale.buildStaleLedger([{ contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-a", local_calendar_date: "2026-01-01", records: [{ ident: "demo", status: stale.STATUS.DEFINITIVE_MISSING, observed_at: "2026-01-01T00:00:00Z" }] }, { contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-b", local_calendar_date: "2026-01-08", records: [{ ident: "demo", status: stale.STATUS.DEFINITIVE_MISSING, observed_at: "2026-01-08T00:00:00Z" }] }], [{ ident: "demo", is_active: 1, is_playable_video: 1 }]),
    missing_transient_present: stale.buildStaleLedger([{ contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-a", local_calendar_date: "2026-01-01", records: [{ ident: "demo", status: stale.STATUS.DEFINITIVE_MISSING, observed_at: "2026-01-01T00:00:00Z" }] }, { contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-b", local_calendar_date: "2026-01-08", records: [{ ident: "demo", status: stale.STATUS.TRANSIENT_FAILURE, observed_at: "2026-01-08T00:00:00Z" }] }, { contract_version: stale.STALE_CONTRACT_VERSION, run_id: "demo-c", local_calendar_date: "2026-01-15", records: [{ ident: "demo", status: stale.STATUS.PRESENT, observed_at: "2026-01-15T00:00:00Z" }] }], [{ ident: "demo", is_active: 1, is_playable_video: 1 }]),
  };
  return Object.fromEntries(Object.entries(cases).map(([name, rows]) => [name, rows[0]?.state || null]));
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) { console.log(usage()); return; }
  const options = parse(argv);
  let result;
  if (options.command === "status") {
    const historical = stale.statusReport(options.outputRoot);
    let scheduler = { scheduler_enabled: false, cadence: "Sunday 05:00", time_zone: "Europe/Bratislava", error: "scheduler status unavailable" };
    try { scheduler = require("./stale-schedule").status(); } catch (error) { scheduler.error = error.code || error.message || "scheduler status unavailable"; }
    result = { ...historical, scheduler_state: scheduler.scheduler_enabled ? "enabled" : "disabled/not installed", scheduler, weekly: weekly.statusReport(options.weeklyStateRoot) };
  } else if (options.command === "demo") result = demo();
  else result = await stale.runStaleVerification(options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error.message || "STALE_VERIFICATION_FAILED"); process.exitCode = 1; });

module.exports = { demo, main, parse, usage };
