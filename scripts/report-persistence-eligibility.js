
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ObservationError } = require("../lib/daily-observation");
const { createB47Artifacts, derivePersistenceLedger, PILOT_MAX_CANDIDATES } = require("../lib/b47-persistence");

const OPTIONS = new Set(["--series-root", "--series-id", "--database", "--purged-ident-sidecar", "--output-dir", "--max-candidates"]);

function value(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new ObservationError("B47_ARGUMENT_INVALID");
  return argv[index + 1];
}

function parseArguments(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (!OPTIONS.has(argv[index])) throw new ObservationError("B47_OPTION_NOT_ALLOWED");
    index += 1;
  }
  const maxCandidates = Number(value(argv, "--max-candidates", String(PILOT_MAX_CANDIDATES)));
  if (!Number.isInteger(maxCandidates) || maxCandidates < 0 || maxCandidates > PILOT_MAX_CANDIDATES) throw new ObservationError("B47_PILOT_LIMIT_INVALID");
  return {
    seriesRoot: path.resolve(value(argv, "--series-root", path.join("runtime", "daily-observation"))),
    seriesId: value(argv, "--series-id", "b46.7-7day-observation"),
    database: path.resolve(value(argv, "--database", path.join("data", "catalog.sqlite"))),
    sidecarPath: path.resolve(value(argv, "--purged-ident-sidecar", path.join("runtime", "maintenance", "history", "b39-purged-idents.json"))),
    outputDir: value(argv, "--output-dir", null),
    maxCandidates,
  };
}

function repositoryCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
}

function runId(now) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
}

function main(options = parseArguments(process.argv.slice(2))) {
  const now = new Date().toISOString();
  const outputDir = path.resolve(options.outputDir || path.join("runtime", "b47-persistence", runId(now)));
  if (fs.existsSync(outputDir)) throw new ObservationError("B47_OUTPUT_ALREADY_EXISTS");
  const ledger = derivePersistenceLedger({
    seriesRoot: options.seriesRoot,
    seriesId: options.seriesId,
    databasePath: options.database,
    sidecarPath: options.sidecarPath,
  });
  const result = createB47Artifacts({
    ledger,
    outputDir,
    createdAt: now,
    sourceSeriesRoot: path.relative(process.cwd(), options.seriesRoot).replaceAll(path.sep, "/"),
    maxCandidates: options.maxCandidates,
    toolBuildIdentity: { tool: "b47-persistence-report", policy_version: "b47-hybrid-persistence-v1", repository_commit: repositoryCommit() },
  });
  console.log(JSON.stringify({
    status: "DRY_RUN",
    output_dir: outputDir,
    series_id: ledger.series_id,
    semantic_contract_id: ledger.semantic_contract_id,
    stats: ledger.stats,
    pilot_plan: { count: result.plan.discovery_delta.length, plan_sha256: result.plan.plan_sha256, candidate_set_sha256: result.plan.candidate_set_sha256, counters: result.plan.counters },
    safety: { production_mutated: false, public_pointer_mutated: false, automatic_import: false },
  }, null, 2));
  return result;
}

if (require.main === module) { try { main(); } catch (error) { console.error(error instanceof ObservationError ? error.code : (error.message || "B47_REPORT_FAILED")); process.exitCode = 1; } }
module.exports = { main, parseArguments, repositoryCommit };
