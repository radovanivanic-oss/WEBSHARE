const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");

const {
  CATEGORY_DEFINITIONS,
  CATEGORY_IDS,
  CATEGORY_TITLES,
  classifyCatalogItem,
} = require("./catalog-classifier");

const DEFAULT_CHUNK_SIZE = 50000;
const LOG_INTERVAL_ITEMS = 50000;

function createEmptyCategoryCounts() {
  return Object.fromEntries(CATEGORY_IDS.map((categoryId) => [categoryId, 0]));
}

async function ensureDirectoryForFile(filePath) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function removePathIfExists(targetPath) {
  await fsPromises.rm(targetPath, { recursive: true, force: true });
}

async function writeJsonFile(filePath, data) {
  await ensureDirectoryForFile(filePath);
  await fsPromises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeToStream(stream, chunk) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };

    stream.on("error", onError);

    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.on("drain", onDrain);
    }
  });
}

async function closeWritableStream(stream) {
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function closeGzipStream(gzipStream, fileStream) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      gzipStream.off("error", onError);
      fileStream.off("error", onError);
      fileStream.off("finish", onFinish);
    };
    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    gzipStream.once("error", onError);
    fileStream.once("error", onError);
    fileStream.once("finish", onFinish);
    gzipStream.end();
  });
}

class LegacyJsonExportWriter {
  constructor(outputPath, enabled) {
    this.outputPath = outputPath;
    this.enabled = enabled;
    this.count = 0;
    this.jsonStream = null;
    this.gzipStream = null;
    this.gzipFileStream = null;
    this.jsonTempPath = `${outputPath}.tmp`;
    this.gzipOutputPath = `${outputPath}.gz`;
    this.gzipTempPath = `${this.gzipOutputPath}.tmp`;
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    await ensureDirectoryForFile(this.outputPath);
    await ensureDirectoryForFile(this.gzipOutputPath);

    this.jsonStream = fs.createWriteStream(this.jsonTempPath, { encoding: "utf8" });
    this.gzipStream = zlib.createGzip();
    this.gzipFileStream = fs.createWriteStream(this.gzipTempPath);
    this.gzipStream.pipe(this.gzipFileStream);

    await writeToStream(this.jsonStream, "[\n");
    await writeToStream(this.gzipStream, "[\n");
  }

  async writeItem(item) {
    if (!this.enabled) {
      return;
    }

    const prefix = this.count === 0 ? "  " : ",\n  ";
    const chunk = `${prefix}${JSON.stringify(item)}`;
    await writeToStream(this.jsonStream, chunk);
    await writeToStream(this.gzipStream, chunk);
    this.count += 1;
  }

  async finish() {
    if (!this.enabled) {
      return;
    }

    await writeToStream(this.jsonStream, "\n]\n");
    await writeToStream(this.gzipStream, "\n]\n");
    await closeWritableStream(this.jsonStream);
    await closeGzipStream(this.gzipStream, this.gzipFileStream);
    await fsPromises.rename(this.jsonTempPath, this.outputPath);
    await fsPromises.rename(this.gzipTempPath, this.gzipOutputPath);
  }
}

class CategoryChunkWriter {
  constructor({ tempCatalogDir, categoryId, chunkSize }) {
    this.tempCatalogDir = tempCatalogDir;
    this.categoryId = categoryId;
    this.chunkSize = chunkSize;
    this.categoryDir = path.join(tempCatalogDir, categoryId);
    this.currentChunkNumber = 0;
    this.currentChunkCount = 0;
    this.totalCount = 0;
    this.chunks = [];
    this.gzipStream = null;
    this.fileStream = null;
  }

  async init() {
    await fsPromises.mkdir(this.categoryDir, { recursive: true });
  }

  get currentFileName() {
    return `${this.categoryId}-${String(this.currentChunkNumber).padStart(4, "0")}.json.gz`;
  }

  async startChunk() {
    this.currentChunkNumber += 1;
    this.currentChunkCount = 0;
    const filePath = path.join(this.categoryDir, this.currentFileName);
    this.gzipStream = zlib.createGzip();
    this.fileStream = fs.createWriteStream(filePath);
    this.gzipStream.pipe(this.fileStream);
    await writeToStream(this.gzipStream, "[\n");
  }

  async finishChunk() {
    if (!this.gzipStream || !this.fileStream) {
      return;
    }

    await writeToStream(this.gzipStream, "\n]\n");
    await closeGzipStream(this.gzipStream, this.fileStream);
    this.chunks.push({
      file: this.currentFileName,
      count: this.currentChunkCount,
    });
    this.gzipStream = null;
    this.fileStream = null;
    this.currentChunkCount = 0;
  }

  async writeItem(item) {
    if (!this.gzipStream || this.currentChunkCount >= this.chunkSize) {
      await this.finishChunk();
      await this.startChunk();
    }

    const prefix = this.currentChunkCount === 0 ? "  " : ",\n  ";
    await writeToStream(this.gzipStream, `${prefix}${JSON.stringify(item)}`);
    this.currentChunkCount += 1;
    this.totalCount += 1;
  }

  async finish() {
    await this.finishChunk();
  }

  manifest() {
    return {
      schemaVersion: 1,
      category: this.categoryId,
      title: CATEGORY_TITLES[this.categoryId] || this.categoryId,
      count: this.totalCount,
      chunks: this.chunks,
    };
  }
}

function normalizeChunkSize(value) {
  const parsed = Number.parseInt(value || String(DEFAULT_CHUNK_SIZE), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHUNK_SIZE;
}

function normalizeBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return String(value).toLowerCase() === "true";
}

function buildCatalogPaths(outputPath) {
  const outputDir = path.dirname(outputPath);
  return {
    outputDir,
    catalogDir: path.join(outputDir, "catalog"),
    tempCatalogDir: path.join(outputDir, `catalog.tmp-${process.pid}-${Date.now()}`),
  };
}

function createExportSummary({ generatedAt, totalItems, chunkSize, categoryWriters }) {
  const categories = CATEGORY_DEFINITIONS.map((category) => {
    const writer = categoryWriters.get(category.id);
    return {
      id: category.id,
      title: category.title,
      count: writer.totalCount,
      manifest: `${category.id}/manifest.json`,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    totalItems,
    chunkSize,
    categories,
  };
}

async function writeManifests(tempCatalogDir, rootManifest, categoryWriters) {
  for (const category of CATEGORY_DEFINITIONS) {
    const writer = categoryWriters.get(category.id);
    await writeJsonFile(
      path.join(tempCatalogDir, category.id, "manifest.json"),
      writer.manifest()
    );
  }

  await writeJsonFile(path.join(tempCatalogDir, "manifest.json"), rootManifest);
}

async function publishCatalogDirectoryAtomically({ tempCatalogDir, catalogDir }) {
  const parentDir = path.dirname(catalogDir);
  const backupDir = path.join(
    parentDir,
    `catalog.previous-${process.pid}-${Date.now()}`
  );
  let backupCreated = false;

  try {
    if (await pathExists(catalogDir)) {
      await fsPromises.rename(catalogDir, backupDir);
      backupCreated = true;
    }

    await fsPromises.rename(tempCatalogDir, catalogDir);

    if (backupCreated) {
      await removePathIfExists(backupDir);
    }
  } catch (error) {
    if (backupCreated && !(await pathExists(catalogDir)) && (await pathExists(backupDir))) {
      await fsPromises.rename(backupDir, catalogDir);
    }
    throw error;
  }
}

function isValidCatalogItem(item) {
  return Boolean(
    item &&
      item.id &&
      item.name &&
      Number.isFinite(item.size) &&
      item.size > 0 &&
      (item.url || item.direct_url)
  );
}

async function exportClassifiedCatalog(options) {
  const {
    catalogJsonlPath,
    outputPath,
    chunkSize = DEFAULT_CHUNK_SIZE,
    exportLegacyAll = true,
    logger,
    getMemoryUsage = () => ({}),
  } = options;

  const generatedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const { catalogDir, tempCatalogDir } = buildCatalogPaths(outputPath);
  const normalizedChunkSize = normalizeChunkSize(chunkSize);
  const legacyWriter = new LegacyJsonExportWriter(outputPath, exportLegacyAll);
  const categoryWriters = new Map(
    CATEGORY_IDS.map((categoryId) => [
      categoryId,
      new CategoryChunkWriter({
        tempCatalogDir,
        categoryId,
        chunkSize: normalizedChunkSize,
      }),
    ])
  );

  const stats = {
    phase: "classify",
    total: 0,
    classifiedItems: 0,
    invalidJsonLines: 0,
    invalidItems: 0,
    categoryCounts: createEmptyCategoryCounts(),
    chunksCreated: 0,
    durationSeconds: 0,
  };

  await removePathIfExists(tempCatalogDir);
  await fsPromises.mkdir(tempCatalogDir, { recursive: true });

  try {
    for (const writer of categoryWriters.values()) {
      await writer.init();
    }
    await legacyWriter.init();

    const input = readline.createInterface({
      input: fs.createReadStream(catalogJsonlPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of input) {
      if (!line.trim()) {
        continue;
      }

      let item;
      try {
        item = JSON.parse(line);
      } catch (error) {
        stats.invalidJsonLines += 1;
        continue;
      }

      if (!isValidCatalogItem(item)) {
        stats.invalidItems += 1;
        continue;
      }

      const classification = classifyCatalogItem(item);
      const categoryId = categoryWriters.has(classification.category)
        ? classification.category
        : "unknown";
      const exportItem = {
        ...item,
        catalogCategory: categoryId,
        classificationConfidence: classification.confidence,
        classificationReason: classification.reason,
      };

      await categoryWriters.get(categoryId).writeItem(exportItem);
      await legacyWriter.writeItem(exportItem);

      stats.total += 1;
      stats.classifiedItems += 1;
      stats.categoryCounts[categoryId] += 1;

      if (stats.total % LOG_INTERVAL_ITEMS === 0 && logger) {
        stats.chunksCreated = Array.from(categoryWriters.values()).reduce(
          (sum, writer) => sum + writer.chunks.length + (writer.currentChunkCount > 0 ? 1 : 0),
          0
        );
        logger.info("Klasifikujem katalóg.", {
          phase: "classify",
          classifiedItems: stats.classifiedItems,
          categoryCounts: stats.categoryCounts,
          currentChunks: stats.chunksCreated,
          invalidJsonLines: stats.invalidJsonLines,
          invalidItems: stats.invalidItems,
          memory: getMemoryUsage(),
        });
      }
    }

    for (const writer of categoryWriters.values()) {
      await writer.finish();
    }
    await legacyWriter.finish();

    stats.chunksCreated = Array.from(categoryWriters.values()).reduce(
      (sum, writer) => sum + writer.chunks.length,
      0
    );
    stats.phase = "export";

    const rootManifest = createExportSummary({
      generatedAt,
      totalItems: stats.total,
      chunkSize: normalizedChunkSize,
      categoryWriters,
    });
    await writeManifests(tempCatalogDir, rootManifest, categoryWriters);
    await publishCatalogDirectoryAtomically({ tempCatalogDir, catalogDir });

    stats.phase = "done";
    stats.durationSeconds = Math.round((Date.now() - startedAtMs) / 1000);

    return {
      generatedAt,
      total: stats.total,
      chunkSize: normalizedChunkSize,
      catalogDir,
      manifestPath: path.join(catalogDir, "manifest.json"),
      exportLegacyAll,
      legacyCount: legacyWriter.count,
      categoryCounts: stats.categoryCounts,
      chunksCreated: stats.chunksCreated,
      invalidJsonLines: stats.invalidJsonLines,
      invalidItems: stats.invalidItems,
      durationSeconds: stats.durationSeconds,
      memory: getMemoryUsage(),
    };
  } catch (error) {
    await removePathIfExists(tempCatalogDir);
    throw error;
  }
}

module.exports = {
  CATEGORY_DEFINITIONS,
  CATEGORY_IDS,
  CATEGORY_TITLES,
  DEFAULT_CHUNK_SIZE,
  exportClassifiedCatalog,
  isValidCatalogItem,
  normalizeBoolean,
  normalizeChunkSize,
};
