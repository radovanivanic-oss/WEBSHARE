#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { applyUnclassifiedPurge, PURGE_POLICY_VERSION, sha256File, writeJson } = require("../lib/unclassified-purge");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") options.databasePath = argv[++i];
    else if (arg === "--plan") options.planPath = argv[++i];
    else if (arg === "--expected-plan-sha256") options.expectedPlanSha256 = argv[++i];
    else if (arg === "--backup") options.backupPath = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--run-id") options.runId = argv[++i];
    else if (arg === "--help") { console.log("usage: node scripts/apply-unclassified-purge.js --database PATH --plan PATH --expected-plan-sha256 HASH --backup PATH --output-dir DIR"); process.exit(0); }
    else throw new Error(`unknown-argument:${arg}`);
  }
  for (const key of ["databasePath", "planPath", "expectedPlanSha256", "backupPath", "outputDir"]) if (!options[key]) throw new Error(`missing-${key}`);
  if (!/^[a-f0-9]{64}$/u.test(options.expectedPlanSha256)) throw new Error("invalid-plan-digest");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await applyUnclassifiedPurge(options);
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
  writeJson(path.join(outputDir, "transaction.json"), result);
  writeJson(path.join(outputDir, "purge.manifest.json"), { ...result, purge_policy_version: PURGE_POLICY_VERSION, sqlite_write_performed: true, finished_reason: "committed" });
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { main, parseArgs };
