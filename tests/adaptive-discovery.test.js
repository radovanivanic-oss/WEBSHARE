"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { discoverAdaptiveFrontier, initialFrontier } = require("../lib/adaptive-discovery");

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

test("productive prefixes receive reserved revisits while new frontier work continues", async () => {
  const state = initialFrontier();
  state.run_count = 1;
  for (const node of Object.values(state.nodes)) {
    node.checked = true;
    node.children_generated = true;
    node.last_checked = "2026-09-19T01:00:00.000Z";
    node.last_checked_calendar_date = "2026-09-19";
    node.last_checked_run = 1;
    node.last_query_count = 0;
  }
  state.nodes["the*"] = {
    prefix: "the*", depth: 3, parent: "th*", checked: true, saturated: false,
    children_generated: true, recent_yield: 0, last_query_count: 1, last_checked: "2026-09-19T01:00:00.000Z",
    last_checked_calendar_date: "2026-09-19", last_checked_run: 1, total_yield: 1,
    branch_score: 1, checks: 1,
  };
  for (const prefix of ["newa*", "newb*", "newc*"]) {
    state.nodes[prefix] = {
      prefix, depth: 3, parent: "new*", checked: false, saturated: false,
      children_generated: false, recent_yield: 0, last_query_count: 0,
      last_checked_calendar_date: null, total_yield: 0, branch_score: 10, checks: 0,
    };
  }

  const result = await discoverAdaptiveFrontier({
    state,
    now: "2026-09-20T01:00:00.000Z",
    calendarDate: "2026-09-20",
    fetchPage: async ({ query }) => ({
      total: 1,
      files: [{ ident: `result-${query}`, name: `Result.${query}.S01E01.mkv`, size: 1, type: "mkv" }],
    }),
    policy: { maxRequests: 4, maxExpandedPrefixes: 4, maxPrefixDepth: 3, maxRuntimeMs: 60000 },
  });

  assert.deepEqual(result.queries.slice(0, 3), ["newa*", "newb*", "the*"]);
  assert.deepEqual(result.revisited_prefixes, ["the*"]);
  assert.equal(result.revisit_budget, 2);
  assert.equal(result.revisit_policy.mode, "NORMAL");
});

test("adaptive discovery has no title-specific Gentlemen branch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "adaptive-discovery.js"), "utf8");
  assert.doesNotMatch(source, /gentlemen/iu);
});
