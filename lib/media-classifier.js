const CLASSIFIER_VERSION = "1.0.0";

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

module.exports = {
  CLASSIFIER_VERSION,
  classifyMedia,
};
