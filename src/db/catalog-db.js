const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function ensureDatabaseDirectory(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function configureConnection(database, options = {}) {
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${options.busyTimeoutMs || 5000}`);
  database.pragma("cache_size = -65536");

  if (!options.readonly) {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("wal_autocheckpoint = 1000");
  }
}

function openCatalogDatabase(databasePath, options = {}) {
  if (!options.readonly) {
    ensureDatabaseDirectory(databasePath);
  }

  const database = new Database(databasePath, {
    readonly: Boolean(options.readonly),
    fileMustExist: Boolean(options.readonly || options.fileMustExist),
    timeout: options.busyTimeoutMs || 5000,
  });
  configureConnection(database, options);
  return database;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  configureConnection,
  ensureDatabaseDirectory,
  nowIso,
  openCatalogDatabase,
};
