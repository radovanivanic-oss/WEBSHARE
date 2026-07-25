const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  getCrawlerV2Config,
  STATE_SCHEMA_VERSION,
} = require("../lib/crawler/config");
const { exportRunJsonl } = require("../lib/crawler/jsonl-export");
const { createStores } = require("../lib/crawler/orchestrator");
const { openCrawlerDatabase } = require("../lib/crawler/state-db");

function parseCount(argv = process.argv.slice(2)) {
  const argument = argv.find((entry) => entry.startsWith("--items="));
  const count = Number(argument?.split("=")[1] || 100_000);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
    throw new Error("--items musí byť celé číslo 1..1000000.");
  }
  return count;
}

function representativeItem(index) {
  const ident = index.toString(36).padStart(10, "0").slice(-10);
  const episode = String((index % 24) + 1).padStart(2, "0");
  const name =
    index % 3 === 0
      ? `Český a slovenský seriál S${String((index % 12) + 1).padStart(2, "0")}E${episode} 2024 2160p WEB-DL Dolby.Vision HDR HEVC CZ.EN release-group-${index}.mkv`
      : `Representative Feature Film ${index} (2023) 1080p BluRay x265 DTS-HD MA CZ titulky extended-cut-group.mkv`;
  return {
    id: ident,
    ident,
    name,
    title: name,
    size: 734003200 + index * 4096,
    extension: "mkv",
    mime: "video/x-matroska",
    type: "mkv",
    img: `https://img.webshare.cz/static/p/${String(index % 1000000).padStart(6, "0")}/${ident}-S.jpg`,
    stripe: `https://img.webshare.cz/static/p/${String(index % 1000000).padStart(6, "0")}/${ident}-M.jpg`,
    stripe_count: 10,
    queued: 0,
    positive_votes: index % 97,
    negative_votes: index % 7,
    password_protected: false,
    category: "video",
    source: "webshare",
    needsFileLink: true,
    url: `webshare://${ident}`,
    direct_url: null,
  };
}

function existingFileBytes(paths) {
  return paths
    .filter((filePath) => fs.existsSync(filePath))
    .reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
}

async function runBenchmark(count = parseCount()) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-crawler-benchmark-")
  );
  const pageSize = 100;
  const config = getCrawlerV2Config({
    runtimeDir: directory,
    algorithm: {
      roots: ["bench"],
      pageSize,
      serverResultCap: count + pageSize + 1,
      maxPagesPerPrefix: Math.ceil(count / pageSize) + 2,
    },
  });
  const beforeHeap = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  let database;
  try {
    database = openCrawlerDatabase(config.stateDbPath);
    const stores = createStores(database);
    const runId = "representative-benchmark";
    stores.runStore.createRun({
      schemaVersion: STATE_SCHEMA_VERSION,
      algorithmVersion: config.algorithm.algorithmVersion,
      algorithmFingerprint: config.algorithmFingerprint,
      partitionCompletenessProven: false,
      rootPrefixCount: 1,
    }, runId);
    stores.frontierStore.seedRoots(runId, ["bench"]);
    const owner = "benchmark-worker";
    stores.frontierStore.lease(runId, owner, 3_600_000);
    let rawJsonBytes = 0;
    for (let offset = 0; offset < count; offset += pageSize) {
      const pageCount = Math.min(pageSize, count - offset);
      const items = Array.from({ length: pageCount }, (_, index) =>
        representativeItem(offset + index)
      );
      rawJsonBytes += items.reduce(
        (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
        0
      );
      stores.itemStore.commitPage({
        runId,
        prefix: "bench",
        depth: 1,
        leaseOwner: owner,
        offset,
        reportedTotal: count,
        items,
      });
    }
    stores.itemStore.commitPage({
      runId,
      prefix: "bench",
      depth: 1,
      leaseOwner: owner,
      offset: count,
      reportedTotal: count,
      items: [],
    });
    stores.frontierStore.complete(runId, "bench", 1, owner);

    const failureCount = Math.max(1, Math.floor(count / 10_000));
    const insertFailure = database.prepare(`
      INSERT INTO crawl_failures (
        run_id, prefix, depth, attempt_count, failure_class,
        error_code, error_message, created_at
      ) VALUES (?, ?, 1, 1, 'temporary', 'ETIMEDOUT', ?, ?)
    `);
    const failureTransaction = database.transaction(() => {
      for (let index = 0; index < failureCount; index += 1) {
        insertFailure.run(
          runId,
          `benchmark-failure-${index}`,
          "Anonymized representative transient failure",
          new Date().toISOString()
        );
      }
    });
    failureTransaction.immediate();

    const finalizedRun = stores.runStore.finalize(runId);
    const outputPath = path.join(
      directory,
      "exports",
      "benchmark",
      "catalog-items.jsonl"
    );
    const manifestPath = path.join(
      directory,
      "exports",
      "benchmark",
      "catalog-items.manifest.json"
    );
    await exportRunJsonl({
      itemStore: stores.itemStore,
      run: finalizedRun,
      outputPath,
      manifestPath,
    });

    const elapsedSeconds =
      Number(process.hrtime.bigint() - started) / 1_000_000_000;
    const sqliteFiles = [
      config.stateDbPath,
      `${config.stateDbPath}-wal`,
      `${config.stateDbPath}-shm`,
    ];
    const sqliteBytes = existingFileBytes(sqliteFiles);
    const exportBytes = existingFileBytes([outputPath, manifestPath]);
    return {
      profile: "representative-normalized-item-v1",
      items: stores.itemStore.countItems(runId),
      average_item_json_bytes: Math.round(rawJsonBytes / count),
      pages: database
        .prepare("SELECT COUNT(*) AS count FROM crawl_pages WHERE run_id = ?")
        .get(runId).count,
      commits: database
        .prepare("SELECT COUNT(*) AS count FROM crawl_commits WHERE run_id = ?")
        .get(runId).count,
      failure_rows: failureCount,
      elapsed_seconds: Number(elapsedSeconds.toFixed(3)),
      items_per_second: Math.round(count / elapsedSeconds),
      database_bytes: fs.statSync(config.stateDbPath).size,
      wal_bytes: fs.existsSync(`${config.stateDbPath}-wal`)
        ? fs.statSync(`${config.stateDbPath}-wal`).size
        : 0,
      shm_bytes: fs.existsSync(`${config.stateDbPath}-shm`)
        ? fs.statSync(`${config.stateDbPath}-shm`).size
        : 0,
      sqlite_files_bytes: sqliteBytes,
      jsonl_bytes: fs.statSync(outputPath).size,
      manifest_bytes: fs.statSync(manifestPath).size,
      live_storage_bytes: sqliteBytes + exportBytes,
      export_temporary_generation_bytes: exportBytes,
      peak_storage_during_export_bytes: sqliteBytes + exportBytes,
      heap_delta_bytes: process.memoryUsage().heapUsed - beforeHeap,
    };
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runBenchmark()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = { parseCount, representativeItem, runBenchmark };
