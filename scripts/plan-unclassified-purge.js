#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { PURGE_POLICY_VERSION, REQUIRED_SCHEMA_VERSION, readPurgeData, validatePurgeData, writeJson, sha256File } = require("../lib/unclassified-purge");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") options.databasePath = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--repository-commit") options.repositoryCommit = argv[++i];
    else if (arg === "--help") { console.log("usage: node scripts/plan-unclassified-purge.js --database PATH --output-dir DIR --repository-commit COMMIT"); process.exit(0); }
    else throw new Error(`unknown-argument:${arg}`);
  }
  for (const key of ["databasePath", "outputDir"]) if (!options[key]) throw new Error(`missing-${key}`);
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const database = openCatalogDatabase(path.resolve(options.databasePath), { readonly: true, fileMustExist: true });
  try {
    const plan = {
      schema_version: REQUIRED_SCHEMA_VERSION,
      repository_commit: options.repositoryCommit || "UNSPECIFIED",
      ...readPurgeData(database),
      sqlite_write_performed: false,
    };
    validatePurgeData(plan);
    const outputDir = path.resolve(options.outputDir);
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
    const planPath = path.join(outputDir, "purge-plan.json");
    writeJson(planPath, plan);
    const planSha256 = sha256File(planPath);
    writeJson(path.join(outputDir, "preflight.json"), {
      purge_policy_version: PURGE_POLICY_VERSION,
      repository_commit: plan.repository_commit,
      plan_sha256: planSha256,
      database_read_only: true,
      sqlite_write_performed: false,
      schema_version: plan.schema_version,
      baseline: plan.baseline,
      dependent: plan.dependent,
      cross_boundary: plan.baseline.cross_boundary,
    });
    console.log(JSON.stringify({ plan_path: planPath, plan_sha256: planSha256, ...plan }));
  } finally { database.close(); }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { main, parseArgs };
