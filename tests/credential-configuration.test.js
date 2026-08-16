"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const endpoint = require("../endpoint");
const today = require("../today");

const repoRoot = path.resolve(__dirname, "..");

test("credential-bearing utilities have no hard-coded key or WST assignment", () => {
  const endpointSource = fs.readFileSync(path.join(repoRoot, "endpoint.js"), "utf8");
  const todaySource = fs.readFileSync(path.join(repoRoot, "today.js"), "utf8");

  assert.doesNotMatch(endpointSource, /apiKey\s*=\s*["'][^"']+["']/u);
  assert.doesNotMatch(todaySource, /wstToken\s*=\s*["'][^"']+["']/u);
  assert.match(endpointSource, /(?:process\.env|env)\.PROXY_API_KEY/u);
  assert.match(todaySource, /(?:process\.env|env)\.WEBSHARE_WST/u);
});

test("missing credentials fail closed without revealing a value", () => {
  assert.throws(() => endpoint.getProxyApiKey({}), /PROXY_API_KEY is required/iu);
  assert.throws(() => today.getWebshareWst({}), /WEBSHARE_WST is required/iu);
  assert.throws(() => endpoint.getProxyApiKey({ PROXY_API_KEY: "   " }), /PROXY_API_KEY is required/iu);
  assert.throws(() => today.getWebshareWst({ WEBSHARE_WST: "" }), /WEBSHARE_WST is required/iu);
});

test("proxy response redaction removes credential-shaped fields recursively", () => {
  const safe = endpoint.redactSensitiveFields({
    id: 1,
    password: "fixture-password",
    nested: { api_key: "fixture-key", address: "127.0.0.1" },
    items: [{ token: "fixture-token", port: 8080, proxy: "http://user:password@example.test" }]
  });

  assert.equal(safe.id, 1);
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.nested.api_key, "[REDACTED]");
  assert.equal(safe.nested.address, "127.0.0.1");
  assert.equal(safe.items[0].token, "[REDACTED]");
  assert.equal(safe.items[0].proxy, "[REDACTED]");
});

test(".env remains ignored and utility errors do not contact a service without credentials", async () => {
  const env = {};
  let calls = 0;
  const client = {
    get: async () => { calls += 1; return { data: [] }; },
    post: async () => { calls += 1; return { data: "" }; }
  };

  await assert.rejects(endpoint.main({ env, client }), /PROXY_API_KEY is required/iu);
  await assert.rejects(today.main({ env, client }), /WEBSHARE_WST is required/iu);
  assert.equal(calls, 0);

  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.env$/mu);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), ".webshare-security-cleanup-env")), false);
});

test("service errors are logged without the credential value", async () => {
  const secret = "fixture-service-secret";
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.join(" "));

  try {
    await endpoint.main({
      env: { PROXY_API_KEY: secret },
      client: { get: async () => { throw new Error(secret); } }
    });
    await today.fetchVideosForFilter("a", {
      wstToken: secret,
      client: { post: async () => { throw new Error(secret); } }
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(messages.some((message) => message.includes(secret)), false);
  assert.deepEqual(messages, ["Proxy API request failed.", "Webshare search request failed."]);
});
