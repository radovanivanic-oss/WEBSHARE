const path = require("path");

const CATEGORY_DEFINITIONS = [
  { id: "movies", title: "Filmy" },
  { id: "series", title: "Seriály" },
  { id: "documentaries", title: "Dokumenty" },
  { id: "concerts", title: "Koncerty" },
  { id: "sports", title: "Šport" },
  { id: "kids", title: "Detské" },
  { id: "music-videos", title: "Hudobné videá" },
  { id: "other", title: "Ostatné" },
  { id: "unknown", title: "Neznáme" },
];

const CATEGORY_TITLES = Object.fromEntries(
  CATEGORY_DEFINITIONS.map((category) => [category.id, category.title])
);

const CATEGORY_IDS = CATEGORY_DEFINITIONS.map((category) => category.id);

const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();

    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return HTML_ENTITIES[key] || match;
  });
}

function decodeUrlEscapes(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function stripKnownExtension(value, extension) {
  const normalizedExtension = String(extension || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();

  if (normalizedExtension) {
    return value.replace(new RegExp(`\\.${escapeRegExp(normalizedExtension)}$`, "i"), "");
  }

  const parsedExtension = path.extname(value);
  return parsedExtension ? value.slice(0, -parsedExtension.length) : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTitleForClassification(item) {
  const original = String(item?.name || item?.title || "");
  const withoutExtension = stripKnownExtension(original, item?.extension || item?.type);
  const decoded = decodeHtmlEntities(decodeUrlEscapes(withoutExtension));

  return decoded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[._\-]+/g, " ")
    .replace(/[\[\](){}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

const seriesPatterns = [
  /\bs\d{1,2}\s*e\d{1,3}\b/i,
  /\b\d{1,2}\s*x\s*\d{1,3}\b/i,
  /\bseason\s*\d{1,3}\b/i,
  /\bepisode\s*\d{1,3}\b/i,
  /\bep\s*\d{1,3}\b/i,
  /\be\d{2,3}\b/i,
];

const documentaryPatterns = [
  /\bdocumentary\b/i,
  /\bdocument\b/i,
  /\bdokument\b/i,
  /\bdokumentarny\b/i,
  /\bdokumentarni\b/i,
  /\bdocu\b/i,
  /\bnational\s+geographic\b/i,
  /\bdiscovery\b/i,
  /\bbbc\s+documentary\b/i,
  /\bnature\s+documentary\b/i,
];

const concertPatterns = [
  /\bconcert\b/i,
  /\bkoncert\b/i,
  /\blive\s+concert\b/i,
  /\blive\s+(at|in)\b/i,
  /\bworld\s+tour\b/i,
  /\bfestival\b/i,
  /\bunplugged\b/i,
  /\btour\b/i,
];

const sportsPatterns = [
  /\bfootball\b/i,
  /\bsoccer\b/i,
  /\bice\s+hockey\b/i,
  /\bhockey\b/i,
  /\bnhl\b/i,
  /\bnfl\b/i,
  /\bnba\b/i,
  /\bufc\b/i,
  /\bmma\b/i,
  /\bboxing\b/i,
  /\bformula\s*1\b/i,
  /\bf1\b/i,
  /\bmotogp\b/i,
  /\btennis\b/i,
  /\bwrestling\b/i,
  /\bsport\b/i,
  /\bmatch\b/i,
  /\brace\b/i,
  /\bround\s*\d{1,3}\b/i,
];

const musicVideoPatterns = [
  /\bmusic\s+video\b/i,
  /\bofficial\s+video\b/i,
  /\bvideoclip\b/i,
  /\bvideo\s+clip\b/i,
  /\bmusic\s+clip\b/i,
];

const kidsStrongPatterns = [
  /\bkids\b/i,
  /\bchildren\b/i,
  /\bdetske\b/i,
  /\bdetsky\b/i,
  /\brozpravka\b/i,
  /\bpohadka\b/i,
  /\bcartoon\b/i,
];

const kidsWeakPatterns = [
  /\banimation\b/i,
  /\banimated\b/i,
];

const movieReleasePatterns = [
  /\b1080p\b/i,
  /\b2160p\b/i,
  /\b720p\b/i,
  /\bbluray\b/i,
  /\bbd\s*rip\b/i,
  /\bbdrip\b/i,
  /\bweb\s*dl\b/i,
  /\bwebdl\b/i,
  /\bweb\s*rip\b/i,
  /\bwebrip\b/i,
  /\bhdrip\b/i,
  /\bdvd\s*rip\b/i,
  /\bdvdrip\b/i,
  /\bremux\b/i,
];

const otherPatterns = [
  /\btrailer\b/i,
  /\bteaser\b/i,
  /\bmaking\s+of\b/i,
  /\bbehind\s+the\s+scenes\b/i,
  /\binterview\b/i,
  /\bshort\s+film\b/i,
  /\bfeaturette\b/i,
];

function hasMovieYear(value) {
  return /\b(19\d{2}|20\d{2})\b/.test(value);
}

function hasEnoughTitleWords(value) {
  const words = value
    .split(/\s+/)
    .filter((word) => word && !/^\d+$/.test(word) && !movieReleasePatterns.some((pattern) => pattern.test(word)));
  return words.length >= 2;
}

function classifyCatalogItem(item) {
  const normalizedTitle = normalizeTitleForClassification(item);

  if (!normalizedTitle) {
    return {
      category: "unknown",
      confidence: 0,
      reason: "empty_title",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, seriesPatterns)) {
    return {
      category: "series",
      confidence: 0.95,
      reason: "series_episode_pattern",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, documentaryPatterns)) {
    return {
      category: "documentaries",
      confidence: 0.9,
      reason: "documentary_keyword",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, concertPatterns)) {
    return {
      category: "concerts",
      confidence: 0.85,
      reason: "concert_keyword",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, sportsPatterns)) {
    return {
      category: "sports",
      confidence: 0.85,
      reason: "sports_keyword",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, musicVideoPatterns)) {
    return {
      category: "music-videos",
      confidence: 0.85,
      reason: "music_video_keyword",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, kidsStrongPatterns)) {
    return {
      category: "kids",
      confidence: 0.8,
      reason: "kids_keyword",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, kidsWeakPatterns)) {
    return {
      category: "other",
      confidence: 0.45,
      reason: "generic_animation_uncertain",
      normalizedTitle,
    };
  }

  const year = hasMovieYear(normalizedTitle);
  const releaseTag = matchesAny(normalizedTitle, movieReleasePatterns);

  if (year && releaseTag && hasEnoughTitleWords(normalizedTitle)) {
    return {
      category: "movies",
      confidence: 0.85,
      reason: "movie_year_release_pattern",
      normalizedTitle,
    };
  }

  if (year && hasEnoughTitleWords(normalizedTitle)) {
    return {
      category: "movies",
      confidence: 0.7,
      reason: "movie_year_pattern",
      normalizedTitle,
    };
  }

  if (matchesAny(normalizedTitle, otherPatterns)) {
    return {
      category: "other",
      confidence: 0.55,
      reason: "known_other_video_keyword",
      normalizedTitle,
    };
  }

  return {
    category: "unknown",
    confidence: 0.2,
    reason: "no_reliable_pattern",
    normalizedTitle,
  };
}

module.exports = {
  CATEGORY_DEFINITIONS,
  CATEGORY_IDS,
  CATEGORY_TITLES,
  classifyCatalogItem,
  normalizeTitleForClassification,
};
