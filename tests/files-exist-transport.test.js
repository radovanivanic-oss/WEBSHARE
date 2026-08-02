"use strict";
const assert = require("node:assert/strict"); const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path"); const test = require("node:test");
const { WebshareSession } = require("../main"); const { createFilesExistConfig, runFilesExistEvidence } = require("../lib/discovery/files-exist-port");
const logger = { info() {}, warn() {}, error() {} };
function session(response, calls = [], loginCalls = []) { return new WebshareSession({ username: "u", password: "p" }, logger, { login: async () => { loginCalls.push(1); return "token"; }, apiClient: { post: async (url, body, options) => { calls.push({ url, body, options }); if (response instanceof Error) throw response; return response; } } }); }
const ok = (exists) => ({ status: 200, headers: { "content-type": "text/xml; charset=UTF-8" }, data: `<response><status>OK</status><exists>${exists ? 1 : 0}</exists></response>` });
test("filesExist sends one authenticated form request and normalizes existing/missing", async () => { const calls = []; const s = session(ok(true), calls); const result = await s.filesExist("abc"); assert.deepEqual(result, { exists: true, status: 200 }); assert.equal(calls.length, 1); assert.match(calls[0].url, /\/api\/file_exists\/$/); assert.match(calls[0].body, /ident=abc/); assert.match(calls[0].body, /wst=token/); const missing = await session(ok(false)).filesExist("missing"); assert.deepEqual(missing, { exists: false, status: 200 }); });
test("filesExist rejects malformed, oversized, wrong content type and API errors", async () => { await assert.rejects(() => session(ok(true)).filesExist(""), (e) => e.code === "CLIENT_REQUEST_ERROR"); await assert.rejects(() => session({ status: 200, headers: { "content-type": "text/plain" }, data: "ok" }).filesExist("x"), (e) => e.code === "UNSUPPORTED_RESPONSE"); await assert.rejects(() => session({ status: 200, headers: { "content-type": "text/xml" }, data: "<response><status>OK</status></response>" }).filesExist("x"), (e) => e.code === "MALFORMED_RESPONSE"); await assert.rejects(() => session({ status: 200, headers: { "content-type": "text/xml" }, data: "<response><status>FATAL</status><code>FILE_EXISTS_FATAL_1</code></response>" }).filesExist("x"), (e) => e.code === "FILE_EXISTS_FATAL_1" && e.retryable === false); });
test("filesExist transport errors are bounded and retryability is explicit", async () => { const error = Object.assign(new Error("secret token password raw body"), { code: "ETIMEDOUT" }); await assert.rejects(() => session(error).filesExist("x"), (e) => e.code === "TIMEOUT" && e.retryable === true && !/secret|token|password|raw body/i.test(e.message)); });
const fileInfoXml = (fields = "<name>movie.mkv</name><available>1</available><removed>0</removed>") => `<response><status>OK</status>${fields}</response>`;
const fileInfoOk = (fields) => ({ status: 200, headers: { "content-type": "text/xml; charset=UTF-8" }, data: fileInfoXml(fields) });
function fileInfoSession(response, calls = []) { return session(response, calls); }
function assertSafeFileInfoError(error, code, retryable) { assert.equal(error.code, code); assert.equal(error.retryable, retryable); assert.match(error.message, /^.{1,256}$/s); assert.doesNotMatch(`${error.code} ${error.message}`, /wst|token|password|<response|raw-body/i); }
test("fileInfo maps every mocked transport and response failure deterministically", async () => {
  const cases = [
    ["http 400", Object.assign(new Error("wst=secret password=secret"), { response: { status: 400 } }), "CLIENT_REQUEST_ERROR", false],
    ["http 401", Object.assign(new Error("wst=secret password=secret"), { response: { status: 401 } }), "AUTHENTICATION_ERROR", false],
    ["http 403", Object.assign(new Error("wst=secret password=secret"), { response: { status: 403 } }), "AUTHENTICATION_ERROR", false],
    ["http 429", Object.assign(new Error("wst=secret password=secret"), { response: { status: 429 } }), "RATE_LIMITED", true],
    ["http 500", Object.assign(new Error("wst=secret password=secret"), { response: { status: 500 } }), "SERVER_ERROR", true],
    ["http 502", Object.assign(new Error("wst=secret password=secret"), { response: { status: 502 } }), "SERVER_ERROR", true],
    ["http 503", Object.assign(new Error("wst=secret password=secret"), { response: { status: 503 } }), "SERVER_ERROR", true],
    ["timeout", Object.assign(new Error("wst=secret password=secret"), { code: "ETIMEDOUT" }), "TIMEOUT", true],
    ["network", Object.assign(new Error("wst=secret password=secret"), { code: "ECONNRESET" }), "NETWORK_ERROR", true],
    ["unknown network", Object.assign(new Error("wst=secret password=secret"), { code: "WST_SECRET_TOKEN" }), "NETWORK_ERROR", true],
    ["malformed XML", { status: 200, headers: { "content-type": "text/xml" }, data: "<response>" }, "MALFORMED_RESPONSE", false],
    ["oversized body", fileInfoOk(`<name>${"x".repeat(65537)}</name><available>1</available><removed>0</removed>`), "UNSUPPORTED_RESPONSE", false],
    ["unsupported content type", { status: 200, headers: { "content-type": "text/plain" }, data: "raw-body" }, "UNSUPPORTED_RESPONSE", false],
    ["missing required fields", fileInfoOk("<name>movie.mkv</name>"), "MALFORMED_RESPONSE", false],
    ["contradictory state", fileInfoOk("<name>movie.mkv</name><available>1</available><removed>1</removed>"), "MALFORMED_RESPONSE", false],
  ];
  for (const [label, mocked, code, retryable] of cases) {
    await assert.rejects(() => fileInfoSession(mocked).fileInfo("safe-ident"), (error) => { assertSafeFileInfoError(error, code, retryable); return true; }, label);
  }
});
test("fileInfo sends one authenticated bounded request and returns validated metadata", async () => { const calls = []; const result = await fileInfoSession(fileInfoOk(), calls).fileInfo("safe-ident"); assert.equal(result.name[0], "movie.mkv"); assert.equal(calls.length, 1); assert.match(calls[0].url, /\/api\/file_info\/$/); assert.match(calls[0].body, /ident=safe-ident/); assert.match(calls[0].body, /maybe_removed=1/); assert.equal(calls[0].options.maxContentLength, 64 * 1024); });
test("adapter integrates with B9 evidence port without retries", async (t) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-transport-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const calls = []; const s = session(ok(true), calls); const config = createFilesExistConfig({ root, idents: ["abc"], limits: { maxIdents: 1, maxRequests: 1, maxDurationMs: 10000 } }); const result = await runFilesExistEvidence(config, s); assert.equal(result.manifest.checked, 1); assert.equal(result.manifest.exists, 1); assert.equal(calls.length, 1); const evidence = JSON.parse(fs.readFileSync(config.paths.evidence, "utf8")); assert.deepEqual(Object.keys(evidence.records[0]).sort(), ["checked_at", "exists", "ident", "response_status", "retryable", "transport_error"].sort()); });
