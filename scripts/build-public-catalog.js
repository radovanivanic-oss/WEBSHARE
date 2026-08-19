#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { buildPublicCatalog } = require("../lib/public-catalog");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--database", "--output-dir", "--generation-id", "--object-base-url", "--build-source-commit"].includes(key) || !argv[i + 1]) throw new Error("usage: node scripts/build-public-catalog.js --database FILE --output-dir DIR --generation-id ID [--object-base-url URL] [--build-source-commit COMMIT]");
    out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (!out.database || !out.outputDir || !out.generationId) throw new Error("missing required arguments");
  return { ...out, database: path.resolve(out.database), outputDir: path.resolve(out.outputDir) };
}

if (require.main === module) {
  try {
    const result = buildPublicCatalog(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ manifest: result.manifest, output: result.root }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };
