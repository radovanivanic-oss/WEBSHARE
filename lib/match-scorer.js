const { normalizedSlug } = require("./media-name-parser");

function diceCoefficient(left, right) {
  const a = normalizedSlug(left);
  const b = normalizedSlug(right);
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
  return (2 * matches) / (a.length + b.length - 2);
}

function resultYear(result, type) {
  const date = type === "tv" ? result.first_air_date : result.release_date;
  const year = Number.parseInt(String(date || "").slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function scoreMetadataMatch(candidate, result, expectedType) {
  const primaryTitle = result.title || result.name || "";
  const originalTitle = result.original_title || result.original_name || "";
  const titleScore = Math.max(
    diceCoefficient(candidate.title, primaryTitle),
    diceCoefficient(candidate.title, originalTitle)
  );
  const candidateYear = candidate.parsedYear || null;
  const matchedYear = resultYear(result, expectedType);
  let yearScore = candidateYear ? 0 : 0.5;
  if (candidateYear && matchedYear) {
    const difference = Math.abs(candidateYear - matchedYear);
    yearScore = difference === 0 ? 1 : difference === 1 ? 0.5 : 0;
  }
  const typeScore = expectedType === "movie" || expectedType === "tv" ? 1 : 0.5;
  const popularity = Math.min(1, Math.log10(Number(result.popularity || 0) + 1) / 3);
  const score = titleScore * 0.65 + yearScore * 0.2 + typeScore * 0.1 + popularity * 0.05;

  return {
    score: Number(score.toFixed(4)),
    titleScore: Number(titleScore.toFixed(4)),
    yearScore,
    typeScore,
    popularityScore: Number(popularity.toFixed(4)),
    matchedYear,
  };
}

function selectBestMatch(candidate, results, expectedType, thresholds) {
  const scored = (results || [])
    .map((result) => ({ result, ...scoreMetadataMatch(candidate, result, expectedType) }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0] || null;
  if (!best) return { status: "not_found", best: null, scored: [] };
  if (best.score >= thresholds.auto) return { status: "matched", best, scored };
  if (best.score >= thresholds.ambiguous) return { status: "ambiguous", best, scored };
  return { status: "not_found", best, scored };
}

module.exports = {
  diceCoefficient,
  scoreMetadataMatch,
  selectBestMatch,
};
