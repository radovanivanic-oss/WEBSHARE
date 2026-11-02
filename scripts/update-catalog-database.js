#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  canRunFullReconciliation,
  isFullReconciliationEnabled,
  loadAndValidateCatalogManifest,
} = require("../lib/catalog-safety");
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

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = getCatalogConfig();
  const inputPath = path.resolve(
    options.input || path.join(config.runtimeDir, "catalog-items.jsonl")
  );
  const manifestPath = path.resolve(
    options.manifest || path.join(path.dirname(inputPath), "catalog-items.manifest.json")
  );
  const lockPath = path.join(config.runtimeDir, "webshare-crawler.lock");
  if (fs.existsSync(lockPath)) throw new Error("Crawler práve beží; databázový import sa nespustí.");
  if (!fs.existsSync(inputPath)) throw new Error(`Chýba ${inputPath}.`);
  if (!fs.existsSync(manifestPath)) throw new Error(`Chýba ${manifestPath}.`);
  const inputStat = fs.statSync(inputPath);
  const manifest = loadAndValidateCatalogManifest(manifestPath, inputPath, inputStat);

  const importArgs = [
    "--input", inputPath,
    "--database", config.databasePath,
    "--manifest", manifestPath,
    "--batch-size", String(config.importBatchSize),
  ];
  const reconciliationAllowed = canRunFullReconciliation(manifest);
  if (reconciliationAllowed) {
    importArgs.push("--full", "--allow-deactivation");
    console.warn("POZOR: povolený full reconciliation môže deaktivovať súbory nevidené v tomto behu.");
  } else {
    console.warn(
      "SAFETY: import bude inkrementálny bez deaktivácie starých súborov.",
      JSON.stringify({
        run_status: manifest.run_status || "legacy_or_unknown",
        reconciliation_safe: manifest.reconciliation_safe === true,
        is_full: manifest.is_full === true,
        full_reconciliation_env: isFullReconciliationEnabled(),
      })
    );
  }

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
