const FILENAME_NOISE = new Set([
  "4k", "8k", "uhd", "fhd", "fullhd", "sd", "hdr", "hdr10", "hdr10+", "dovi",
  "2160p", "1080p", "1080i", "720p", "576p", "480p", "webdl", "webrip", "bluray",
  "bdrip", "brrip", "remux", "bdremux", "hdtv", "hdrip", "dvdrip", "camrip", "cam",
  "telesync", "xvid", "divx", "x264", "x265", "h264", "h265", "hevc", "avc", "av1",
  "vp9", "aac", "ac3", "eac3", "ddp", "dts", "truehd", "atmos", "flac", "mp3", "pcm",
  "proper", "repack", "internal", "limited", "extended", "unrated", "directorscut",
  "complete", "sample", "multi", "dual", "dubbed", "dub", "subbed", "subs", "subtitles",
  "titulky", "tit", "10bit", "m1080p", "bone", "ta",
]);

function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return fold(value).split(/\s+/u).filter(Boolean);
}

function isTrustedExternal(media) {
  return Boolean(media && media.external_source && String(media.external_id || "").trim());
}

function externalKey(media) {
  if (!isTrustedExternal(media)) return null;
  return `${String(media.external_source).toLowerCase()}:${String(media.external_id)}:${String(media.media_type || "")}`;
}

function compatibleYear(left, right) {
  if (left.year == null || right.year == null) return false;
  return Number(left.year) === Number(right.year);
}

function looksLikeReleaseToken(token) {
  return /\d/u.test(token) || /^[A-Z]+$/u.test(token) || /[a-z][A-Z]/u.test(token);
}

function normalizedFilenameTitle(file) {
  const value = file.parsed_title || file.original_name || file.normalized_name || "";
  return tokens(value).filter((token) => !FILENAME_NOISE.has(token));
}

function metadataTitles(media) {
  const values = [media.title, media.original_title, ...(media.aliases || [])];
  return values.map(fold).filter(Boolean);
}

function filenameMatchesMetadata(file, media) {
  const candidate = normalizedFilenameTitle(file);
  if (!candidate.length) return false;
  const candidateSet = new Set(candidate);
  const expectedTitles = metadataTitles(media).map(tokens).filter((value) => value.length);
  const known = new Set(expectedTitles.flat());
  const hasCompleteTitle = expectedTitles.some((expected) => expected.every((token) => candidateSet.has(token)));
  if (!hasCompleteTitle) return false;
  return candidate.every((token) => known.has(token) || FILENAME_NOISE.has(token) || looksLikeReleaseToken(token));
}

function compareMedia(left, right, options = {}) {
  if (!left || !right) throw new TypeError("compareMedia requires two media rows");
  if (left.media_type !== right.media_type) {
    return { status: "PROVEN_DIFFERENT_MOVIE", reason: "media-type-conflict", evidence: [] };
  }
  const leftKey = externalKey(left);
  const rightKey = externalKey(right);
  if (leftKey && rightKey) {
    return leftKey === rightKey
      ? { status: "PROVEN_SAME_MOVIE", reason: "same-trusted-external-identity", evidence: [leftKey] }
      : { status: "PROVEN_DIFFERENT_MOVIE", reason: "trusted-external-id-conflict", evidence: [leftKey, rightKey] };
  }
  if (left.media_type !== "movie" || !compatibleYear(left, right)) {
    return { status: "AMBIGUOUS", reason: left.media_type !== "movie" ? "unsupported-media-type" : "missing-or-conflicting-year", evidence: [] };
  }
  const metadataRow = leftKey ? left : rightKey ? right : null;
  const localRow = leftKey ? right : rightKey ? left : null;
  if (metadataRow && filenameMatchesMetadata({
    parsed_title: localRow.title,
    original_name: localRow.title,
    normalized_name: localRow.title,
  }, metadataRow)) {
    return { status: "STRONG_SAME_MOVIE", reason: "trusted-metadata-title-year-and-alias-match", evidence: [externalKey(metadataRow)] };
  }
  const leftTitles = new Set(metadataTitles(left));
  const rightTitles = new Set(metadataTitles(right));
  if ([...leftTitles].some((title) => rightTitles.has(title)) && left.metadata_status === "matched" && right.metadata_status === "matched") {
    return { status: "STRONG_SAME_MOVIE", reason: "matching-verified-title-year", evidence: [...leftTitles].filter((title) => rightTitles.has(title)) };
  }
  if (fold(left.title) === fold(right.title) && left.metadata_status === "matched" && right.metadata_status === "matched") {
    return { status: "STRONG_SAME_MOVIE", reason: "matching-verified-title-year", evidence: [fold(left.title)] };
  }
  return { status: "AMBIGUOUS", reason: "filename-or-title-year-only", evidence: [] };
}

function canonicalScore(media) {
  return [
    isTrustedExternal(media) ? 100000 : 0,
    media.metadata_status === "matched" ? 10000 : 0,
    Number(media.metadata_confidence || 0) * 1000,
    media.poster_url ? 100 : 0,
    media.overview ? 50 : 0,
    media.release_date ? 25 : 0,
    Number(media.id || 0) ? -Number(media.id) / 1000000 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function selectCanonical(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError("selectCanonical requires rows");
  return [...rows].sort((left, right) => canonicalScore(right) - canonicalScore(left) || Number(left.id) - Number(right.id))[0];
}

function planGroup(rows, filesByMediaId = new Map()) {
  const canonical = selectCanonical(rows);
  const comparisons = rows.filter((row) => row.id !== canonical.id).map((row) => ({
    source: row.id,
    target: canonical.id,
    ...compareMedia(row, canonical, { filesByMediaId }),
  }));
  const mergeable = comparisons.filter((item) => item.status === "PROVEN_SAME_MOVIE" || item.status === "STRONG_SAME_MOVIE");
  const rejected = comparisons.filter((item) => item.status !== "PROVEN_SAME_MOVIE" && item.status !== "STRONG_SAME_MOVIE");
  return {
    canonical: { id: canonical.id, title: canonical.title, external_source: canonical.external_source || null, external_id: canonical.external_id || null },
    source_ids: rows.filter((row) => row.id !== canonical.id).map((row) => row.id),
    mergeable,
    rejected,
    files_to_reassign: mergeable.flatMap((item) => [...(filesByMediaId.get(item.source) || [])].map((file) => file.id)),
    status: rejected.length ? (mergeable.length ? "PARTIAL" : "AMBIGUOUS") : "SAFE",
  };
}

module.exports = {
  compareMedia,
  externalKey,
  fold,
  filenameMatchesMetadata,
  planGroup,
  selectCanonical,
};
