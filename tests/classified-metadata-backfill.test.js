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
