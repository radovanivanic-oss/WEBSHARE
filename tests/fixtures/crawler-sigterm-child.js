const path = require("path");
const { getCrawlerV2Config } = require("../../lib/crawler/config");
const { executeCrawler } = require("../../lib/crawler/orchestrator");

async function main() {
  const runtimeDir = path.resolve(process.argv[2]);
  const config = getCrawlerV2Config({
    runtimeDir,
    leaseDurationMs: 5_000,
    workerConcurrency: 1,
    algorithm: {
      roots: ["signal"],
      pageSize: 2,
      serverResultCap: 100,
      maxPagesPerPrefix: 10,
    },
  });
  let announced = false;
  const result = await executeCrawler({
    command: "crawl",
    config,
    transport: {
      async fetchPage() {
        if (!announced) {
          announced = true;
          process.stdout.write("READY\n");
          setTimeout(() => process.emit("SIGTERM", "SIGTERM"), 20);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          total: 1,
          files: [{ ident: "signal-item", name: "Signal item.mkv" }],
        };
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
