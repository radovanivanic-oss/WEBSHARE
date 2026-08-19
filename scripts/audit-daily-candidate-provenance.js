"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { auditDailyCandidateProvenance, buildPurgedSidecar } = require("../lib/daily-candidate-provenance");

function options(argv) {
  const result = { historicalJsonlPaths: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--historical-jsonl") result.historicalJsonlPaths.push(argv[++i]);
    else if (arg.startsWith("--") && i + 1 < argv.length) result[arg.slice(2).replaceAll("-", "_")] = argv[++i];
    else if (arg === "--help") { console.log("usage: node scripts/audit-daily-candidate-provenance.js --plan PATH --database PATH --b39-database PATH --output-dir DIR --b39-sidecar PATH --b39-source-sha256 HASH [--historical-jsonl PATH ...]"); process.exit(0); }
    else throw new Error(`unknown-argument:${arg}`);
  }
  for (const key of ["plan", "database", "b39_database", "output_dir", "b39_sidecar"]) if (!result[key]) throw new Error(`missing-${key}`);
  return result;
}

(async() => {
  const o = options(process.argv);
  if (fs.existsSync(o.b39_sidecar)) throw new Error(`refusing-to-overwrite-existing-sidecar:${o.b39_sidecar}`);
  const sidecar = buildPurgedSidecar({ currentDatabasePath: o.database, b39DatabasePath: o.b39_database, sourceSha256: o.b39_source_sha256 || null, outputPath: o.b39_sidecar });
  const result = await auditDailyCandidateProvenance({ planPath: o.plan, currentDatabasePath: o.database, b39DatabasePath: o.b39_database, historicalJsonlPaths: o.historicalJsonlPaths, outputDir: o.output_dir, b39SidecarPath: o.b39_sidecar, b39SourceSha256: o.b39_source_sha256 || null });
  console.log(JSON.stringify({ sidecar: { path: o.b39_sidecar, ident_count: sidecar.ident_count, bytes: sidecar.bytes, idents_sha256: sidecar.idents_sha256 }, report: result.report }, null, 2));
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
