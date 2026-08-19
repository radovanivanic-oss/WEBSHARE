"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { planDigest, readAndValidatePurgedSidecar, validateDailyPlan } = require("../lib/daily-candidate-provenance");
const { auditFrozenRecords, fileSha256, freezeAcceptedPlan, writeBatches } = require("../lib/bootstrap-backlog");

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function parseArguments(argv) {
  return {
    database: argument(argv, "--database", "data/catalog.sqlite"),
    plan: argument(argv, "--plan"),
    sidecar: argument(argv, "--purged-ident-sidecar"),
    outputDir: argument(argv, "--output-dir"),
    expectedPlanSha256: argument(argv, "--expected-plan-sha256"),
  };
}

function requireOption(value, name) {
  if (!value) throw new Error(`${name}_REQUIRED`);
  return path.resolve(value);
}

function main(options = parseArguments(process.argv.slice(2))) {
  const databasePath = requireOption(options.database, "DATABASE");
  const planPath = requireOption(options.plan, "PLAN");
  const sidecarPath = requireOption(options.sidecar, "SIDECAR");
  const outputDir = requireOption(options.outputDir, "OUTPUT_DIR");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  validateDailyPlan(plan);
  const actualPlanSha256 = planDigest(plan);
  if (actualPlanSha256 !== plan.plan_sha256 || (options.expectedPlanSha256 && actualPlanSha256 !== options.expectedPlanSha256)) throw new Error("BOOTSTRAP_SOURCE_PLAN_DIGEST_MISMATCH");
  const sidecar = readAndValidatePurgedSidecar(sidecarPath);
  const database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  try {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
    const freeze = freezeAcceptedPlan({ plan, database, purgedIdents: new Set(sidecar.idents), sourcePlanSha256: actualPlanSha256, outputDir });
    const audit = auditFrozenRecords({ freeze, database, purgedIdents: new Set(sidecar.idents), outputDir });
    const batches = writeBatches(audit, outputDir);
    const result = {
      source_plan: planPath,
      source_plan_sha256: actualPlanSha256,
      source_plan_artifact_sha256: fileSha256(planPath),
      sidecar: sidecarPath,
      sidecar_artifact_sha256: fileSha256(sidecarPath),
      freeze_count: freeze.candidate_count,
      freeze_digest: freeze.logical_digest,
      audit_count: audit.approved_count,
      rejected_count: audit.rejected_count,
      audit_digest: audit.approved_logical_digest,
      batch_count: batches.manifest.batch_count,
      batch_size: batches.manifest.batch_size,
      output_dir: outputDir,
    };
    fs.writeFileSync(path.join(outputDir, "bootstrap-run-summary.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o640 });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, parseArguments };
