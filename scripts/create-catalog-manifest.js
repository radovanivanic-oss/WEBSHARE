#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getCatalogConfig } = require("../src/config/catalog-config");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  if (!process.argv.includes("--confirmed-full")) {
    throw new Error("Manifest možno vytvoriť iba s explicitným --confirmed-full.");
  }
  const items = Number.parseInt(argument("--items"), 10);
  if (!Number.isFinite(items) || items < 1) {
    throw new Error("Chýba platný --items počet.");
  }
  const config = getCatalogConfig();
  const inputPath = path.resolve(argument("--input") || path.join(config.runtimeDir, "catalog-items.jsonl"));
  const manifestPath = path.resolve(argument("--output") || path.join(config.runtimeDir, "catalog-items.manifest.json"));
  const lockPath = path.join(config.runtimeDir, "webshare-crawler.lock");
  if (fs.existsSync(lockPath)) throw new Error("Crawler práve beží.");
  const stat = fs.statSync(inputPath);
  const manifest = {
    success: true,
    is_full: true,
    generated_at: new Date().toISOString(),
    source_path: inputPath,
    source_size: stat.size,
    source_mtime_ms: Math.trunc(stat.mtimeMs),
    items,
    failed_prefixes: 0,
    manually_confirmed: true,
  };
  fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  console.log(manifestPath);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
