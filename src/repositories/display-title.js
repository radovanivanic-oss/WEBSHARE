const DISPLAY_TITLE_POLICY_VERSION = "b35-display-title-v1";

// These are deliberately conservative. They help us recognise a provider-backed
// English title among TMDb alternative titles; they do not translate or
// transliterate a native title.
const COMMON_ENGLISH_WORDS = new Set([
  "a", "about", "act", "after", "again", "all", "american", "an", "and", "at", "be", "before",
  "between", "by", "complete", "completion", "deep", "don", "dont", "down", "emotional", "experiment",
  "family", "find", "for", "from", "girl", "in", "into", "is", "last", "man", "marriage", "marry",
  "my", "no", "of", "office", "on", "one", "or", "proposal", "role", "series", "the", "this", "to",
  "too", "up", "we", "who", "with", "you",
]);

const BAD_GLYPH_RE = /[\uFFFD\u25A1\u25A0]/u;
const CONTROL_RE = /[\u0000-\u001F\u007F]/u;
const TECHNICAL_TOKEN_RE = /(?:\b(?:2160p|1080p|720p|576p|480p|4k|8k|web[- .]?dl|web[- .]?rip|bluray|brrip|remux|x26[45]|h\.?26[45]|aac|ac3|dts|hdr|dolby[ .-]?vision|cam|ts|telesync|s\d{1,2}e\d{1,3})\b)/iu;

function text(value) {
  // Do not normalize identity or native display text. NFKC would rewrite
  // legitimate full-width punctuation in otherwise readable titles.
  return String(value || "").trim();
}

function hasLetters(value) {
  return /\p{L}/u.test(value);
}

function hasLatinLetters(value) {
  return /\p{Script=Latin}/u.test(value);
}

function hasNonLatinLetters(value) {
  return /\p{L}/u.test(value) && !hasLatinLetters(value);
}

function safeTitle(value) {
  const candidate = text(value);
  return Boolean(candidate) && candidate.length <= 180 && hasLetters(candidate)
    && !BAD_GLYPH_RE.test(candidate) && !CONTROL_RE.test(candidate)
    && !TECHNICAL_TOKEN_RE.test(candidate);
}

function languageScore(language) {
  const normalized = text(language).toLowerCase();
  if (normalized === "sk" || normalized.startsWith("sk-")) return 40;
  if (normalized === "cs" || normalized.startsWith("cs-")) return 35;
  if (normalized === "en" || normalized.startsWith("en-")) return 30;
  return 0;
}

function englishEvidence(candidate) {
  const words = candidate.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z]+/g) || [];
  const common = words.filter((word) => COMMON_ENGLISH_WORDS.has(word)).length;
  return common >= 1 && words.length >= 2 ? common : 0;
}

function trustedAlias(alias, media) {
  if (!alias || typeof alias !== "object") return false;
  const source = text(alias.source).toLowerCase();
  if (source !== "tmdb" && source !== "provider") return false;
  if (media && media.metadata_status && media.metadata_status !== "matched") return false;
  if (media && media.metadata_confidence !== null && media.metadata_confidence !== undefined
    && Number(media.metadata_confidence) < 0.8) return false;
  return safeTitle(alias.alias);
}

function displayTitleDecision(media, aliases = []) {
  const title = text(media && media.title);
  const originalTitle = text(media && media.original_title);
  if (safeTitle(title) && !hasNonLatinLetters(title) && !BAD_GLYPH_RE.test(title)) {
    return { displayTitle: title, reason: "CANONICAL_TITLE_READABLE", policyVersion: DISPLAY_TITLE_POLICY_VERSION };
  }

  const candidates = aliases
    .filter((alias) => trustedAlias(alias, media))
    .map((alias, index) => {
      const candidate = text(alias.alias);
      const explicitLanguage = languageScore(alias.language);
      const english = explicitLanguage || englishEvidence(candidate) * 5;
      return {
        displayTitle: candidate,
        score: explicitLanguage * 100 + english * 10 + (hasLatinLetters(candidate) ? 2 : 0) - index / 1000,
        explicitLanguage,
      };
    })
    .filter((candidate) => candidate.explicitLanguage > 0 || englishEvidence(candidate.displayTitle) > 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length > 0) {
    return {
      displayTitle: candidates[0].displayTitle,
      reason: candidates[0].explicitLanguage > 0 ? "TRUSTED_LOCALIZED_ALIAS" : "TRUSTED_ENGLISH_ALIAS",
      policyVersion: DISPLAY_TITLE_POLICY_VERSION,
    };
  }

  if (safeTitle(title)) {
    return { displayTitle: title, reason: "NATIVE_UNICODE_TITLE", policyVersion: DISPLAY_TITLE_POLICY_VERSION };
  }
  if (safeTitle(originalTitle)) {
    return { displayTitle: originalTitle, reason: "ORIGINAL_TITLE_FALLBACK", policyVersion: DISPLAY_TITLE_POLICY_VERSION };
  }
  return { displayTitle: title || originalTitle || "", reason: "NO_SAFE_ALTERNATIVE", policyVersion: DISPLAY_TITLE_POLICY_VERSION };
}

function selectDisplayTitle(media, aliases = []) {
  return displayTitleDecision(media, aliases).displayTitle;
}

module.exports = {
  DISPLAY_TITLE_POLICY_VERSION,
  displayTitleDecision,
  selectDisplayTitle,
  safeTitle,
};
