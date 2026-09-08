"use strict";

const ALPHABET = Object.freeze([..."abcdefghijklmnopqrstuvwxyz0123456789"]);

function validateItem(item) {
  return item && typeof item.ident === "string" && item.ident.length > 0
    && typeof item.name === "string" && item.name.length > 0;
}

function initialFrontier(prefixes = ALPHABET) {
  const nodes = {};
  for (const prefix of prefixes) nodes[`${prefix}*`] = { prefix: `${prefix}*`, depth: 1, parent: null, checked: false, saturated: false, children_generated: false, recent_yield: 0, total_yield: 0, branch_score: 0, checks: 0 };
  return { schema_version: 1, run_count: 0, nodes };
}

function normalizeState(value, prefixes = ALPHABET) {
  const state = value && value.schema_version === 1 && value.nodes ? value : initialFrontier(prefixes);
  for (const prefix of prefixes) {
    const key = `${prefix}*`;
    if (!state.nodes[key]) state.nodes[key] = { prefix: key, depth: 1, parent: null, checked: false, saturated: false, children_generated: false, recent_yield: 0, total_yield: 0, branch_score: 0, checks: 0 };
  }
  return state;
}

function children(node, alphabet = ALPHABET) {
  return alphabet.map((suffix) => `${node.prefix.slice(0, -1)}${suffix}*`);
}

function nodePriority(node, runCount) {
  if (!node.checked) return Number(node.branch_score || 0) > 0 ? 0 : node.depth === 1 ? 1 : 2;
  if (node.saturated && !node.children_generated) return 1;
  if (node.recent_yield > 0 && runCount - (node.last_checked_run || 0) >= 2) return 2;
  return 3;
}

async function discoverAdaptiveFrontier({
  fetchPage,
  normalize = (x) => x,
  state,
  policy,
  now = new Date().toISOString(),
  persist = null,
}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage dependency required");
  const limits = {
    pageSize: 100,
    maxPagesPerPrefix: 5,
    maxRequests: 600,
    maxExpandedPrefixes: 120,
    maxPrefixDepth: 3,
    maxDiscoveredItems: 60000,
    maxRuntimeMs: 15 * 60 * 1000,
    ...policy,
  };
  const frontier = normalizeState(state, ALPHABET);
  const runCount = Number(frontier.run_count || 0) + 1;
  const byIdent = new Map();
  const pageReports = [];
  const processed = [];
  const expanded = [];
  let requests = 0;
  let rawRecords = 0;
  let nonemptyQueries = 0;
  const started = Date.now();
  const queue = Object.values(frontier.nodes);
  const queued = new Set(queue.map((x) => x.prefix));
  const enqueue = (node) => { if (!queued.has(node.prefix)) { queued.add(node.prefix); queue.push(node); } };
  while (queue.length && requests < limits.maxRequests && rawRecords < limits.maxDiscoveredItems && processed.length < limits.maxExpandedPrefixes && Date.now() - started < limits.maxRuntimeMs) {
    queue.sort((a, b) => nodePriority(a, runCount) - nodePriority(b, runCount)
      || (nodePriority(a, runCount) === 0 && Number(b.branch_score || 0) - Number(a.branch_score || 0))
      || a.depth - b.depth || a.prefix.localeCompare(b.prefix));
    const node = queue.shift();
    if (node.checked && node.children_generated && nodePriority(node, runCount) === 3) continue;
    let pages = [];
    let queryYield = 0;
    let queryRecords = 0;
    let hadRecords = false;
    for (let page = 0; page < limits.maxPagesPerPrefix && requests < limits.maxRequests && rawRecords < limits.maxDiscoveredItems; page += 1) {
      if (Date.now() - started >= limits.maxRuntimeMs) break;
      const response = await fetchPage({ query: node.prefix, offset: page * limits.pageSize, limit: limits.pageSize });
      requests += 1;
      const raw = Array.isArray(response?.files) ? response.files : [];
      rawRecords += raw.length;
      if (raw.length) hadRecords = true;
      const items = raw.map(normalize).filter(validateItem);
      let newInQuery = 0;
      for (const item of items) {
        queryRecords += 1;
        if (!byIdent.has(item.ident)) { byIdent.set(item.ident, item); newInQuery += 1; }
      }
      queryYield += newInQuery;
      pages.push({ page, offset: page * limits.pageSize, raw_count: raw.length, valid_count: items.length, reported_total: response?.total ?? null });
      if (raw.length < limits.pageSize) break;
    }
    const fullWindow = pages.length === limits.maxPagesPerPrefix && pages.every((p) => p.raw_count >= limits.pageSize);
    const reportedWindow = pages.some((p) => Number(p.reported_total) >= limits.pageSize * limits.maxPagesPerPrefix);
    const saturated = fullWindow || reportedWindow;
    node.checked = true;
    node.last_checked = now;
    node.last_checked_run = runCount;
    node.checks = Number(node.checks || 0) + 1;
    node.recent_yield = queryYield;
    node.total_yield = Number(node.total_yield || 0) + queryYield;
    node.saturated = saturated;
    if (saturated && node.depth < limits.maxPrefixDepth && !node.children_generated) {
      node.children_generated = true;
      const base = node.prefix.slice(0, -1).toLowerCase();
      const childScores = Object.fromEntries(ALPHABET.map((suffix) => [suffix, 0]));
      for (const item of byIdent.values()) {
        const compact = String(item.name || "").toLowerCase().replace(/[^a-z0-9]/gu, "");
        for (const suffix of ALPHABET) if (compact.startsWith(base + suffix)) childScores[suffix] += 1;
      }
      for (const prefix of children(node)) {
        const suffix = prefix.slice(-2, -1);
        if (!frontier.nodes[prefix]) frontier.nodes[prefix] = { prefix, depth: node.depth + 1, parent: node.prefix, checked: false, saturated: false, children_generated: false, recent_yield: 0, total_yield: 0, branch_score: childScores[suffix] || 0, checks: 0 };
        else frontier.nodes[prefix].branch_score = Math.max(Number(frontier.nodes[prefix].branch_score || 0), childScores[suffix] || 0);
        enqueue(frontier.nodes[prefix]);
      }
      expanded.push(node.prefix);
    } else if (node.depth >= limits.maxPrefixDepth) node.children_generated = true;
    processed.push({ prefix: node.prefix, depth: node.depth, pages: pages.length, records: queryRecords, yield: queryYield, saturated, full_window: fullWindow });
    pageReports.push(...pages.map((page) => ({ query: node.prefix, ...page })));
    if (hadRecords) nonemptyQueries += 1;
    if (typeof persist === "function") persist({ ...frontier, run_count: runCount, updated_at: now });
  }
  frontier.run_count = runCount;
  frontier.updated_at = now;
  const stopReason = requests >= limits.maxRequests ? "MAX_REQUESTS" : rawRecords >= limits.maxDiscoveredItems ? "MAX_DISCOVERED_ITEMS" : Date.now() - started >= limits.maxRuntimeMs ? "MAX_RUNTIME" : "FRONTIER_BUDGET_COMPLETE";
  return {
    mode: "ADAPTIVE_PREFIX_FRONTIER",
    coverage_declaration: "BOUNDED_ADAPTIVE_BEST_EFFORT",
    complete: false,
    stop_reason: stopReason,
    requests,
    raw_records: rawRecords,
    unique_idents: byIdent.size,
    nonempty_queries: nonemptyQueries,
    empty_queries: processed.length - nonemptyQueries,
    items: [...byIdent.values()].sort((a, b) => a.ident.localeCompare(b.ident)),
    queries: processed.map((x) => x.prefix),
    page_reports: pageReports,
    processed_prefixes: processed,
    expanded_prefixes: expanded,
    saturated_prefixes: processed.filter((x) => x.saturated).map((x) => x.prefix),
    frontier: { ...frontier, backlog: Object.values(frontier.nodes).filter((x) => !x.checked || (x.saturated && !x.children_generated)).length, node_count: Object.keys(frontier.nodes).length },
    runtime_ms: Date.now() - started,
  };
}

module.exports = { ALPHABET, initialFrontier, normalizeState, discoverAdaptiveFrontier };
