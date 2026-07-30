#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseStringPromise } = require("xml2js");
const {
  createApiClient,
  fetchSearchPage,
  getConfig,
  loginAndGetWst,
  sanitizeLogValue,
} = require("../main");
const {
  attachAxiosTelemetry,
  createSafeLogger,
} = require("./audit-webshare-search-semantics");

const FILE_INFO_URL = "https://webshare.cz/api/file_info/";
const MAX_TOTAL_API_REQUESTS = 12;
const MAX_PAGE_SIZE = 20;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OFFSETS = 5;
const MAX_OFFSET = 10_000;
const MAX_SORTS = 4;
const MAX_DETAIL_SAMPLES = 3;
const MAX_ITEM_SAMPLES = 20;
const MAX_FIELD_NAMES = 64;
const MAX_QUERY_BYTES = 256;
const DOCUMENTED_SORTS = Object.freeze([
  "recent",
  "rating",
  "largest",
  "smallest",
]);
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
  "--offset",
  "--sort",
  "--repeat-offset-zero",
  "--detail-samples",
  "--max-api-requests",
  "--page-size",
  "--timeout-ms",
  "--output-dir",
]);

function usage() {
  return [
    "Použitie:",
    "  node scripts/audit-webshare-enumeration.js \\",
    "    --query test \\",
    "    --offset 0 --offset 100 --offset 900 --offset 1000 --offset 1100 \\",
    "    --sort recent --sort rating --sort largest --sort smallest \\",
    "    --repeat-offset-zero 1 --detail-samples 1 \\",
    "    --max-api-requests 12 --page-size 20 --timeout-ms 15000 \\",
    "    --output-dir /tmp/webshare-enumeration-audit-<timestamp>",
  ].join("\n");
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ""))) {
    throw new Error(`${label} musí byť neambiguózne desiatkové celé číslo.`);
  }
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new Error(`${label} musí byť v rozsahu ${minimum}..${maximum}.`);
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
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const values = {
    query: null,
    offsets: [],
    sorts: [],
    repeatOffsetZero: 0,
    detailSamples: 0,
    maxApiRequests: MAX_TOTAL_API_REQUESTS,
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
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Argument ${key} vyžaduje hodnotu.`);
    }
    if (key === "--offset") {
      values.offsets.push(
        parseInteger(value, key, 0, MAX_OFFSET)
      );
    } else if (key === "--sort") {
      if (!DOCUMENTED_SORTS.includes(value)) {
        throw new Error(
          `${key} musí byť jedna z dokumentovaných hodnôt: ${DOCUMENTED_SORTS.join(
            ", "
          )}.`
        );
      }
      values.sorts.push(value);
    } else {
      if (seen.has(key)) throw new Error(`Argument ${key} bol zadaný viackrát.`);
      seen.add(key);
      if (key === "--query") {
        values.query = validateQuery(value);
      } else if (key === "--repeat-offset-zero") {
        values.repeatOffsetZero = parseInteger(value, key, 0, 1);
      } else if (key === "--detail-samples") {
        values.detailSamples = parseInteger(
          value,
          key,
          0,
          MAX_DETAIL_SAMPLES
        );
      } else if (key === "--max-api-requests") {
        values.maxApiRequests = parseInteger(
          value,
          key,
          1,
          MAX_TOTAL_API_REQUESTS
        );
      } else if (key === "--page-size") {
        values.pageSize = parseInteger(value, key, 1, MAX_PAGE_SIZE);
      } else if (key === "--timeout-ms") {
        values.timeoutMs = parseInteger(value, key, 1, MAX_TIMEOUT_MS);
      } else if (key === "--output-dir") {
        values.outputDir = path.resolve(value);
      }
    }
    index += 1;
  }
  if (!values.query) throw new Error("Chýba --query.");
  if (values.offsets.length === 0) throw new Error("Chýba aspoň jeden --offset.");
  if (values.offsets.length > MAX_OFFSETS) {
    throw new Error(`Počet offsetov prekračuje maximum ${MAX_OFFSETS}.`);
  }
  if (new Set(values.offsets).size !== values.offsets.length) {
    throw new Error("Offset zoznam nesmie obsahovať duplicity.");
  }
  if (values.sorts.length === 0) throw new Error("Chýba aspoň jeden --sort.");
  if (values.sorts.length > MAX_SORTS) {
    throw new Error(`Počet sort hodnôt prekračuje maximum ${MAX_SORTS}.`);
  }
  if (new Set(values.sorts).size !== values.sorts.length) {
    throw new Error("Sort zoznam nesmie obsahovať duplicity.");
  }
  if (values.repeatOffsetZero > 0 && !values.offsets.includes(0)) {
    throw new Error("--repeat-offset-zero vyžaduje explicitný --offset 0.");
  }
  if (!values.outputDir) throw new Error("Chýba --output-dir.");
  const plannedSearchRequests =
    values.offsets.length +
    values.repeatOffsetZero +
    Math.max(0, values.sorts.length - 1);
  const plannedTotalRequests =
    2 + plannedSearchRequests + values.detailSamples;
  if (plannedTotalRequests > values.maxApiRequests) {
    throw new Error(
      `Plán vyžaduje ${plannedTotalRequests} requestov a prekračuje --max-api-requests=${values.maxApiRequests}.`
    );
  }
  values.plannedSearchRequests = plannedSearchRequests;
  values.plannedTotalRequests = plannedTotalRequests;
  return values;
}

function comparisonPathKey(value) {
  const normalized = path.resolve(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function prepareOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const canonicalParent = fs.realpathSync.native(path.dirname(resolved));
  const canonicalTemp = fs.realpathSync.native(os.tmpdir());
  if (comparisonPathKey(canonicalParent) !== comparisonPathKey(canonicalTemp)) {
    throw new Error("Diagnostický output musí byť priamy podadresár OS temp.");
  }
  if (
    !/^webshare-enumeration-audit-[a-zA-Z0-9._-]+$/.test(
      path.basename(resolved)
    )
  ) {
    throw new Error(
      "Diagnostický adresár musí mať názov webshare-enumeration-audit-<id>."
    );
  }
  if (fs.existsSync(resolved)) {
    throw new Error("Diagnostický output adresár už existuje.");
  }
  fs.mkdirSync(resolved, { mode: 0o700 });
  return resolved;
}

function createRequestBudget(maxTotalRequests) {
  if (
    !Number.isSafeInteger(maxTotalRequests) ||
    maxTotalRequests < 1 ||
    maxTotalRequests > MAX_TOTAL_API_REQUESTS
  ) {
    throw new Error(
      `Enumeration audit request budget musí byť v rozsahu 1..${MAX_TOTAL_API_REQUESTS}.`
    );
  }
  const counters = {
    total: 0,
    salt: 0,
    login: 0,
    search: 0,
    detail: 0,
    completed: 0,
  };
  const attempts = [];
  return {
    beforeRequest(kind, operationKey) {
      const operation = String(operationKey || kind);
      if (counters.total >= maxTotalRequests) {
        throw new Error("Celkový enumeration audit request budget bol vyčerpaný.");
      }
      if (kind === "login") {
        if (operation === "salt") {
          if (counters.salt >= 1) {
            throw new Error("Enumeration audit povoľuje iba jeden salt request.");
          }
          counters.salt += 1;
        } else if (operation === "login") {
          if (counters.login >= 1) {
            throw new Error("Enumeration audit povoľuje iba jeden login request.");
          }
          counters.login += 1;
        } else {
          throw new Error(`Nepovolený auth request: ${operation}`);
        }
      } else if (kind === "search") {
        counters.search += 1;
      } else if (kind === "detail") {
        if (counters.detail >= MAX_DETAIL_SAMPLES) {
          throw new Error("Enumeration audit detail request budget bol vyčerpaný.");
        }
        counters.detail += 1;
      } else {
        throw new Error(`Nepovolený request kind: ${kind}`);
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
        max_total_requests: maxTotalRequests,
        attempts: attempts.map((entry) => ({ ...entry })),
      };
    },
  };
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function safeText(value, maximum = 512) {
  const scalar = firstValue(value);
  if (scalar === null || scalar === undefined) return null;
  return String(scalar).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum);
}

function boundedFieldNames(value) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).sort().slice(0, MAX_FIELD_NAMES);
}

function timestampFormat(value) {
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  const text = String(value || "");
  if (/^[0-9]{10}$/.test(text)) return "epoch-seconds-string";
  if (/^[0-9]{13}$/.test(text)) return "epoch-milliseconds-string";
  if (!Number.isNaN(Date.parse(text))) return "date-parseable-string";
  return "string";
}

function auditTimestampSchema(sourceItems) {
  return Object.fromEntries(
    TIMESTAMP_FIELDS.map((field) => {
      const values = sourceItems
        .map((item) => firstValue(item?.[field]))
        .filter((value) => value !== null && value !== undefined && value !== "");
      return [
        field,
        {
          present: values.length > 0,
          present_count: values.length,
          value_types: [...new Set(values.map((value) => typeof value))]
            .sort()
            .slice(0, 8),
          formats: [...new Set(values.map(timestampFormat))].sort().slice(0, 8),
        },
      ];
    })
  );
}

function orderedFingerprint(idents) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(idents))
    .digest("hex");
}

function analyzeSearchPage(spec, page, pageSize) {
  const files = Array.isArray(page?.files) ? page.files : [];
  const boundedFiles = files.slice(0, MAX_ITEM_SAMPLES);
  const samples = boundedFiles.map((file) => ({
    ident: safeText(file?.ident, 128),
    name: safeText(file?.name),
    size: safeText(file?.size, 64),
    type: safeText(file?.type, 64),
  }));
  const idents = samples.map((item) => item.ident).filter(Boolean);
  return {
    probe_kind: spec.kind,
    query: spec.query,
    sort: spec.sort,
    offset: spec.offset,
    requested_page_size: pageSize,
    reported_total: safeText(page?.total, 64),
    returned_item_count: files.length,
    full_page: files.length === pageSize,
    ordered_ident_fingerprint: orderedFingerprint(idents),
    unique_ident_count: new Set(idents).size,
    duplicate_ident_count: idents.length - new Set(idents).size,
    response_fields: {
      root: boundedFieldNames(page),
      file: boundedFieldNames(files[0]),
    },
    timestamp_schema: auditTimestampSchema(boundedFiles),
    samples,
    http: null,
  };
}

function setOverlap(left, right) {
  const rightSet = new Set(right);
  return new Set(left.filter((value) => rightSet.has(value))).size;
}

function buildPageComparisons(results) {
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < results.length;
      rightIndex += 1
    ) {
      const left = results[leftIndex];
      const right = results[rightIndex];
      const leftIds = left.samples.map((item) => item.ident).filter(Boolean);
      const rightIds = right.samples.map((item) => item.ident).filter(Boolean);
      comparisons.push({
        left: {
          kind: left.probe_kind,
          sort: left.sort,
          offset: left.offset,
        },
        right: {
          kind: right.probe_kind,
          sort: right.sort,
          offset: right.offset,
        },
        ident_overlap: setOverlap(leftIds, rightIds),
        identical_ident_order:
          left.ordered_ident_fingerprint === right.ordered_ident_fingerprint,
        reported_total_equal: left.reported_total === right.reported_total,
      });
    }
  }
  return comparisons;
}

function analyzeIdentFormat(results) {
  const idents = [
    ...new Set(
      results.flatMap((result) =>
        result.samples.map((item) => item.ident).filter(Boolean)
      )
    ),
  ].slice(0, MAX_ITEM_SAMPLES * MAX_TOTAL_API_REQUESTS);
  const lengths = {};
  for (const ident of idents) {
    const key = String(ident.length);
    lengths[key] = (lengths[key] || 0) + 1;
  }
  return {
    sampled_unique_idents: idents.length,
    length_distribution: lengths,
    all_ascii_alphanumeric: idents.every((ident) => /^[A-Za-z0-9]+$/.test(ident)),
    all_numeric: idents.every((ident) => /^[0-9]+$/.test(ident)),
    monotonicity_not_inferred: true,
    range_filter_observed: false,
  };
}

async function parseApiResponse(data, endpointName) {
  const parsed = await parseStringPromise(data, {
    explicitArray: true,
    trim: true,
  });
  const response = parsed?.response;
  const status = firstValue(response?.status);
  if (status !== "OK") {
    const code = safeText(response?.code, 128);
    const message = safeText(response?.message, 512);
    throw new Error(
      `${endpointName} failed${code ? ` (${code})` : ""}: ${
        message || "unknown API error"
      }`
    );
  }
  return response;
}

async function fetchFileInfo(options) {
  const {
    client,
    ident,
    signal,
    requestMeter,
  } = options;
  requestMeter.beforeRequest("detail", `file_info:${ident}`);
  const response = await client.post(
    FILE_INFO_URL,
    new URLSearchParams({
      ident,
      maybe_removed: "1",
    }).toString(),
    { signal }
  );
  requestMeter.afterRequest();
  return parseApiResponse(response.data, "file_info");
}

function analyzeFileInfo(ident, response) {
  return {
    ident,
    response_fields: boundedFieldNames(response),
    timestamp_schema: auditTimestampSchema([response]),
    selected_fields: {
      name: safeText(response?.name),
      size: safeText(response?.size, 64),
      type: safeText(response?.type, 64),
      available: safeText(response?.available, 16),
      removed: safeText(response?.removed, 16),
      removed_at: safeText(response?.removed_at, 128),
      removal_reason: safeText(response?.removal_reason, 256),
    },
    http: null,
  };
}

function buildSearchPlan(options) {
  const baseSort = options.sorts[0];
  const plan = options.offsets.map((offset) => ({
    kind: "offset",
    query: options.query,
    sort: baseSort,
    offset,
  }));
  for (let index = 0; index < options.repeatOffsetZero; index += 1) {
    plan.push({
      kind: "repeat_offset_zero",
      query: options.query,
      sort: baseSort,
      offset: 0,
    });
  }
  for (const sort of options.sorts.slice(1)) {
    plan.push({
      kind: "sort",
      query: options.query,
      sort,
      offset: 0,
    });
  }
  return plan;
}

function telemetryFor(records, endpoint, index) {
  const record =
    records.filter((entry) => entry.endpoint === endpoint)[index] || null;
  return record ? { ...record } : null;
}

function renderMarkdown(report) {
  const lines = [
    "# Webshare Enumeration Strategy Audit",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "| Kind | Sort | Offset | HTTP | Total | Returned | Fingerprint |",
    "|---|---|---:|---:|---:|---:|---|",
  ];
  for (const result of report.search_probes) {
    lines.push(
      `| ${result.probe_kind} | ${result.sort} | ${result.offset} | ${
        result.http?.status ?? "n/a"
      } | ${result.reported_total ?? "n/a"} | ${
        result.returned_item_count
      } | ${result.ordered_ident_fingerprint.slice(0, 12)}… |`
    );
  }
  lines.push(
    "",
    "Diagnostic only: no crawl, import, reconciliation, publish, or production catalog access."
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

async function withTimeout(timeoutMs, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
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
  const requestBudget = createRequestBudget(options.maxApiRequests);
  const client = dependencies.client || createApiClient();
  const telemetry =
    dependencies.telemetry ||
    (client?.interceptors
      ? attachAxiosTelemetry(client)
      : { records: [], maxInFlight: 0 });
  const authenticate = dependencies.authenticate || loginAndGetWst;
  const wst = await withTimeout(options.timeoutMs, (signal) =>
    authenticate({
      username: config.username,
      password: config.password,
      signal,
      requestMeter: requestBudget,
      client,
      logger,
    })
  );
  logger.addSecret(wst);
  const session = {
    async withWst(task) {
      return task(wst);
    },
  };
  const fetchPage = dependencies.fetchSearchPage || fetchSearchPage;
  const detailFetcher = dependencies.fetchFileInfo || fetchFileInfo;
  const searchPlan = buildSearchPlan(options);
  const searchResults = [];
  let activeRequests = 0;
  let maxObservedConcurrency = 0;
  let searchTelemetryIndex = 0;
  for (const spec of searchPlan) {
    const page = await withTimeout(options.timeoutMs, async (signal) => {
      activeRequests += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests);
      try {
        logger.info(
          `Search query=${JSON.stringify(spec.query)} sort=${spec.sort} offset=${spec.offset}.`
        );
        return await fetchPage(
          client,
          session,
          {
            prefix: spec.query,
            wildcardSuffix: "",
            offset: spec.offset,
            limit: options.pageSize,
            sort: spec.sort,
            category: "video",
            signal,
            requestMeter: requestBudget,
          },
          { apiRequests: 0 }
        );
      } finally {
        activeRequests -= 1;
      }
    });
    const analyzed = analyzeSearchPage(spec, page, options.pageSize);
    analyzed.http = telemetryFor(
      telemetry.records,
      "/api/search/",
      searchTelemetryIndex
    );
    searchTelemetryIndex += 1;
    searchResults.push(analyzed);
  }
  const detailResults = [];
  const detailIdents = [
    ...new Set(
      searchResults.flatMap((result) =>
        result.samples.map((item) => item.ident).filter(Boolean)
      )
    ),
  ].slice(0, options.detailSamples);
  let detailTelemetryIndex = 0;
  for (const ident of detailIdents) {
    const response = await withTimeout(options.timeoutMs, async (signal) => {
      activeRequests += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests);
      try {
        logger.info(`file_info sample ident=${JSON.stringify(ident)}.`);
        return await detailFetcher({
          client,
          ident,
          signal,
          requestMeter: requestBudget,
        });
      } finally {
        activeRequests -= 1;
      }
    });
    const analyzed = analyzeFileInfo(ident, response);
    analyzed.http = telemetryFor(
      telemetry.records,
      "/api/file_info/",
      detailTelemetryIndex
    );
    detailTelemetryIndex += 1;
    detailResults.push(analyzed);
  }
  if (detailResults.length !== options.detailSamples) {
    throw new Error(
      `Detail audit očakával ${options.detailSamples} vzoriek, získal ${detailResults.length}.`
    );
  }
  const report = sanitizeLogValue(
    {
      generated_at: new Date().toISOString(),
      diagnostic_only: true,
      import_performed: false,
      reconciliation_performed: false,
      publish_performed: false,
      crawler_state_created: false,
      concurrency: 1,
      max_observed_concurrency: maxObservedConcurrency,
      query: options.query,
      base_sort: options.sorts[0],
      documented_sorts_tested: [...options.sorts],
      requested_offsets: [...options.offsets],
      repeated_offset_zero: options.repeatOffsetZero,
      page_size: options.pageSize,
      timeout_ms: options.timeoutMs,
      request_budget: requestBudget.snapshot(),
      http_telemetry: {
        max_in_flight: telemetry.maxInFlight,
        requests: telemetry.records,
      },
      search_probes: searchResults,
      page_comparisons: buildPageComparisons(searchResults),
      ident_audit: analyzeIdentFormat(searchResults),
      detail_probes: detailResults,
      bounded_output: {
        item_samples_per_page: MAX_ITEM_SAMPLES,
        field_names_per_object: MAX_FIELD_NAMES,
        raw_response_body_persisted: false,
      },
    },
    [config.username, config.password, wst]
  );
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
        search_probe_count: result.report.search_probes.length,
        detail_probe_count: result.report.detail_probes.length,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `Webshare enumeration audit zlyhal: ${sanitizeLogValue(
        error?.message || String(error),
        [process.env.WEBSHARE_USERNAME, process.env.WEBSHARE_PASSWORD]
      )}`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  DOCUMENTED_SORTS,
  MAX_DETAIL_SAMPLES,
  MAX_FIELD_NAMES,
  MAX_ITEM_SAMPLES,
  MAX_PAGE_SIZE,
  MAX_TOTAL_API_REQUESTS,
  analyzeFileInfo,
  analyzeSearchPage,
  buildPageComparisons,
  buildSearchPlan,
  createRequestBudget,
  fetchFileInfo,
  parseArguments,
  prepareOutputDirectory,
  runAudit,
  usage,
};
