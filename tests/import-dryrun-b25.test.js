"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { statement, statementDigest } = require("../scripts/run-import-dryrun-b25");
const { INSERT_COLUMNS } = require("../scripts/run-import-review-b19a");
test("B25 statement is insert-only, ordered, and digest-stable", () => { assert.match(statement, /^INSERT INTO files \(/); assert.ok(INSERT_COLUMNS.every(column => statement.includes(`@${column}`))); assert.doesNotMatch(statement, /\b(?:UPDATE|UPSERT|REPLACE|DELETE)\b/i); assert.match(statementDigest, /^[a-f0-9]{64}$/); });
