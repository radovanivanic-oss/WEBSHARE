const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function migrationChecksum(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function loadMigrations(migrationsDir) {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d+[-_].+\.js$/i.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(migrationsDir, name);
      delete require.cache[require.resolve(filePath)];
      const migration = require(filePath);
      return {
        ...migration,
        filePath,
        fileName: name,
        checksum: migrationChecksum(filePath),
      };
    });
}

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function migrateDatabase(database, migrationsDir, options = {}) {
  ensureMigrationTable(database);
  const appliedRows = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const migrations = loadMigrations(migrationsDir);
  const applied = [];

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || !migration.name || typeof migration.up !== "function") {
      throw new Error(`Neplatná migrácia ${migration.fileName}.`);
    }

    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(`Checksum migrácie ${migration.version} sa zmenil po aplikovaní.`);
      }
      continue;
    }

    const apply = database.transaction(() => {
      migration.up(database);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        )
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    });
    apply();
    applied.push(migration.version);
    options.logger?.info?.(`Aplikovaná migrácia ${migration.version}: ${migration.name}`);
  }

  return { applied, currentVersion: migrations.at(-1)?.version || 0 };
}

function rollbackLastMigration(database, migrationsDir, options = {}) {
  ensureMigrationTable(database);
  const current = database
    .prepare("SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get();
  if (!current) {
    return null;
  }

  const migration = loadMigrations(migrationsDir).find((item) => item.version === current.version);
  if (!migration || typeof migration.down !== "function") {
    throw new Error(`Migrácia ${current.version} nemá bezpečný rollback.`);
  }

  const rollback = database.transaction(() => {
    migration.down(database);
    database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(current.version);
  });
  rollback();
  options.logger?.info?.(`Vrátená migrácia ${migration.version}: ${migration.name}`);
  return migration.version;
}

module.exports = {
  ensureMigrationTable,
  loadMigrations,
  migrateDatabase,
  rollbackLastMigration,
};
