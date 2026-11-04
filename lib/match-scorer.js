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

function strictTitleKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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
    exactTitle: [primaryTitle, originalTitle].some((title) => strictTitleKey(title) === strictTitleKey(candidate.title)),
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
  // An exact normalized title with a type-correct provider result is stronger
  // evidence than the weighted score alone when the candidate has no year.
  // Keep ties ambiguous so same-title remakes still require more evidence.
  const exactTitleMatches = scored.filter((item) => item.exactTitle && item.typeScore === 1);
  const yearCompatible = !candidate.parsedYear || !best.matchedYear || candidate.parsedYear === best.matchedYear;
  if (exactTitleMatches.length === 1 && yearCompatible) return { status: "matched", best, scored };
  // A title search can return a real show together with an incomplete
  // placeholder/spin-off that has the same normalized title.  Prefer the
  // only dated exact result when the other exact result has no air date.  A
  // same-title remake where both results have dates remains ambiguous below.
  const datedExactMatches = exactTitleMatches.filter((item) => item.matchedYear);
  if (
    exactTitleMatches.length > 1
    && datedExactMatches.length === 1
    && !candidate.parsedYear
    && datedExactMatches[0].result === best.result
  ) {
    return { status: "matched", best, scored };
  }
  if (best.score >= thresholds.auto) return { status: "matched", best, scored };
  if (best.score >= thresholds.ambiguous) return { status: "ambiguous", best, scored };
  return { status: "not_found", best, scored };
}

module.exports = {
  diceCoefficient,
  scoreMetadataMatch,
  selectBestMatch,
};
