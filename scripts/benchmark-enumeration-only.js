#!/usr/bin/env node
"use strict";

const { compareIdentSets } = require("../lib/enumeration-only");

function parseSizes(argv) {
  const index = argv.indexOf("--sizes");
  return (index >= 0 ? argv[index + 1] : "1000,10000,50000").split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
}

function main(argv = process.argv.slice(2)) {
  const results = [];
  for (const size of parseSizes(argv)) {
    const known = new Set(Array.from({ length: size }, (_, index) => `known-${index}`));
    const records = Array.from({ length: size }, (_, index) => index % 10 === 0 ? `new-${index}` : `known-${index}`);
    const startedAt = process.hrtime.bigint();
    const comparison = compareIdentSets({ knownIdents: known, observedIdents: records });
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    results.push({ size, observed_unique: comparison.observed_unique, new_ident_count: comparison.new_idents.length, duration_ms: Number(durationMs.toFixed(3)), records_per_second: Math.round(size / (durationMs / 1000)) });
  }
  console.log(JSON.stringify({ mode: "synthetic-local-enumeration-compare", results }, null, 2));
  return results;
}

if (require.main === module) main();

module.exports = { main, parseSizes };
