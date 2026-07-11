#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getCatalogConfig } = require("../src/config/catalog-config");

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} skončil s kódom ${result.status}.`);
}

function main() {
  const config = getCatalogConfig();
  const inputPath = path.join(config.runtimeDir, "catalog-items.jsonl");
  const manifestPath = path.join(config.runtimeDir, "catalog-items.manifest.json");
  const lockPath = path.join(config.runtimeDir, "webshare-crawler.lock");
  if (fs.existsSync(lockPath)) throw new Error("Crawler práve beží; databázový import sa nespustí.");
  if (!fs.existsSync(inputPath)) throw new Error(`Chýba ${inputPath}.`);
  if (!fs.existsSync(manifestPath)) throw new Error(`Chýba ${manifestPath}.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.success) throw new Error("Crawler manifest nie je úspešný.");
  const inputStat = fs.statSync(inputPath);
  if (Number(manifest.source_size) !== inputStat.size) {
    throw new Error("JSONL sa nezhoduje s úspešným crawl manifestom.");
  }

  const importArgs = [
    "--input", inputPath,
    "--database", config.databasePath,
    "--manifest", manifestPath,
    "--batch-size", String(config.importBatchSize),
  ];
  if (manifest.is_full) importArgs.push("--full");
  else console.warn("Crawl obsahuje failed prefixes; import bude inkrementálny bez deaktivácie starých súborov.");

  runNode(path.join("scripts", "import-catalog-jsonl.js"), importArgs);
  runNode(path.join("scripts", "reclassify-catalog.js"), []);
  console.log("Catalog database update OK");
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
