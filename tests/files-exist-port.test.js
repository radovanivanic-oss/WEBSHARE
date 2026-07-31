"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_LOG_BYTES,
  createFilesExistConfig,
  runFilesExistEvidence,
} = require("../lib/discovery/files-exist-port");

function fixture(t, suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `webshare-files-exist-${suffix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function config(root, idents, limits = {}) {
  return createFilesExistConfig({
    root,
    idents,
    limits: {
      maxIdents: 20,
      maxRequests: 20,
      maxDurationMs: 10_000,
      ...limits,
    },
  });
}

function sessionFor(results, calls = []) {
  return {
    async filesExist(ident) {
      calls.push(ident);
      const value = results[ident];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

test("files_exist records only bounded evidence for existing and missing idents", async (t) => {
  const root = fixture(t, "basic");
  const current = config(root, ["exists", "missing"]);
  const result = await runFilesExistEvidence(
    current,
    sessionFor({
      exists: { exists: true, status: 200, title: "must-not-persist" },
      missing: { exists: false, status: 404, filename: "must-not-persist" },
    })
  );
  assert.equal(result.manifest.checked, 2);
  assert.equal(result.manifest.exists, 1);
  assert.equal(result.manifest.missing, 1);
  assert.equal(result.manifest.transport_errors, 0);
  assert.equal(result.manifest.evidence_only, true);
  assert.equal(result.manifest.import_performed, false);
  assert.equal(result.manifest.publication_performed, false);
  assert.equal(result.manifest.reconciliation_performed, false);
  assert.equal(result.manifest.deactivation_allowed, false);
  const evidence = JSON.parse(fs.readFileSync(current.paths.evidence, "utf8"));
  assert.deepEqual(evidence.records, [
    {
      ident: "exists",
      exists: true,
      checked_at: evidence.records[0].checked_at,
      response_status: 200,
      transport_error: null,
      retryable: false,
    },
    {
      ident: "missing",
      exists: false,
      checked_at: evidence.records[1].checked_at,
      response_status: 404,
      transport_error: null,
      retryable: false,
    },
  ]);
  const raw = fs.readFileSync(current.paths.evidence, "utf8");
  assert.equal(raw.includes("must-not-persist"), false);
});

test("files_exist classifies transport and retryable errors without retries", async (t) => {
  const root = fixture(t, "errors");
  const calls = [];
  const result = await runFilesExistEvidence(
    config(root, ["temporary", "fatal"]),
    sessionFor(
      {
        temporary: Object.assign(new Error("temporary failure"), {
          status: 503,
        }),
        fatal: Object.assign(new Error("fatal failure"), { status: 400 }),
      },
      calls
    )
  );
  assert.deepEqual(calls, ["temporary", "fatal"]);
  assert.equal(result.manifest.checked, 2);
  assert.equal(result.manifest.transport_errors, 2);
  assert.equal(result.manifest.retryable_errors, 1);
  const records = JSON.parse(fs.readFileSync(result.paths.evidence, "utf8")).records;
  assert.equal(records[0].exists, false);
  assert.equal(records[0].retryable, true);
  assert.equal(records[1].retryable, false);
  assert.equal(records[0].transport_error, "temporary failure");
});

test("files_exist checkpoints before transport and resumes remaining idents", async (t) => {
  const root = fixture(t, "resume");
  const current = config(root, ["one", "two", "three"]);
  const controller = new AbortController();
  const firstCalls = [];
  const firstSession = {
    async filesExist(ident) {
      firstCalls.push(ident);
      if (ident === "two") {
        controller.abort(new Error("operator stop"));
        throw controller.signal.reason;
      }
      return { exists: ident === "one", status: ident === "one" ? 200 : 404 };
    },
  };
  const interrupted = await runFilesExistEvidence(current, firstSession, {
    signal: controller.signal,
  });
  assert.equal(interrupted.manifest.status, "interrupted");
  assert.deepEqual(firstCalls, ["one", "two"]);
  const checkpoint = JSON.parse(fs.readFileSync(current.paths.checkpoint, "utf8"));
  assert.deepEqual(checkpoint.checked_idents, ["one"]);
  assert.equal(checkpoint.next_index, 1);
  assert.equal(checkpoint.requests_reserved, 2);
  assert.equal(checkpoint.requests_completed, 2);

  const manifestPath = current.paths.manifest;
  const manifestBefore = fs.readFileSync(manifestPath, "utf8");
  const corruptManifest = JSON.parse(manifestBefore);
  corruptManifest.checked = 999;
  fs.writeFileSync(manifestPath, `${JSON.stringify(corruptManifest)}\n`);
  await assert.rejects(
    runFilesExistEvidence(current, sessionFor({}), { resume: true }),
    /manifest/i
  );
  fs.writeFileSync(manifestPath, manifestBefore);

  const resumedCalls = [];
  const resumed = await runFilesExistEvidence(
    current,
    sessionFor(
      {
        two: { exists: false, status: 404 },
        three: { exists: true, status: 200 },
      },
      resumedCalls
    ),
    { resume: true }
  );
  assert.equal(resumed.manifest.status, "completed");
  assert.deepEqual(resumedCalls, ["two", "three"]);
  assert.equal(resumed.manifest.checked, 3);
  assert.equal(resumed.manifest.exists, 2);
  assert.equal(resumed.manifest.missing, 1);
  assert.equal(resumed.manifest.requests_completed, 4);
  assert.equal(new Set(JSON.parse(fs.readFileSync(current.paths.evidence, "utf8")).records.map((r) => r.ident)).size, 3);
});

test("files_exist respects bounded requests, duration and serial execution", async (t) => {
  const root = fixture(t, "limits");
  const calls = [];
  const result = await runFilesExistEvidence(
    config(root, ["one", "two", "three"], { maxRequests: 2 }),
    sessionFor(
      {
        one: { exists: true, status: 200 },
        two: { exists: true, status: 200 },
        three: { exists: true, status: 200 },
      },
      calls
    )
  );
  assert.equal(result.manifest.finished_reason, "max_requests");
  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(result.manifest.checked, 2);
  assert.equal(result.manifest.remaining_count, 1);
  assert.equal(result.manifest.requests_reserved, 2);
  assert.equal(result.manifest.requests_completed, 2);
  assert.equal(typeof result.manifest.average_request_duration_ms, "number");
  assert.equal(typeof result.manifest.total_duration_ms, "number");
});

test("files_exist persistence is atomic, bounded and rejects duplicate input", async (t) => {
  const root = fixture(t, "atomic");
  const current = config(root, ["same", "same"]);
  const result = await runFilesExistEvidence(
    current,
    sessionFor({ same: { exists: true, status: 200 } })
  );
  assert.equal(result.manifest.checked, 1);
  for (const file of [current.paths.checkpoint, current.paths.evidence, current.paths.manifest]) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".tmp-")), false);
  }
  for (const line of fs.readFileSync(result.paths.log, "utf8").trim().split("\n")) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal(fs.statSync(result.paths.log).size <= MAX_LOG_BYTES, true);
});
