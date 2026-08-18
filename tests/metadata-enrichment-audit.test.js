const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const Database = require("better-sqlite3");
const {
  buildEnrichmentCandidates,
  inferExpectedTypes,
  normalizeMatchText,
  providerTaxonomy,
  selectStrictMetadataMatch,
} = require("../lib/metadata-enrichment");
const { createMetadataFileCache } = require("../lib/metadata-file-cache");
const { TmdbClient } = require("../providers/tmdb-client");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { runMetadataEnrichmentAudit } = require("../scripts/audit-unclassified-metadata-enrichment");
const { matchEntity } = require("../scripts/audit-unclassified-metadata-enrichment");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-b37-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureDatabase(directory) {
  const databasePath = path.join(directory, "catalog.sqlite");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE media (
      id INTEGER PRIMARY KEY, title TEXT, original_title TEXT, media_type TEXT,
      category TEXT, year INTEGER, release_date TEXT, tvshow_id INTEGER,
      metadata_status TEXT, metadata_confidence REAL, external_source TEXT,
      external_id TEXT, genres_json TEXT, countries_json TEXT, languages_json TEXT,
      is_active INTEGER
    );
    CREATE TABLE files (
      id INTEGER PRIMARY KEY, media_id INTEGER, original_name TEXT,
      parsed_title TEXT, parsed_year INTEGER, parsed_season INTEGER,
      parsed_episode INTEGER, is_active INTEGER, is_playable_video INTEGER
    );
    CREATE TABLE media_aliases (
      id INTEGER PRIMARY KEY, media_id INTEGER, alias TEXT,
      language TEXT, source TEXT
    );
  `);
  database.prepare(`INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    1, "Mystery Show", "Mystery Show", "tv", "unknown", 2024, null, null,
    "unmatched", null, null, null, null, null, null, 1,
  );
  database.prepare(`INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    2, "Movie 2020", "Movie 2020", null, "unknown", 2020, null, null,
    "unmatched", null, null, null, null, null, null, 1,
  );
  database.prepare(`INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    3, "Known Film", "Known Film", "movie", "movies", 2020, "2020-01-01", null,
    "matched", 0.95, "tmdb", "123", null, null, null, 1,
  );
  database.prepare(`INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, 1, "Mystery.Show.S01E01.2024.mkv", "Mystery Show", 2024, 1, 1, 1, 1);
  database.prepare(`INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(2, 1, "Mystery.Show.S01E02.2024.mkv", "Mystery Show", 2024, 1, 2, 1, 1);
  database.close();
  return databasePath;
}

test("metadata candidate normalization preserves native scripts and strips release tokens", () => {
  assert.equal(normalizeMatchText("결혼의 완성.S01E01.1080p.WEB-DL.mkv"), "결혼의 완성");
  assert.equal(normalizeMatchText("嫁入高门 (2024)"), "嫁入高门");
  const candidates = buildEnrichmentCandidates({
    media: { title: "결혼의 완성", original_title: "결혼의 완성", year: 2024 },
    files: [{ original_name: "결혼의 완성.S01E01.1080p.mkv", parsed_title: "결혼의 완성", parsed_year: 2024, parsed_season: 1, parsed_episode: 1 }],
  });
  assert.equal(candidates[0].title, "결혼의 완성");
  assert.deepEqual(inferExpectedTypes({ media_type: null }, [{ original_name: "Show.S01E01.mkv" }]), ["tv"]);
});

test("strict matching rejects wrong years, incompatible types, and close candidates", () => {
  const candidate = { title: "The Office", year: 2005, source: "media_title" };
  const accepted = selectStrictMetadataMatch({
    candidates: [candidate],
    expectedType: "tv",
    results: [{ id: 1, name: "The Office", original_name: "The Office", first_air_date: "2005-03-24", popularity: 10 }],
  });
  assert.equal(accepted.status, "MATCHED");
  const wrongYear = selectStrictMetadataMatch({
    candidates: [candidate],
    expectedType: "tv",
    results: [{ id: 2, name: "The Office", first_air_date: "2019-01-01", popularity: 10 }],
  });
  assert.equal(wrongYear.status, "NO_MATCH");
  const close = selectStrictMetadataMatch({
    candidates: [{ title: "Dune", year: 2021, source: "media_title" }],
    expectedType: "movie",
    results: [
      { id: 3, title: "Dune", release_date: "2021-01-01", popularity: 1 },
      { id: 4, title: "Dune", release_date: "2021-01-01", popularity: 1 },
    ],
  });
  assert.equal(close.status, "AMBIGUOUS");
});

test("matching fixtures cover localized/original titles, remakes, type conflicts, and Unicode", () => {
  const cases = [
    { name: "exact movie", candidate: { title: "Inception", year: 2010 }, type: "movie", result: { id: 1, title: "Inception", original_title: "Inception", release_date: "2010-07-16" }, expected: "MATCHED" },
    { name: "exact series", candidate: { title: "Oasis", year: 2023 }, type: "tv", result: { id: 2, name: "Oasis", original_name: "Oasis", first_air_date: "2023-01-01" }, expected: "MATCHED" },
    { name: "localized alias", candidate: { title: "Počiatok", year: 2010 }, type: "movie", result: { id: 3, title: "Inception", original_title: "Inception", alternative_titles: [{ title: "Počiatok" }], release_date: "2010-07-16" }, expected: "MATCHED" },
    { name: "same title remake", candidate: { title: "The Ring", year: 2002 }, type: "movie", result: { id: 4, title: "The Ring", release_date: "1998-01-01" }, expected: "NO_MATCH" },
    { name: "movie versus tv", candidate: { title: "Fargo", year: 2014 }, type: "movie", result: { id: 5, name: "Fargo", first_air_date: "2014-01-01" }, expected: "AMBIGUOUS" },
    { name: "native Korean", candidate: { title: "결혼의 완성", year: 2024 }, type: "tv", result: { id: 6, name: "The Completion of Marriage", original_name: "결혼의 완성", first_air_date: "2024-01-01" }, expected: "MATCHED" },
    { name: "wrong year", candidate: { title: "Dune", year: 2021 }, type: "movie", result: { id: 7, title: "Dune", release_date: "1984-01-01" }, expected: "NO_MATCH" },
    { name: "no match", candidate: { title: "No Such Work", year: 2024 }, type: "movie", result: { id: 8, title: "Unrelated", release_date: "2024-01-01" }, expected: "NO_MATCH" },
  ];
  for (const item of cases) {
    const actual = selectStrictMetadataMatch({ candidates: [item.candidate], expectedType: item.type, results: [item.result] });
    assert.equal(actual.status, item.expected, item.name);
  }
});

test("provider taxonomy keeps documentary secondary and does not infer anime from animation", () => {
  assert.deepEqual(providerTaxonomy({ genres: [{ name: "Documentary" }], keywords: { results: [] } }, "movie"), {
    primaryType: "movies", secondaryTags: ["documentary"], reasonCodes: ["TRUSTED_DOCUMENTARY_GENRE"],
  });
  assert.deepEqual(providerTaxonomy({ genres: [{ name: "Animation" }], keywords: { results: [] } }, "tv").secondaryTags, []);
  assert.deepEqual(providerTaxonomy({ genres: [], keywords: { keywords: [{ name: "anime" }] } }, "tv").secondaryTags, ["anime"]);
});

test("file metadata cache is versioned, atomic, and does not persist credentials", (t) => {
  const directory = temporaryDirectory(t);
  const cache = createMetadataFileCache({ root: directory, provider: "tmdb", version: "test", ttlDays: 1 });
  cache.set("request", { results: [{ id: 1 }] }, { endpoint: "/search/tv", params: { query: "Show" } });
  assert.deepEqual(cache.get("request"), { results: [{ id: 1 }] });
  const payload = fs.readFileSync(fs.readdirSync(directory).map((file) => path.join(directory, file)).find((file) => file.endsWith(".json")), "utf8");
  assert.equal(payload.includes("api_key"), false);
  assert.equal(payload.includes("test-key"), false);
});

test("TMDb client can use the isolated file cache without a SQLite write path", async (t) => {
  const directory = temporaryDirectory(t);
  const cache = createMetadataFileCache({ root: directory, provider: "tmdb", version: "test", ttlDays: 1 });
  const config = getCatalogConfig({ TMDB_API_KEY: "test-key", TMDB_REQUEST_DELAY_MS: "0", TMDB_LANGUAGE: "en-US", TMDB_FALLBACK_LANGUAGES: "en-US" });
  const client = new TmdbClient(config, null, { warn() {} }, { cacheStore: cache });
  let calls = 0;
  client.client.get = async () => { calls += 1; return { status: 200, data: { results: [{ id: 10 }] } }; };
  assert.deepEqual(await client.search({ title: "Safe Show", parsedYear: 2024 }, "tv"), [{ id: 10 }]);
  assert.deepEqual(await client.search({ title: "Safe Show", parsedYear: 2024 }, "tv"), [{ id: 10 }]);
  assert.equal(calls, 1);
});

test("read-only candidate audit is deterministic, preserves SQLite, and resumes safely", async (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = fixtureDatabase(directory);
  const before = fs.readFileSync(databasePath);
  const firstDir = path.join(directory, "first");
  const secondDir = path.join(directory, "second");
  const options = { database: databasePath, outputDir: firstDir, limit: 2, offset: 0, maxProviderRequests: 0, provider: "tmdb", mode: "candidate-audit", dryRun: true, maxQueriesPerEntity: 2 };
  const first = await runMetadataEnrichmentAudit(options);
  const second = await runMetadataEnrichmentAudit({ ...options, outputDir: secondDir });
  assert.equal(first.deterministic_sha256, second.deterministic_sha256);
  assert.equal(first.sqlite_write_performed, false);
  assert.deepEqual(fs.readFileSync(databasePath), before);
  for (const artifact of ["classification-summary.json", "reason-distribution.json", "confidence-distribution.json", "category-proposals.json", "conflicts.json", "ambiguous-samples.json", "migration-candidates.json"]) assert.equal(fs.existsSync(path.join(firstDir, artifact)), true, artifact);
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstDir, "migration-candidates.json"), "utf8")).candidate_count, 0);
  const resumedDir = path.join(directory, "resumed");
  const partial = await runMetadataEnrichmentAudit({ ...options, outputDir: resumedDir, limit: 1 });
  assert.equal(partial.results.length, 1);
  const resumed = await runMetadataEnrichmentAudit({ ...options, outputDir: resumedDir, limit: 1, resume: true });
  assert.equal(resumed.results.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(resumedDir, "checkpoint.json"), "utf8")).processed_total, 2);
});

test("provider errors fail closed into retry state and never write SQLite", async () => {
  const counters = { provider_requests: 0, searched_entities: 0, matched: 0, no_match: 0, ambiguous: 0, retry_later: 0, failed: 0 };
  const provider = { search: async () => { const error = new Error("429"); error.response = { status: 429 }; throw error; } };
  const result = await matchEntity({ media: { title: "Safe Title", year: 2024, media_type: null }, files: [], aliases: [] }, provider, { maxQueriesPerEntity: 1 }, counters);
  assert.equal(result.state, "RETRY_LATER");
  assert.equal(counters.retry_later, 1);
});

test("control mode evaluates hidden persisted identities without using them as query input", async (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = fixtureDatabase(directory);
  const outputDir = path.join(directory, "control");
  const provider = {
    client: { get: async () => ({ status: 200, data: {} }) },
    search: async () => [{ id: 123, title: "Known Film", release_date: "2020-01-01" }],
    details: async () => ({ genres: [], keywords: [] }),
  };
  const report = await runMetadataEnrichmentAudit({
    database: databasePath, outputDir, limit: 2, offset: 0, maxProviderRequests: 5,
    provider: "tmdb", mode: "control", dryRun: true, maxQueriesPerEntity: 1,
  }, { provider, config: { tmdbApiKey: "fixture" } });
  assert.equal(report.control_metrics.correct_identity, 1);
  assert.equal(report.control_metrics.wrong_identity, 0);
  assert.equal(report.results[0].expected_identity_hidden, true);
  assert.equal(Object.hasOwn(report.results[0], "external_id"), true);
});
