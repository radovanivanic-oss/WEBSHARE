const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildOverviewEligibility,
  buildEligibilityRecord,
  deterministicPlanDigest,
  evaluateProviderMetadata,
  isTrustedProviderIdentity,
  selectDeterministicSample,
} = require("../lib/classified-metadata-backfill");
const { TmdbClient } = require("../providers/tmdb-client");
const { createMetadataFileCache } = require("../lib/metadata-file-cache");
const { getCatalogConfig } = require("../src/config/catalog-config");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { apply: applyBackfill, digest: backfillDigest } = require("../scripts/apply-classified-metadata-backfill");

function row(extra = {}) {
  return {
    id: 4576, title: "Enola Holmes 3", original_title: "Enola Holmes 3", year: 2026,
    media_type: "movie", category: "movies", external_source: "tmdb", external_id: "1202033",
    provider_id: "1202033",
    metadata_status: "matched", metadata_confidence: 0.98, overview: null, poster_url: "poster",
    backdrop_url: "backdrop", genres_json: JSON.stringify([{ id: 12, name: "Adventure" }]),
    release_date: "2026-06-30", is_active: 1, ...extra,
  };
}

test("trusted identity and overview eligibility are fail-closed", () => {
  assert.equal(isTrustedProviderIdentity(row()), true);
  assert.equal(buildOverviewEligibility(row())?.provider_id, "1202033");
  assert.equal(buildOverviewEligibility(row({ metadata_confidence: 0.79 })), null);
  assert.equal(buildOverviewEligibility(row({ metadata_status: "local" })), null);
  assert.equal(buildOverviewEligibility(row({ overview: "Existing description" })), null);
  assert.equal(buildEligibilityRecord(row({ external_source: null, external_id: null })), null);
});

test("exact provider metadata fills only missing fields", () => {
  const result = evaluateProviderMetadata(row(), {
    id: 1202033, title: "Enola Holmes 3", original_title: "Enola Holmes 3",
    release_date: "2026-06-30", overview: "A sufficiently long provider description.",
    poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg",
    genres: [{ id: 12, name: "Adventure" }],
  }, "en-US");
  assert.equal(result.state, "READY");
  assert.deepEqual(result.fields_to_fill, ["overview"]);
  assert.equal(result.selected_language, "en-US");
  assert.ok(result.overview_digest);
  assert.equal(result.poster_url, null);
});

test("overview eligibility preserves the source row for fill-missing-only evaluation", () => {
  const eligible = buildOverviewEligibility(row());
  const result = evaluateProviderMetadata(eligible._sourceRow, {
    id: 1202033, title: "Enola Holmes 3", original_title: "Enola Holmes 3",
    release_date: "2026-06-30", overview: "A sufficiently long provider description.",
    poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg", genres: [{ id: 12, name: "Adventure" }],
  }, "en-US");
  assert.deepEqual(result.fields_to_fill, ["overview"]);
});

test("provider type, ID, year, and title conflicts are rejected", () => {
  const result = evaluateProviderMetadata(row(), { id: 99, name: "Different Show", first_air_date: "2010-01-01" }, "en-US");
  assert.equal(result.state, "CONFLICTING");
  assert.ok(result.issues.includes("PROVIDER_ID_MISMATCH"));
  assert.ok(result.issues.includes("PROVIDER_TYPE_OR_SHAPE_CONFLICT"));
});

test("sample selection and plan digest are deterministic", () => {
  const records = [row({ id: 3, title: "Latin" }), row({ id: 2, title: "결혼의 완성", media_type: "tv", category: "series" }), row({ id: 1, title: "嫁入高门" })];
  assert.deepEqual(selectDeterministicSample(records, 3).map((item) => item.id), selectDeterministicSample([...records].reverse(), 3).map((item) => item.id));
  assert.equal(deterministicPlanDigest(records), deterministicPlanDigest([...records].reverse()));
});

test("exact-ID client uses the isolated cache and reports selected language", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-b41-cache-"));
  try {
    const cache = createMetadataFileCache({ root: directory, provider: "tmdb", version: "B41-test-v1", ttlDays: 1 });
    const config = getCatalogConfig({ TMDB_API_KEY: "fixture", TMDB_LANGUAGE: "sk-SK", TMDB_FALLBACK_LANGUAGES: "cs-CZ,en-US", TMDB_REQUEST_DELAY_MS: "0" });
    const client = new TmdbClient(config, null, { warn() {} }, { cacheStore: cache, minRequestIntervalMs: 0 });
    let calls = 0;
    client.client.get = async (_endpoint, request) => {
      calls += 1;
      return { status: 200, data: { id: 1202033, title: "Enola Holmes 3", original_title: "Enola Holmes 3", release_date: "2026-06-30", overview: request.params.language === "en-US" ? "English provider overview." : "" } };
    };
    const first = await client.detailsExact("movie", "1202033");
    const second = await client.detailsExact("movie", "1202033");
    assert.equal(first.selectedLanguage, "en-US");
    assert.equal(second.selectedLanguage, "en-US");
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("controlled metadata apply writes only reviewed missing fields and preserves catalog counts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-b42-apply-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const planPath = path.join(directory, "plan.json");
  const valuesPath = path.join(directory, "values.json");
  const backupPath = path.join(directory, "backup.sqlite");
  try {
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE media (
        id INTEGER PRIMARY KEY, media_type TEXT, category TEXT, external_source TEXT, external_id TEXT,
        metadata_status TEXT, metadata_confidence REAL, overview TEXT, poster_url TEXT, backdrop_url TEXT,
        genres_json TEXT, release_date TEXT, original_title TEXT, metadata_language TEXT,
        metadata_updated_at TEXT, updated_at TEXT, is_active INTEGER
      );
      CREATE TABLE files (id INTEGER PRIMARY KEY, is_active INTEGER, is_playable_video INTEGER, media_id INTEGER);
      INSERT INTO media VALUES (1,'movie','movies','tmdb','10','matched',0.99,NULL,'poster','backdrop','[]','2020-01-01','Title',NULL,NULL,'before',1);
      INSERT INTO files VALUES (1,1,1,1);
    `);
    db.close();
    const records = [{ media_id: 1, provider: "tmdb", provider_id: "10", media_type: "movie", category: "movies", fields_to_fill: ["overview"], policy_version: "test" }];
    const values = [{ media_id: 1, fields_to_fill: ["overview"], overview: "Provider description", poster_url: null, backdrop_url: null, genres: [], release_date: null, original_title: null, selected_overview_language: "en-US" }];
    fs.writeFileSync(planPath, JSON.stringify({ records, deterministic_sha256: backfillDigest(records) }));
    fs.writeFileSync(valuesPath, JSON.stringify({ records: values, deterministic_sha256: backfillDigest(values) }));
    await applyBackfill({ database: databasePath, plan: planPath, values: valuesPath, expectedPlanSha256: backfillDigest(records), expectedValuesSha256: backfillDigest(values), backup: backupPath, outputDir: path.join(directory, "evidence"), apply: true });
    const after = new Database(databasePath, { readonly: true });
    assert.equal(after.prepare("SELECT overview FROM media WHERE id=1").get().overview, "Provider description");
    assert.equal(after.prepare("SELECT COUNT(*) n FROM media").get().n, 1);
    assert.equal(after.prepare("SELECT COUNT(*) n FROM files").get().n, 1);
    after.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
