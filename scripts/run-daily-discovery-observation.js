"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ObservationError, runObservation } = require("../lib/daily-observation");

const OPTIONS = new Set(["--series-root", "--series-id", "--database", "--purged-ident-sidecar"]);

function value(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new ObservationError("OBSERVATION_ARGUMENT_INVALID");
  return argv[index + 1];
}

function parseArguments(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (!OPTIONS.has(argv[index])) throw new ObservationError("OBSERVATION_OPTION_NOT_ALLOWED");
    index += 1;
  }
  return {
    seriesRoot: value(argv, "--series-root", path.join("runtime", "daily-observation")),
    seriesId: value(argv, "--series-id", "b46.7-7day-observation"),
    database: value(argv, "--database", path.join("data", "catalog.sqlite")),
    sidecar: value(argv, "--purged-ident-sidecar", path.join("runtime", "maintenance", "history", "b39-purged-idents.json")),
  };
}

function repositoryCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
}

async function main(options = parseArguments(process.argv.slice(2))) {
  const result = await runObservation({ ...options, repositoryCommit: repositoryCommit() });
  console.log(JSON.stringify({ status: result.manifest.status, observation: result.manifest.observation_finished_at, artifact_dir: result.manifest.series_id ? path.relative(process.cwd(), result.runDir) : null, summary: result.summary }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error instanceof ObservationError ? error.code : "OBSERVATION_FAILED"); process.exitCode = 1; });

module.exports = { main, parseArguments, repositoryCommit };
