#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const weekly = require("../lib/weekly-stale-maintenance");

function loadDotEnv(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, "$2");
  }
}

function rotateLog(file, maxBytes = 5 * 1024 * 1024, keep = 8) {
  if (!file || !fs.existsSync(file) || fs.statSync(file).size <= maxBytes) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  for (let index = keep - 1; index >= 1; index -= 1) {
    const old = `${file}.${index}`;
    const next = `${file}.${index + 1}`;
    if (fs.existsSync(old)) { if (index + 1 >= keep) fs.rmSync(old); else fs.renameSync(old, next); }
  }
  fs.renameSync(file, `${file}.1`);
}

function logger(file) {
  if (!file) return () => {};
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  return (event) => fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o640 });
}

async function main() {
  loadDotEnv();
  if (!process.env.MAINTENANCE_PUBLICATION_ADAPTER) process.env.MAINTENANCE_PUBLICATION_ADAPTER = path.join(process.cwd(), "lib/maintenance-publication-adapter.js");
  const logFile = path.resolve(process.env.STALE_WEEKLY_LOG || "runtime/stale-weekly/weekly.log");
  rotateLog(logFile);
  const result = await weekly.runWeeklyStaleMaintenance({ stateRoot: process.env.STALE_WEEKLY_STATE_ROOT, runsRoot: process.env.STALE_WEEKLY_RUNS_ROOT, databasePath: process.env.PRODUCTION_DATABASE_PATH, sidecarPath: process.env.B39_SIDECAR_PATH, observationRoot: process.env.DAILY_OBSERVATION_ROOT, publicRepository: process.env.PUBLIC_KODI_REPOSITORY, generationId: process.env.STALE_GENERATION_ID }, { logger: logger(logFile) });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(weekly.safeError(error)); process.exitCode = 1; });

module.exports = { loadDotEnv, main, rotateLog };
