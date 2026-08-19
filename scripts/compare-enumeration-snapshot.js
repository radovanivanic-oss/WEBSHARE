#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const {
  buildEnumerationCertificate,
  compareIdentSets,
  createKnownIdentIndex,
  toMinimalRecord,
  validatePartitionProof,
} = require("../lib/enumeration-only");

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function usage() {
  return "node scripts/compare-enumeration-snapshot.js --database FILE --input-jsonl FILE --output-dir DIR --run-id ID [--coverage-status UNPROVEN|PROVEN_COMPLETE --partition-proof FILE]";
}

async function main(argv = process.argv.slice(2)) {
  const databasePath = arg(argv, "--database");
  const inputPath = arg(argv, "--input-jsonl");
  const outputDir = arg(argv, "--output-dir");
  const runId = arg(argv, "--run-id");
  if (!databasePath || !inputPath || !outputDir || !runId) throw new Error(usage());
  const coverageStatus = arg(argv, "--coverage-status") || "UNPROVEN";
  const partitionProofPath = arg(argv, "--partition-proof");
  let partitionProof = { declared: [], catch_all: false };
  if (coverageStatus === "PROVEN_COMPLETE") {
    if (!partitionProofPath) throw new Error("PROVEN_COMPLETE_REQUIRES_PARTITION_PROOF");
    partitionProof = validatePartitionProof(JSON.parse(fs.readFileSync(partitionProofPath, "utf8")));
  }
  const startedAt = new Date().toISOString();
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
  const database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  const knownIndex = createKnownIdentIndex(database);
  const observed = new Set();
  const newRecordsPath = path.join(outputDir, "new-items.jsonl");
  const output = fs.createWriteStream(newRecordsPath, { flags: "wx", mode: 0o640 });
  let rawRecords = 0;
  let duplicateCount = 0;
  let malformedCount = 0;
  const digest = crypto.createHash("sha256");
  const input = readline.createInterface({ input: fs.createReadStream(inputPath, { flags: "r" }), crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      rawRecords += 1;
      let parsed;
      try { parsed = JSON.parse(line); } catch { malformedCount += 1; continue; }
      const record = toMinimalRecord(parsed, { runId, partition: parsed.partition || null });
      if (!record) { malformedCount += 1; continue; }
      if (observed.has(record.ident)) { duplicateCount += 1; continue; }
      observed.add(record.ident);
      digest.update(`${record.ident}\n`);
      if (!knownIndex.idents.has(record.ident)) {
        const lineOutput = `${JSON.stringify(record)}\n`;
        if (!output.write(lineOutput)) await new Promise((resolve) => output.once("drain", resolve));
      }
    }
  } finally {
    input.close();
    await new Promise((resolve, reject) => { output.end((error) => error ? reject(error) : resolve()); });
    database.close();
  }
  const comparison = compareIdentSets({ knownIdents: knownIndex.idents, observedIdents: observed, complete: coverageStatus === "PROVEN_COMPLETE", coverageStatus });
  const certificate = buildEnumerationCertificate({
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    queryContract: { source: "existing-crawler-export", input_path_not_persisted: true },
    partitions: partitionProof,
    completionStatus: "COMPLETE",
    coverageStatus,
    rawRecords,
    uniqueIdents: observed,
    duplicateCount,
    malformedCount,
    knownIndex,
    comparison,
  });
  fs.writeFileSync(path.join(outputDir, "enumeration-certificate.json"), `${JSON.stringify(certificate, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  const summary = { ...certificate, known_lookup: knownIndex.metrics, snapshot_input_sha256: digest.digest("hex"), new_items_path: newRecordsPath };
  fs.writeFileSync(path.join(outputDir, "enumeration-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { main, usage };
