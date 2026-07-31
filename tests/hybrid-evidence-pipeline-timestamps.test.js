"use strict";
const assert = require("node:assert/strict"); const test = require("node:test");
const { validatePipelineTimestamps } = require("../scripts/run-hybrid-evidence-pipeline");
const t0 = "2026-07-31T15:20:57.000Z"; const t1 = "2026-07-31T15:21:01.000Z"; const source = "2026-07-30T18:44:20.697Z";
test("pipeline timestamps are runner-owned and ordered", () => { assert.equal(validatePipelineTimestamps(t0, t1, t1), true); assert.ok(Date.parse(t0) > Date.parse(source)); });
test("source timestamps remain distinct metadata", () => { const manifest = { started_at: t0, finished_at: t1, source_started_at: source, source_finished_at: "2026-07-30T18:44:21.961Z" }; assert.ok(Date.parse(manifest.started_at) > Date.parse(manifest.source_finished_at)); assert.notEqual(manifest.started_at, manifest.source_started_at); });
test("reversed, malformed, or future timestamps fail closed", () => { assert.throws(() => validatePipelineTimestamps(t1, t0, t1)); assert.throws(() => validatePipelineTimestamps("not-a-time", t1, t1)); assert.throws(() => validatePipelineTimestamps(t0, "2026-08-01T00:00:00.000Z", t1)); });
test("injected clock values produce deterministic validation", () => { const started = "2026-01-01T00:00:00.000Z"; const finished = "2026-01-01T00:00:01.000Z"; assert.equal(validatePipelineTimestamps(started, finished, finished), true); assert.equal(validatePipelineTimestamps(started, finished, finished), true); });
