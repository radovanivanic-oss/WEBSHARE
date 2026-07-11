const path = require("path");

const PARSER_VERSION = "1.0.0";
const VIDEO_EXTENSIONS = new Set([
  "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg",
  "mts", "ogv", "ts", "vob", "webm", "wmv",
]);

const LANGUAGE_TOKENS = new Map([
  ["cz", "CZ"], ["cze", "CZ"], ["czech", "CZ"],
  ["sk", "SK"], ["slo", "SK"], ["slovak", "SK"],
  ["en", "EN"], ["eng", "EN"], ["english", "EN"],
  ["de", "DE"], ["ger", "DE"], ["german", "DE"],
  ["pl", "PL"], ["pol", "PL"], ["polish", "PL"],
  ["hu", "HU"], ["hun", "HU"], ["hungarian", "HU"],
  ["fr", "FR"], ["fre", "FR"], ["french", "FR"],
  ["es", "ES"], ["spa", "ES"], ["spanish", "ES"],
  ["it", "IT"], ["ita", "IT"], ["italian", "IT"],
  ["jp", "JA"], ["jpn", "JA"], ["japanese", "JA"],
]);

const EPISODE_PATTERNS = [
  /(?:^|[^a-z0-9])s(?<season>\d{1,2})[ ._-]*e(?<episode>\d{1,3})(?:[^a-z0-9]|$)/i,
  /(?:^|[^a-z0-9])(?<season>\d{1,2})x(?<episode>\d{1,3})(?:[^a-z0-9]|$)/i,
];

const TECHNICAL_PATTERNS = [
  /\b(?:4320p|2160p|1080p|1080i|720p|576p|480p|4k|8k|uhd|fhd|fullhd|sd)\b/gi,
  /\b(?:web[ ._-]?dl|web[ ._-]?rip|bluray|blu[ ._-]?ray|bdremux|bdrip|brrip|hdtv|hdrip|dvdrip|dvd[ ._-]?rip|camrip|telesync|remux)\b/gi,
  /\b(?:xvid|divx|x26[45]|h[ ._-]?26[45]|hevc|avc|av1|mpeg[ ._-]?2|vp9)\b/gi,
  /\b(?:aac|ac3|eac3|ddp(?:5[ ._-]?1)?|dts(?:[ ._-]?hd)?|truehd|atmos|flac|mp3|pcm)\b/gi,
  /\b(?:hdr10\+?|hdr|dolby[ ._-]?vision|dovi|dv)\b/gi,
  /\b(?:proper|repack|internal|limited|extended|unrated|directors?[ ._-]?cut|complete|sample)\b/gi,
  /\b(?:multi|dual|dabing|dubbed|dub|subbed|subs?|subtitles?|titulky|tit)\b/gi,
];

function decodeText(value) {
  let result = String(value || "");
  try {
    result = decodeURIComponent(result);
  } catch {}
  return result
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripExtension(name, explicitExtension) {
  const normalizedExtension = String(explicitExtension || "").replace(/^\./, "").toLowerCase();
  if (normalizedExtension && name.toLowerCase().endsWith(`.${normalizedExtension}`)) {
    return name.slice(0, -(normalizedExtension.length + 1));
  }
  return name.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function normalizedSlug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractEpisode(value) {
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(value);
    if (match) {
      return {
        season: Number.parseInt(match.groups.season, 10),
        episode: Number.parseInt(match.groups.episode, 10),
        matchedText: match[0],
        index: match.index,
      };
    }
  }
  return null;
}

function extractYear(value) {
  const currentYear = new Date().getUTCFullYear() + 2;
  const matches = [...String(value).matchAll(/(?:^|[^0-9])((?:18|19|20)\d{2})(?=[^0-9]|$)/g)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const year = Number.parseInt(matches[index][1], 10);
    if (year >= 1888 && year <= currentYear) {
      return { year, matchedText: matches[index][1] };
    }
  }
  return null;
}

function extractLanguages(value) {
  const tokens = String(value).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const result = [];
  for (const token of tokens) {
    const language = LANGUAGE_TOKENS.get(token);
    if (language && !result.includes(language)) {
      result.push(language);
    }
  }
  return result;
}

function detectResolution(value) {
  const text = String(value).toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(text)) return "4320p";
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return "2160p";
  if (/\b(?:1080p|1080i|fhd|fullhd)\b/.test(text)) return "1080p";
  if (/\b720p\b/.test(text)) return "720p";
  if (/\b576p\b/.test(text)) return "576p";
  if (/\b480p\b/.test(text)) return "480p";
  return null;
}

function detectSource(value) {
  const text = String(value).toLowerCase();
  if (/web[ ._-]?dl/.test(text)) return "WEB-DL";
  if (/web[ ._-]?rip/.test(text)) return "WEBRip";
  if (/bdremux|remux/.test(text)) return "Remux";
  if (/bluray|blu[ ._-]?ray|bdrip|brrip/.test(text)) return "BluRay";
  if (/hdtv/.test(text)) return "HDTV";
  if (/dvd/.test(text)) return "DVD";
  if (/camrip|\bcam\b/.test(text)) return "CAM";
  return null;
}

function detectVideoCodec(value) {
  const text = String(value).toLowerCase();
  if (/\b(?:x265|h[ ._-]?265|hevc)\b/.test(text)) return "HEVC";
  if (/\b(?:x264|h[ ._-]?264|avc)\b/.test(text)) return "AVC";
  if (/\bav1\b/.test(text)) return "AV1";
  if (/\b(?:xvid|divx)\b/.test(text)) return "Xvid";
  if (/\bvp9\b/.test(text)) return "VP9";
  return null;
}

function detectAudioCodec(value) {
  const text = String(value).toLowerCase();
  if (/\btruehd\b/.test(text)) return "TrueHD";
  if (/\bdts[ ._-]?hd\b/.test(text)) return "DTS-HD";
  if (/\bdts\b/.test(text)) return "DTS";
  if (/\b(?:eac3|ddp)\b/.test(text)) return "E-AC-3";
  if (/\bac3\b/.test(text)) return "AC-3";
  if (/\baac\b/.test(text)) return "AAC";
  if (/\bflac\b/.test(text)) return "FLAC";
  return null;
}

function detectCandidateType(value, episode, year) {
  const text = String(value).toLowerCase();
  if (episode) return "episode";
  if (/\b(?:formula[ ._-]?1|f1|motogp|ufc|wwe|nba|nhl|nfl|uefa|champions[ ._-]?league|premier[ ._-]?league|round[ ._-]?\d+|matchday)\b/.test(text)) {
    return "sports";
  }
  if (/\b(?:concert|live[ ._-]?(?:at|in)|unplugged|world[ ._-]?tour|music[ ._-]?festival)\b/.test(text)) {
    return "concert";
  }
  if (year || detectResolution(value) || detectSource(value)) return "movie";
  return "unknown";
}

function cleanTitle(value, episode, year, languages) {
  let title = String(value);
  if (episode) {
    title = title.slice(0, episode.index);
  }
  if (year) {
    title = title.replace(new RegExp(`(?:^|[^0-9])${year.year}(?=[^0-9]|$)`), " ");
  }
  for (const pattern of TECHNICAL_PATTERNS) {
    title = title.replace(pattern, " ");
  }
  for (const language of languages) {
    for (const [token, mapped] of LANGUAGE_TOKENS) {
      if (mapped === language) {
        title = title.replace(new RegExp(`\\b${token}\\b`, "gi"), " ");
      }
    }
  }
  return title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s+[a-z0-9]{2,15}$/i, " ")
    .replace(/[-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReleaseGroup(value) {
  const match = String(value).match(/-([a-z0-9]{2,15})(?:\.[a-z0-9]{2,5})?$/i);
  return match ? match[1] : null;
}

function parseMediaName(name, options = {}) {
  const decodedName = decodeText(name);
  const requestedExtension = String(options.extension || "").replace(/^\./, "").toLowerCase();
  const nameExtension = path.extname(decodedName).slice(1).toLowerCase();
  const explicitExtension = VIDEO_EXTENSIONS.has(requestedExtension) ? requestedExtension : "";
  const extension = explicitExtension || nameExtension || requestedExtension || null;
  const baseName = stripExtension(decodedName, extension);
  const episode = extractEpisode(baseName);
  const year = extractYear(baseName);
  const languages = extractLanguages(baseName);
  const title = cleanTitle(baseName, episode, year, languages);
  const candidateType = detectCandidateType(baseName, episode, year);
  const reasons = [];
  let confidence = 0.42;

  if (episode) {
    confidence = 0.96;
    reasons.push("episode-pattern");
  } else if (year && title.split(/\s+/).length >= 2) {
    confidence = 0.84;
    reasons.push("title-and-year");
  } else if (detectResolution(baseName) || detectSource(baseName)) {
    confidence = 0.64;
    reasons.push("technical-video-markers");
  } else {
    reasons.push("weak-title-only");
  }

  if (!title || title.length < 2) {
    confidence = 0.1;
    reasons.push("missing-title");
  }
  if (extension && !VIDEO_EXTENSIONS.has(extension)) {
    confidence = Math.min(confidence, 0.35);
    reasons.push("non-video-extension");
  }

  return {
    originalName: decodedName,
    normalizedName: baseName.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim(),
    title: title || baseName,
    normalizedTitle: normalizedSlug(title || baseName),
    year: year?.year || null,
    candidateType,
    season: episode?.season || null,
    episode: episode?.episode || null,
    resolution: detectResolution(baseName),
    source: detectSource(baseName),
    videoCodec: detectVideoCodec(baseName),
    audioCodec: detectAudioCodec(baseName),
    hdr: /\bhdr(?:10\+?)?\b/i.test(baseName),
    dolbyVision: /\b(?:dolby[ ._-]?vision|dovi|dv)\b/i.test(baseName),
    languages,
    hasDubbing: /\b(?:dabing|dubbed|czdub|skdub)\b/i.test(baseName),
    hasSubtitles: /\b(?:subs?|subtitles?|titulky|cztit|sktit)\b/i.test(baseName),
    releaseGroup: extractReleaseGroup(baseName),
    extension,
    isVideoExtension: extension ? VIDEO_EXTENSIONS.has(extension) : false,
    confidence: Number(confidence.toFixed(2)),
    reason: reasons.join(","),
    parserVersion: PARSER_VERSION,
  };
}

module.exports = {
  PARSER_VERSION,
  VIDEO_EXTENSIONS,
  normalizedSlug,
  parseMediaName,
};
