#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { compactCatalog } = require("../lib/catalog-compaction");
const { writeJson } = require("../lib/unclassified-purge");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") options.databasePath = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--compact-path") options.compactPath = argv[++i];
    else if (arg === "--expected-counts-json") options.expectedCountsPath = argv[++i];
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--maintenance-window-confirmed") options.maintenanceConfirmed = true;
    else if (arg === "--run-id") options.runId = argv[++i];
    else if (arg === "--help") { console.log("usage: node scripts/compact-catalog.js --database PATH --output-dir DIR --expected-counts-json PATH [--compact-path PATH] [--replace --maintenance-window-confirmed]"); process.exit(0); }
    else throw new Error(`unknown-argument:${arg}`);
  }
  for (const key of ["databasePath", "outputDir", "expectedCountsPath"]) if (!options[key]) throw new Error(`missing-${key}`);
  if (options.replace && !options.maintenanceConfirmed) throw new Error("maintenance-confirmation-required");
  options.expected = JSON.parse(fs.readFileSync(path.resolve(options.expectedCountsPath), "utf8"));
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await compactCatalog(options);
  writeJson(path.join(path.resolve(options.outputDir), "compaction.json"), { ...result, replacement_performed: Boolean(result.replacement) });
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { main, parseArgs };
