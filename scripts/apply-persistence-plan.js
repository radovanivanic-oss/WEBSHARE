
"use strict";

const path = require("node:path");
const { applyPilotPlan } = require("../lib/b47-persistence");

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("B47_ARGUMENT_INVALID");
  return argv[index + 1];
}

function parseArguments(argv) {
  const allowed = new Set(["--plan", "--database", "--purged-ident-sidecar", "--series-root", "--series-id", "--backup-path", "--output-dir", "--prevalidated-backup", "--apply", "--confirm-production-apply"]);
  for (let i = 0; i < argv.length; i += 1) {
    if (!allowed.has(argv[i])) throw new Error("B47_OPTION_NOT_ALLOWED");
    if (!["--apply", "--confirm-production-apply", "--prevalidated-backup"].includes(argv[i])) i += 1;
  }
  const planPath = argument(argv, "--plan");
  if (!planPath) throw new Error("B47_PLAN_REQUIRED");
  return {
    planPath: path.resolve(planPath),
    databasePath: path.resolve(argument(argv, "--database", "data/catalog.sqlite")),
    sidecarPath: path.resolve(argument(argv, "--purged-ident-sidecar", "runtime/maintenance/history/b39-purged-idents.json")),
    seriesRoot: path.resolve(argument(argv, "--series-root", "runtime/daily-observation")),
    seriesId: argument(argv, "--series-id", "b46.7-7day-observation"),
    backupPath: argument(argv, "--backup-path"),
    outputDir: argument(argv, "--output-dir"),
    prevalidatedBackup: argv.includes("--prevalidated-backup"),
    apply: argv.includes("--apply"),
    confirm: argv.includes("--confirm-production-apply"),
  };
}

async function main(options = parseArguments(process.argv.slice(2))) {
  const result = await applyPilotPlan(options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error.message || "B47_APPLY_FAILED"); process.exitCode = 1; });
module.exports = { main, parseArguments };
