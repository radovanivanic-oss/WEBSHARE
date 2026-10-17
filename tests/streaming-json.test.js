"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { containsSecretMaterial } = require("../lib/streaming-json");

test("secret detector allows non-secret authorization audit metadata", () => {
  assert.equal(containsSecretMaterial({
    explicit_authorization: true,
    authorization_sha256: "a".repeat(64),
    authorization_mode: "AUTOMATIC_SAFE_ADDITIVE",
  }), false);
});

test("secret detector rejects credential keys and serialized credential material", () => {
  assert.equal(containsSecretMaterial({ authorization: "Bearer secret" }), true);
  assert.equal(containsSecretMaterial({ message: "wst=secret-token" }), true);
});
