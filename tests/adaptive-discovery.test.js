"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { discoverAdaptiveFrontier } = require("../lib/adaptive-discovery");

const filler = (prefix, page, count = 100) => Array.from({ length: count }, (_, i) => ({ ident: `${prefix}-${page}-${i}`, name: `Filler.${prefix}.${page}.${i}.mkv`, size: 1, type: "mkv" }));

function saturatedProvider(target = false) {
  return async ({ query, offset, limit }) => {
    const page = offset / limit;
    const files = filler(query, page, limit);
    if (query === "t*" || query === "th*") for (let i = 0; i < files.length; i += 1) files[i].name = `The.Filler.${query}.${page}.${i}.mkv`;
    if (target && query === "the*" && page === 0) files[0] = { ident: "gentlemen-regression", name: "The.Gentlemen.S02E01.mkv", size: 1, type: "mkv" };
    return { total: 1000, files };
  };
}

test("saturated broad prefixes expand generically to the useful deeper prefix", async () => {
  const result = await discoverAdaptiveFrontier({ fetchPage: saturatedProvider(true), policy: { maxRequests: 600, maxExpandedPrefixes: 120, maxPrefixDepth: 3, maxRuntimeMs: 60000 } });
  assert.ok(result.saturated_prefixes.includes("t*"));
  assert.ok(result.expanded_prefixes.includes("t*"));
  assert.ok(result.queries.includes("the*"));
  assert.ok(result.items.some((item) => item.ident === "gentlemen-regression"));
});

test("unsaturated prefixes do not expand unnecessarily", async () => {
  const result = await discoverAdaptiveFrontier({
    fetchPage: async ({ query }) => ({ total: 1, files: [{ ident: `${query}-one`, name: `${query}-one.mkv`, size: 1, type: "mkv" }] }),
    policy: { maxRequests: 1, maxExpandedPrefixes: 1, maxRuntimeMs: 60000 },
  });
  assert.equal(result.expanded_prefixes.length, 0);
  assert.equal(result.processed_prefixes[0].saturated, false);
});

test("maximum depth and request budget are enforced", async () => {
  const result = await discoverAdaptiveFrontier({ fetchPage: saturatedProvider(), policy: { maxRequests: 3, maxExpandedPrefixes: 3, maxPrefixDepth: 1, maxRuntimeMs: 60000 } });
  assert.equal(result.requests, 3);
  assert.equal(result.expanded_prefixes.length, 0);
  assert.ok(result.processed_prefixes.every((item) => item.depth <= 1));
});

test("persisted frontier resumes unfinished child work", async () => {
  let saved = null;
  const first = await discoverAdaptiveFrontier({ fetchPage: saturatedProvider(false), policy: { maxRequests: 100, maxExpandedPrefixes: 20, maxPrefixDepth: 3, maxRuntimeMs: 60000 }, persist: (state) => { saved = structuredClone(state); } });
  assert.ok(saved);
  assert.equal(first.queries.length, 20);
  const second = await discoverAdaptiveFrontier({ fetchPage: saturatedProvider(true), state: saved, policy: { maxRequests: 600, maxExpandedPrefixes: 300, maxPrefixDepth: 3, maxRuntimeMs: 60000 } });
  assert.ok(second.queries.includes("the*"));
  assert.ok(second.items.some((item) => item.ident === "gentlemen-regression"));
});

test("adaptive discovery has no title-specific Gentlemen branch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "adaptive-discovery.js"), "utf8");
  assert.doesNotMatch(source, /gentlemen/iu);
});
