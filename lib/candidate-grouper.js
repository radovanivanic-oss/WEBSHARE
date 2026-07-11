const GROUPING_VERSION = "1.0.0";

function pad(value, length) {
  return String(value || 0).padStart(length, "0");
}

function buildCandidate(parsed) {
  const slug = parsed.normalizedTitle || "unknown";
  let candidateKey;
  let lookupKey;
  let seriesKey = null;

  if (parsed.candidateType === "episode") {
    seriesKey = `tv|${slug}`;
    lookupKey = seriesKey;
    candidateKey = `episode|${slug}|s${pad(parsed.season, 2)}|e${pad(parsed.episode, 3)}`;
  } else {
    const type = parsed.candidateType === "movie" ? "movie" : parsed.candidateType || "unknown";
    const year = parsed.year || "year-unknown";
    candidateKey = `${type}|${slug}|${year}`;
    lookupKey = candidateKey;
  }

  return {
    candidateKey,
    lookupKey,
    seriesKey,
    normalizedTitle: parsed.normalizedTitle,
    title: parsed.title,
    parsedYear: parsed.year,
    candidateType: parsed.candidateType,
    seasonNumber: parsed.season,
    episodeNumber: parsed.episode,
    parseConfidence: parsed.confidence,
    groupingVersion: GROUPING_VERSION,
  };
}

module.exports = {
  GROUPING_VERSION,
  buildCandidate,
};
