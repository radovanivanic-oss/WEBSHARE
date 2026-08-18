"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TmdbClient, isTemporaryError } = require("../providers/tmdb-client");
const { createMetadataFileCache } = require("../lib/metadata-file-cache");
const {
  MATCH_POLICY_VERSION,
  buildEnrichmentCandidates,
  buildEvidenceDigest,
  inferExpectedTypes,
  providerTaxonomy,
  selectStrictMetadataMatch,
} = require("../lib/metadata-enrichment");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");

const AUDIT_VERSION = "B37-unclassified-metadata-enrichment-v1";
const STATES = Object.freeze(["PENDING", "SEARCHED", "MATCHED", "AMBIGUOUS", "NO_MATCH", "RETRY_LATER", "FAILED"]);

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseArguments(argv) {
  const options = { mode: "candidate-audit", limit: 100, offset: 0, maxProviderRequests: 0, provider: "tmdb", dryRun: false, maxQueriesPerEntity: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--database") options.database = argv[++index];
    else if (value === "--output-dir") options.outputDir = argv[++index];
    else if (value === "--limit") options.limit = Number.parseInt(argv[++index], 10);
    else if (value === "--offset") options.offset = Number.parseInt(argv[++index], 10);
    else if (value === "--max-provider-requests") options.maxProviderRequests = Number.parseInt(argv[++index], 10);
    else if (value === "--provider") options.provider = argv[++index];
    else if (value === "--mode") options.mode = argv[++index];
    else if (value === "--resume") options.resume = true;
    else if (value === "--max-queries-per-entity") options.maxQueriesPerEntity = Number.parseInt(argv[++index], 10);
    else throw new Error(`Neplatný argument ${value}.`);
  }
  if (!options.database || !options.outputDir) throw new Error("Vyžaduje sa --database a --output-dir.");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 5000) throw new Error("limit musí byť 1..5000.");
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("offset musí byť nezáporné celé číslo.");
  if (!Number.isSafeInteger(options.maxQueriesPerEntity) || options.maxQueriesPerEntity < 1 || options.maxQueriesPerEntity > 3) throw new Error("max-queries-per-entity musí byť 1..3.");
  if (!new Set(["candidate-audit", "retrospective", "provider-sample"]).has(options.mode)) throw new Error("nepodporovaný mode.");
  if (options.mode === "provider-sample" && (!options.dryRun || options.provider !== "tmdb" || !Number.isSafeInteger(options.maxProviderRequests) || options.maxProviderRequests < 1 || options.maxProviderRequests > 10000)) {
    throw new Error("provider-sample vyžaduje --dry-run, --provider tmdb a provider request budget 1..10000.");
  }
  return options;
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeErrorMessage(error) {
  return String(error?.code || error?.message || "metadata_enrichment_error")
    .replace(/([?&]api_key=)[^&\s]*/giu, "$1[REDACTED]")
    .replace(/TMDB_API_KEY[^\s]*/giu, "TMDB_API_KEY[REDACTED]");
}

function auditInputDigest(options, databasePath) {
  const stat = fs.statSync(databasePath);
  return digest({
    audit_version: AUDIT_VERSION,
    match_policy_version: MATCH_POLICY_VERSION,
    mode: options.mode,
    provider: options.provider,
    batch_limit: options.limit,
    start_offset: options.offset,
    max_queries_per_entity: options.maxQueriesPerEntity,
    database: path.resolve(databasePath),
    database_size: stat.size,
    database_mtime_ms: stat.mtimeMs,
  });
}

function loadResume(outputDir, options, databasePath) {
  if (!options.resume) {
    if (fs.existsSync(path.join(outputDir, "checkpoint.json")) || fs.existsSync(path.join(outputDir, "enrichment-results.json"))) {
      throw new Error("AUDIT_OUTPUT_EXISTS_USE_RESUME_OR_NEW_OUTPUT_DIR");
    }
    return { offset: options.offset, previousResults: [], previousProcessed: 0, previousCounters: null, inputDigest: auditInputDigest(options, databasePath) };
  }
  const checkpointPath = path.join(outputDir, "checkpoint.json");
  const resultsPath = path.join(outputDir, "enrichment-results.json");
  if (!fs.existsSync(checkpointPath) || !fs.existsSync(resultsPath)) throw new Error("RESUME_ARTIFACTS_MISSING");
  let checkpoint;
  let prior;
  try {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    prior = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  } catch {
    throw new Error("RESUME_ARTIFACTS_INVALID");
  }
  const expectedInput = auditInputDigest({ ...options, offset: checkpoint.start_offset ?? options.offset }, databasePath);
  if (checkpoint.input_digest !== expectedInput || prior.match_policy_version !== MATCH_POLICY_VERSION || prior.audit_version !== AUDIT_VERSION) {
    throw new Error("RESUME_INPUT_OR_POLICY_MISMATCH");
  }
  if (!Array.isArray(prior.results) || prior.results.length !== Number(checkpoint.processed_total || checkpoint.processed || 0)) throw new Error("RESUME_RESULT_COUNT_MISMATCH");
  return {
    offset: Number(checkpoint.next_offset),
    previousResults: prior.results,
    previousProcessed: Number(checkpoint.processed_total || checkpoint.processed || 0),
    previousCounters: prior.counters || null,
    inputDigest: checkpoint.input_digest,
  };
}

function buildEntityQueries(database, rows, ids) {
  const placeholders = ids.map(() => "?").join(",");
  const files = database.prepare(`SELECT media_id, original_name, parsed_title, parsed_year, parsed_season, parsed_episode, is_active, is_playable_video FROM files WHERE media_id IN (${placeholders}) ORDER BY media_id, id`).all(...ids);
  const aliases = database.prepare(`SELECT media_id, alias, language, source FROM media_aliases WHERE media_id IN (${placeholders}) ORDER BY media_id, id`).all(...ids);
  const filesById = new Map(ids.map((id) => [id, []]));
  const aliasesById = new Map(ids.map((id) => [id, []]));
  for (const file of files) filesById.get(file.media_id).push(file);
  for (const alias of aliases) aliasesById.get(alias.media_id).push(alias);
  return rows.map((media) => ({ media, files: filesById.get(media.id) || [], aliases: aliasesById.get(media.id) || [] }));
}

function selectUnknownRows(database, limit, offset) {
  return database.prepare(`
    SELECT id, title, original_title, media_type, category, year, tvshow_id, metadata_status,
      metadata_confidence, external_source, external_id, genres_json, countries_json, languages_json, is_active
    FROM media WHERE category = 'unknown' ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset);
}

function selectMatchedRows(database, limit, offset) {
  return database.prepare(`
    SELECT id, title, original_title, media_type, category, year, release_date, tvshow_id,
      metadata_status, metadata_confidence, external_source, external_id
    FROM media WHERE metadata_status = 'matched' AND media_type IN ('movie', 'tv')
    ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset);
}

function createRequestMeter(client, limit, counters) {
  const original = client.client.get.bind(client.client);
  client.client.get = async (endpoint, options) => {
    if (counters.provider_requests >= limit) {
      const error = new Error("provider_request_budget_exhausted");
      error.code = "PROVIDER_REQUEST_BUDGET_EXHAUSTED";
      throw error;
    }
    counters.provider_requests += 1;
    if (String(endpoint).startsWith("/search/")) counters.search_requests += 1;
    else counters.detail_requests += 1;
    return original(endpoint, options);
  };
}

async function matchEntity(entity, provider, options, counters) {
  const candidates = buildEnrichmentCandidates(entity);
  const expectedTypes = inferExpectedTypes(entity.media, entity.files);
  if (!candidates.length) return { state: "NO_MATCH", reason_codes: ["NO_SAFE_QUERY_CANDIDATE"], candidates: [], expected_types: expectedTypes };
  if (!provider) return { state: "PENDING", reason_codes: ["PROVIDER_NOT_RUN"], candidates, expected_types: expectedTypes };

  const allMatches = [];
  try {
    for (const type of expectedTypes) {
      for (const candidate of candidates.slice(0, options.maxQueriesPerEntity)) {
        const results = await provider.search({ title: candidate.title, parsedYear: candidate.year }, type);
        counters.searched_entities += 1;
        const selection = selectStrictMetadataMatch({ candidates: [candidate], results, expectedType: type, thresholds: { auto: 0.9, ambiguous: 0.72 } });
        if (selection.best) allMatches.push({ ...selection, candidate, type });
      }
    }
    allMatches.sort((left, right) => (right.best?.score || 0) - (left.best?.score || 0));
    const selected = allMatches[0];
    if (!selected || selected.status === "NO_MATCH") {
      counters.no_match += 1;
      return { state: "NO_MATCH", reason_codes: selected?.reasonCodes || ["NO_ACCEPTABLE_PROVIDER_RESULT"], candidates, expected_types: expectedTypes };
    }
    if (selected.status === "AMBIGUOUS") {
      counters.ambiguous += 1;
      return { state: "AMBIGUOUS", reason_codes: selected.reasonCodes, candidates, expected_types: expectedTypes, best: { id: selected.best.result.id, score: selected.best.score, type: selected.type, title: selected.best.matchedTitle, year: selected.best.matchedYear } };
    }
    const details = await provider.details(selected.type, selected.best.result.id);
    counters.matched += 1;
    const quality = selected.best.titleExact && selected.best.yearScore === 1 ? "PROVEN" : "HIGH";
    return {
      state: "MATCHED",
      confidence: quality,
      confidence_score: selected.best.score,
      reason_codes: selected.reasonCodes,
      candidates,
      expected_types: expectedTypes,
      provider: "tmdb",
      external_id: String(selected.best.result.id),
      provider_media_type: selected.type,
      provider_title: selected.best.matchedTitle,
      provider_year: selected.best.matchedYear,
      evidence_digest: buildEvidenceDigest(selected.candidate, selected.best),
      taxonomy: providerTaxonomy(details || {}, selected.type),
    };
  } catch (error) {
    if (error.code === "PROVIDER_REQUEST_BUDGET_EXHAUSTED") throw error;
    const temporary = isTemporaryError(error);
    counters[temporary ? "retry_later" : "failed"] += 1;
    return { state: temporary ? "RETRY_LATER" : "FAILED", reason_codes: [temporary ? "RETRYABLE_PROVIDER_ERROR" : "PROVIDER_ERROR"], candidates, expected_types: expectedTypes, error_code: error.code || "provider_error" };
  }
}

function groundTruthResult(media) {
  return {
    id: String(media.external_id),
    title: media.title,
    name: media.title,
    original_title: media.original_title,
    original_name: media.original_title,
    release_date: media.media_type === "movie" ? media.release_date : undefined,
    first_air_date: media.media_type === "tv" ? media.release_date : undefined,
    popularity: 1,
  };
}

function retrospectiveEntity(entity) {
  const candidates = buildEnrichmentCandidates(entity);
  const truth = groundTruthResult(entity.media);
  const type = entity.media.media_type;
  const selections = candidates.map((candidate) => ({ candidate, selection: selectStrictMetadataMatch({ candidates: [candidate], results: [truth], expectedType: type, thresholds: { auto: 0.9, ambiguous: 0.72 } }) }));
  const selected = selections.find((item) => item.selection.status === "MATCHED") || selections.find((item) => item.selection.status === "AMBIGUOUS") || selections[0];
  const fallback = entity.files.length === 0 && candidates.some((candidate) => candidate.source === "media_title");
  return {
    media_id: entity.media.id,
    media_type: type,
    external_id_hidden: true,
    candidate_count: candidates.length,
    candidate_sources: candidates.map((candidate) => candidate.source),
    state: selected?.selection.status || "NO_MATCH",
    correct_identity: selected?.selection.best?.result?.id === String(entity.media.external_id),
    fallback_to_media_title: fallback,
    score: selected?.selection.best?.score || null,
  };
}

async function runMetadataEnrichmentAudit(options, dependencies = {}) {
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const databasePath = path.resolve(options.database);
  const resume = loadResume(outputDir, options, databasePath);
  const effectiveOffset = resume.offset;
  const database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  const rows = options.mode === "retrospective"
    ? selectMatchedRows(database, options.limit, effectiveOffset)
    : selectUnknownRows(database, options.limit, effectiveOffset);
  const entities = buildEntityQueries(database, rows, rows.map((row) => row.id));
  const counters = {
    entities: entities.length, provider_requests: 0, search_requests: 0, detail_requests: 0,
    cache_hits: 0, searched_entities: 0, matched: 0, no_match: 0, ambiguous: 0, retry_later: 0, failed: 0,
  };
  const results = [];
  if (options.mode === "retrospective") {
    for (const entity of entities) results.push(retrospectiveEntity(entity));
  } else {
    let provider = dependencies.provider || null;
    if (options.mode === "provider-sample") {
      const config = dependencies.config || getCatalogConfig();
      if (!config.tmdbApiKey) throw new Error("TMDB_API_KEY_REQUIRED_FOR_PROVIDER_SAMPLE");
      const cache = dependencies.cache || createMetadataFileCache({ root: path.join(outputDir, "cache"), provider: "tmdb", version: MATCH_POLICY_VERSION, ttlDays: 30 });
      provider = provider || new TmdbClient(config, null, { warn() {} }, { cacheStore: cache, onCacheHit: () => { counters.cache_hits += 1; } });
      createRequestMeter(provider, options.maxProviderRequests, counters);
    }
    for (const entity of entities) {
      const result = await matchEntity(entity, provider, options, counters);
      results.push({ media_id: entity.media.id, title: entity.media.title, active: Boolean(entity.media.is_active), file_count: entity.files.length, ...result });
      if (counters.provider_requests >= options.maxProviderRequests && options.mode === "provider-sample") break;
    }
  }
  database.close();
  const allResults = [...resume.previousResults, ...results];
  const byState = {};
  const byConfidence = {};
  for (const result of allResults) {
    byState[result.state] = (byState[result.state] || 0) + 1;
    if (result.confidence) byConfidence[result.confidence] = (byConfidence[result.confidence] || 0) + 1;
  }
  const core = {
    schema_version: 1,
    audit_version: AUDIT_VERSION,
    match_policy_version: MATCH_POLICY_VERSION,
    mode: options.mode,
    provider: options.provider,
    database_read_only: true,
    sqlite_write_performed: false,
    provider_credentials_persisted: false,
    scope: { limit: options.limit, offset: effectiveOffset, start_offset: options.resume ? (JSON.parse(fs.readFileSync(path.join(outputDir, "checkpoint.json"), "utf8")).start_offset ?? options.offset) : options.offset },
    counters,
    state_counts: byState,
    confidence_counts: byConfidence,
    retrospective_top1_accuracy: options.mode === "retrospective" && allResults.length ? Number((allResults.filter((result) => result.correct_identity).length / allResults.length).toFixed(6)) : null,
    results: allResults,
  };
  const report = { ...core, deterministic_sha256: digest(core) };
  atomicJson(path.join(outputDir, "enrichment-results.json"), report);
  atomicJson(path.join(outputDir, "checkpoint.json"), { schema_version: 1, audit_version: AUDIT_VERSION, start_offset: options.resume ? JSON.parse(fs.readFileSync(path.join(outputDir, "checkpoint.json"), "utf8")).start_offset ?? options.offset : options.offset, input_digest: resume.inputDigest, next_offset: effectiveOffset + results.length, processed: results.length, processed_total: allResults.length, state_counts: byState, provider_requests: counters.provider_requests, sqlite_write_performed: false, finished_reason: results.length < options.limit ? "completed" : "limit_reached" });
  atomicJson(path.join(outputDir, "audit.manifest.json"), { schema_version: 1, audit_version: AUDIT_VERSION, match_policy_version: MATCH_POLICY_VERSION, deterministic_sha256: report.deterministic_sha256, provider_requests: counters.provider_requests, sqlite_write_performed: false, database_read_only: true, results: allResults.length, resumable: true });
  fs.writeFileSync(path.join(outputDir, "audit.log"), "metadata enrichment audit; SQLite writes: 0; credentials persisted: 0\n", { encoding: "utf8", mode: 0o600 });
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runMetadataEnrichmentAudit(options);
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(safeErrorMessage(error)); process.exitCode = 1; });

module.exports = {
  AUDIT_VERSION,
  MATCH_POLICY_VERSION,
  STATES,
  buildEntityQueries,
  matchEntity,
  parseArguments,
  retrospectiveEntity,
  safeErrorMessage,
  runMetadataEnrichmentAudit,
};
