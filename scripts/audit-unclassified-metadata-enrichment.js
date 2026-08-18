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
  const options = { mode: "candidate-audit", limit: 100, offset: 0, maxProviderRequests: 0, provider: "tmdb", dryRun: false, maxQueriesPerEntity: 2, activeOnly: false, stratified: false };
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
    else if (value === "--active-only") options.activeOnly = true;
    else if (value === "--stratified") options.stratified = true;
    else if (value === "--cache-dir") options.cacheDir = argv[++index];
    else if (value === "--max-queries-per-entity") options.maxQueriesPerEntity = Number.parseInt(argv[++index], 10);
    else throw new Error(`Neplatný argument ${value}.`);
  }
  if (!options.database || !options.outputDir) throw new Error("Vyžaduje sa --database a --output-dir.");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 5000) throw new Error("limit musí byť 1..5000.");
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("offset musí byť nezáporné celé číslo.");
  if (!Number.isSafeInteger(options.maxQueriesPerEntity) || options.maxQueriesPerEntity < 1 || options.maxQueriesPerEntity > 3) throw new Error("max-queries-per-entity musí byť 1..3.");
  if (!new Set(["candidate-audit", "retrospective", "control", "provider-sample"]).has(options.mode)) throw new Error("nepodporovaný mode.");
  if (["control", "provider-sample"].includes(options.mode) && (!options.dryRun || options.provider !== "tmdb" || !Number.isSafeInteger(options.maxProviderRequests) || options.maxProviderRequests < 1 || options.maxProviderRequests > 10000)) {
    throw new Error("live mode vyžaduje --dry-run, --provider tmdb a provider request budget 1..10000.");
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

function selectActiveUnknownRows(database, limit, offset) {
  return database.prepare(`
    SELECT id, title, original_title, media_type, category, year, tvshow_id, metadata_status,
      metadata_confidence, external_source, external_id, genres_json, countries_json, languages_json, is_active
    FROM media WHERE category = 'unknown' AND is_active = 1 ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset);
}

function selectUnknownRowsByIds(database, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database.prepare(`
    SELECT id, title, original_title, media_type, category, year, tvshow_id, metadata_status,
      metadata_confidence, external_source, external_id, genres_json, countries_json, languages_json, is_active
    FROM media WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
}

function selectStratifiedUnknownRows(database, limit) {
  const bucketLimit = Math.max(1, Math.ceil(limit / 5));
  const spreadOrder = "((CAST(m.id AS INTEGER) * 1103515245 + 12345) % 2147483647), m.id";
  const queries = [
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND (SELECT COUNT(*) FROM files f WHERE f.media_id = m.id) = 1 ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND (SELECT COUNT(*) FROM files f WHERE f.media_id = m.id) > 1 ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND m.year IS NOT NULL ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND m.year IS NULL ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT DISTINCT m.id FROM media m JOIN files f ON f.media_id = m.id WHERE m.category = 'unknown' AND m.is_active = 1 AND (f.parsed_season IS NOT NULL OR f.parsed_episode IS NOT NULL) ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND (m.title GLOB '*[一-龥]*' OR m.title GLOB '*[ぁ-ん]*' OR m.title GLOB '*[가-힣]*' OR m.title GLOB '*[А-я]*') ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND lower(COALESCE(m.title, '')) LIKE '%document%' ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND lower(COALESCE(m.title, '')) LIKE '%anime%' ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND lower(COALESCE(m.title, '')) LIKE '%concert%' ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 AND length(COALESCE(m.title, '')) BETWEEN 4 AND 120 AND m.title NOT GLOB '*[0-9]*' AND lower(COALESCE(m.title, '')) NOT LIKE '%anime%' AND lower(COALESCE(m.title, '')) NOT LIKE '%amv%' AND lower(COALESCE(m.title, '')) NOT LIKE '%concert%' AND lower(COALESCE(m.title, '')) NOT LIKE '%episode%' ORDER BY ${spreadOrder} LIMIT ?`,
    `SELECT m.id FROM media m WHERE m.category = 'unknown' AND m.is_active = 1 ORDER BY ${spreadOrder} LIMIT ?`,
  ];
  const buckets = queries.map((query) => database.prepare(query).all(bucketLimit).map((row) => row.id));
  const ids = new Set();
  for (let index = 0; ids.size < limit; index += 1) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[index] !== undefined) {
        ids.add(bucket[index]);
        added = true;
        if (ids.size >= limit) break;
      }
    }
    if (!added) break;
  }
  return selectUnknownRowsByIds(database, [...ids]);
}

function selectControlRows(database, limit, offset = 0) {
  const perType = Math.max(1, Math.floor(limit / 2));
  const typeOffset = Math.max(0, Math.floor(offset / 2));
  const select = (type) => database.prepare(`
    SELECT id, title, original_title, media_type, category, year, release_date, tvshow_id,
      metadata_status, metadata_confidence, external_source, external_id,
      genres_json, countries_json, languages_json, is_active
    FROM media WHERE metadata_status = 'matched' AND media_type = ? AND external_source = 'tmdb'
    ORDER BY id LIMIT ? OFFSET ?`).all(type, perType, typeOffset);
  return [...select("movie"), ...select("tv")].sort((left, right) => left.id - right.id).slice(0, limit);
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
  const startedAt = Date.now();
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const databasePath = path.resolve(options.database);
  const resume = loadResume(outputDir, options, databasePath);
  const effectiveOffset = resume.offset;
  const database = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  const rows = options.mode === "retrospective"
    ? selectMatchedRows(database, options.limit, effectiveOffset)
    : options.mode === "control"
      ? selectControlRows(database, options.limit, effectiveOffset)
      : options.stratified
        ? selectStratifiedUnknownRows(database, options.limit)
        : options.activeOnly
          ? selectActiveUnknownRows(database, options.limit, effectiveOffset)
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
    if (["control", "provider-sample"].includes(options.mode)) {
      const config = dependencies.config || getCatalogConfig();
      if (!config.tmdbApiKey) throw new Error("TMDB_API_KEY_REQUIRED_FOR_PROVIDER_SAMPLE");
      const cache = dependencies.cache || createMetadataFileCache({ root: options.cacheDir || path.join(outputDir, "cache"), provider: "tmdb", version: MATCH_POLICY_VERSION, ttlDays: 30 });
      provider = provider || new TmdbClient(config, null, { warn() {} }, {
        cacheStore: cache,
        onCacheHit: () => { counters.cache_hits += 1; },
        minRequestIntervalMs: Math.ceil(60000 / config.tmdbLiveRateLimitPerMinute),
      });
      createRequestMeter(provider, options.maxProviderRequests, counters);
    }
    for (const entity of entities) {
      const result = await matchEntity(entity, provider, options, counters);
      const control = options.mode === "control" ? {
        expected_identity_hidden: true,
        correct_identity: result.state === "MATCHED" && String(result.external_id) === String(entity.media.external_id),
        correct_type: result.state === "MATCHED" && result.provider_media_type === entity.media.media_type,
      } : {};
      results.push({ media_id: entity.media.id, title: entity.media.title, active: Boolean(entity.media.is_active), file_count: entity.files.length, media_type: entity.media.media_type, ...result, ...control });
      if (counters.provider_requests >= options.maxProviderRequests && ["control", "provider-sample"].includes(options.mode)) break;
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
    retrospective_top1_accuracy: ["retrospective", "control"].includes(options.mode) && allResults.length ? Number((allResults.filter((result) => result.correct_identity).length / allResults.length).toFixed(6)) : null,
    control_metrics: options.mode === "control" ? {
      correct_identity: allResults.filter((result) => result.correct_identity).length,
      wrong_identity: allResults.filter((result) => result.state === "MATCHED" && !result.correct_identity).length,
      correct_type: allResults.filter((result) => result.correct_type).length,
      wrong_type: allResults.filter((result) => result.state === "MATCHED" && !result.correct_type).length,
    } : null,
    sample_id_digest: digest(allResults.map((result) => result.media_id)),
    results: allResults,
  };
  const report = { ...core, runtime_ms: Date.now() - startedAt, deterministic_sha256: digest(core) };
  const migrationCandidates = allResults
    .filter((result) => result.state === "MATCHED" && ["PROVEN", "HIGH"].includes(result.confidence))
    .map((result) => ({
      media_id: result.media_id,
      current_category: "unknown",
      proposed_category: result.taxonomy?.primaryType || null,
      secondary_tags: result.taxonomy?.secondaryTags || [],
      confidence: result.confidence,
      confidence_score: result.confidence_score,
      reason_codes: result.reason_codes || [],
      evidence_digest: result.evidence_digest,
      file_count: result.file_count,
      active: result.active,
      provider: result.provider,
      external_id: result.external_id,
      provider_media_type: result.provider_media_type,
      policy_version: MATCH_POLICY_VERSION,
    }));
  const reasonDistribution = {};
  for (const result of allResults) for (const reason of result.reason_codes || []) reasonDistribution[reason] = (reasonDistribution[reason] || 0) + 1;
  const categoryProposals = {};
  for (const candidate of migrationCandidates) {
    categoryProposals[candidate.proposed_category] = (categoryProposals[candidate.proposed_category] || 0) + 1;
    for (const tag of candidate.secondary_tags) categoryProposals[tag] = (categoryProposals[tag] || 0) + 1;
  }
  atomicJson(path.join(outputDir, "classification-summary.json"), { audit_version: AUDIT_VERSION, policy_version: MATCH_POLICY_VERSION, mode: options.mode, entities: allResults.length, state_counts: byState, confidence_counts: byConfidence, sqlite_write_performed: false });
  atomicJson(path.join(outputDir, "reason-distribution.json"), reasonDistribution);
  atomicJson(path.join(outputDir, "confidence-distribution.json"), byConfidence);
  atomicJson(path.join(outputDir, "category-proposals.json"), categoryProposals);
  atomicJson(path.join(outputDir, "conflicts.json"), allResults.filter((result) => ["AMBIGUOUS", "RETRY_LATER", "FAILED"].includes(result.state)).slice(0, 200));
  atomicJson(path.join(outputDir, "ambiguous-samples.json"), allResults.filter((result) => result.state === "AMBIGUOUS").slice(0, 200));
  atomicJson(path.join(outputDir, "migration-candidates.json"), { schema_version: 1, policy_version: MATCH_POLICY_VERSION, sqlite_write_performed: false, candidate_count: migrationCandidates.length, plan_sha256: digest(migrationCandidates), candidates: migrationCandidates });
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
