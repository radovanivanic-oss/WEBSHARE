const assert = require("node:assert/strict");
const test = require("node:test");
const { parseArguments } = require("../scripts/enrich-metadata");

test("metadata enrichment can prioritize recent movie candidates", () => {
  assert.deepEqual(
    parseArguments(["--only-pending", "--recent-first", "--limit", "250"]),
    {
      limit: 250,
      dryRun: false,
      retryFailed: false,
      onlyPending: true,
      recentFirst: true,
      provider: "tmdb",
      maxAttempts: 3,
    }
  );
});
