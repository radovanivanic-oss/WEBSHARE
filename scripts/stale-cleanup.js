#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runStaleCleanup, safeError } = require("../lib/stale-cleanup");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function rotateBoundedLog(filePath) {
  if (!filePath) return;
  const maximumBytes = 5 * 1024 * 1024;
  const keep = 8;
  try {
    const absolute = path.resolve(filePath);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size < maximumBytes) return;
    const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    fs.renameSync(absolute, `${absolute}.${stamp}`);
    const prefix = `${path.basename(absolute)}.`;
    const archived = fs.readdirSync(path.dirname(absolute)).filter((name) => name.startsWith(prefix)).sort().reverse();
    for (const name of archived.slice(keep)) fs.unlinkSync(path.join(path.dirname(absolute), name));
  } catch {}
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env"));
  if (!process.env.MAINTENANCE_PUBLICATION_ADAPTER) process.env.MAINTENANCE_PUBLICATION_ADAPTER = path.join(process.cwd(), "lib/maintenance-publication-adapter.js");
  rotateBoundedLog(process.env.STALE_CLEANUP_LOG);
  const result = await runStaleCleanup({
    evidenceRoot: process.env.STALE_B56_EVIDENCE_ROOT,
    outputRoot: process.env.STALE_CLEANUP_OUTPUT_ROOT,
    databasePath: process.env.PRODUCTION_DB,
    sidecarPath: process.env.B39_SIDECAR_PATH,
    observationRoot: process.env.DAILY_OBSERVATION_ROOT,
    publicRepository: process.env.PUBLIC_REPOSITORY,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "LOCKED") process.exitCode = 2;
}

main().catch((error) => {
  const safe = safeError(error);
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = 1;
});
