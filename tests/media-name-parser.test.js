const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCandidate } = require("../lib/candidate-grouper");
const { parseMediaName } = require("../lib/media-name-parser");
const { diceCoefficient, selectBestMatch } = require("../lib/match-scorer");

test("parses movie technical metadata", () => {
  const parsed = parseMediaName("Dune.Part.Two.2024.2160p.WEB-DL.DV.HDR.HEVC.CZ.EN.mkv");
  assert.equal(parsed.title, "Dune Part Two");
  assert.equal(parsed.year, 2024);
  assert.equal(parsed.candidateType, "movie");
  assert.equal(parsed.resolution, "2160p");
  assert.equal(parsed.source, "WEB-DL");
  assert.equal(parsed.videoCodec, "HEVC");
  assert.equal(parsed.hdr, true);
  assert.equal(parsed.dolbyVision, true);
  assert.deepEqual(parsed.languages, ["CZ", "EN"]);
});

test("parses episode and groups versions", () => {
  const first = parseMediaName("The.Last.of.Us.S01E03.1080p.WEB-DL.x265.CZ.EN.mkv");
  const second = parseMediaName("The Last of Us S01E03 2160p BluRay SK.mkv");
  assert.equal(first.title, "The Last of Us");
  assert.equal(first.candidateType, "episode");
  assert.equal(first.season, 1);
  assert.equal(first.episode, 3);
  assert.equal(buildCandidate(first).candidateKey, buildCandidate(second).candidateKey);
  assert.equal(buildCandidate(first).lookupKey, "tv|the-last-of-us");
});

test("recognizes special candidate types without forcing a movie", () => {
  assert.equal(parseMediaName("Metallica.Live.in.Moscow.1991.mkv").candidateType, "concert");
  assert.equal(parseMediaName("Formula.1.2026.Round.05.mkv").candidateType, "sports");
  assert.equal(parseMediaName("Planet.Earth.II.S01E01.mkv").candidateType, "episode");
  assert.equal(parseMediaName("Some.Random.Video.File.mkv").candidateType, "unknown");
});

test("normalizes extension and weak files safely", () => {
  assert.equal(parseMediaName("Movie.File", { extension: ".MP4" }).extension, "mp4");
  assert.equal(parseMediaName("Movie.File.mkv", { extension: "video" }).extension, "mkv");
  const archive = parseMediaName("Movie.2024.zip");
  assert.equal(archive.isVideoExtension, false);
  assert.ok(archive.confidence <= 0.35);
});

test("metadata matcher prefers exact title and year", () => {
  const candidate = { title: "Dune Part Two", parsedYear: 2024 };
  const selection = selectBestMatch(candidate, [
    { id: 1, title: "Dune", release_date: "1984-01-01", popularity: 80 },
    { id: 2, title: "Dune: Part Two", release_date: "2024-03-01", popularity: 50 },
  ], "movie", { auto: 0.85, ambiguous: 0.7 });
  assert.equal(selection.best.result.id, 2);
  assert.equal(selection.status, "matched");
  assert.ok(diceCoefficient("Černobyl", "Cernobyl") > 0.9);
});

test("metadata matcher does not auto-match a wrong remake", () => {
  const selection = selectBestMatch(
    { title: "The Thing", parsedYear: 1982 },
    [{ id: 1, title: "The Thing", release_date: "2011-01-01", popularity: 100 }],
    "movie",
    { auto: 0.9, ambiguous: 0.72 }
  );
  assert.notEqual(selection.status, "matched");
});
