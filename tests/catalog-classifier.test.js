const assert = require("assert");
const {
  classifyCatalogItem,
  normalizeTitleForClassification,
} = require("../lib/catalog-classifier");

function item(name, extra = {}) {
  return {
    id: name,
    ident: name,
    name,
    title: name,
    size: 1024,
    url: `webshare://${name}`,
    ...extra,
  };
}

function expectCategory(name, expectedCategory) {
  const result = classifyCatalogItem(item(name));
  assert.strictEqual(
    result.category,
    expectedCategory,
    `${name} should be ${expectedCategory}, got ${result.category} (${result.reason})`
  );
  assert.strictEqual(typeof result.confidence, "number");
  assert.ok(result.reason);
}

expectCategory("The.Last.of.Us.S01E03.1080p.WEB-DL.mkv", "series");
expectCategory("Planet.Earth.II.S01E01.Documentary.mkv", "series");
expectCategory("Metallica.Live.in.Moscow.1991.1080p.mkv", "concerts");
expectCategory("Formula.1.2026.Round.05.mkv", "sports");
expectCategory("Dune.Part.Two.2024.2160p.WEB-DL.mkv", "movies");
expectCategory("Some.Random.Video.File.mkv", "unknown");
expectCategory("BBC.Documentary.Nature.2020.1080p.mkv", "documentaries");
expectCategory("Artist.Official.Video.2024.mkv", "music-videos");
expectCategory("Rozpravka.Pre.Deti.2019.mkv", "kids");

assert.strictEqual(
  normalizeTitleForClassification(item("Dune%20Part%20Two%202024.WEB-DL.mkv")),
  "dune part two 2024 web dl"
);
assert.strictEqual(
  normalizeTitleForClassification(item("Rozprávka&nbsp;Pre_Deti.mkv")),
  "rozpravka pre deti"
);

console.log("catalog-classifier tests OK");
