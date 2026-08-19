"use strict";

const crypto = require("crypto");
const { normalizeMatchText } = require("./metadata-enrichment");

const POLICY_VERSION = "B41-classified-metadata-backfill-v1";
const TRUSTED_MIN_CONFIDENCE = 0.8;
const DOMAIN_ORDER = Object.freeze(["movie", "tv"]);

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTrustedProviderIdentity(row) {
  return row?.external_source === "tmdb"
    && /^\d+$/u.test(String(row.external_id || ""))
    && row.metadata_status === "matched"
    && Number(row.metadata_confidence || 0) >= TRUSTED_MIN_CONFIDENCE;
}

function isCanonicalRow(row) {
  return (row.media_type === "movie" && row.category === "movies")
    || (row.media_type === "tv" && row.category === "series");
}

function missingFields(row) {
  const fields = [];
  if (!hasText(row.overview)) fields.push("overview");
  if (!hasText(row.poster_url)) fields.push("poster");
  if (!hasText(row.backdrop_url)) fields.push("backdrop");
  if (!hasGenres(row.genres_json)) fields.push("genres");
  if (!hasText(row.release_date)) fields.push("release_date");
  if (!hasText(row.original_title)) fields.push("original_title");
  return fields;
}

function hasGenres(value) {
  if (!hasText(value)) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function buildEligibilityRecord(row) {
  if (!isCanonicalRow(row)) return null;
  const fields = missingFields(row);
  if (!fields.length) return null;
  return {
    media_id: row.id,
    media_type: row.media_type,
    category: row.category,
    active: Boolean(row.is_active),
    title: row.title || null,
    year: row.year || null,
    provider: row.external_source,
    provider_id: String(row.external_id),
    metadata_status: row.metadata_status,
    metadata_confidence: Number(row.metadata_confidence || 0),
    fields_missing: fields,
  };
}

function buildOverviewEligibility(row) {
  if (!isCanonicalRow(row) || hasText(row.overview) || !isTrustedProviderIdentity(row)) return null;
  return buildEligibilityRecord(row);
}

function classifyScript(value) {
  const text = String(value || "");
  if (/\p{Script=Hangul}/u.test(text)) return "hangul";
  if (/\p{Script=Han}/u.test(text)) return "han";
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return "kana";
  if (/\p{Script=Thai}/u.test(text)) return "thai";
  if (/\p{Script=Devanagari}/u.test(text)) return "devanagari";
  if (/\p{Letter}/u.test(text)) return "latin-or-other";
  return "none";
}

function sampleStrata(record) {
  return [
    record.media_type,
    record.active ? "active" : "inactive",
    record.year ? (record.year < 2000 ? "old" : record.year < 2020 ? "mid" : "recent") : "yearless",
    classifyScript(record.title),
  ].join("|");
}

function selectDeterministicSample(records, limit) {
  const sorted = [...records].sort((a, b) => a.media_id - b.media_id);
  const buckets = new Map();
  for (const record of sorted) {
    const key = sampleStrata(record);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  const keys = [...buckets.keys()].sort();
  const result = [];
  let cursor = 0;
  while (result.length < limit && keys.length) {
    let added = false;
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (cursor < bucket.length && result.length < limit) {
        result.push(bucket[cursor]);
        added = true;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return result;
}

function providerYear(details, mediaType) {
  const value = mediaType === "tv" ? details?.first_air_date : details?.release_date;
  const match = String(value || "").match(/^(\d{4})(?:-\d{2}-\d{2})?$/u);
  return match ? Number(match[1]) : null;
}

function providerTitleValues(details) {
  const alternatives = details?.alternative_titles?.titles || details?.alternative_titles?.results || [];
  return [details?.title, details?.name, details?.original_title, details?.original_name,
    ...(Array.isArray(alternatives) ? alternatives.map((item) => item?.title || item?.name) : [])]
    .filter(hasText).map(String);
}

function validateExactProviderIdentity(row, details) {
  const issues = [];
  if (!details || String(details.id || "") !== String(row.provider_id)) issues.push("PROVIDER_ID_MISMATCH");
  if (row.media_type === "movie" && !hasText(details?.title) && !hasText(details?.original_title)) issues.push("PROVIDER_TYPE_OR_SHAPE_CONFLICT");
  if (row.media_type === "tv" && !hasText(details?.name) && !hasText(details?.original_name)) issues.push("PROVIDER_TYPE_OR_SHAPE_CONFLICT");
  const year = providerYear(details, row.media_type);
  if (row.year && year && Math.abs(Number(row.year) - year) > 1) issues.push("YEAR_CONFLICT_WITH_TRUSTED_ID");
  const local = normalizeMatchText(row.title || row.original_title || "");
  const providerTitles = providerTitleValues(details).map(normalizeMatchText);
  if (local && providerTitles.length && !providerTitles.some((title) => title === local || title.includes(local) || local.includes(title))) {
    issues.push("TITLE_SANITY_MISMATCH");
  }
  return { valid: issues.length === 0, issues };
}

function overviewValue(details) {
  const value = String(details?.overview || "").trim();
  if (!value || value.length < 10 || /^[.\-_*\s]+$/u.test(value)) return null;
  return value;
}

function normalizeGenres(details) {
  if (!Array.isArray(details?.genres)) return [];
  return details.genres.map((item) => ({ id: item?.id ?? null, name: String(item?.name || item || "").trim() }))
    .filter((item) => item.name);
}

function evaluateProviderMetadata(row, details, selectedLanguage) {
  const identity = validateExactProviderIdentity(row, details);
  if (!identity.valid) {
    return { state: "CONFLICTING", issues: identity.issues, fields_to_fill: [], selected_language: null };
  }
  const fields = [];
  const overview = overviewValue(details);
  if (!hasText(row.overview) && overview) fields.push("overview");
  if (!hasText(row.poster_url) && hasText(details?.poster_path)) fields.push("poster");
  if (!hasText(row.backdrop_url) && hasText(details?.backdrop_path)) fields.push("backdrop");
  if (!hasGenres(row.genres_json) && normalizeGenres(details).length) fields.push("genres");
  const releaseDate = row.media_type === "tv" ? details?.first_air_date : details?.release_date;
  if (!hasText(row.release_date) && /^\d{4}-\d{2}-\d{2}$/u.test(String(releaseDate || ""))) fields.push("release_date");
  const originalTitle = row.media_type === "tv" ? details?.original_name : details?.original_title;
  if (!hasText(row.original_title) && hasText(originalTitle)) fields.push("original_title");
  const result = {
    state: fields.length ? "READY" : "NO_NEW_METADATA",
    fields_to_fill: fields,
    selected_language: fields.includes("overview") ? selectedLanguage || null : null,
    overview: fields.includes("overview") ? overview : null,
    overview_digest: fields.includes("overview") ? digest(overview) : null,
    poster_url: fields.includes("poster") && details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
    backdrop_url: fields.includes("backdrop") && details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
    genres: fields.includes("genres") ? normalizeGenres(details) : [],
    release_date: fields.includes("release_date") ? String(releaseDate) : null,
    original_title: fields.includes("original_title") ? String(originalTitle) : null,
    provider_year: providerYear(details, row.media_type),
    issues: [],
  };
  return result;
}

function deterministicPlanDigest(records) {
  return digest(records.map((record) => ({
    media_id: record.media_id,
    media_type: record.media_type,
    category: record.category,
    active: record.active,
    provider: record.provider,
    provider_id: record.provider_id,
    fields_missing: record.fields_missing,
  })).sort((a, b) => a.media_id - b.media_id));
}

module.exports = {
  DOMAIN_ORDER,
  POLICY_VERSION,
  TRUSTED_MIN_CONFIDENCE,
  buildEligibilityRecord,
  buildOverviewEligibility,
  deterministicPlanDigest,
  digest,
  evaluateProviderMetadata,
  hasGenres,
  hasText,
  isCanonicalRow,
  isTrustedProviderIdentity,
  missingFields,
  sampleStrata,
  selectDeterministicSample,
};
