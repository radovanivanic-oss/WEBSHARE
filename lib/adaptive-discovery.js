"use strict";

const ALPHABET = Object.freeze([..."abcdefghijklmnopqrstuvwxyz0123456789"]);

function validateItem(item) {
  return item && typeof item.ident === "string" && item.ident.length > 0
    && typeof item.name === "string" && item.name.length > 0;
}

function initialFrontier(prefixes = ALPHABET) {
  const nodes = {};
  for (const prefix of prefixes) nodes[`${prefix}*`] = { prefix: `${prefix}*`, depth: 1, parent: null, checked: false, saturated: false, children_generated: false, recent_yield: 0, last_query_count: 0, last_checked_calendar_date: null, total_yield: 0, branch_score: 0, checks: 0 };
  return { schema_version: 1, run_count: 0, nodes };
}

function normalizeState(value, prefixes = ALPHABET) {
  const state = value && value.schema_version === 1 && value.nodes ? value : initialFrontier(prefixes);
  for (const prefix of prefixes) {
    const key = `${prefix}*`;
    if (!state.nodes[key]) state.nodes[key] = { prefix: key, depth: 1, parent: null, checked: false, saturated: false, children_generated: false, recent_yield: 0, last_query_count: 0, last_checked_calendar_date: null, total_yield: 0, branch_score: 0, checks: 0 };
  }
  return state;
}

function children(node, alphabet = ALPHABET) {
  return alphabet.map((suffix) => `${node.prefix.slice(0, -1)}${suffix}*`);
}

function lastCheckedDate(node) {
  return node.last_checked_calendar_date || String(node.last_checked || "").slice(0, 10) || null;
}

function hasRecentResults(node) {
  return Number(node.last_query_count ?? node.recent_yield ?? 0) > 0;
}

function revisitDue(node, calendarDate, runCount) {
  if (!node.checked || !hasRecentResults(node)) return false;
  const checkedDate = lastCheckedDate(node);
  if (calendarDate && checkedDate) return checkedDate !== calendarDate;
  return runCount - Number(node.last_checked_run || 0) >= 1;
}

function calendarAgeDays(from, to) {
  if (!from || !to) return 0;
  const left = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const right = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return Math.max(0, Math.round((right - left) / 86400000));
}

function dueProductiveNodes(nodes, calendarDate, runCount) {
  return nodes.filter((node) => revisitDue(node, calendarDate, runCount));
}

function revisitAllocation({ maxExpandedPrefixes, policy, dueNodes, calendarDate }) {
  if (maxExpandedPrefixes <= 0) return { requested: 0, share: 0, mode: "DISABLED", oldest_due_age_days: 0 };
  if (Number.isInteger(policy?.maxRevisitPrefixes)) {
    const requested = Math.min(maxExpandedPrefixes, Math.max(0, policy.maxRevisitPrefixes));
    const oldest = dueNodes.reduce((max, node) => Math.max(max, calendarAgeDays(lastCheckedDate(node), calendarDate)), 0);
    return { requested, share: requested / maxExpandedPrefixes, mode: "EXPLICIT", oldest_due_age_days: oldest };
  }

  // A fixed reserve is not enough once a productive frontier has a backlog:
  // the backlog grows faster than a 25% slice can revisit it.  Use the age and
  // size of the due queue to reserve most of the bounded run when necessary,
  // while retaining a bounded exploration lane for new content.
  const oldest = dueNodes.reduce((max, node) => Math.max(max, calendarAgeDays(lastCheckedDate(node), calendarDate)), 0);
  const backlogRatio = dueNodes.length / Math.max(1, maxExpandedPrefixes);
  let share = Number.isFinite(policy?.healthyRevisitShare) ? Number(policy.healthyRevisitShare) : 0.5;
  let mode = "NORMAL";
  if (dueNodes.length === 0) {
    share = Number.isFinite(policy?.emptyBacklogRevisitShare) ? Number(policy.emptyBacklogRevisitShare) : 0.25;
    mode = "EXPLORATION_FIRST";
  } else if (oldest >= Number(policy?.revisitDeadlineDays || 3) || backlogRatio >= 2) {
    share = Number.isFinite(policy?.highBacklogRevisitShare) ? Number(policy.highBacklogRevisitShare) : 0.8;
    mode = "BACKLOG_HIGH";
  } else if (backlogRatio >= 1) {
    share = Number.isFinite(policy?.elevatedBacklogRevisitShare) ? Number(policy.elevatedBacklogRevisitShare) : 0.7;
    mode = "BACKLOG_ELEVATED";
  }
  share = Math.max(0, Math.min(1, share));
  const requested = Math.min(maxExpandedPrefixes, Math.max(1, Math.ceil(maxExpandedPrefixes * share)));
  return { requested, share, mode, oldest_due_age_days: oldest };
}

function nodePriority(node, runCount, calendarDate) {
  // Sample every broad root before spending the bounded run budget on a
  // child branch.  Otherwise a high-yield branch can starve later roots
  // (including `t*`) forever, which defeats the adaptive frontier.
  if (!node.checked) return node.depth === 1 ? 0 : Number(node.branch_score || 0) > 0 ? 1 : 2;
  if (node.saturated && !node.children_generated) return 1;
  if (revisitDue(node, calendarDate, runCount)) return 2;
  return 3;
}

async function discoverAdaptiveFrontier({
  fetchPage,
  normalize = (x) => x,
  state,
  policy,
  now = new Date().toISOString(),
  calendarDate = String(now).slice(0, 10),
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
  let revisited = 0;
  const started = Date.now();
  const queue = Object.values(frontier.nodes);
  const queued = new Set(queue.map((x) => x.prefix));
  const enqueue = (node) => { if (!queued.has(node.prefix)) { queued.add(node.prefix); queue.push(node); } };
  const dueBeforeRun = dueProductiveNodes(queue, calendarDate, runCount);
  const revisitPolicy = revisitAllocation({ maxExpandedPrefixes: limits.maxExpandedPrefixes, policy, dueNodes: dueBeforeRun, calendarDate });
  limits.maxRevisitPrefixes = revisitPolicy.requested;
  while (queue.length && requests < limits.maxRequests && rawRecords < limits.maxDiscoveredItems && processed.length < limits.maxExpandedPrefixes && Date.now() - started < limits.maxRuntimeMs) {
    const dueNow = (node) => revisitDue(node, calendarDate, runCount);
    const remainingRevisits = limits.maxRevisitPrefixes - revisited;
    const reserveStartsAt = Math.max(0, limits.maxExpandedPrefixes - remainingRevisits);
    let node = null;
    let selectedForRevisit = false;
    if (remainingRevisits > 0 && processed.length >= reserveStartsAt) {
      const due = queue.filter(dueNow).sort((a, b) =>
        String(lastCheckedDate(a) || "").localeCompare(String(lastCheckedDate(b) || ""))
        || Number(b.last_query_count ?? b.recent_yield ?? 0) - Number(a.last_query_count ?? a.recent_yield ?? 0)
        || a.prefix.localeCompare(b.prefix));
      if (due.length) {
        node = due[0];
        selectedForRevisit = true;
      }
    }
    if (!node) {
      const candidates = queue.filter((candidate) => remainingRevisits > 0 || !dueNow(candidate));
      candidates.sort((a, b) => nodePriority(a, runCount, calendarDate) - nodePriority(b, runCount, calendarDate)
        || (nodePriority(a, runCount, calendarDate) === 0 && Number(b.branch_score || 0) - Number(a.branch_score || 0))
        || a.depth - b.depth || a.prefix.localeCompare(b.prefix));
      node = candidates[0] || null;
      selectedForRevisit = Boolean(node && dueNow(node));
    }
    if (!node) break;
    queue.splice(queue.indexOf(node), 1);
    if (node.checked && node.children_generated && nodePriority(node, runCount, calendarDate) === 3) continue;
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
    node.last_checked_calendar_date = calendarDate;
    node.last_checked_run = runCount;
    node.checks = Number(node.checks || 0) + 1;
    node.recent_yield = queryYield;
    node.last_query_count = queryRecords;
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
    if (selectedForRevisit) revisited += 1;
    processed.push({ prefix: node.prefix, depth: node.depth, pages: pages.length, records: queryRecords, yield: queryYield, saturated, full_window: fullWindow, revisited: selectedForRevisit });
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
    revisited_prefixes: processed.filter((x) => x.revisited).map((x) => x.prefix),
    revisit_budget: limits.maxRevisitPrefixes,
    revisit_policy: {
      mode: revisitPolicy.mode,
      requested_share: revisitPolicy.share,
      productive_due_prefixes: dueBeforeRun.length,
      oldest_due_age_days: revisitPolicy.oldest_due_age_days,
      actually_consumed: revisited,
    },
    expanded_prefixes: expanded,
    saturated_prefixes: processed.filter((x) => x.saturated).map((x) => x.prefix),
    frontier: { ...frontier, backlog: Object.values(frontier.nodes).filter((x) => !x.checked || (x.saturated && !x.children_generated)).length, node_count: Object.keys(frontier.nodes).length },
    runtime_ms: Date.now() - started,
  };
}

module.exports = { ALPHABET, initialFrontier, normalizeState, discoverAdaptiveFrontier };
