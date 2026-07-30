const { acquireCrawlerLock } = require("../../lib/crawler/lock");

try {
  const lock = acquireCrawlerLock(process.argv[2], "child-run", {
    recoverStale: process.argv.includes("--recover-stale"),
  });
  process.stdout.write("LOCKED\n");
  setTimeout(() => {
    lock.release();
    // Keep the child alive until the pipe flushes. The Windows test runner can
    // otherwise observe the exit event before the final stdout data event.
    process.stdout.write("RELEASED\n", () => process.exit(0));
  }, 500);
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exitCode = 3;
}
