#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { TmdbClient } = require("../providers/tmdb-client");
const { createMetadataFileCache } = require("../lib/metadata-file-cache");
const {
  POLICY_VERSION,
  buildEligibilityRecord,
  buildOverviewEligibility,
  deterministicPlanDigest,
  digest,
  evaluateProviderMetadata,
  isCanonicalRow,
  isTrustedProviderIdentity,
  selectDeterministicSample,
} = require("../lib/classified-metadata-backfill");
const { getCatalogConfig } = require("../src/config/catalog-config");

function parseArguments(argv) {
  const options = { database: null, outputDir: null, provider: "tmdb", limit: 200, offset: 0, maxProviderRequests: 500, mode: "candidate-audit", dryRun: false, cacheDir: null, resume: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--database") options.database = argv[++index];
    else if (value === "--output-dir") options.outputDir = argv[++index];
    else if (value === "--provider") options.provider = argv[++index] || "tmdb";
    else if (value === "--limit") options.limit = Number.parseInt(argv[++index], 10);
    else if (value === "--offset") options.offset = Number.parseInt(argv[++index], 10);
    else if (value === "--max-provider-requests") options.maxProviderRequests = Number.parseInt(argv[++index], 10);
    else if (value === "--mode") options.mode = argv[++index] || "candidate-audit";
    else if (value === "--cache-dir") options.cacheDir = argv[++index];
    else if (value === "--resume") options.resume = true;
    else if (value === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.database || !options.outputDir) throw new Error("--database and --output-dir are required");
  if (!options.dryRun) throw new Error("This tool is read-only; pass --dry-run explicitly");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 5000) throw new Error("invalid --limit");
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("invalid --offset");
  if (!Number.isSafeInteger(options.maxProviderRequests) || options.maxProviderRequests < 0) throw new Error("invalid --max-provider-requests");
  if (!["candidate-audit", "live-sample"].includes(options.mode)) throw new Error("invalid --mode");
  return options;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function canonicalRows(database) {
  return database.prepare(`
    SELECT id,title,original_title,year,media_type,category,external_source,external_id,
      metadata_status,metadata_confidence,overview,poster_url,backdrop_url,genres_json,
      release_date,is_active
    FROM media
    WHERE (media_type='movie' AND category='movies') OR (media_type='tv' AND category='series')
    ORDER BY id
  `).all();
}

function countFields(rows) {
  const counters = { total: rows.length, active: 0, trusted_provider: 0, overview_present: 0, overview_missing: 0, poster_present: 0, poster_missing: 0, backdrop_present: 0, backdrop_missing: 0, genres_present: 0, genres_missing: 0, release_date_present: 0, release_date_missing: 0, original_title_present: 0, original_title_missing: 0 };
  for (const row of rows) {
    if (row.is_active) counters.active += 1;
    if (isTrustedProviderIdentity(row)) counters.trusted_provider += 1;
    for (const [key, present] of [["overview", row.overview], ["poster", row.poster_url], ["backdrop", row.backdrop_url], ["release_date", row.release_date], ["original_title", row.original_title]]) counters[`${key}_${present && String(present).trim() ? "present" : "missing"}`] += 1;
    const genres = (() => { try { const parsed = JSON.parse(row.genres_json || "[]"); return Array.isArray(parsed) && parsed.length > 0; } catch { return false; } })();
    counters[`genres_${genres ? "present" : "missing"}`] += 1;
  }
  return counters;
}

function summarizeByDomain(rows) {
  return Object.fromEntries(["movie", "tv"].map((type) => [type, countFields(rows.filter((row) => row.media_type === type))]));
}

function loadProvider(options, config, outputDir) {
  if (options.provider !== "tmdb") throw new Error(`Unsupported provider: ${options.provider}`);
  if (!config.tmdbApiKey) throw new Error("TMDB_API_KEY is required for live-sample mode");
  const cache = createMetadataFileCache({ root: options.cacheDir || path.join(outputDir, "provider-cache"), provider: "tmdb", version: "B41-exact-id-v1", ttlDays: 30 });
  const counters = { provider_requests: 0, cache_hits: 0, retryable_errors: 0, not_found: 0, malformed: 0 };
  const client = new TmdbClient(config, null, { warn: (message, data) => { if (data?.status === 429) counters.retryable_errors += 1; } }, { cacheStore: cache, onAttempt: () => { counters.provider_requests += 1; }, onCacheHit: () => { counters.cache_hits += 1; }, minRequestIntervalMs: 2000 });
  return { client, counters, cache };
}

async function liveSample(records, options, outputDir) {
  const config = getCatalogConfig(process.env);
  const provider = loadProvider(options, config, outputDir);
  const selected = selectDeterministicSample(records, Math.min(options.limit, records.length)).slice(options.offset);
  const selectedDigest = digest(selected.map((record) => record.media_id));
  const configuration = { policy_version: POLICY_VERSION, selected_digest: selectedDigest, limit: options.limit, offset: options.offset, max_provider_requests: options.maxProviderRequests };
  const checkpointPath = path.join(outputDir, "live-sample-checkpoint.json");
  const partialPath = path.join(outputDir, "live-sample-results.partial.json");
  let results = [];
  let values = [];
  let nextIndex = 0;
  if (options.resume && fs.existsSync(checkpointPath)) {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (JSON.stringify(checkpoint.configuration) !== JSON.stringify(configuration)) throw new Error("live sample checkpoint configuration mismatch");
    const partial = JSON.parse(fs.readFileSync(partialPath, "utf8"));
    if (!Array.isArray(partial.results) || !Array.isArray(partial.values) || partial.results.length !== checkpoint.next_index || partial.values.length !== checkpoint.next_index) throw new Error("live sample checkpoint result mismatch");
    results = partial.results;
    values = partial.values;
    nextIndex = checkpoint.next_index;
  }
  for (let index = nextIndex; index < selected.length; index += 1) {
    const record = selected[index];
    if (provider.counters.provider_requests >= options.maxProviderRequests) break;
    try {
      const exact = await provider.client.detailsExact(record.media_type, record.provider_id);
      const evaluation = evaluateProviderMetadata(record, exact.details, exact.selectedLanguage);
      results.push({ ...record, state: evaluation.state, fields_to_fill: evaluation.fields_to_fill, selected_language: evaluation.selected_language, overview_digest: evaluation.overview_digest, overview_length: evaluation.overview ? evaluation.overview.length : 0, provider_year: evaluation.provider_year, issues: evaluation.issues, languages_tried: exact.languagesTried, provider_id_verified: String(exact.details?.id || "") === record.provider_id });
      values.push({ media_id: record.media_id, fields_to_fill: evaluation.fields_to_fill, overview: evaluation.overview, poster_url: evaluation.poster_url, backdrop_url: evaluation.backdrop_url, genres: evaluation.genres, release_date: evaluation.release_date, original_title: evaluation.original_title, selected_overview_language: evaluation.selected_language });
    } catch (error) {
      const notFound = Number(error?.response?.status) === 404;
      results.push({ ...record, state: notFound ? "NO_PROVIDER_METADATA" : "RETRY_LATER", fields_to_fill: [], selected_language: null, overview_digest: null, overview_length: 0, provider_year: null, issues: [notFound ? "PROVIDER_RECORD_NOT_FOUND" : (error.code || error.message)], languages_tried: [], provider_id_verified: false });
      values.push({ media_id: record.media_id, fields_to_fill: [], overview: null, poster_url: null, backdrop_url: null, genres: [], release_date: null, original_title: null, selected_overview_language: null });
    }
    writeJson(partialPath, { schema_version: 1, policy_version: POLICY_VERSION, configuration, results, values });
    writeJson(checkpointPath, { schema_version: 1, policy_version: POLICY_VERSION, configuration, next_index: index + 1, provider_requests: provider.counters.provider_requests, cache_hits: provider.counters.cache_hits });
  }
    const migrationPlan = results.filter((item) => item.state === "READY" && item.fields_to_fill.length > 0).map((item) => ({
      media_id: item.media_id,
      provider: item.provider,
      provider_id: item.provider_id,
      media_type: item.media_type,
      category: item.category,
      active: item.active,
      fields_to_fill: item.fields_to_fill,
      selected_overview_language: item.selected_language,
      overview_digest: item.overview_digest,
      evidence_digest: digest({ policy_version: POLICY_VERSION, media_id: item.media_id, provider: item.provider, provider_id: item.provider_id, fields_to_fill: item.fields_to_fill, selected_language: item.selected_language, overview_digest: item.overview_digest }),
      policy_version: POLICY_VERSION,
    })).sort((a, b) => a.media_id - b.media_id);
  writeJson(path.join(outputDir, "metadata-migration-plan.json"), { schema_version: 1, policy_version: POLICY_VERSION, provider: options.provider, source: "bounded-live-sample", candidate_count: migrationPlan.length, records: migrationPlan, deterministic_sha256: digest(migrationPlan) });
  const selectedValues = values.filter((value) => value.fields_to_fill.length > 0).sort((a, b) => a.media_id - b.media_id);
  writeJson(path.join(outputDir, "metadata-values.json"), { schema_version: 1, policy_version: POLICY_VERSION, provider: options.provider, records: selectedValues, deterministic_sha256: digest(selectedValues) });
  const summary = {
    sample_size: selected.length,
    processed: results.length,
    stopped_by_request_budget: results.length < selected.length,
    states: Object.fromEntries([...new Set(results.map((item) => item.state))].sort().map((state) => [state, results.filter((item) => item.state === state).length])),
    fields: Object.fromEntries(["overview", "poster", "backdrop", "genres", "release_date", "original_title"].map((field) => [field, results.filter((item) => item.fields_to_fill.includes(field)).length])),
    languages: Object.fromEntries([...new Set(results.map((item) => item.selected_language).filter(Boolean))].sort().map((language) => [language, results.filter((item) => item.selected_language === language).length])),
    wrong_provider_identity: results.filter((item) => item.provider_id_verified === false && !["RETRY_LATER", "NO_PROVIDER_METADATA"].includes(item.state)).length,
    provider: provider.counters,
    configuration,
    sample_digest: digest(results.map((item) => ({ media_id: item.media_id, state: item.state, fields_to_fill: item.fields_to_fill, selected_language: item.selected_language, overview_digest: item.overview_digest, issues: item.issues })).sort((a, b) => a.media_id - b.media_id)),
    migration_plan_count: migrationPlan.length,
    migration_plan_sha256: digest(migrationPlan),
    metadata_values_count: selectedValues.length,
    metadata_values_sha256: digest(selectedValues),
  };
  writeJson(path.join(outputDir, "live-sample-results.json"), results);
  writeJson(path.join(outputDir, "live-sample-summary.json"), summary);
  return { summary, results };
}

async function run(options) {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const database = new Database(path.resolve(options.database), { readonly: true, fileMustExist: true });
  try {
    const rows = canonicalRows(database);
    const domains = summarizeByDomain(rows);
    const overviewEligible = rows.map(buildOverviewEligibility).filter(Boolean);
    const allEligible = rows.map(buildEligibilityRecord).filter(Boolean);
    const plan = { schema_version: 1, policy_version: POLICY_VERSION, provider: options.provider, database_read_only: true, candidate_count: allEligible.length, overview_candidate_count: overviewEligible.length, records: allEligible };
    const summary = { schema_version: 1, policy_version: POLICY_VERSION, provider: options.provider, sqlite_write_performed: false, domains, canonical_entities: rows.length, active_canonical_entities: rows.filter((row) => row.is_active).length, eligible_for_any_missing_field: allEligible.length, eligible_for_any_missing_field_active: allEligible.filter((row) => row.active).length, eligible_missing_overview: overviewEligible.length, eligible_missing_overview_active: overviewEligible.filter((row) => row.active).length, eligible_missing_overview_by_domain: Object.fromEntries(["movie", "tv"].map((type) => [type, overviewEligible.filter((row) => row.media_type === type).length])), eligible_missing_overview_active_by_domain: Object.fromEntries(["movie", "tv"].map((type) => [type, overviewEligible.filter((row) => row.media_type === type && row.active).length])), overview_missing_without_trusted_provider_by_domain: Object.fromEntries(["movie", "tv"].map((type) => [type, rows.filter((row) => row.media_type === type && !String(row.overview || "").trim() && !isTrustedProviderIdentity(row)).length])), deterministic_plan_sha256: deterministicPlanDigest(allEligible), overview_plan_sha256: deterministicPlanDigest(overviewEligible), selected_mode: options.mode, dry_run: true };
    writeJson(path.join(options.outputDir, "candidate-plan.json"), plan);
    writeJson(path.join(options.outputDir, "audit-summary.json"), summary);
    writeJson(path.join(options.outputDir, "audit-manifest.json"), { policy_version: POLICY_VERSION, candidate_plan_sha256: summary.deterministic_plan_sha256, overview_plan_sha256: summary.overview_plan_sha256, generated_at: new Date().toISOString(), sqlite_write_performed: false });
    if (options.mode === "live-sample") {
      if (!process.env.TMDB_API_KEY) throw new Error("TMDB_API_KEY is required for live-sample mode");
      await liveSample(overviewEligible, options, options.outputDir);
    }
    return summary;
  } finally { database.close(); }
}

if (require.main === module) run(parseArguments(process.argv.slice(2))).then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { canonicalRows, countFields, liveSample, parseArguments, run, summarizeByDomain };
