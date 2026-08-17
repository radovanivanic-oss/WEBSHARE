#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { applyMediaEntityMigration, MIGRATION_POLICY_VERSION } = require("../lib/media-entity-migration");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") options.databasePath = argv[++i];
    else if (arg === "--plan") options.planPath = argv[++i];
    else if (arg === "--expected-plan-sha256") options.expectedPlanSha256 = argv[++i];
    else if (arg === "--backup") options.backupPath = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--expected-groups") options.expectedGroups = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-groups") options.maxGroups = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-file-reassignments") options.maxFileReassignments = Number.parseInt(argv[++i], 10);
    else if (arg === "--expected-counts-json") options.expectedCountsPath = argv[++i];
    else if (arg === "--help") { console.log("usage: node scripts/apply-media-entity-resolution.js --database PATH --plan PATH --expected-plan-sha256 HASH --backup PATH --output-dir DIR --expected-groups N --max-groups N --max-file-reassignments N --expected-counts-json PATH"); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ["databasePath", "planPath", "expectedPlanSha256", "backupPath", "outputDir", "expectedCountsPath"]) if (!options[key]) throw new Error(`missing-${key}`);
  options.expectedCounts = JSON.parse(fs.readFileSync(path.resolve(options.expectedCountsPath), "utf8"));
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await applyMediaEntityMigration(options);
  fs.mkdirSync(path.resolve(options.outputDir), { recursive: true, mode: 0o750 });
  fs.writeFileSync(path.join(path.resolve(options.outputDir), "transaction.json"), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(path.resolve(options.outputDir), "migration.manifest.json"), `${JSON.stringify({ ...result, migration_policy_version: MIGRATION_POLICY_VERSION, finished_reason: "committed" }, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { main, parseArgs };
