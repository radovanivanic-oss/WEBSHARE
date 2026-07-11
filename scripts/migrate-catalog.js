#!/usr/bin/env node
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { migrateDatabase, rollbackLastMigration } = require("../src/db/migrate");

function main() {
  const config = getCatalogConfig();
  const database = openCatalogDatabase(config.databasePath);
  try {
    if (process.argv.includes("--rollback")) {
      const version = rollbackLastMigration(database, config.migrationsDir, { logger: console });
      console.log(version ? `Rollback migrácie ${version} dokončený.` : "Nie je čo vrátiť.");
      return;
    }
    const result = migrateDatabase(database, config.migrationsDir, { logger: console });
    console.log(`Migrácie OK. Schema version: ${result.currentVersion}.`);
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
