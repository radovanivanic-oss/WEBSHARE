const crypto = require("crypto");
const path = require("path");

const STATE_SCHEMA_VERSION = 2;
const ALGORITHM_VERSION = "webshare-search-v2";
const WEBSHARE_SEARCH_ENDPOINT = "https://webshare.cz/api/search/";
const DEFAULT_ROOT_PREFIXES = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const DEFAULT_PARTITION_CHARACTERS = [
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  " ",
  ".",
  "-",
  "_",
  "(",
  "[",
];

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildAlgorithmConfig(overrides = {}) {
  return Object.freeze({
    algorithmVersion: ALGORITHM_VERSION,
    roots: Object.freeze([...(overrides.roots ?? DEFAULT_ROOT_PREFIXES)]),
    partitionCharacters: Object.freeze([
      ...(overrides.partitionCharacters ?? DEFAULT_PARTITION_CHARACTERS),
    ]),
    partitionCompletenessProven:
      overrides.partitionCompletenessProven === true,
    searchEndpoint: WEBSHARE_SEARCH_ENDPOINT,
    queryMode: "webshare_what_wildcard",
    wildcardSuffix: "*",
    category: "video",
    sort: "recent",
    normalizerVersion: "legacy-normalize-file-v1",
    pageSize: overrides.pageSize ?? 100,
    serverResultCap: overrides.serverResultCap ?? 1000,
    maxPagesPerPrefix: overrides.maxPagesPerPrefix ?? 100,
    maxDepth: overrides.maxDepth ?? 5,
    bestEffortSearchContinuation:
      overrides.bestEffortSearchContinuation === true,
    // The provider's capped totals are not a proof that character prefixes
    // are disjoint.  This option may nevertheless expand capped prefixes to
    // collect more candidates; the run remains explicitly incomplete and
    // can never authorize full reconciliation.
    bestEffortPartitioning:
      overrides.bestEffortPartitioning === true,
    repeatedPageRule: "canonical_ident_multiset_sha256_v2",
    completionRule: "short_page_and_reported_total_consistent_v2",
  });
}

function algorithmFingerprint(algorithmConfig) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(algorithmConfig))
    .digest("hex");
}

function validateAlgorithmConfig(algorithm) {
  const numericFields = [
    "pageSize",
    "serverResultCap",
    "maxPagesPerPrefix",
    "maxDepth",
  ];
  for (const field of numericFields) {
    if (!Number.isSafeInteger(algorithm[field]) || algorithm[field] < 1) {
      throw new TypeError(`${field} musí byť kladné celé číslo.`);
    }
  }
  for (const [field, values] of [
    ["roots", algorithm.roots],
    ["partitionCharacters", algorithm.partitionCharacters],
  ]) {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      throw new TypeError(`${field} musí byť neprázdne pole reťazcov.`);
    }
    if (new Set(values).size !== values.length) {
      throw new TypeError(`${field} obsahuje duplicitné hodnoty.`);
    }
  }
  return algorithm;
}

function getCrawlerV2Config(options = {}) {
  const runtimeDir = path.resolve(
    options.runtimeDir || path.join(process.cwd(), "runtime")
  );
  const environmentAlgorithm = {};
  if (process.env.CRAWLER_BEST_EFFORT_SEARCH === "true") {
    environmentAlgorithm.bestEffortSearchContinuation = true;
  }
  if (process.env.CRAWLER_BEST_EFFORT_PARTITIONING === "true") {
    environmentAlgorithm.bestEffortPartitioning = true;
  }
  if (process.env.CRAWLER_MAX_PAGES_PER_PREFIX) {
    environmentAlgorithm.maxPagesPerPrefix = Number(
      process.env.CRAWLER_MAX_PAGES_PER_PREFIX
    );
  }
  const algorithm = validateAlgorithmConfig(
    buildAlgorithmConfig({
      ...environmentAlgorithm,
      ...(options.algorithm || {}),
    })
  );
  const config = {
    runtimeDir,
    stateDbPath:
      options.stateDbPath || path.join(runtimeDir, "crawler-state.sqlite"),
    lockPath:
      options.lockPath || path.join(runtimeDir, "locks", "crawler-v2.lock"),
    legacyCheckpointPaths:
      options.legacyCheckpointPaths || [
        path.join(runtimeDir, "webshare-crawler.checkpoint.json"),
        path.join(runtimeDir, "checkpoint.json"),
    ],
    exportPath:
      options.exportPath ||
      path.join(
        runtimeDir,
        "crawler-runs",
        "{run_id}",
        "exports",
        "{export_id}",
        "catalog-items.jsonl"
      ),
    manifestPath:
      options.manifestPath ||
      path.join(
        runtimeDir,
        "crawler-runs",
        "{run_id}",
        "exports",
        "{export_id}",
        "catalog-items.manifest.json"
      ),
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    workerConcurrency: options.workerConcurrency ?? 3,
    maxAttempts: options.maxAttempts ?? 5,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 1_000,
    retryMaxDelayMs: options.retryMaxDelayMs ?? 30_000,
    algorithm,
    algorithmFingerprint: algorithmFingerprint(algorithm),
  };
  if (!Number.isSafeInteger(config.leaseDurationMs) || config.leaseDurationMs < 30) {
    throw new TypeError("leaseDurationMs musí byť celé číslo najmenej 30 ms.");
  }
  for (const field of ["workerConcurrency", "maxAttempts"]) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) {
      throw new TypeError(`${field} musí byť kladné celé číslo.`);
    }
  }
  for (const field of [
    "retryBaseDelayMs",
    "retryMaxDelayMs",
  ]) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 0) {
      throw new TypeError(`${field} musí byť nezáporné celé číslo.`);
    }
  }
  if (config.retryMaxDelayMs < config.retryBaseDelayMs) {
    throw new TypeError(
      "retryMaxDelayMs nesmie byť menšie než retryBaseDelayMs."
    );
  }
  return config;
}

module.exports = {
  ALGORITHM_VERSION,
  DEFAULT_PARTITION_CHARACTERS,
  DEFAULT_ROOT_PREFIXES,
  STATE_SCHEMA_VERSION,
  WEBSHARE_SEARCH_ENDPOINT,
  algorithmFingerprint,
  buildAlgorithmConfig,
  canonicalJson,
  getCrawlerV2Config,
  validateAlgorithmConfig,
};
