"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { guard, parse } = require("../scripts/run-candidate-metadata-b23");

test("B23 runner accepts only its direct, new runtime root", () => {
  const runtime = path.resolve("runtime");
  assert.doesNotThrow(() => guard(path.join(runtime, "candidate-metadata-b23-20260803T000000Z")));
  assert.throws(() => guard(path.join(runtime, "candidate-metadata-b22-20260803T000000Z")));
  assert.throws(() => guard(path.resolve("candidate-metadata-b23-20260803T000000Z")));
  assert.deepEqual(parse(["--source-file-exists-dir", "source", "--output-dir", "output"]), { source: path.resolve("source"), output: path.resolve("output") });
});
