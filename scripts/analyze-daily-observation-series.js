"use strict";

const path = require("node:path");
const { analyzeSeries, writeAnalysisReport } = require("../lib/daily-observation-analyzer");

function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

function parseArguments(argv) {
  const allowed = new Set(["--series-root", "--series-id", "--output", "--require-complete"]);
  for (let index = 0; index < argv.length; index += 1) {
    if (!allowed.has(argv[index])) throw new Error("ANALYZER_OPTION_INVALID");
    if (argv[index] !== "--require-complete") index += 1;
  }
  return {
    seriesRoot: path.resolve(argument(argv, "--series-root", path.join("runtime", "daily-observation"))),
    seriesId: argument(argv, "--series-id", null),
    outputPath: argument(argv, "--output", null),
    allowIncomplete: !argv.includes("--require-complete"),
  };
}

function main(options = parseArguments(process.argv.slice(2))) {
  const result = writeAnalysisReport(options);
  console.log(JSON.stringify({ series_id: result.report.series_id, complete: result.report.complete, valid_observations: result.report.valid_observations, output: result.outputPath }, null, 2));
  return result.report;
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }

module.exports = { analyzeSeries, main, parseArguments };
