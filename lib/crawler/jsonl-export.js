const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { once } = require("events");
const {
  buildUnverifiedCrawlerManifest,
  fileFingerprint,
} = require("../catalog-safety");

async function writeLine(stream, line) {
  if (!stream.write(line)) {
    await once(stream, "drain");
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function exportRunJsonl(options) {
  const { itemStore, run, fault = null } = options;
  const shouldAbort =
    typeof options.shouldAbort === "function"
      ? options.shouldAbort
      : () => false;
  const resolvedOutput = path.resolve(options.outputPath);
  const resolvedManifest = path.resolve(options.manifestPath);
  const finalDirectory = path.dirname(resolvedOutput);
  if (path.dirname(resolvedManifest) !== finalDirectory) {
    throw new Error("JSONL a manifest musia byť v rovnakom export adresári.");
  }
  if (fs.existsSync(finalDirectory)) {
    throw new Error(`Export destination už existuje: ${finalDirectory}`);
  }

  const parentDirectory = path.dirname(finalDirectory);
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporaryDirectory = path.join(
    parentDirectory,
    `.tmp-${path.basename(finalDirectory)}-${process.pid}-${crypto.randomUUID()}`
  );
  fs.mkdirSync(temporaryDirectory, { mode: 0o750 });
  const temporaryOutput = path.join(
    temporaryDirectory,
    path.basename(resolvedOutput)
  );
  const temporaryManifest = path.join(
    temporaryDirectory,
    path.basename(resolvedManifest)
  );
  const stream = fs.createWriteStream(temporaryOutput, {
    flags: "wx",
    mode: 0o640,
  });
  const contentHash = crypto.createHash("sha256");
  let items = 0;

  try {
    for (const row of itemStore.iterateItems(run.run_id)) {
      if (shouldAbort()) {
        const error = new Error("Export prerušený kontrolovaným shutdownom.");
        error.code = "shutdown_requested";
        throw error;
      }
      const line = `${row.item_json}\n`;
      contentHash.update(line);
      await writeLine(stream, line);
      items += 1;
      if (fault) {
        await fault("after_export_item", { items, runId: run.run_id });
      }
    }
    stream.end();
    await once(stream, "close");
    if (Number(run.unique_items) !== items) {
      throw new Error(
        `Export item count ${items} nesedí s run.unique_items ${run.unique_items}.`
      );
    }
    const descriptor = fs.openSync(temporaryOutput, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    const stat = fs.statSync(temporaryOutput);
    const manifest = {
      ...buildUnverifiedCrawlerManifest({
        inputPath: temporaryOutput,
        stat,
        items,
        failedPrefixes: run.failed_count,
      }),
      source_path: resolvedOutput,
      source_fingerprint: fileFingerprint(temporaryOutput, stat),
      content_sha256: contentHash.digest("hex"),
      run_id: run.run_id,
      run_status: run.status,
      reconciliation_safe: false,
      is_full: false,
      completeness_reason:
        run.blocked_count > 0
          ? "blocked_prefixes_and_unverified_search_partition"
          : run.failed_count > 0
            ? "failed_prefixes_and_unverified_search_partition"
            : "webshare_search_partition_not_proven",
      blocked_prefixes: run.blocked_count,
      algorithm_fingerprint: run.algorithm_fingerprint,
    };
    fs.writeFileSync(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o640 }
    );
    const manifestDescriptor = fs.openSync(temporaryManifest, "r+");
    try {
      fs.fsyncSync(manifestDescriptor);
    } finally {
      fs.closeSync(manifestDescriptor);
    }
    fsyncDirectory(temporaryDirectory);
    if (fault) {
      await fault("before_export_publish", {
        items,
        runId: run.run_id,
        sourceSize: stat.size,
      });
    }
    if (shouldAbort()) {
      const error = new Error(
        "Export nebol publikovaný pre kontrolovaný shutdown."
      );
      error.code = "shutdown_requested";
      throw error;
    }
    fs.renameSync(temporaryDirectory, finalDirectory);
    let durabilityWarning = null;
    try {
      fsyncDirectory(parentDirectory);
    } catch (error) {
      // rename() is the publication commit point. Once it succeeds, deleting
      // or reporting the valid export as unpublished would be incorrect. A
      // parent-directory fsync failure affects crash durability, not pair
      // consistency, and is therefore surfaced explicitly in the result.
      durabilityWarning = `Export bol publikovaný, parent fsync zlyhal: ${error.message}`;
    }
    return {
      outputPath: resolvedOutput,
      manifestPath: resolvedManifest,
      manifest,
      durabilityWarning,
    };
  } catch (error) {
    if (!stream.closed) {
      const closed = new Promise((resolve) => stream.once("close", resolve));
      stream.destroy();
      await closed;
    }
    if (fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

module.exports = { exportRunJsonl, fsyncDirectory };
