"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  FIELDS,
  createCandidateMetadataConfig,
  normalizeMetadata,
  runCandidateMetadata,
} = require("../lib/discovery/candidate-metadata");

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function response(fields) {
  return { name: ["movie.mkv"], available: ["1"], removed: ["0"], ...fields };
}

async function acquire(t, outcome) {
  const config = createCandidateMetadataConfig({
    root: root(t), idents: ["safe-ident"], limits: { maxCandidates: 1, maxRequests: 1 },
  });
  const result = await runCandidateMetadata(config, {
    fileInfo: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return JSON.parse(fs.readFileSync(config.paths.snapshot, "utf8")).records[0];
}

function assertSafeError(record) {
  assert.deepEqual(Object.keys(record).sort(), FIELDS.slice().sort());
  assert.equal(record.raw_json, null);
  assert.equal(record.original_name, null);
  assert.equal(record.normalized_name, null);
  assert.match(record.transport_error, /^[A-Z_]{1,64}$/);
  assert.doesNotMatch(JSON.stringify(record), /wst|token|password|<response|raw-body/i);
}

test("normalizes complete metadata into approved bounded fields", () => {
  const record = normalizeMetadata("id", response({ name: ["Movie.2024.mkv"], type: ["mkv"], size: ["123"] }), "2026-01-01T00:00:00.000Z");
  assert.equal(record.metadata_status, "METADATA_READY");
  assert.equal(record.normalized_name, "movie-2024-mkv");
  assert.doesNotMatch(record.raw_json, /url|token|password/i);
});

test("candidate metadata maps adapter outcomes to stable statuses and persists only approved fields", async (t) => {
  const cases = [
    ["ready", response(), "METADATA_READY", null, false],
    ["incomplete", response({ name: [""] }), "METADATA_INCOMPLETE", null, false],
    ["unavailable", response({ available: ["0"], removed: ["1"] }), "NOT_AVAILABLE", null, false],
    ["retry", Object.assign(new Error("wst token password raw-body"), { code: "TIMEOUT", retryable: true }), "RETRY_LATER", "TIMEOUT", true],
    ["fatal", Object.assign(new Error("wst token password raw-body"), { code: "MALFORMED_RESPONSE", retryable: false }), "TRANSPORT_ERROR", "MALFORMED_RESPONSE", false],
  ];
  for (const [label, outcome, status, code, retryable] of cases) {
    const record = await acquire(t, outcome);
    assert.equal(record.metadata_status, status, label);
    assert.equal(record.transport_error, code, label);
    assert.equal(record.retryable, retryable, label);
    if (code) assertSafeError(record);
  }
});

test("candidate metadata redacts unknown adapter codes and invalid input remains invalid", async (t) => {
  const record = await acquire(t, Object.assign(new Error("wst=secret password=secret <response>raw-body</response>"), { code: "WST_SECRET_TOKEN", retryable: false }));
  assert.equal(record.metadata_status, "TRANSPORT_ERROR");
  assert.equal(record.transport_error, "TRANSPORT_ERROR");
  assertSafeError(record);
  assert.throws(() => createCandidateMetadataConfig({ root: root(t), idents: [""] }), /invalid metadata input/);
});

test("interruption resumes without duplicate records and rejects mismatches", async (t) => {
  const value = root(t);
  const config = createCandidateMetadataConfig({ root: value, idents: ["a", "b"], limits: { maxCandidates: 2, maxRequests: 2 } });
  const session = { fileInfo: async (ident) => response({ name: [`${ident}.mkv`] }) };
  await runCandidateMetadata(config, session, { stopAfter: 1 });
  const done = await runCandidateMetadata(config, session, { resume: true });
  assert.equal(done.manifest.processed, 2);
  await assert.rejects(runCandidateMetadata(createCandidateMetadataConfig({ root: value, idents: ["a", "c"], limits: { maxCandidates: 2, maxRequests: 2 } }), session, { resume: true }), /mismatch/);
  fs.writeFileSync(config.paths.manifest, "{}");
  await assert.rejects(runCandidateMetadata(config, session, { resume: true }));
});
