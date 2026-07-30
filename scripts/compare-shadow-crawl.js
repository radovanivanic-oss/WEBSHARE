#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const MAX_DISTRIBUTION_KEYS = 256;
const MAX_DISTRIBUTION_KEY_LENGTH = 80;
const SQLITE_BATCH_LINES = 2000;
const ALLOWED_ARGUMENTS = new Set([
  "--shadow-jsonl",
  "--legacy-jsonl",
  "--output-report",
]);

function comparisonPathKey(value) {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!ALLOWED_ARGUMENTS.has(key)) throw new Error(`Neznámy argument: ${key}`);
    if (Object.hasOwn(result, key)) {
      throw new Error(`Argument ${key} bol zadaný viackrát.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument ${key} vyžaduje hodnotu.`);
    }
    result[key] = value;
    index += 1;
  }
  for (const required of ALLOWED_ARGUMENTS) {
    if (!result[required]) throw new Error(`Chýba ${required}.`);
  }
  return {
    shadowJsonl: path.resolve(result["--shadow-jsonl"]),
    legacyJsonl: path.resolve(result["--legacy-jsonl"]),
    outputReport: path.resolve(result["--output-report"]),
  };
}

function sameExistingFile(left, right) {
  if (comparisonPathKey(left) === comparisonPathKey(right)) return true;
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
    return true;
  }
  return (
    comparisonPathKey(fs.realpathSync.native(left)) ===
    comparisonPathKey(fs.realpathSync.native(right))
  );
}

function normalizeDistributionKey(key) {
  return (
    String(key || "unknown")
      .trim()
      .toLowerCase()
      .normalize("NFC")
      .slice(0, MAX_DISTRIBUTION_KEY_LENGTH) || "unknown"
  );
}

function increment(distribution, key) {
  const normalized = normalizeDistributionKey(key);
  if (distribution.has(normalized)) {
    distribution.set(normalized, distribution.get(normalized) + 1);
    return;
  }
  if (distribution.size < MAX_DISTRIBUTION_KEYS) {
    distribution.set(normalized, 1);
    return;
  }
  distribution.set("__other__", (distribution.get("__other__") || 0) + 1);
}

function objectFromMap(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
}

function itemPrefix(item) {
  const name = String(item?.name || item?.title || "").trim().toLowerCase();
  if (!name) return "unknown";
  const first = [...name][0];
  if (/^[a-z0-9]$/.test(first)) return first;
  if (/\s/u.test(first)) return "whitespace";
  if (/^[._()[\]\-_]$/.test(first)) return `punct:${first}`;
  return "other_unicode_or_symbol";
}

async function* boundedLines(inputPath, maxLineBytes = MAX_JSONL_LINE_BYTES) {
  const stream = fs.createReadStream(inputPath, {
    highWaterMark: 64 * 1024,
  });
  let fragments = [];
  let bufferedBytes = 0;
  let oversized = false;
  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline === -1 ? chunk.length : newline;
      let segment = chunk.subarray(cursor, end);
      if (!oversized) {
        if (bufferedBytes + segment.length > maxLineBytes) {
          fragments = [];
          bufferedBytes = 0;
          oversized = true;
        } else if (segment.length) {
          fragments.push(segment);
          bufferedBytes += segment.length;
        }
      }
      if (newline !== -1) {
        if (oversized) {
          yield { oversized: true, line: null };
        } else {
          let line = Buffer.concat(fragments, bufferedBytes);
          if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
          yield { oversized: false, line: line.toString("utf8") };
        }
        fragments = [];
        bufferedBytes = 0;
        oversized = false;
        cursor = newline + 1;
      } else {
        cursor = chunk.length;
      }
    }
  }
  if (oversized) {
    yield { oversized: true, line: null };
  } else if (bufferedBytes > 0) {
    yield {
      oversized: false,
      line: Buffer.concat(fragments, bufferedBytes).toString("utf8"),
    };
  }
}

async function streamIntoDatabase(options) {
  const {
    inputPath,
    insert,
    database,
    label,
    comparablePrefixes = null,
    shadowPrefixes = null,
    updateComparable = null,
    maxLineBytes = MAX_JSONL_LINE_BYTES,
  } = options;
  const metrics = {
    lines: 0,
    invalidLines: 0,
    oversizedLines: 0,
    duplicateLines: 0,
    comparableLines: 0,
    extension: new Map(),
    category: new Map(),
    prefix: new Map(),
  };
  let inTransaction = false;
  let pending = 0;
  const begin = () => {
    database.exec("BEGIN IMMEDIATE");
    inTransaction = true;
  };
  const commit = () => {
    database.exec("COMMIT");
    inTransaction = false;
    pending = 0;
  };
  begin();
  try {
    for await (const entry of boundedLines(inputPath, maxLineBytes)) {
      metrics.lines += 1;
      if (entry.oversized) {
        metrics.invalidLines += 1;
        metrics.oversizedLines += 1;
        continue;
      }
      if (!entry.line.trim()) continue;
      let item;
      try {
        item = JSON.parse(entry.line);
        if (!item || typeof item.ident !== "string" || !item.ident.trim()) {
          throw new Error("missing ident");
        }
      } catch {
        metrics.invalidLines += 1;
        continue;
      }
      const prefix = itemPrefix(item);
      if (shadowPrefixes) shadowPrefixes.add(prefix);
      const comparable =
        !comparablePrefixes || comparablePrefixes.has(prefix) ? 1 : 0;
      const result = comparablePrefixes
        ? insert.run(item.ident, comparable)
        : insert.run(item.ident);
      if (result.changes === 0) {
        metrics.duplicateLines += 1;
        if (comparable && updateComparable) {
          const promoted = updateComparable.run(item.ident);
          if (promoted.changes === 1) metrics.comparableLines += 1;
        }
      } else if (comparable) {
        metrics.comparableLines += 1;
      }
      increment(metrics.extension, item.extension || item.type);
      increment(metrics.category, item.category);
      increment(metrics.prefix, prefix);
      pending += 1;
      if (pending >= SQLITE_BATCH_LINES) {
        commit();
        begin();
      }
    }
    commit();
  } catch (error) {
    if (inTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return {
    label,
    lines: metrics.lines,
    invalid_lines: metrics.invalidLines,
    oversized_lines: metrics.oversizedLines,
    duplicate_lines: metrics.duplicateLines,
    comparable_unique_lines: metrics.comparableLines,
    distribution_key_limit: MAX_DISTRIBUTION_KEYS,
    extension_distribution: objectFromMap(metrics.extension),
    category_distribution: objectFromMap(metrics.category),
    prefix_distribution: objectFromMap(metrics.prefix),
  };
}

function validatePaths(options) {
  for (const input of [options.shadowJsonl, options.legacyJsonl]) {
    if (!fs.statSync(input).isFile()) {
      throw new Error(`Vstup nie je súbor: ${input}`);
    }
  }
  if (sameExistingFile(options.shadowJsonl, options.legacyJsonl)) {
    throw new Error("Shadow a legacy vstup nesmú byť rovnaký súbor.");
  }
  if (
    sameExistingFile(options.outputReport, options.shadowJsonl) ||
    sameExistingFile(options.outputReport, options.legacyJsonl)
  ) {
    throw new Error("Output report nesmie prepísať žiadny vstupný JSONL.");
  }
  if (fs.existsSync(options.outputReport)) {
    throw new Error(`Output report už existuje: ${options.outputReport}`);
  }
}

async function compareShadowCrawl(options) {
  const resolvedOptions = {
    ...options,
    shadowJsonl: path.resolve(options.shadowJsonl),
    legacyJsonl: path.resolve(options.legacyJsonl),
    outputReport: path.resolve(options.outputReport),
  };
  validatePaths(resolvedOptions);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "webshare-shadow-compare-")
  );
  const temporaryIdentity = fs.lstatSync(temporaryRoot);
  const databasePath = path.join(temporaryRoot, "compare.sqlite");
  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.exec(`
      CREATE TABLE shadow_idents (
        ident TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TABLE legacy_idents (
        ident TEXT PRIMARY KEY,
        comparable INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
    `);
    const shadowPrefixes = new Set();
    const shadowMetrics = await streamIntoDatabase({
      inputPath: resolvedOptions.shadowJsonl,
      insert: database.prepare(
        "INSERT OR IGNORE INTO shadow_idents(ident) VALUES (?)"
      ),
      database,
      label: "shadow",
      shadowPrefixes,
      maxLineBytes: options.maxLineBytes,
    });
    const legacyMetrics = await streamIntoDatabase({
      inputPath: resolvedOptions.legacyJsonl,
      insert: database.prepare(
        "INSERT OR IGNORE INTO legacy_idents(ident, comparable) VALUES (?, ?)"
      ),
      database,
      label: "legacy",
      comparablePrefixes: shadowPrefixes,
      updateComparable: database.prepare(
        "UPDATE legacy_idents SET comparable = 1 WHERE ident = ? AND comparable = 0"
      ),
      maxLineBytes: options.maxLineBytes,
    });

    const scalar = (sql) => Number(database.prepare(sql).get().count);
    const report = {
      generated_at: new Date().toISOString(),
      comparison_is_not_reconciliation: true,
      legacy_only_is_not_deletion: true,
      scope_note:
        "Bounded shadow rozsah nie je úplný katalóg; legacy-only je iba pozorovanie absencie v tomto výreze a nikdy nie pokyn na odstránenie.",
      shadow_unique_idents: scalar(
        "SELECT COUNT(*) AS count FROM shadow_idents"
      ),
      legacy_unique_idents: scalar(
        "SELECT COUNT(*) AS count FROM legacy_idents"
      ),
      legacy_unique_idents_in_comparable_prefixes: scalar(
        "SELECT COUNT(*) AS count FROM legacy_idents WHERE comparable = 1"
      ),
      overlap: scalar(`
        SELECT COUNT(*) AS count
        FROM shadow_idents s
        INNER JOIN legacy_idents l ON l.ident = s.ident
      `),
      shadow_only: scalar(`
        SELECT COUNT(*) AS count
        FROM shadow_idents s
        LEFT JOIN legacy_idents l ON l.ident = s.ident
        WHERE l.ident IS NULL
      `),
      legacy_only: scalar(`
        SELECT COUNT(*) AS count
        FROM legacy_idents l
        LEFT JOIN shadow_idents s ON s.ident = l.ident
        WHERE s.ident IS NULL
      `),
      comparable_prefixes: [...shadowPrefixes].sort(),
      shadow: shadowMetrics,
      legacy: legacyMetrics,
    };
    fs.mkdirSync(path.dirname(resolvedOptions.outputReport), {
      recursive: true,
    });
    const temporaryReport = path.join(
      path.dirname(resolvedOptions.outputReport),
      `.tmp-${path.basename(resolvedOptions.outputReport)}-${process.pid}-${crypto.randomUUID()}`
    );
    try {
      const payload = `${JSON.stringify(report, null, 2)}\n`;
      fs.writeFileSync(temporaryReport, payload, {
        flag: "wx",
        mode: 0o640,
      });
      const descriptor = fs.openSync(temporaryReport, "r+");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (fs.existsSync(resolvedOptions.outputReport)) {
        throw new Error("Output report vznikol počas porovnania; nebude prepísaný.");
      }
      fs.renameSync(temporaryReport, resolvedOptions.outputReport);
    } catch (error) {
      if (fs.existsSync(temporaryReport)) fs.unlinkSync(temporaryReport);
      throw error;
    }
    return report;
  } finally {
    database.close();
    if (fs.existsSync(temporaryRoot)) {
      const current = fs.lstatSync(temporaryRoot);
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === temporaryIdentity.dev &&
        current.ino === temporaryIdentity.ino
      ) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await compareShadowCrawl(options);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Shadow comparison zlyhalo (bez zmien vstupov): ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_DISTRIBUTION_KEYS,
  MAX_JSONL_LINE_BYTES,
  boundedLines,
  compareShadowCrawl,
  itemPrefix,
  parseArguments,
  sameExistingFile,
  streamIntoDatabase,
  validatePaths,
};
