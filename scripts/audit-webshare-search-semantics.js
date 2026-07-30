#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const {
  createApiClient,
  fetchSearchPage,
  getConfig,
  loginAndGetWst,
  sanitizeLogValue,
} = require("../main");

const MAX_SEARCH_REQUESTS = 8;
const MAX_PAGE_SIZE = 20;
const MAX_TIMEOUT_MS = 60_000;
const MAX_QUERY_BYTES = 256;
const TIMESTAMP_FIELDS = Object.freeze([
  "created",
  "created_at",
  "uploaded",
  "uploaded_at",
  "date_created",
  "timestamp",
]);
const VALUE_ARGUMENTS = new Set([
  "--query",
  "--max-search-requests",
  "--page-size",
  "--timeout-ms",
  "--output-dir",
]);

function usage() {
  return [
    "Použitie:",
    "  node scripts/audit-webshare-search-semantics.js \\",
    "    --query 0 --query '0*' --query test --query 'test*' \\",
    "    --max-search-requests 8 --page-size 20 --timeout-ms 15000 \\",
    "    --output-dir /tmp/webshare-search-semantics-<timestamp>",
  ].join("\n");
}

function parsePositiveInteger(value, label, maximum) {
  if (!/^[1-9][0-9]*$/.test(String(value || ""))) {
    throw new Error(`${label} musí byť kladné desiatkové celé číslo.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new Error(`${label} prekračuje maximum ${maximum}.`);
  }
  return number;
}

function validateQuery(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_QUERY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      `Query musí byť neprázdny reťazec do ${MAX_QUERY_BYTES} bajtov bez control znakov.`
    );
  }
  return value;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    return { help: true };
  }
  const values = {
    queries: [],
    maxSearchRequests: MAX_SEARCH_REQUESTS,
    pageSize: MAX_PAGE_SIZE,
    timeoutMs: 15_000,
    outputDir: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!VALUE_ARGUMENTS.has(key)) {
      throw new Error(`Neznámy argument: ${key}`);
    }
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith("--") && key !== "--query")) {
      throw new Error(`Argument ${key} vyžaduje hodnotu.`);
    }
    if (key === "--query") {
      values.queries.push(validateQuery(value));
    } else {
      if (seen.has(key)) throw new Error(`Argument ${key} bol zadaný viackrát.`);
      seen.add(key);
      if (key === "--max-search-requests") {
        values.maxSearchRequests = parsePositiveInteger(
          value,
          key,
          MAX_SEARCH_REQUESTS
        );
      } else if (key === "--page-size") {
        values.pageSize = parsePositiveInteger(value, key, MAX_PAGE_SIZE);
      } else if (key === "--timeout-ms") {
        values.timeoutMs = parsePositiveInteger(value, key, MAX_TIMEOUT_MS);
      } else if (key === "--output-dir") {
        values.outputDir = path.resolve(value);
      }
    }
    index += 1;
  }
  if (values.queries.length === 0) throw new Error("Chýba aspoň jeden --query.");
  if (values.queries.length > MAX_SEARCH_REQUESTS) {
    throw new Error(`Počet query prekračuje maximum ${MAX_SEARCH_REQUESTS}.`);
  }
  if (new Set(values.queries).size !== values.queries.length) {
    throw new Error("Query zoznam nesmie obsahovať duplicity.");
  }
  if (values.queries.length > values.maxSearchRequests) {
    throw new Error("Počet query prekračuje --max-search-requests.");
  }
  if (!values.outputDir) throw new Error("Chýba --output-dir.");
  return values;
}

function comparisonPathKey(value) {
  const normalized = path.resolve(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function prepareOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const parent = path.dirname(resolved);
  const canonicalParent = fs.realpathSync.native(parent);
  const canonicalTemp = fs.realpathSync.native(os.tmpdir());
  if (comparisonPathKey(canonicalParent) !== comparisonPathKey(canonicalTemp)) {
    throw new Error("Diagnostický output musí byť priamy podadresár OS temp.");
  }
  if (!/^webshare-search-semantics-[a-zA-Z0-9._-]+$/.test(path.basename(resolved))) {
    throw new Error(
      "Diagnostický adresár musí mať názov webshare-search-semantics-<id>."
    );
  }
  if (fs.existsSync(resolved)) {
    throw new Error("Diagnostický output adresár už existuje.");
  }
  fs.mkdirSync(resolved, { mode: 0o700 });
  return resolved;
}

function createRequestBudget(maxSearchRequests) {
  const counters = {
    total: 0,
    salt: 0,
    login: 0,
    search: 0,
    completed: 0,
  };
  const attempts = [];
  return {
    beforeRequest(kind, operationKey) {
      const operation = String(operationKey || kind);
      if (kind === "search") {
        if (counters.search >= maxSearchRequests) {
          throw new Error("Diagnostický search request budget bol vyčerpaný.");
        }
        counters.search += 1;
      } else if (kind === "login") {
        if (operation === "salt") {
          if (counters.salt >= 1) {
            throw new Error("Diagnostika povoľuje iba jeden salt request.");
          }
          counters.salt += 1;
        } else if (operation === "login") {
          if (counters.login >= 1) {
            throw new Error("Diagnostika povoľuje iba jeden login request.");
          }
          counters.login += 1;
        } else {
          throw new Error(`Nepovolený auth request: ${operation}`);
        }
      } else {
        throw new Error(`Nepovolený request kind: ${kind}`);
      }
      if (counters.total >= maxSearchRequests + 2) {
        throw new Error("Celkový diagnostický request budget bol vyčerpaný.");
      }
      counters.total += 1;
      attempts.push({ kind, operation });
    },
    afterRequest() {
      counters.completed += 1;
    },
    snapshot() {
      return {
        ...counters,
        max_search_requests: maxSearchRequests,
        max_total_requests: maxSearchRequests + 2,
        attempts: attempts.map((entry) => ({ ...entry })),
      };
    },
  };
}

function createSafeLogger(initialSecrets = []) {
  const secrets = new Set(initialSecrets.filter(Boolean).map(String));
  const entries = [];
  function add(level, message) {
    entries.push({
      timestamp: new Date().toISOString(),
      level,
      message: String(sanitizeLogValue(String(message), [...secrets])).slice(
        0,
        2048
      ),
    });
  }
  return {
    info(message) {
      add("INFO", message);
    },
    warn(message) {
      add("WARN", message);
    },
    error(message) {
      add("ERROR", message);
    },
    addSecret(secret) {
      if (secret) secrets.add(String(secret));
    },
    text() {
      return `${entries
        .map((entry) => `[${entry.timestamp}] [${entry.level}] ${entry.message}`)
        .join("\n")}\n`;
    },
  };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) ?? null;
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function endpointName(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "unknown";
  }
}

function attachAxiosTelemetry(client) {
  const records = [];
  let active = 0;
  let maxInFlight = 0;
  const started = new WeakMap();
  client.interceptors.request.use((config) => {
    active += 1;
    maxInFlight = Math.max(maxInFlight, active);
    started.set(config, {
      monotonic: performance.now(),
      wall: new Date().toISOString(),
    });
    return config;
  });
  function finish(config, response, error) {
    const timing = config ? started.get(config) : null;
    active = Math.max(0, active - 1);
    const headers = response?.headers || error?.response?.headers || null;
    records.push({
      endpoint: endpointName(config?.url),
      method: String(config?.method || "post").toUpperCase(),
      status: response?.status ?? error?.response?.status ?? null,
      started_at: timing?.wall ?? null,
      ended_at: new Date().toISOString(),
      latency_ms: timing
        ? Number((performance.now() - timing.monotonic).toFixed(3))
        : null,
      content_length: headerValue(headers, "content-length"),
      content_type: headerValue(headers, "content-type"),
      retry_after: headerValue(headers, "retry-after"),
      outcome: error ? "error" : "success",
    });
  }
  client.interceptors.response.use(
    (response) => {
      finish(response.config, response, null);
      return response;
    },
    (error) => {
      finish(error?.config, null, error);
      return Promise.reject(error);
    }
  );
  return {
    records,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

function firstValue(value) {
  let current = value;
  while (Array.isArray(current)) current = current[0];
  if (current && typeof current === "object" && Object.hasOwn(current, "_")) {
    return current._;
  }
  return current ?? null;
}

function safeText(value, maximum = 512) {
  return String(firstValue(value) ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, maximum);
}

function normalizeText(value) {
  return safeText(value, 4096).trim().toLowerCase().normalize("NFC");
}

function queryTerm(query) {
  let term = String(query);
  if (term.endsWith("*")) term = term.slice(0, -1);
  if (
    term.length >= 2 &&
    ((term.startsWith('"') && term.endsWith('"')) ||
      (term.startsWith("'") && term.endsWith("'")))
  ) {
    term = term.slice(1, -1);
  }
  return term.trim().toLowerCase().normalize("NFC");
}

function timestampFormat(value) {
  const scalar = firstValue(value);
  if (scalar === null) return "null";
  if (typeof scalar === "number") {
    return Number.isInteger(scalar) ? "integer" : "number";
  }
  const text = String(scalar).trim();
  if (/^[0-9]{10}$/.test(text)) return "epoch-seconds-string";
  if (/^[0-9]{13}$/.test(text)) return "epoch-milliseconds-string";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(text)) return "iso-8601-like";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text)) return "date-like";
  return "other-string";
}

function auditTimestampSchema(files) {
  const result = {};
  for (const field of TIMESTAMP_FIELDS) {
    const values = files
      .filter((file) => file && Object.hasOwn(file, field))
      .map((file) => firstValue(file[field]));
    result[field] = {
      present: values.length > 0,
      present_count: values.length,
      value_types: [...new Set(values.map((value) => typeof value))].sort(),
      formats: [...new Set(values.map(timestampFormat))].sort(),
    };
  }
  return result;
}

function analyzePage(query, page, pageSize) {
  const files = Array.isArray(page?.files) ? page.files : [];
  const term = queryTerm(query);
  const literal = String(query).toLowerCase().normalize("NFC");
  let literalPrefix = 0;
  let termPrefix = 0;
  let termSubstring = 0;
  let termToken = 0;
  let literalWildcardInName = 0;
  const items = files.map((file) => {
    const ident = safeText(file?.ident, 128);
    const name = safeText(file?.name, 512);
    const normalizedName = normalizeText(name);
    const tokens = normalizedName.match(/[\p{L}\p{N}]+/gu) || [];
    if (literal && normalizedName.startsWith(literal)) literalPrefix += 1;
    if (term && normalizedName.startsWith(term)) termPrefix += 1;
    if (term && normalizedName.includes(term)) termSubstring += 1;
    if (term && tokens.includes(term)) termToken += 1;
    if (normalizedName.includes("*")) literalWildcardInName += 1;
    return {
      ident,
      name,
      size: safeText(file?.size, 64) || null,
    };
  });
  let observedMatch = "unknown";
  if (files.length && term && termPrefix === files.length) {
    observedMatch = "literal-prefix-compatible";
  } else if (files.length && term && termSubstring === files.length) {
    observedMatch = "substring-compatible";
  } else if (files.length && term && termToken === files.length) {
    observedMatch = "token-compatible";
  } else if (files.length) {
    observedMatch = "fuzzy-full-text-or-unknown";
  }
  return {
    query,
    request_url_shape: {
      method: "POST",
      endpoint: "https://webshare.cz/api/search/",
      form_fields: [
        "what",
        "limit",
        "offset",
        "sort",
        "category",
        "wst[REDACTED]",
      ],
      what: query,
      encoded_what: new URLSearchParams({ what: query })
        .toString()
        .slice("what=".length),
    },
    reported_total: firstValue(page?.total),
    returned_item_count: files.length,
    requested_page_size: pageSize,
    full_page: files.length === pageSize,
    offset: 0,
    match_observation: observedMatch,
    match_counts: {
      name_starts_with_literal_query: literalPrefix,
      name_starts_with_query_without_trailing_wildcard: termPrefix,
      name_contains_query_without_trailing_wildcard: termSubstring,
      token_equals_query_without_trailing_wildcard: termToken,
      name_contains_literal_asterisk: literalWildcardInName,
    },
    timestamp_schema: auditTimestampSchema(files),
    items,
  };
}

function setOverlap(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function buildOverlap(results) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < results.length;
      rightIndex += 1
    ) {
      const left = results[leftIndex];
      const right = results[rightIndex];
      const leftIdents = left.items.map((item) => item.ident);
      const rightIdents = right.items.map((item) => item.ident);
      const leftNames = left.items.map((item) => normalizeText(item.name));
      const rightNames = right.items.map((item) => normalizeText(item.name));
      const identOverlap = setOverlap(
        new Set(leftIdents),
        new Set(rightIdents)
      );
      const nameOverlap = setOverlap(new Set(leftNames), new Set(rightNames));
      const unionSize = new Set([...leftIdents, ...rightIdents]).size;
      pairs.push({
        left_query: left.query,
        right_query: right.query,
        ident_overlap: identOverlap,
        name_overlap: nameOverlap,
        identical_ident_order:
          JSON.stringify(leftIdents) === JSON.stringify(rightIdents),
        identical_name_order:
          JSON.stringify(leftNames) === JSON.stringify(rightNames),
        ident_jaccard_percent:
          unionSize === 0
            ? null
            : Number(((identOverlap / unionSize) * 100).toFixed(6)),
      });
    }
  }
  const wildcardPairs = [];
  const byQuery = new Map(results.map((result) => [result.query, result]));
  for (const result of results) {
    if (result.query.endsWith("*")) continue;
    const wildcard = byQuery.get(`${result.query}*`);
    if (!wildcard) continue;
    const pair = pairs.find(
      (candidate) =>
        candidate.left_query === result.query &&
        candidate.right_query === wildcard.query
    );
    wildcardPairs.push({
      plain_query: result.query,
      wildcard_query: wildcard.query,
      ...pair,
      wildcard_observation: pair?.identical_ident_order
        ? "asterisk-probably-does-not-change-results"
        : "asterisk-changes-results-or-ranking",
    });
  }
  return { pairs, wildcard_pairs: wildcardPairs };
}

function markdownEscape(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/gu, " ");
}

function renderMarkdown(report) {
  const lines = [
    "# Webshare Search Semantics Audit",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "| Query | HTTP | Latency ms | Total | Returned | Full | Observation |",
    "|---|---:|---:|---:|---:|---|---|",
  ];
  for (const result of report.results) {
    lines.push(
      `| ${markdownEscape(result.query)} | ${result.http?.status ?? "n/a"} | ${
        result.http?.latency_ms ?? "n/a"
      } | ${markdownEscape(result.reported_total)} | ${
        result.returned_item_count
      } | ${result.full_page ? "yes" : "no"} | ${markdownEscape(
        result.match_observation
      )} |`
    );
  }
  lines.push(
    "",
    "This report is diagnostic only. It is not a crawl, import, publish, or reconciliation."
  );
  return `${lines.join("\n")}\n`;
}

function writeReports(outputDir, report, logger) {
  const files = {
    json: path.join(outputDir, "report.json"),
    markdown: path.join(outputDir, "report.md"),
    log: path.join(outputDir, "sanitized.log"),
  };
  fs.writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(files.markdown, renderMarkdown(report), {
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(files.log, logger.text(), {
    flag: "wx",
    mode: 0o600,
  });
  return files;
}

async function runAudit(options, dependencies = {}) {
  const outputDir = prepareOutputDirectory(options.outputDir);
  const config = dependencies.config || getConfig();
  const logger =
    dependencies.logger ||
    createSafeLogger([
      config.username,
      config.password,
      config.githubExportToken,
    ]);
  const requestBudget = createRequestBudget(options.maxSearchRequests);
  const client = dependencies.client || createApiClient();
  const telemetry =
    dependencies.telemetry ||
    (client?.interceptors
      ? attachAxiosTelemetry(client)
      : { records: [], maxInFlight: 0 });
  const authenticate = dependencies.authenticate || loginAndGetWst;
  const authController = new AbortController();
  const authTimer = setTimeout(() => authController.abort(), options.timeoutMs);
  let wst;
  try {
    logger.info("Starting one bounded Webshare authentication.");
    wst = await authenticate({
      username: config.username,
      password: config.password,
      signal: authController.signal,
      requestMeter: requestBudget,
      client,
      logger,
    });
  } finally {
    clearTimeout(authTimer);
  }
  logger.addSecret(wst);
  const session = {
    async withWst(task) {
      return task(wst);
    },
  };
  const fetchPage = dependencies.fetchSearchPage || fetchSearchPage;
  const results = [];
  let activeSearches = 0;
  let maxSearchConcurrency = 0;
  let searchTelemetryIndex = 0;
  for (const query of options.queries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    activeSearches += 1;
    maxSearchConcurrency = Math.max(maxSearchConcurrency, activeSearches);
    try {
      logger.info(`Search query ${JSON.stringify(query)} offset=0.`);
      let page;
      try {
        page = await fetchPage(
          client,
          session,
          {
            prefix: query,
            wildcardSuffix: "",
            offset: 0,
            limit: options.pageSize,
            sort: "recent",
            category: "video",
            signal: controller.signal,
            requestMeter: requestBudget,
          },
          { apiRequests: 0 }
        );
      } catch (error) {
        throw new Error(
          String(
            sanitizeLogValue(error?.message || String(error), [
              config.username,
              config.password,
              wst,
            ])
          )
        );
      }
      const result = analyzePage(query, page, options.pageSize);
      const searchRecords = telemetry.records.filter(
        (entry) => entry.endpoint === "/api/search/"
      );
      result.http = searchRecords[searchTelemetryIndex] || null;
      searchTelemetryIndex += 1;
      results.push(result);
    } finally {
      activeSearches -= 1;
      clearTimeout(timer);
    }
  }
  const report = sanitizeLogValue({
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    import_performed: false,
    reconciliation_performed: false,
    publish_performed: false,
    concurrency: 1,
    max_observed_search_concurrency: maxSearchConcurrency,
    request_budget: requestBudget.snapshot(),
    http_telemetry: {
      max_in_flight: telemetry.maxInFlight,
      requests: telemetry.records,
    },
    queries: [...options.queries],
    page_size: options.pageSize,
    offset: 0,
    timeout_ms: options.timeoutMs,
    results,
    overlap: buildOverlap(results),
  }, [config.username, config.password, wst]);
  const files = writeReports(outputDir, report, logger);
  return { report, files, outputDir };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runAudit(options);
  console.log(
    JSON.stringify(
      {
        success: true,
        output_dir: result.outputDir,
        request_budget: result.report.request_budget,
        query_count: result.report.results.length,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `Webshare search semantics audit zlyhal: ${sanitizeLogValue(
        error?.message || String(error),
        [process.env.WEBSHARE_USERNAME, process.env.WEBSHARE_PASSWORD]
      )}`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_PAGE_SIZE,
  MAX_SEARCH_REQUESTS,
  MAX_TIMEOUT_MS,
  TIMESTAMP_FIELDS,
  analyzePage,
  attachAxiosTelemetry,
  buildOverlap,
  createRequestBudget,
  createSafeLogger,
  parseArguments,
  prepareOutputDirectory,
  runAudit,
  usage,
};
