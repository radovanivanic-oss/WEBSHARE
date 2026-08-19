#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { validatePublicCatalog } = require("../lib/public-catalog");

const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  console.error("usage: node scripts/validate-public-catalog.js CATALOG_V1_ROOT");
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(validatePublicCatalog(path.resolve(root)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
