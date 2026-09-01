"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { parseStringPromise } = require("xml2js");

const {
  createApiClient,
  getConfig,
  loginAndGetWst,
  sanitizeLogValue,
} = require("../main");
const {
  WEBSHARE_SEARCH_ENDPOINT,
} = require("../lib/crawler/config");

const DEFAULT_QUERIES = Object.freeze(["a", "e", "m", "q", "z", "0", "5", "9"]);
const DEFAULT_PAGES = 5;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SEARCH_REQUESTS = 100;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_QUERIES = 12;
const MAX_PAGES = 5;
const MAX_PAGE_SIZE = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_SEARCH_REQUESTS = 120;
const MAX_ATTEMPTS = 2;
const SAFE_METADATA_FIELDS = Object.freeze([
  "name",
  "size",
  "type",
  "img",
  "stripe",
  "stripe_count",
  "queued",
  "positive_votes",
  "negative_votes",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function firstValue(value) {
  let current = value;
  while (Array.isArray(current)) current = current[0];
  if (current && typeof current === "object" && Object.hasOwn(current, "_")) return current._;
  return current ?? null;
}

function safeText(value, maximum = 512) {
  return String(firstValue(value) ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function redactText(value, secrets = []) {
  let result = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  result = result
    .replace(/([?&]wst=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/(\b(?:wst|token|password|digest|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/=._-]+/giu, "[REDACTED]");
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => String(right).length - String(left).length)) {
    result = result.replaceAll(String(secret), "[REDACTED]");
  }
  return result.slice(0, 512) || null;
}

function parsePositiveInteger(value, label, maximum) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) throw new Error(`${label} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new Error(`${label} exceeds maximum ${maximum}`);
  return number;
}

function validateQuery(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("query must be a non-empty safe string of at most 256 bytes");
  }
  return value;
}

function defaultOutputDirectory() {
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return path.resolve(process.cwd(), "runtime", "b50-anonymous-search", stamp);
}

function parseArguments(argv) {
  const values = {
    queries: [],
    pages: DEFAULT_PAGES,
    pageSize: DEFAULT_PAGE_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxSearchRequests: DEFAULT_MAX_SEARCH_REQUESTS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    repeatQuery: "a",
    outputDir: null,
    noRepeat: false,
  };
  const valueArguments = new Set(["--query", "--pages", "--page-size", "--timeout-ms", "--max-search-requests", "--max-attempts", "--repeat-query", "--output-dir"]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--no-repeat") {
      if (seen.has(key)) throw new Error("duplicate --no-repeat");
      seen.add(key);
      values.noRepeat = true;
      continue;
    }
    if (!valueArguments.has(key)) throw new Error(`unknown argument ${key}`);
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith("--")) throw new Error(`${key} requires a value`);
    if (key !== "--query" && key !== "--repeat-query" && seen.has(key)) throw new Error(`duplicate ${key}`);
    if (key !== "--query") seen.add(key);
    if (key === "--query") values.queries.push(validateQuery(raw));
    else if (key === "--pages") values.pages = parsePositiveInteger(raw, key, MAX_PAGES);
    else if (key === "--page-size") values.pageSize = parsePositiveInteger(raw, key, MAX_PAGE_SIZE);
    else if (key === "--timeout-ms") values.timeoutMs = parsePositiveInteger(raw, key, MAX_TIMEOUT_MS);
    else if (key === "--max-search-requests") values.maxSearchRequests = parsePositiveInteger(raw, key, MAX_SEARCH_REQUESTS);
    else if (key === "--max-attempts") values.maxAttempts = parsePositiveInteger(raw, key, MAX_ATTEMPTS);
    else if (key === "--repeat-query") values.repeatQuery = validateQuery(raw);
    else values.outputDir = path.resolve(raw);
    index += 1;
  }
  if (values.queries.length === 0) values.queries = [...DEFAULT_QUERIES];
  if (values.queries.length > MAX_QUERIES) throw new Error(`query count exceeds maximum ${MAX_QUERIES}`);
  if (new Set(values.queries).size !== values.queries.length) throw new Error("queries must be unique");
  const repeatRequests = values.noRepeat ? 0 : 4;
  const minimumRequests = values.queries.length * values.pages * 2 + repeatRequests;
  if (minimumRequests > values.maxSearchRequests) throw new Error("search portfolio exceeds --max-search-requests");
  values.outputDir ||= defaultOutputDirectory();
  return values;
}

function prepareOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const runtimeRoot = path.resolve(process.cwd(), "runtime", "b50-anonymous-search");
  const temporaryRoot = path.resolve(os.tmpdir());
  const isWithin = (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`);
  const isSafeTemp = path.dirname(resolved) === temporaryRoot && /^b50-anonymous-search-[A-Za-z0-9._-]+$/u.test(path.basename(resolved));
  if (!isWithin(runtimeRoot) && !isSafeTemp) throw new Error("audit output must be under runtime/b50-anonymous-search or a named OS-temp directory");
  if (fs.existsSync(resolved)) throw new Error("audit output directory already exists");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function createRequestBudget(maxSearchRequests) {
  const state = { total: 0, salt: 0, login: 0, search: 0, completed: 0, attempts: [] };
  return {
    beforeRequest(kind, operation) {
      if (kind === "search") {
        if (state.search >= maxSearchRequests) throw Object.assign(new Error("B50 search request budget exhausted"), { code: "B50_REQUEST_BUDGET_EXHAUSTED" });
        state.search += 1;
      } else if (kind === "login" && operation === "salt") {
        if (state.salt >= 1) throw new Error("B50 permits one salt request");
        state.salt += 1;
      } else if (kind === "login" && operation === "login") {
        if (state.login >= 1) throw new Error("B50 permits one login request");
        state.login += 1;
      } else throw new Error(`B50 disallowed request ${kind}:${operation}`);
      state.total += 1;
      state.attempts.push({ kind, operation: String(operation || kind) });
    },
    afterRequest() { state.completed += 1; },
    snapshot() { return { ...state, max_search_requests: maxSearchRequests, max_total_requests: maxSearchRequests + 2 }; },
  };
}

function classifyError(error) {
  const status = Number(error?.response?.status || error?.status || 0) || null;
  const code = String(error?.code || "").toUpperCase();
  if (status === 429 || code === "429" || code === "RATE_LIMITED") return { class: "RATE_LIMITED", retryable: true, status };
  if (status >= 500 || ["SERVER_ERROR", "HTTP_500", "TEMPORARY_HTTP"].includes(code)) return { class: "SERVER_ERROR", retryable: true, status };
  if (["ECONNABORTED", "ETIMEDOUT", "TIMEOUT"].includes(code)) return { class: "TIMEOUT", retryable: true, status };
  if (["ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "NETWORK_ERROR"].includes(code)) return { class: "NETWORK", retryable: true, status };
  if (status >= 400 || code === "ERR_BAD_REQUEST" || code === "CLIENT_REQUEST_ERROR") return { class: "CLIENT_REQUEST", retryable: false, status };
  return { class: "PROVIDER_OR_UNKNOWN", retryable: Boolean(error?.retryable), status };
}

function requestShape(mode) {
  return {
    endpoint: new URL(WEBSHARE_SEARCH_ENDPOINT).pathname,
    method: "POST",
    content_type: "application/x-www-form-urlencoded",
    form_fields: ["what", "limit", "offset", "sort", "category", ...(mode === "authenticated" ? ["wst[REDACTED]"] : [])],
    authentication_field_present: mode === "authenticated",
  };
}

function normalizedMetadata(file) {
  const values = {};
  for (const field of SAFE_METADATA_FIELDS) {
    if (Object.hasOwn(file || {}, field)) values[field] = safeText(file[field], 2048);
  }
  return { fields: Object.keys(values).sort(), fingerprint: sha256(values) };
}

function normalizedRecords(files) {
  if (!Array.isArray(files)) throw new Error("provider file collection is not an array");
  return files.map((file) => {
    const ident = safeText(file?.ident, 256);
    if (!ident) throw Object.assign(new Error("provider file has no ident"), { code: "MALFORMED_PROVIDER_RESPONSE" });
    const metadata = normalizedMetadata(file);
    return { ident, metadata_fields: metadata.fields, metadata_fingerprint: metadata.fingerprint };
  });
}

async function parseSearchXml(data) {
  let parsed;
  try {
    parsed = await parseStringPromise(String(data || ""), { explicitArray: true, trim: true, strict: true });
  } catch (error) {
    throw Object.assign(new Error("malformed Webshare search XML"), { code: "MALFORMED_PROVIDER_RESPONSE", cause: error });
  }
  const response = parsed?.response;
  const status = safeText(response?.status, 64);
  if (status !== "OK") {
    throw Object.assign(new Error("Webshare search provider error"), {
      code: safeText(response?.code, 120) || "UNKNOWN_PROVIDER_ERROR",
      provider_code: safeText(response?.code, 120),
      provider_message: safeText(response?.message, 512),
      status: 200,
      retryable: false,
    });
  }
  const files = Array.isArray(response.file) ? response.file : [];
  return { total: firstValue(response.total), records: normalizedRecords(files) };
}

function httpRecord({ mode, query, pageIndex, offset, limit, attempt, requestOrdinal, startedAt, response, error, retryDecision }) {
  const classification = classifyError(error);
  const headers = response?.headers || error?.response?.headers || {};
  const header = (name) => typeof headers.get === "function" ? headers.get(name) : headers[name] || headers[name.toLowerCase()] || null;
  return {
    mode,
    phase: "discovery-search",
    endpoint_name: "webshare.search",
    endpoint: new URL(WEBSHARE_SEARCH_ENDPOINT).pathname,
    method: "POST",
    safe_query_literal: /^[a-z0-9]$/iu.test(query) ? query : null,
    page_index: pageIndex,
    offset,
    limit,
    sort: "recent",
    category: "video",
    request_ordinal: requestOrdinal,
    attempt,
    http_status: response?.status ?? error?.response?.status ?? classification.status,
    axios_code: typeof error?.code === "string" ? error.code.replace(/[^A-Z0-9_:-]/giu, "_").slice(0, 80) : null,
    provider_safe_error_code: redactText(error?.provider_code || error?.code, [])?.replace(/[^A-Z0-9_:-]/giu, "_").slice(0, 120) || null,
    sanitized_provider_message: redactText(error?.provider_message || error?.message, []),
    retry_after: redactText(header("retry-after"), []),
    elapsed_request_ms: Number((performance.now() - startedAt).toFixed(3)),
    authentication_succeeded: mode === "authenticated",
    retry_decision: retryDecision,
    error_class: error ? classification.class : null,
    retryable: error ? classification.retryable : false,
    outcome: error ? "error" : "success",
    response_content_type: redactText(header("content-type"), []),
    response_content_length: redactText(header("content-length"), []),
  };
}

async function performSearch({ client, wst, mode, query, pageIndex, pageSize, timeoutMs, maxAttempts, requestMeter, secrets = [] }) {
  const offset = pageIndex * pageSize;
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let requestOrdinal;
    try {
      requestMeter.beforeRequest("search", `${mode}:${query}:${pageIndex}:${attempt}`);
      requestOrdinal = requestMeter.snapshot().search;
    } catch (error) {
      const metadata = httpRecord({ mode, query, pageIndex, offset, limit: pageSize, attempt, requestOrdinal: null, startedAt: performance.now(), error, retryDecision: "FAIL_CLOSED" });
      metadata.sanitized_provider_message = redactText(error.message, secrets);
      attempts.push(metadata);
      return { mode, query, page_index: pageIndex, offset, limit: pageSize, status: "FAILED", request_shape: requestShape(mode), attempts, error: { code: error.code || "B50_REQUEST_BUDGET_EXHAUSTED", class: "REQUEST_BUDGET" } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    const params = new URLSearchParams({ what: query, limit: String(pageSize), offset: String(offset), sort: "recent", category: "video" });
    if (mode === "authenticated") params.set("wst", wst);
    try {
      const response = await client.post(WEBSHARE_SEARCH_ENDPOINT, params.toString(), { signal: controller.signal, maxContentLength: 20 * 1024 * 1024, maxBodyLength: 64 * 1024 });
      requestMeter.afterRequest();
      const page = await parseSearchXml(response.data);
      attempts.push(httpRecord({ mode, query, pageIndex, offset, limit: pageSize, attempt, requestOrdinal, startedAt, response, retryDecision: attempt > 1 ? "RETRY_SUCCEEDED" : "NO_RETRY_SUCCESS" }));
      return { mode, query, page_index: pageIndex, offset, limit: pageSize, status: "SUCCESS", request_shape: requestShape(mode), attempts, reported_total: page.total, records: page.records, idents: page.records.map((record) => record.ident), full_page: page.records.length === pageSize, duplicate_ident_count: page.records.length - new Set(page.records.map((record) => record.ident)).size };
    } catch (error) {
      requestMeter.afterRequest();
      const classification = classifyError(error);
      const shouldRetry = attempt < maxAttempts && classification.retryable;
      attempts.push(httpRecord({ mode, query, pageIndex, offset, limit: pageSize, attempt, requestOrdinal, startedAt, error, retryDecision: shouldRetry ? "RETRY_BOUNDED" : "FAIL_CLOSED" }));
      if (!shouldRetry) return { mode, query, page_index: pageIndex, offset, limit: pageSize, status: "FAILED", request_shape: requestShape(mode), attempts, error: { code: error.code || "PROVIDER_ERROR", class: classification.class } };
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("B50 retry loop exhausted unexpectedly");
}

function compareResults(anonymous, authenticated) {
  const a = anonymous?.idents || [];
  const b = authenticated?.idents || [];
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = a.filter((ident) => bSet.has(ident));
  const anonymousOnly = a.filter((ident) => !bSet.has(ident));
  const authenticatedOnly = b.filter((ident) => !aSet.has(ident));
  const union = [...new Set([...a, ...b])];
  const ranksA = new Map(a.map((ident, index) => [ident, index + 1]));
  const ranksB = new Map(b.map((ident, index) => [ident, index + 1]));
  const displacements = intersection.map((ident) => Math.abs(ranksA.get(ident) - ranksB.get(ident)));
  const metadataA = new Map((anonymous?.records || []).map((record) => [record.ident, record]));
  const metadataB = new Map((authenticated?.records || []).map((record) => [record.ident, record]));
  const metadataFields = new Set();
  let metadataDifferences = 0;
  for (const ident of intersection) {
    const left = metadataA.get(ident);
    const right = metadataB.get(ident);
    if (left?.metadata_fingerprint !== right?.metadata_fingerprint) {
      metadataDifferences += 1;
      for (const field of new Set([...(left?.metadata_fields || []), ...(right?.metadata_fields || [])])) metadataFields.add(field);
    }
  }
  return {
    anonymous_status: anonymous?.status || "MISSING",
    authenticated_status: authenticated?.status || "MISSING",
    anonymous_count: a.length,
    authenticated_count: b.length,
    ordered_ident_equal: JSON.stringify(a) === JSON.stringify(b),
    unordered_ident_equal: aSet.size === bSet.size && intersection.length === aSet.size,
    intersection: intersection.length,
    anonymous_only: [...anonymousOnly].sort(),
    authenticated_only: [...authenticatedOnly].sort(),
    union: union.length,
    jaccard: union.length ? intersection.length / union.length : 1,
    rank_displacement: {
      common_count: displacements.length,
      changed_rank_count: displacements.filter((value) => value > 0).length,
      mean_absolute: displacements.length ? displacements.reduce((sum, value) => sum + value, 0) / displacements.length : 0,
      max_absolute: displacements.length ? Math.max(...displacements) : 0,
    },
    metadata_differences: metadataDifferences,
    metadata_difference_fields: [...metadataFields].sort(),
    duplicate_idents: { anonymous: anonymous?.duplicate_ident_count ?? null, authenticated: authenticated?.duplicate_ident_count ?? null },
    paging: {
      reported_total_equal: anonymous?.reported_total === authenticated?.reported_total,
      anonymous_full_page: anonymous?.full_page ?? false,
      authenticated_full_page: authenticated?.full_page ?? false,
    },
  };
}

function numericStats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, min: null, max: null, mean: null, median: null };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, min: sorted[0], max: sorted.at(-1), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
}

function aggregateComparisons(comparisons) {
  const usable = comparisons
    .filter((entry) => entry.comparison?.anonymous_status === "SUCCESS" && entry.comparison?.authenticated_status === "SUCCESS")
    .map((entry) => entry.comparison);
  const allAnonymousOnly = [...new Set(usable.flatMap((comparison) => comparison.anonymous_only))].sort();
  const allAuthenticatedOnly = [...new Set(usable.flatMap((comparison) => comparison.authenticated_only))].sort();
  const rankChanged = usable.reduce((sum, comparison) => sum + comparison.rank_displacement.changed_rank_count, 0);
  const common = usable.reduce((sum, comparison) => sum + comparison.rank_displacement.common_count, 0);
  return {
    compared_requests: comparisons.length,
    usable_compared_requests: usable.length,
    ordered_exact_match_percent: usable.length ? usable.filter((comparison) => comparison.ordered_ident_equal).length / usable.length * 100 : null,
    unordered_exact_match_percent: usable.length ? usable.filter((comparison) => comparison.unordered_ident_equal).length / usable.length * 100 : null,
    jaccard: numericStats(usable.map((comparison) => comparison.jaccard)),
    anonymous_only_population: allAnonymousOnly,
    authenticated_only_population: allAuthenticatedOnly,
    rank_order_divergence: { common_idents: common, changed_rank_positions: rankChanged, changed_rank_percent: common ? rankChanged / common * 100 : null },
    metadata_difference_requests: usable.filter((comparison) => comparison.metadata_differences > 0).length,
    paging_divergence_requests: usable.filter((comparison) => !comparison.paging.reported_total_equal || comparison.paging.anonymous_full_page !== comparison.paging.authenticated_full_page).length,
  };
}

function buildAbaAnalysis(sequence) {
  const byLabel = new Map(sequence.map((entry) => [entry.label, entry.result]));
  const comparisons = [];
  const add = (left, right, reason) => {
    const leftResult = byLabel.get(left);
    const rightResult = byLabel.get(right);
    if (leftResult?.status === "SUCCESS" && rightResult?.status === "SUCCESS") comparisons.push({ reason, left, right, comparison: compareResults(leftResult, rightResult) });
  };
  add("anonymous_a", "anonymous_b", "anonymous_rotation");
  add("authenticated_a", "authenticated_b", "authenticated_rotation");
  add("anonymous_a", "authenticated_a", "auth_effect_a");
  add("anonymous_b", "authenticated_b", "auth_effect_b");
  return { sequence: sequence.map((entry) => ({ label: entry.label, mode: entry.mode, status: entry.result.status, query: entry.result.query, page_index: entry.result.page_index })), comparisons };
}

function createSafeLogger(secrets) {
  const lines = [];
  return {
    info(message) { lines.push(`[INFO] ${redactText(message, secrets)}`); },
    warn(message) { lines.push(`[WARN] ${redactText(message, secrets)}`); },
    error(message) { lines.push(`[ERROR] ${redactText(message, secrets)}`); },
    text() { return `${lines.join("\n")}\n`; },
  };
}

function renderMarkdown(report) {
  const lines = [
    "# B50 Anonymous Webshare Search Audit",
    "",
    `Generated: ${report.generated_at}`,
    `Endpoint: ${report.endpoint}`,
    `Portfolio requests: ${report.request_budget.search}`,
    "",
    "| Query | Page | Anonymous | Authenticated | Jaccard | Ordered equal | Unordered equal |",
    "|---|---:|---|---|---:|---|---|",
  ];
  for (const pair of report.portfolio_comparisons) {
    lines.push(`| ${pair.query} | ${pair.page_index + 1} | ${pair.anonymous_status} | ${pair.authenticated_status} | ${pair.comparison.jaccard.toFixed(6)} | ${pair.comparison.ordered_ident_equal ? "yes" : "no"} | ${pair.comparison.unordered_ident_equal ? "yes" : "no"} |`);
  }
  lines.push("", "This is a bounded read-only diagnostic. It performs no catalog, SQLite, publication, or scheduler mutation.", "");
  return `${lines.join("\n")}\n`;
}

function writeReports(outputDir, report, logger) {
  const files = {
    json: path.join(outputDir, "report.json"),
    markdown: path.join(outputDir, "report.md"),
    log: path.join(outputDir, "sanitized.log"),
  };
  fs.writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(files.markdown, renderMarkdown(report), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(files.log, logger.text(), { flag: "wx", mode: 0o600 });
  return files;
}

async function runAudit(options, dependencies = {}) {
  const outputDir = prepareOutputDirectory(options.outputDir);
  const config = dependencies.config || getConfig();
  const secrets = [config.username, config.password];
  const logger = dependencies.logger || createSafeLogger(secrets);
  const requestMeter = dependencies.requestMeter || createRequestBudget(options.maxSearchRequests);
  const client = dependencies.client || createApiClient();
  const authenticate = dependencies.authenticate || loginAndGetWst;
  logger.info("Starting one bounded authenticated comparison session.");
  const wst = await authenticate({ username: config.username, password: config.password, client, requestMeter, logger });
  logger.info("Authentication succeeded; token value is never persisted.");
  const portfolioComparisons = [];
  const rawPortfolio = [];
  const search = dependencies.performSearch || performSearch;
  const searchOptions = (mode, query, pageIndex) => ({ client, wst, mode, query, pageIndex, pageSize: options.pageSize, timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts, requestMeter, secrets });
  for (const query of options.queries) {
    for (let pageIndex = 0; pageIndex < options.pages; pageIndex += 1) {
      const anonymous = await search(searchOptions("anonymous", query, pageIndex));
      const authenticated = await search(searchOptions("authenticated", query, pageIndex));
      rawPortfolio.push({ query, page_index: pageIndex, anonymous, authenticated });
      portfolioComparisons.push({ query, page_index: pageIndex, anonymous_status: anonymous.status, authenticated_status: authenticated.status, comparison: compareResults(anonymous, authenticated) });
    }
  }
  let aba = null;
  const rawRepeatResults = [];
  if (!options.noRepeat) {
    const sequence = [];
    for (const [label, mode] of [["anonymous_a", "anonymous"], ["authenticated_a", "authenticated"], ["anonymous_b", "anonymous"], ["authenticated_b", "authenticated"]]) {
      const result = await search(searchOptions(mode, options.repeatQuery, 0));
      rawRepeatResults.push(result);
      sequence.push({ label, mode, result });
    }
    aba = buildAbaAnalysis(sequence);
  }
  const requestSnapshot = requestMeter.snapshot();
  const allResults = rawPortfolio.flatMap((pair) => [pair.anonymous, pair.authenticated]).concat(rawRepeatResults);
  const statusCount = (mode) => ({ success: allResults.filter((result) => result.mode === mode && result.status === "SUCCESS").length, failed: allResults.filter((result) => result.mode === mode && result.status === "FAILED").length });
  const report = {
    schema_version: 1,
    kind: "B50_ANONYMOUS_WEBSHARE_SEARCH_AUDIT",
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    production_mutation: false,
    publication_mutation: false,
    scheduler_mutation: false,
    endpoint: WEBSHARE_SEARCH_ENDPOINT,
    endpoint_equivalence: { anonymous: WEBSHARE_SEARCH_ENDPOINT, authenticated: WEBSHARE_SEARCH_ENDPOINT, same: true },
    request_shapes: { anonymous: requestShape("anonymous"), authenticated: requestShape("authenticated") },
    search_parameters: { category: "video", sort: "recent", page_size: options.pageSize, pages: options.pages, offsets: Array.from({ length: options.pages }, (_, index) => index * options.pageSize) },
    query_portfolio: [...options.queries],
    repeat_query: options.noRepeat ? null : options.repeatQuery,
    max_attempts_per_logical_request: options.maxAttempts,
    request_budget: requestSnapshot,
    http_outcomes: { anonymous: statusCount("anonymous"), authenticated: statusCount("authenticated") },
    portfolio_results: rawPortfolio,
    portfolio_comparisons: portfolioComparisons,
    aggregate: aggregateComparisons(portfolioComparisons),
    aba_analysis: aba,
    safety: { raw_response_bodies_persisted: false, credentials_persisted: false, wst_persisted: false, cookies_persisted: false, authorization_values_persisted: false, database_opened: false, production_apply: false },
    audit_interpretation: { provider_rotation_must_be_separated_from_auth_effect: true, first_observed_is_not_upload_time: true },
  };
  // The report contains only explicitly selected public fields and never the
  // request body, token, cookies, or raw provider response. Do not pass the
  // complete report through sanitizeLogValue: that safety helper intentionally
  // truncates arrays, which would corrupt the audit's full-set accounting.
  const files = writeReports(outputDir, report, logger);
  return { report, files, outputDir };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runAudit(options);
  console.log(JSON.stringify({ success: true, output_dir: result.outputDir, request_budget: result.report.request_budget, anonymous: result.report.http_outcomes.anonymous, authenticated: result.report.http_outcomes.authenticated }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`B50 anonymous search audit failed: ${sanitizeLogValue(error?.message || String(error), [process.env.WEBSHARE_USERNAME, process.env.WEBSHARE_PASSWORD])}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_QUERIES,
  MAX_ATTEMPTS,
  MAX_PAGE_SIZE,
  MAX_PAGES,
  MAX_SEARCH_REQUESTS,
  aggregateComparisons,
  buildAbaAnalysis,
  classifyError,
  compareResults,
  createRequestBudget,
  defaultOutputDirectory,
  normalizedMetadata,
  parseArguments,
  parseSearchXml,
  performSearch,
  prepareOutputDirectory,
  redactText,
  requestShape,
  runAudit,
  sha256,
  stableJson,
};
