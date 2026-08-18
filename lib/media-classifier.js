const CLASSIFIER_VERSION = "1.0.0";
const UNCLASSIFIED_CLASSIFIER_VERSION = "2.0.0";
const DEEP_UNCLASSIFIED_CLASSIFIER_VERSION = "3.0.0";

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

const DEEP_CONFIDENCE = Object.freeze({
  PROVEN: "PROVEN",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  INSUFFICIENT: "INSUFFICIENT",
  CONFLICTING: "CONFLICTING",
});

function trustedProviderMetadata(media) {
  return media.metadata_status === "matched"
    && Number(media.metadata_confidence || 0) >= 0.8
    && Boolean(media.external_source && media.external_id);
}

function deepResult({
  category = "unknown",
  confidenceClass = DEEP_CONFIDENCE.INSUFFICIENT,
  confidence = 0.2,
  reasonCodes = ["INSUFFICIENT_EVIDENCE"],
  evidence = {},
  conflictFlags = [],
  secondaryTags = [],
}) {
  const eligible = confidenceClass === DEEP_CONFIDENCE.PROVEN
    || confidenceClass === DEEP_CONFIDENCE.HIGH;
  return {
    category,
    proposedCategory: category,
    confidenceClass,
    confidence,
    reasonCodes,
    evidence,
    conflictFlags,
    secondaryTags,
    eligible,
    classifierVersion: DEEP_UNCLASSIFIED_CLASSIFIER_VERSION,
  };
}

/**
 * Classifies one unknown media entity from persisted metadata plus aggregate
 * file evidence. This is deliberately stricter than the legacy filename
 * classifier: raw keywords are never sufficient, and only PROVEN/HIGH
 * results are eligible for a write plan.
 */
function classifyDeepUnclassifiedMedia({ media = {}, fileEvidence = {} }) {
  const type = String(media.media_type || "unknown").toLowerCase();
  const trusted = trustedProviderMetadata(media);
  const structuralSeries = Boolean(
    fileEvidence.episodePatternFiles >= 3
      && fileEvidence.distinctEpisodeKeys >= 3
      && fileEvidence.episodePatternRatio >= 0.5,
  );
  const episodeWordSeries = Boolean(
    fileEvidence.episodeWordFiles >= 5
      && fileEvidence.distinctEpisodeNumbers >= 4
      && fileEvidence.episodeWordRatio >= 0.5
      && fileEvidence.nonGenericEpisodeTitle,
  );
  const strongSeries = structuralSeries || episodeWordSeries;
  const documentary = Boolean(
    fileEvidence.documentaryFiles >= 2
      && fileEvidence.documentaryRatio >= 0.5,
  );
  const musicVideo = Boolean(
    fileEvidence.musicVideoFiles >= 2
      && fileEvidence.musicVideoRatio >= 0.5,
  );
  const concert = Boolean(
    fileEvidence.concertFiles >= 2
      && fileEvidence.concertRatio >= 0.5,
  );
  const sport = Boolean(
    fileEvidence.sportFiles >= 2
      && fileEvidence.sportRatio >= 0.5,
  );

  const strongSignals = [
    strongSeries ? "series" : null,
    documentary ? "documentaries" : null,
    musicVideo ? "music-videos" : null,
    concert ? "concerts" : null,
    sport ? "sports" : null,
  ].filter(Boolean);

  if (trusted && ["movie", "tv", "episode"].includes(type)) {
    if (strongSeries && type === "movie") {
      return deepResult({
        confidenceClass: DEEP_CONFIDENCE.CONFLICTING,
        confidence: 0.1,
        reasonCodes: ["TRUSTED_PROVIDER_TYPE", "STRUCTURAL_EPISODE_PATTERN", "CONFLICTING_EVIDENCE"],
        evidence: { trustedType: type, strongSignals },
        conflictFlags: ["TRUSTED_MOVIE_VS_SERIES_STRUCTURE"],
      });
    }
    return deepResult({
      category: type === "movie" ? "movies" : "series",
      confidenceClass: DEEP_CONFIDENCE.PROVEN,
      confidence: 0.99,
      reasonCodes: ["TRUSTED_PROVIDER_TYPE"],
      evidence: { provider: media.external_source, externalId: media.external_id, mediaType: type },
    });
  }

  if (type === "concert" || type === "sports") {
    return deepResult({
      category: type === "concert" ? "concerts" : "sports",
      confidenceClass: DEEP_CONFIDENCE.PROVEN,
      confidence: 0.98,
      reasonCodes: [type === "concert" ? "PERSISTED_CONCERT_TYPE" : "PERSISTED_SPORT_TYPE"],
      evidence: { mediaType: type },
    });
  }

  if (strongSignals.length > 1) {
    return deepResult({
      confidenceClass: DEEP_CONFIDENCE.CONFLICTING,
      confidence: 0.1,
      reasonCodes: ["CONFLICTING_EVIDENCE", ...strongSignals.map((signal) => `${signal.toUpperCase().replace(/-/g, "_")}_SIGNAL`)],
      evidence: { strongSignals },
      conflictFlags: strongSignals,
    });
  }

  if (strongSeries) {
    return deepResult({
      category: "series",
      confidenceClass: DEEP_CONFIDENCE.HIGH,
      confidence: 0.95,
      reasonCodes: [structuralSeries ? "MULTI_FILE_EPISODE_CONSENSUS" : "MULTI_FILE_EPISODE_WORD_CONSENSUS"],
      evidence: { episodePatternFiles: fileEvidence.episodePatternFiles || 0, distinctEpisodeKeys: fileEvidence.distinctEpisodeKeys || 0 },
    });
  }

  if (documentary) {
    return deepResult({
      category: "documentaries",
      confidenceClass: DEEP_CONFIDENCE.HIGH,
      confidence: 0.9,
      reasonCodes: ["MULTI_FILE_DOCUMENTARY_CONSENSUS"],
      evidence: { documentaryFiles: fileEvidence.documentaryFiles, documentaryRatio: fileEvidence.documentaryRatio },
    });
  }

  if (musicVideo) {
    return deepResult({
      category: "music-videos",
      confidenceClass: DEEP_CONFIDENCE.HIGH,
      confidence: 0.9,
      reasonCodes: ["MULTI_FILE_MUSIC_VIDEO_CONSENSUS"],
      evidence: { musicVideoFiles: fileEvidence.musicVideoFiles, musicVideoRatio: fileEvidence.musicVideoRatio },
    });
  }

  if (concert) {
    return deepResult({
      category: "concerts",
      confidenceClass: DEEP_CONFIDENCE.HIGH,
      confidence: 0.88,
      reasonCodes: ["MULTI_FILE_CONCERT_CONSENSUS"],
      evidence: { concertFiles: fileEvidence.concertFiles, concertRatio: fileEvidence.concertRatio },
    });
  }

  if (sport) {
    return deepResult({
      category: "sports",
      confidenceClass: DEEP_CONFIDENCE.HIGH,
      confidence: 0.88,
      reasonCodes: ["MULTI_FILE_SPORT_CONSENSUS"],
      evidence: { sportFiles: fileEvidence.sportFiles, sportRatio: fileEvidence.sportRatio },
    });
  }

  const weakSignals = [
    fileEvidence.keywordOnly ? "AMBIGUOUS_KEYWORD_ONLY" : null,
    fileEvidence.files > 1 ? "MULTIPLE_FILES_WITHOUT_IDENTITY" : null,
    media.year != null ? "YEAR_ONLY" : null,
  ].filter(Boolean);
  return deepResult({
    confidenceClass: weakSignals.length ? DEEP_CONFIDENCE.LOW : DEEP_CONFIDENCE.INSUFFICIENT,
    confidence: weakSignals.length ? 0.35 : 0.2,
    reasonCodes: weakSignals.length ? weakSignals : ["INSUFFICIENT_EVIDENCE"],
    evidence: { files: fileEvidence.files || 0 },
  });
}

module.exports = {
  CLASSIFIER_VERSION,
  classifyMedia,
  UNCLASSIFIED_CLASSIFIER_VERSION,
  classifyUnclassifiedMedia,
  DEEP_CONFIDENCE,
  DEEP_UNCLASSIFIED_CLASSIFIER_VERSION,
  classifyDeepUnclassifiedMedia,
};
