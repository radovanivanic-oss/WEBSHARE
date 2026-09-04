#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runAutomaticProductionMaintenance } = require("../lib/production-maintenance");

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
  const maximumBytes = 10 * 1024 * 1024;
  const keep = 14;
  try {
    const absolute = path.resolve(filePath);
    if (fs.statSync(absolute).size < maximumBytes) return;
    const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    fs.renameSync(absolute, `${absolute}.${stamp}`);
    const prefix = `${path.basename(absolute)}.`;
    const archived = fs.readdirSync(path.dirname(absolute)).filter((name) => name.startsWith(prefix)).sort().reverse();
    for (const name of archived.slice(keep)) fs.unlinkSync(path.join(path.dirname(absolute), name));
  } catch {}
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env"));
  rotateBoundedLog(process.env.PRODUCTION_MAINTENANCE_LOG);
  const result = await runAutomaticProductionMaintenance();
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "DISCOVERY_FAILED") process.exitCode = 1;
}

main().catch((error) => {
  const code = String(error?.code || "PRODUCTION_MAINTENANCE_FAILED").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 160);
  console.error(code || "PRODUCTION_MAINTENANCE_FAILED");
  process.exitCode = 1;
});
