const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { STATE_SCHEMA_VERSION } = require("./config");
const { RecoveryRequiredError } = require("./errors");

const SCHEMA_SQL = `
CREATE TABLE crawler_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE crawl_runs (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  algorithm_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'running', 'complete', 'complete_with_failures', 'incomplete',
    'aborted', 'recovery_required'
  )),
  reconciliation_safe INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_safe IN (0, 1)),
  partition_completeness_proven INTEGER NOT NULL DEFAULT 0 CHECK (partition_completeness_proven IN (0, 1)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  root_prefix_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  in_progress_count INTEGER NOT NULL DEFAULT 0,
  complete_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  unique_items INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE crawl_frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE RESTRICT,
  prefix TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  parent_prefix TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'in_progress', 'complete', 'failed', 'blocked'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_started_at TEXT,
  lease_expires_at TEXT,
  total_reported INTEGER,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  items_observed INTEGER NOT NULL DEFAULT 0,
  last_offset INTEGER,
  last_page_count INTEGER NOT NULL DEFAULT 0,
  last_page_fingerprint TEXT,
  saturation_reason TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_id, prefix, depth)
);

CREATE INDEX crawl_frontier_state_idx
  ON crawl_frontier(run_id, state, depth, created_at);
CREATE INDEX crawl_frontier_lease_idx
  ON crawl_frontier(run_id, lease_expires_at);

CREATE TRIGGER crawl_frontier_insert_counts
AFTER INSERT ON crawl_frontier
BEGIN
  UPDATE crawl_runs SET
    queued_count = queued_count + CASE WHEN NEW.state = 'queued' THEN 1 ELSE 0 END,
    in_progress_count = in_progress_count + CASE WHEN NEW.state = 'in_progress' THEN 1 ELSE 0 END,
    complete_count = complete_count + CASE WHEN NEW.state = 'complete' THEN 1 ELSE 0 END,
    failed_count = failed_count + CASE WHEN NEW.state = 'failed' THEN 1 ELSE 0 END,
    blocked_count = blocked_count + CASE WHEN NEW.state = 'blocked' THEN 1 ELSE 0 END,
    updated_at = NEW.updated_at
  WHERE run_id = NEW.run_id;
END;

CREATE TRIGGER crawl_frontier_update_counts
AFTER UPDATE OF state ON crawl_frontier
WHEN OLD.state != NEW.state
BEGIN
  UPDATE crawl_runs SET
    queued_count = queued_count
      - CASE WHEN OLD.state = 'queued' THEN 1 ELSE 0 END
      + CASE WHEN NEW.state = 'queued' THEN 1 ELSE 0 END,
    in_progress_count = in_progress_count
      - CASE WHEN OLD.state = 'in_progress' THEN 1 ELSE 0 END
      + CASE WHEN NEW.state = 'in_progress' THEN 1 ELSE 0 END,
    complete_count = complete_count
      - CASE WHEN OLD.state = 'complete' THEN 1 ELSE 0 END
      + CASE WHEN NEW.state = 'complete' THEN 1 ELSE 0 END,
    failed_count = failed_count
      - CASE WHEN OLD.state = 'failed' THEN 1 ELSE 0 END
      + CASE WHEN NEW.state = 'failed' THEN 1 ELSE 0 END,
    blocked_count = blocked_count
      - CASE WHEN OLD.state = 'blocked' THEN 1 ELSE 0 END
      + CASE WHEN NEW.state = 'blocked' THEN 1 ELSE 0 END,
    updated_at = NEW.updated_at
  WHERE run_id = NEW.run_id;
END;

CREATE TABLE crawl_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE RESTRICT,
  prefix TEXT NOT NULL,
  depth INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  reported_total INTEGER,
  page_fingerprint TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE(run_id, prefix, depth, offset)
);

CREATE INDEX crawl_pages_fingerprint_idx
  ON crawl_pages(run_id, prefix, depth, page_fingerprint);

CREATE TABLE crawl_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE RESTRICT,
  prefix TEXT NOT NULL,
  depth INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  failure_class TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX crawl_failures_run_idx
  ON crawl_failures(run_id, prefix, depth, created_at);

CREATE TABLE crawl_items (
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE RESTRICT,
  ident TEXT NOT NULL,
  item_json TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, ident)
) WITHOUT ROWID;

CREATE TABLE crawl_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE RESTRICT,
  prefix TEXT NOT NULL,
  depth INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  page_fingerprint TEXT NOT NULL,
  inserted_items INTEGER NOT NULL,
  duplicate_items INTEGER NOT NULL,
  committed_at TEXT NOT NULL
);
`;

function quickCheckExistingDatabase(databasePath) {
  let database;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    // Keep startup validation bounded: crawler_state is tiny even when
    // crawl_items contains millions of rows. Full integrity checking is an
    // explicit offline operator action, never an implicit resume side effect.
    const result = database.pragma("quick_check('crawler_state')");
    if (!Array.isArray(result) || result[0]?.quick_check !== "ok") {
      throw new Error(JSON.stringify(result));
    }
    const stateTable = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='crawler_state'"
      )
      .get();
    if (!stateTable) {
      throw new Error("chýba tabuľka crawler_state");
    }
    const version = database
      .prepare("SELECT value FROM crawler_state WHERE key='schema_version'")
      .get();
    if (Number(version?.value) !== STATE_SCHEMA_VERSION) {
      throw new Error(
        `nepodporovaná schema_version ${version?.value ?? "missing"}`
      );
    }
  } catch (error) {
    throw new RecoveryRequiredError(
      `Crawler state DB vyžaduje recovery: ${databasePath}: ${error.message}`,
      { cause: error, code: "state_db_invalid" }
    );
  } finally {
    database?.close();
  }
}

function initializeDatabase(database) {
  const now = new Date().toISOString();
  database
    .transaction(() => {
      database.exec(SCHEMA_SQL);
      database
        .prepare(
          "INSERT INTO crawler_state(key, value, updated_at) VALUES (?, ?, ?)"
        )
        .run("schema_version", String(STATE_SCHEMA_VERSION), now);
    })
    .immediate();
}

function openCrawlerDatabase(databasePath, options = {}) {
  const resolvedPath = path.resolve(databasePath);
  const exists = fs.existsSync(resolvedPath);
  if (exists) {
    quickCheckExistingDatabase(resolvedPath);
  } else if (options.create === false) {
    throw new RecoveryRequiredError(`Crawler state DB neexistuje: ${resolvedPath}`, {
      code: "state_db_missing",
    });
  } else {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  let database;
  try {
    database = new Database(resolvedPath, {
      readonly: options.readonly === true,
      fileMustExist: options.readonly === true,
    });
    if (options.readonly === true) {
      database.pragma("busy_timeout = 5000");
      database.pragma("foreign_keys = ON");
      return database;
    }
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    if (!exists) {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = NORMAL");
      initializeDatabase(database);
    } else {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = NORMAL");
    }
    return database;
  } catch (error) {
    database?.close();
    throw new RecoveryRequiredError(
      `Crawler state DB sa nepodarilo bezpečne otvoriť: ${resolvedPath}: ${error.message}`,
      { cause: error, code: "state_db_open_failed" }
    );
  }
}

module.exports = {
  SCHEMA_SQL,
  openCrawlerDatabase,
  quickCheckExistingDatabase,
};
