#!/usr/bin/env node
"use strict";

const path = require("node:path");
const m = require("../lib/maintenance-cycle");

function parse(argv) {
  const command = argv[0] || "status";
  const allowed = new Set(["--cycle-id", "--cycle-root", "--database", "--observation-root", "--sidecar", "--public-repository", "--observation-cutoff", "--max-candidates", "--plan-sha", "--candidate-set-sha", "--confirm", "--identity", "--generation-id", "--demo-root"]);
  const out = { command };
  for (let i = 1; i < argv.length; i++) {
    if (!allowed.has(argv[i]) || !argv[i + 1]) throw new Error("MAINTENANCE_OPTION_INVALID:" + argv[i]);
    out[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (command !== "demo" && !out.cycleId) throw new Error("MAINTENANCE_CYCLE_ID_REQUIRED");
  if (out.database) out.databasePath = path.resolve(out.database);
  if (out.observationRoot) out.observationRoot = path.resolve(out.observationRoot);
  if (out.sidecar) out.sidecarPath = path.resolve(out.sidecar);
  if (out.publicRepository) out.publicRepository = path.resolve(out.publicRepository);
  if (out.cycleRoot) out.cycleRoot = path.resolve(out.cycleRoot);
  if (out.demoRoot) out.demoRoot = path.resolve(out.demoRoot);
  if (out.maxCandidates !== undefined) out.maxCandidates = Number(out.maxCandidates);
  return out;
}

function usage() {
  return [
    "maintenance prepare --cycle-id ID [--observation-cutoff ISO] [--max-candidates 500]",
    "maintenance status --cycle-id ID",
    "maintenance authorize-apply --cycle-id ID --plan-sha SHA --confirm \"AUTHORIZE APPLY ID SHA\"",
    "maintenance apply --cycle-id ID",
    "maintenance prepare-publication --cycle-id ID [--generation-id ID]",
    "maintenance authorize-publication --cycle-id ID --plan-sha SHA --confirm \"AUTHORIZE PUBLICATION ID SHA\"",
    "maintenance publish --cycle-id ID",
    "maintenance demo [--demo-root DIR]",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (options.command === "help" || options.command === "--help") { console.log(usage()); return { status: "HELP" }; }
  let result;
  if (options.command === "prepare") result = m.prepare(options);
  else if (options.command === "status") result = m.status(options.cycleId, options.cycleRoot);
  else if (options.command === "authorize-apply") result = m.authorizeApply({ cycleId: options.cycleId, cycleRoot: options.cycleRoot, planSha: options.planSha, candidateSetSha: options.candidateSetSha, confirmation: options.confirm, identity: options.identity });
  else if (options.command === "apply") result = await m.apply(options);
  else if (options.command === "prepare-publication") result = await m.preparePublication(options);
  else if (options.command === "authorize-publication") result = m.authorizePublication({ cycleId: options.cycleId, cycleRoot: options.cycleRoot, planSha: options.planSha, confirmation: options.confirm, identity: options.identity });
  else if (options.command === "publish") result = await m.publish(options);
  else if (options.command === "demo") result = m.demonstrate(options);
  else throw new Error("MAINTENANCE_COMMAND_INVALID:" + options.command);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error.message || "MAINTENANCE_FAILED"); process.exitCode = 1; });
module.exports = { main, parse, usage };
