#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const config = getCatalogConfig();
  if (!fs.existsSync(config.databasePath)) {
    throw new Error(`Databáza neexistuje: ${config.databasePath}`);
  }
  const backupDir = path.join(path.dirname(config.databasePath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const destination = path.join(backupDir, `catalog.sqlite.backup-${timestamp()}`);
  const database = openCatalogDatabase(config.databasePath, { fileMustExist: true });
  try {
    await database.backup(destination);
    console.log(destination);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
