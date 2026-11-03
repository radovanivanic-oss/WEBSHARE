const assert = require("node:assert/strict");
const test = require("node:test");
const { selectBestMatch } = require("../lib/match-scorer");

test("exact type-correct title is accepted without a year", () => {
  const result = selectBestMatch(
    { title: "Reacher", parsedYear: null },
    [{ id: 108978, name: "Reacher", first_air_date: "2022-02-04", popularity: 1 }],
    "tv",
    { auto: 0.9, ambiguous: 0.72 }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.best.result.id, 108978);
});

test("same-title type-correct remakes remain ambiguous", () => {
  const result = selectBestMatch(
    { title: "The Office", parsedYear: null },
    [
      { id: 1, name: "The Office", first_air_date: "2001-01-01", popularity: 1 },
      { id: 2, name: "The Office", first_air_date: "2005-01-01", popularity: 1 },
    ],
    "tv",
    { auto: 0.9, ambiguous: 0.72 }
  );
  assert.equal(result.status, "ambiguous");
});

test("exact dated show wins over an undated same-title placeholder", () => {
  const result = selectBestMatch(
    { title: "Gold Rush", parsedYear: null },
    [
      { id: 34634, name: "Zlatá horúčka", original_name: "Gold Rush", first_air_date: "2010-12-03", popularity: 44 },
      { id: 10220, name: "Gold Rush", original_name: "Gold Rush", first_air_date: "", popularity: 0.3 },
    ],
    "tv",
    { auto: 0.9, ambiguous: 0.72 }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.best.result.id, 34634);
});
