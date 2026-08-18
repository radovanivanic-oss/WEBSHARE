"use strict";

const crypto = require("crypto");
const path = require("path");

const MATCH_POLICY_VERSION = "B37-metadata-match-v1";
const TECHNICAL_TOKENS = /\b(?:4320p|2160p|1080p|1080i|720p|576p|480p|4k|8k|uhd|fhd|fullhd|sd|web[ ._-]?dl|web[ ._-]?rip|webrip|bluray|blu[ ._-]?ray|bdremux|bdrip|brrip|hdtv|hdrip|dvdrip|dvd[ ._-]?rip|camrip|telesync|remux|xvid|divx|x26[45]|h[ ._-]?26[45]|hevc|avc|av1|mpeg[ ._-]?2|vp9|aac|ac3|eac3|ddp(?:5[ ._-]?1)?|dts(?:[ ._-]?hd)?|truehd|atmos|flac|mp3|pcm|hdr10\+?|hdr|dolby[ ._-]?vision|dovi|proper|repack|internal|limited|extended|unrated|directors?[ ._-]?cut|complete|sample|multi|dual|dabing|dubbed|dub|subbed|subs?|subtitles?|titulky|cztit|sktit)\b/giu;
const YEAR_TOKEN = /\b(?:18|19|20)\d{2}\b/gu;
const EPISODE_TOKEN = /(?:^|[^a-z0-9])s\d{1,2}[ ._-]*e\d{1,3}(?=$|[^0-9])/giu;
const GENERIC_TITLE = /^(?:episode|ep|part|cast|sample|video|movie|film|unknown|untitled)(?:\s+\d+)?$/iu;

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/iu, "")
    .replace(/^\s*\[[^\]]{1,80}\]\s*/u, " ")
    .replace(/\s*\[[a-f0-9]{6,40}\]\s*$/iu, " ")
    .replace(EPISODE_TOKEN, " ")
    .replace(TECHNICAL_TOKENS, " ")
    .replace(YEAR_TOKEN, " ")
    .replace(/[._]+/gu, " ")
    .replace(/[-–—]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compact(value) {
  return normalizeMatchText(value).replace(/[^\p{L}\p{N}]/gu, "");
}

function latinSlug(value) {
  return normalizeMatchText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "");
}

function dice(left, right) {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let matches = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = pairs.get(pair) || 0;
    if (count > 0) {
      pairs.set(pair, count - 1);
      matches += 1;
    }
  }
  const charScore = (2 * matches) / (a.length + b.length - 2);
  const slugA = latinSlug(left);
  const slugB = latinSlug(right);
  const slugScore = slugA && slugB && slugA === slugB ? 1 : 0;
  return Math.max(charScore, slugScore);
}

function parseYear(value) {
  const match = String(value || "").match(/\b((?:18|19|20)\d{2})\b/u);
  return match ? Number(match[1]) : null;
}

function cleanCandidateTitle(value) {
  const title = normalizeMatchText(value);
  if (!title || title.length < 2 || GENERIC_TITLE.test(title)) return null;
  if (/^[0-9a-f]{20,}$/iu.test(compact(title))) return null;
  return title;
}

function buildEnrichmentCandidates({ media = {}, files = [], aliases = [], limit = 3 } = {}) {
  const values = [];
  const add = (value, source, year = null) => {
    const title = cleanCandidateTitle(value);
    if (!title) return;
    const key = `${compact(title)}|${year || ""}`;
    if (values.some((item) => item.key === key)) return;
    values.push({ key, title, year: year || parseYear(value) || null, source });
  };
  add(media.title, "media_title", media.year);
  add(media.original_title, "original_title", media.year);
  for (const alias of aliases) add(alias.alias || alias, "persisted_alias", media.year);
  for (const file of files) {
    add(file.parsed_title, "parsed_file_title", file.parsed_year || media.year);
    if (values.length < limit * 2) add(file.original_name, "file_name", file.parsed_year || media.year);
  }
  return values.slice(0, Math.max(1, Math.min(limit, 5)));
}

function inferExpectedTypes(media, files = []) {
  const hasEpisode = media.media_type === "tv" || media.media_type === "episode"
    || media.tvshow_id
    || files.some((file) => file.parsed_season != null && file.parsed_episode != null
      || /\bs\d{1,2}[ ._-]*e\d{1,3}\b/iu.test(String(file.original_name || "")));
  if (hasEpisode) return ["tv"];
  if (media.media_type === "movie") return ["movie"];
  return ["movie", "tv"];
}

function providerTitles(result) {
  const alternatives = result.alternative_titles?.titles || result.alternative_titles?.results || result.alternative_titles || [];
  return [
    result.title,
    result.name,
    result.original_title,
    result.original_name,
    ...(Array.isArray(alternatives) ? alternatives.map((item) => item.title || item.name || item) : []),
  ].filter(Boolean).map(String);
}

function providerYear(result, type) {
  return parseYear(type === "tv" ? result.first_air_date : result.release_date);
}

function scoreProviderResult(candidate, result, expectedType) {
  const titles = providerTitles(result);
  const normalizedCandidate = compact(candidate.title);
  const titleScores = titles.map((title) => ({ title, score: dice(candidate.title, title), exact: compact(title) === normalizedCandidate }));
  const bestTitle = titleScores.sort((left, right) => right.score - left.score)[0] || { title: "", score: 0, exact: false };
  const matchedYear = providerYear(result, expectedType);
  let yearScore = candidate.year == null ? 0.5 : matchedYear == null ? 0.4 : Math.abs(candidate.year - matchedYear) === 0 ? 1 : Math.abs(candidate.year - matchedYear) === 1 ? 0.5 : 0;
  const yearConflict = candidate.year != null && matchedYear != null && Math.abs(candidate.year - matchedYear) > 1;
  if (yearConflict) yearScore = 0;
  const score = bestTitle.score * 0.72 + yearScore * 0.23 + Math.min(1, Math.log10(Number(result.popularity || 0) + 1) / 3) * 0.05;
  return {
    result,
    score: Number(score.toFixed(4)),
    titleScore: Number(bestTitle.score.toFixed(4)),
    titleExact: bestTitle.exact,
    matchedTitle: bestTitle.title,
    matchedYear,
    yearScore,
    yearConflict,
    expectedType,
  };
}

function selectStrictMetadataMatch({ candidates = [], results = [], expectedType, thresholds = {} } = {}) {
  const auto = Number(thresholds.auto ?? 0.9);
  const ambiguous = Number(thresholds.ambiguous ?? 0.72);
  const scored = results
    .map((result) => scoreProviderResult(candidates[0] || { title: "", year: null }, result, expectedType))
    .filter((item) => !item.yearConflict && item.titleScore >= 0.7)
    .sort((left, right) => right.score - left.score || String(left.result.id).localeCompare(String(right.result.id)));
  const best = scored[0] || null;
  if (!best) return { status: "NO_MATCH", best: null, scored, reasonCodes: ["NO_ACCEPTABLE_PROVIDER_RESULT"] };
  const second = scored[1];
  const closeCompetition = second && second.result.id !== best.result.id && best.score - second.score < 0.05;
  const reasonCodes = [best.titleExact ? "EXACT_TITLE_OR_ALIAS" : "FUZZY_TITLE_MATCH"];
  if (best.matchedYear != null && candidates[0]?.year != null) reasonCodes.push(best.yearScore === 1 ? "EXACT_YEAR" : "NEAR_YEAR");
  else reasonCodes.push("MISSING_CANDIDATE_YEAR");
  if (closeCompetition) return { status: "AMBIGUOUS", best, scored, reasonCodes: [...reasonCodes, "CLOSE_PROVIDER_CANDIDATES"] };
  if (best.score >= auto && best.titleScore >= 0.9) return { status: "MATCHED", best, scored, reasonCodes };
  if (best.score >= ambiguous) return { status: "AMBIGUOUS", best, scored, reasonCodes: [...reasonCodes, "BELOW_AUTO_MATCH_THRESHOLD"] };
  return { status: "NO_MATCH", best, scored, reasonCodes: [...reasonCodes, "BELOW_AMBIGUOUS_THRESHOLD"] };
}

function providerTaxonomy(details, primaryType) {
  const genres = (details.genres || []).map((item) => String(item.name || item).toLowerCase());
  const keywordSource = details.keywords;
  const keywordItems = Array.isArray(keywordSource)
    ? keywordSource
    : [...(keywordSource?.keywords || []), ...(keywordSource?.results || [])];
  const keywords = keywordItems.map((item) => String(item.name || item).toLowerCase());
  const documentary = genres.includes("documentary") || genres.includes("dokumentárny") || genres.includes("dokumentární");
  const anime = keywords.includes("anime") || keywords.includes("japanese animation");
  return {
    primaryType: primaryType === "tv" ? "series" : "movies",
    secondaryTags: [documentary ? "documentary" : null, anime ? "anime" : null].filter(Boolean),
    reasonCodes: [documentary ? "TRUSTED_DOCUMENTARY_GENRE" : null, anime ? "EXPLICIT_ANIME_PROVIDER_KEYWORD" : null].filter(Boolean),
  };
}

function buildEvidenceDigest(candidate, scored) {
  return digest({
    policy_version: MATCH_POLICY_VERSION,
    candidate: { title: candidate.title, year: candidate.year, source: candidate.source },
    match: scored ? { id: scored.result.id, score: scored.score, titleScore: scored.titleScore, matchedYear: scored.matchedYear, expectedType: scored.expectedType } : null,
  });
}

module.exports = {
  MATCH_POLICY_VERSION,
  buildEnrichmentCandidates,
  buildEvidenceDigest,
  cleanCandidateTitle,
  compact,
  dice,
  inferExpectedTypes,
  normalizeMatchText,
  parseYear,
  providerTaxonomy,
  scoreProviderResult,
  selectStrictMetadataMatch,
};
