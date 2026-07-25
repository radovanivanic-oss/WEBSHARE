const { acquireCrawlerLock } = require("../../lib/crawler/lock");

try {
  const lock = acquireCrawlerLock(process.argv[2], "child-run", {
    recoverStale: process.argv.includes("--recover-stale"),
  });
  process.stdout.write("LOCKED\n");
  setTimeout(() => {
    lock.release();
    process.stdout.write("RELEASED\n");
  }, 500);
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exitCode = 3;
}
