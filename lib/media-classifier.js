const CLASSIFIER_VERSION = "1.0.0";
const UNCLASSIFIED_CLASSIFIER_VERSION = "2.0.0";

function normalizedGenres(media) {
  const source = Array.isArray(media.genres) ? media.genres : [];
  return source.map((genre) => String(genre.name || genre).toLowerCase());
}

function classifyMedia({ media = {}, candidate = {}, sampleName = "" }) {
  const genres = normalizedGenres(media);
  const text = `${media.title || ""} ${media.original_title || ""} ${candidate.title || ""} ${sampleName}`.toLowerCase();
  const type = media.media_type || candidate.candidateType;
  let category = "unknown";
  let confidence = 0.4;
  let reason = "insufficient-signals";

  if (genres.includes("documentary")) {
    category = "documentaries";
    confidence = 0.98;
    reason = "metadata-documentary-genre";
  } else if (/\b(?:formula\s*1|f1|motogp|ufc|wwe|nba|nhl|nfl|uefa|matchday|round\s*\d+)\b/.test(text)) {
    category = "sports";
    confidence = 0.9;
    reason = "strong-sports-pattern";
  } else if (/\b(?:concert|live\s+(?:at|in)|unplugged|world\s+tour|music\s+festival)\b/.test(text)) {
    category = "concerts";
    confidence = 0.86;
    reason = "strong-concert-pattern";
  } else if (genres.includes("animation") && /\b(?:anime|japan|japanese)\b/.test(text)) {
    category = "anime";
    confidence = 0.82;
    reason = "animation-and-anime-signal";
  } else if (genres.includes("family") && (genres.includes("animation") || genres.includes("kids"))) {
    category = "kids";
    confidence = 0.82;
    reason = "family-animation-metadata";
  } else if (type === "tv" || type === "episode") {
    category = "series";
    confidence = media.external_id ? 0.98 : 0.85;
    reason = media.external_id ? "metadata-tv-type" : "episode-pattern";
  } else if (type === "movie") {
    category = "movies";
    confidence = media.external_id ? 0.97 : 0.76;
    reason = media.external_id ? "metadata-movie-type" : "local-movie-pattern";
  } else if (/\b(?:music\s+video|official\s+video|videoclip)\b/.test(text)) {
    category = "music-videos";
    confidence = 0.8;
    reason = "music-video-pattern";
  } else if (candidate.parseConfidence >= 0.55) {
    category = "other";
    confidence = 0.55;
    reason = "parsed-but-unclassified";
  }

  return { category, confidence, reason, classifierVersion: CLASSIFIER_VERSION };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function normalizedValues(value) {
  return parseJsonArray(value)
    .map((item) => String(item && typeof item === "object" ? item.name || item.value || "" : item).trim().toLowerCase())
    .filter(Boolean);
}

function classifyUnclassifiedMedia({ media = {}, fileEvidence = {} }) {
  const type = String(media.media_type || "unknown").toLowerCase();
  const title = `${media.title || ""} ${media.original_title || ""} ${fileEvidence.sampleName || ""}`.toLowerCase();
  const genres = normalizedValues(media.genres_json || media.genres);
  const countries = normalizedValues(media.countries_json || media.countries);
  const languages = normalizedValues(media.languages_json || media.languages);
  const trustedMetadata = media.metadata_status === "matched"
    && Number(media.metadata_confidence || 0) >= 0.8
    && Boolean(media.external_source && media.external_id);
  const evidence = [];

  if (trustedMetadata && ["movie", "tv", "episode"].includes(type)) {
    evidence.push("TRUSTED_PROVIDER_TYPE");
    return {
      category: type === "movie" ? "movies" : "series",
      confidence: 0.99,
      reason: "TRUSTED_PROVIDER_TYPE",
      evidence,
      classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
    };
  }

  if (type === "tv" || type === "episode" || media.tvshow_id || fileEvidence.episodePattern) {
    evidence.push(type === "tv" || type === "episode" ? "PERSISTED_TV_TYPE" : "STRUCTURAL_EPISODE_PATTERN");
    return {
      category: "series",
      confidence: 0.96,
      reason: evidence[0],
      evidence,
      classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
    };
  }

  if (type === "concert") {
    return {
      category: "concerts",
      confidence: 0.98,
      reason: "PERSISTED_CONCERT_TYPE",
      evidence: ["PERSISTED_CONCERT_TYPE"],
      classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
    };
  }

  if (type === "sports") {
    return {
      category: "sports",
      confidence: 0.98,
      reason: "PERSISTED_SPORT_TYPE",
      evidence: ["PERSISTED_SPORT_TYPE"],
      classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
    };
  }

  if (trustedMetadata && genres.includes("documentary")) {
    return {
      category: "documentaries",
      confidence: 0.97,
      reason: "DOCUMENTARY_GENRE",
      evidence: ["TRUSTED_PROVIDER_TYPE", "DOCUMENTARY_GENRE"],
      classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
    };
  }

  if (trustedMetadata && genres.includes("animation")
    && (countries.some((value) => /japan|japanese|jp/.test(value))
      || languages.some((value) => /japanese|ja/.test(value))
      || /\banime\b/.test(title))) {
    return {
      category: "anime",
      confidence: 0.93,
      reason: "ANIME_METADATA",
      evidence: ["TRUSTED_PROVIDER_TYPE", "ANIMATION_GENRE", "ANIME_METADATA"],
      classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
    };
  }

  if (/\b(?:concert|koncert|unplugged|world tour)\b/.test(title)
    || /\b(?:formula\s*1|motogp|ufc|wwe|nba|nhl|nfl|uefa)\b/.test(title)
    || /\b(?:music video|official video|videoclip)\b/.test(title)) {
    evidence.push("KEYWORD_ONLY");
  }

  return {
    category: "unknown",
    confidence: evidence.includes("KEYWORD_ONLY") ? 0.35 : 0.2,
    reason: evidence.includes("KEYWORD_ONLY") ? "AMBIGUOUS_KEYWORD_ONLY" : "INSUFFICIENT_EVIDENCE",
    evidence,
    classifierVersion: UNCLASSIFIED_CLASSIFIER_VERSION,
  };
}

module.exports = {
  CLASSIFIER_VERSION,
  classifyMedia,
  UNCLASSIFIED_CLASSIFIER_VERSION,
  classifyUnclassifiedMedia,
};
