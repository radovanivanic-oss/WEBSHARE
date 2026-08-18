const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { openCatalogDatabase, nowIso } = require("../src/db/catalog-db");

const PURGE_POLICY_VERSION = "B39-unclassified-catalog-purge-v1";
const REQUIRED_SCHEMA_VERSION = 9;
const UNCLASSIFIED_CATEGORIES = ["unknown", "unclassified"];
const SCOPE_SQL = "lower(category) IN ('unknown','unclassified')";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function stableDigest(value) {
  return sha256(JSON.stringify(value));
}

function count(database, sql, ...args) {
  return database.prepare(sql).get(...args).count;
}

function digestRows(database, sql) {
  const result = database.prepare(`
    SELECT COUNT(*) AS count, group_concat(CAST(id AS TEXT), char(10)) AS values_text
    FROM (${sql})
  `).get();
  const canonical = result.values_text ? `${result.values_text}\n` : "";
  return { count: result.count, sha256: sha256(canonical) };
}

function countRows(database, sql) {
  return { count: database.prepare(`SELECT COUNT(*) AS count FROM (${sql.replace(/\s+ORDER BY\s+[^)]*$/i, "")})`).get().count, sha256: null };
}

function schemaVersion(database) {
  return database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
}

function foreignKeyErrors(database) {
  return database.prepare("PRAGMA foreign_key_check").all();
}

function categoryCounts(database) {
  return database.prepare("SELECT category, is_active, COUNT(*) AS count FROM media GROUP BY category, is_active ORDER BY category, is_active").all();
}

function readCounts(database) {
  return {
    files: count(database, "SELECT COUNT(*) AS count FROM files"),
    active_files: count(database, "SELECT COUNT(*) AS count FROM files WHERE is_active=1"),
    active_playable_files: count(database, "SELECT COUNT(*) AS count FROM files WHERE is_active=1 AND is_playable_video=1"),
    media: count(database, "SELECT COUNT(*) AS count FROM media"),
    active_media: count(database, "SELECT COUNT(*) AS count FROM media WHERE is_active=1"),
    unclassified_media: count(database, `SELECT COUNT(*) AS count FROM media WHERE ${SCOPE_SQL}`),
    active_unclassified_media: count(database, `SELECT COUNT(*) AS count FROM media WHERE ${SCOPE_SQL} AND is_active=1`),
    unclassified_files: count(database, `SELECT COUNT(*) AS count FROM files f JOIN media m ON m.id=f.media_id WHERE ${SCOPE_SQL.replaceAll("category", "m.category")}`),
    unclassified_active_files: count(database, `SELECT COUNT(*) AS count FROM files f JOIN media m ON m.id=f.media_id WHERE ${SCOPE_SQL.replaceAll("category", "m.category")} AND f.is_active=1`),
    unclassified_active_playable_files: count(database, `SELECT COUNT(*) AS count FROM files f JOIN media m ON m.id=f.media_id WHERE ${SCOPE_SQL.replaceAll("category", "m.category")} AND f.is_active=1 AND f.is_playable_video=1`),
    orphan_files: count(database, "SELECT COUNT(*) AS count FROM files WHERE media_id IS NULL OR NOT EXISTS (SELECT 1 FROM media m WHERE m.id=files.media_id)"),
    duplicate_file_ownership: count(database, "SELECT COUNT(*) AS count FROM (SELECT ident FROM files GROUP BY ident HAVING COUNT(*) > 1)"),
  };
}

function readPurgeData(database, { skipFtsDigest = false, fast = false } = {}) {
  const digest = fast ? countRows : digestRows;
  const mediaDigest = digest(database, `SELECT id FROM media WHERE ${SCOPE_SQL} ORDER BY id`);
  const fileDigest = digest(database, `
    SELECT f.id FROM files f JOIN media m ON m.id=f.media_id
    WHERE ${SCOPE_SQL.replaceAll("category", "m.category")} ORDER BY f.id
  `);
  const candidateDigest = digest(database, `
    SELECT c.id FROM candidates c JOIN media m ON m.id=c.media_id
    WHERE ${SCOPE_SQL.replaceAll("category", "m.category")} ORDER BY c.id
  `);
  const aliasDigest = digest(database, `
    SELECT a.id FROM media_aliases a JOIN media m ON m.id=a.media_id
    WHERE ${SCOPE_SQL.replaceAll("category", "m.category")} ORDER BY a.id
  `);
  const ftsDigest = (skipFtsDigest || fast)
    ? { count: count(database, `SELECT COUNT(*) AS count FROM media_fts WHERE CAST(media_id AS INTEGER) IN (SELECT id FROM media WHERE ${SCOPE_SQL})`), sha256: null }
    : digest(database, `
      SELECT rowid AS id FROM media_fts
      WHERE CAST(media_id AS INTEGER) IN (SELECT id FROM media WHERE ${SCOPE_SQL}) ORDER BY rowid
    `);
  const metadataJobDigest = digest(database, `
    SELECT j.id FROM metadata_jobs j JOIN candidates c ON c.id=j.candidate_id
    JOIN media m ON m.id=c.media_id
    WHERE ${SCOPE_SQL.replaceAll("category", "m.category")} ORDER BY j.id
  `);
  const auditDigest = digest(database, `
    SELECT DISTINCT a.id FROM classification_audit a
    LEFT JOIN media m ON m.id=a.media_id
    LEFT JOIN files f ON f.id=a.file_id
    WHERE (m.id IS NOT NULL AND ${SCOPE_SQL.replaceAll("category", "m.category")})
       OR (f.id IS NOT NULL AND f.media_id IN (SELECT id FROM media WHERE ${SCOPE_SQL}))
    ORDER BY a.id
  `);
  const crossBoundary = {
    classified_children_of_unclassified: count(database, `
      SELECT COUNT(*) AS count FROM media child JOIN media parent ON parent.id=child.tvshow_id
      WHERE ${SCOPE_SQL.replaceAll("category", "parent.category")}
        AND NOT (${SCOPE_SQL.replaceAll("category", "child.category")})
    `),
    unclassified_children_of_classified: count(database, `
      SELECT COUNT(*) AS count FROM media child JOIN media parent ON parent.id=child.tvshow_id
      WHERE NOT (${SCOPE_SQL.replaceAll("category", "parent.category")})
        AND ${SCOPE_SQL.replaceAll("category", "child.category")}
    `),
    candidates_with_classified_files: count(database, `
      SELECT COUNT(DISTINCT f.candidate_id) AS count
      FROM files f JOIN candidates c ON c.id=f.candidate_id
      JOIN media m ON m.id=f.media_id
      WHERE c.media_id IN (SELECT id FROM media WHERE ${SCOPE_SQL})
        AND NOT (${SCOPE_SQL.replaceAll("category", "m.category")})
    `),
    purge_files_with_non_purge_owner: count(database, `
      SELECT COUNT(*) AS count FROM files f
      WHERE f.media_id IN (SELECT id FROM media WHERE ${SCOPE_SQL})
        AND NOT EXISTS (SELECT 1 FROM media m WHERE m.id=f.media_id AND ${SCOPE_SQL})
    `),
    candidates_without_media_with_purge_files: count(database, `
      SELECT COUNT(DISTINCT c.id) AS count FROM candidates c JOIN files f ON f.candidate_id=c.id
      WHERE c.media_id IS NULL AND f.media_id IN (SELECT id FROM media WHERE ${SCOPE_SQL})
    `),
  };
  const dependent = {
    candidates: candidateDigest.count,
    aliases: aliasDigest.count,
    fts_rows: ftsDigest.count,
    metadata_jobs: metadataJobDigest.count,
    classification_audit: auditDigest.count,
    child_media_rows: count(database, `SELECT COUNT(*) AS count FROM media WHERE tvshow_id IN (SELECT id FROM media WHERE ${SCOPE_SQL})`),
  };
  const counts = readCounts(database);
  const sets = {
    media: mediaDigest,
    files: fileDigest,
    candidates: candidateDigest,
    aliases: aliasDigest,
    fts_rows: ftsDigest,
    metadata_jobs: metadataJobDigest,
    classification_audit: auditDigest,
  };
  const baseline = {
    counts,
    category_counts: categoryCounts(database),
    schema_version: schemaVersion(database),
    sets,
    cross_boundary: crossBoundary,
  };
  const afterCounts = {
    ...counts,
    files: counts.files - sets.files.count,
    active_files: counts.active_files - counts.unclassified_active_files,
    active_playable_files: counts.active_playable_files - counts.unclassified_active_playable_files,
    media: counts.media - sets.media.count,
    active_media: counts.active_media - counts.active_unclassified_media,
    unclassified_media: counts.unclassified_media - sets.media.count,
    active_unclassified_media: counts.active_unclassified_media - counts.active_unclassified_media,
    unclassified_files: 0,
    unclassified_active_files: 0,
    unclassified_active_playable_files: 0,
  };
  return {
    policy_version: PURGE_POLICY_VERSION,
    scope_categories: UNCLASSIFIED_CATEGORIES,
    schema_version: baseline.schema_version,
    baseline,
    dependent,
    after_counts: afterCounts,
    deterministic_digest: stableDigest({ baseline, dependent, after_counts: afterCounts }),
  };
}

function assertEqualJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}-drift`);
}

function assertPlanCompatible(actual, expected, label) {
  const actualComparable = JSON.parse(JSON.stringify({ policy_version: actual.policy_version, scope_categories: actual.scope_categories, schema_version: actual.schema_version, baseline: actual.baseline, dependent: actual.dependent, after_counts: actual.after_counts }));
  const expectedComparable = JSON.parse(JSON.stringify({ policy_version: expected.policy_version, scope_categories: expected.scope_categories, schema_version: expected.schema_version, baseline: expected.baseline, dependent: expected.dependent, after_counts: expected.after_counts }));
  for (const key of Object.keys(actualComparable.baseline.sets)) {
    delete actualComparable.baseline.sets[key].sha256;
    delete expectedComparable.baseline.sets[key].sha256;
  }
  assertEqualJson(actualComparable, expectedComparable, label);
}

function validatePurgeData(data) {
  if (!data || data.policy_version !== PURGE_POLICY_VERSION) throw new Error("invalid-purge-policy");
  if (data.schema_version !== REQUIRED_SCHEMA_VERSION) throw new Error(`unsupported-schema-version:${data.schema_version}`);
  if (!data.baseline || !data.baseline.counts || !data.baseline.sets || !data.dependent) throw new Error("invalid-purge-plan");
  const violations = Object.values(data.baseline.cross_boundary || {}).reduce((total, value) => total + value, 0);
  if (violations !== 0) throw new Error("cross-boundary-dependency");
  return data;
}

function readPlanFile(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  validatePurgeData(plan);
  return plan;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, filePath);
}

function createTempSets(database) {
  database.exec(`
    CREATE TEMP TABLE purge_media_ids(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE purge_file_ids(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE purge_candidate_ids(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE purge_alias_ids(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE purge_fts_rowids(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE purge_metadata_job_ids(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE purge_audit_ids(id INTEGER PRIMARY KEY);
    INSERT INTO purge_media_ids SELECT id FROM media WHERE ${SCOPE_SQL};
    INSERT INTO purge_file_ids
      SELECT f.id FROM files f WHERE f.media_id IN (SELECT id FROM purge_media_ids);
    INSERT INTO purge_candidate_ids
      SELECT c.id FROM candidates c WHERE c.media_id IN (SELECT id FROM purge_media_ids);
    INSERT INTO purge_alias_ids
      SELECT a.id FROM media_aliases a WHERE a.media_id IN (SELECT id FROM purge_media_ids);
    INSERT INTO purge_fts_rowids
      SELECT rowid FROM media_fts
      WHERE CAST(media_id AS INTEGER) IN (SELECT id FROM purge_media_ids);
    INSERT INTO purge_metadata_job_ids
      SELECT j.id FROM metadata_jobs j WHERE j.candidate_id IN (SELECT id FROM purge_candidate_ids);
    INSERT INTO purge_audit_ids
      SELECT DISTINCT a.id FROM classification_audit a
      WHERE a.media_id IN (SELECT id FROM purge_media_ids)
         OR a.file_id IN (SELECT id FROM purge_file_ids);
  `);
}

function tempSetCounts(database) {
  const result = {};
  for (const [key, table] of Object.entries({ media: "purge_media_ids", files: "purge_file_ids", candidates: "purge_candidate_ids", aliases: "purge_alias_ids", metadata_jobs: "purge_metadata_job_ids", classification_audit: "purge_audit_ids" })) {
    result[key] = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }
  result.fts_rows = database.prepare("SELECT COUNT(*) AS count FROM purge_fts_rowids").get().count;
  return result;
}

function deleteLeaves(database) {
  let total = 0;
  while (true) {
    const result = database.prepare(`
      DELETE FROM media
      WHERE id IN (SELECT id FROM purge_media_ids)
        AND NOT EXISTS (SELECT 1 FROM media child WHERE child.tvshow_id = media.id)
    `).run();
    total += result.changes;
    if (result.changes === 0) break;
  }
  return total;
}

const FTS_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE media_fts USING fts5(
    media_id UNINDEXED,
    title,
    original_title,
    aliases,
    tokenize = 'unicode61 remove_diacritics 2'
  )
`;

function resetFtsIndex(database) {
  const before = database.prepare("SELECT COUNT(*) AS count FROM media_fts").get().count;
  database.exec("DROP TABLE media_fts;");
  database.exec(FTS_SCHEMA_SQL);
  return { before, after: 0, deleted: before };
}

function rebuildFtsIndex(database, { maintenance = false } = {}) {
  const before = database.prepare("SELECT COUNT(*) AS count FROM media_fts").get().count;
  if (maintenance) {
    database.pragma("journal_mode = OFF");
    database.pragma("synchronous = OFF");
    database.pragma("temp_store = MEMORY");
    database.pragma("cache_size = -262144");
  }
  database.prepare("INSERT INTO media_fts(media_fts, rank) VALUES('automerge', 0)").run();
  database.exec("DELETE FROM media_fts;");
  database.exec(`
    INSERT INTO media_fts(media_id, title, original_title, aliases)
    SELECT CAST(media.id AS TEXT), media.title, COALESCE(media.original_title, ''),
      COALESCE(alias_values.aliases, '')
    FROM media
    LEFT JOIN (
      SELECT media_id, GROUP_CONCAT(alias, ' ') AS aliases
      FROM media_aliases
      GROUP BY media_id
    ) AS alias_values ON alias_values.media_id = media.id
  `);
  database.prepare("INSERT INTO media_fts(media_fts) VALUES('optimize')").run();
  const after = database.prepare("SELECT COUNT(*) AS count FROM media_fts").get().count;
  return { before, after, deleted: before - after };
}

async function applyUnclassifiedPurge(options) {
  const databasePath = path.resolve(options.databasePath);
  const planPath = path.resolve(options.planPath);
  const planHash = sha256File(planPath);
  if (options.expectedPlanSha256 && planHash !== options.expectedPlanSha256) throw new Error(`plan-digest-mismatch:${planHash}`);
  const plan = readPlanFile(planPath);
  if (plan.schema_version !== REQUIRED_SCHEMA_VERSION) throw new Error("plan-schema-version-mismatch");
  const database = openCatalogDatabase(databasePath, { fileMustExist: true });
  const started = Date.now();
  let before;
  let backupPath = null;
  try {
    if (schemaVersion(database) !== plan.schema_version) throw new Error("schema-version-drift");
    const current = readPurgeData(database, { fast: true });
    assertPlanCompatible(current, plan, "purge-plan");
    before = current.baseline.counts;
    if (options.backupPath) {
      backupPath = path.resolve(options.backupPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o750 });
      await database.backup(backupPath);
      const backupDb = openCatalogDatabase(backupPath, { readonly: true, fileMustExist: true });
      try {
        if (backupDb.pragma("quick_check", { simple: true }) !== "ok") throw new Error("backup-quick-check-failed");
        if (foreignKeyErrors(backupDb).length) throw new Error("backup-foreign-key-check-failed");
        assertPlanCompatible(readPurgeData(backupDb, { fast: true }), plan, "backup-plan");
      } finally { backupDb.close(); }
    }
    let deleted = {};
    const transaction = database.transaction(() => {
      if (schemaVersion(database) !== plan.schema_version) throw new Error("schema-version-drift-in-transaction");
      const currentInTransaction = readPurgeData(database, { fast: true });
      assertPlanCompatible(currentInTransaction, plan, "transaction-plan");
      createTempSets(database);
      const temp = tempSetCounts(database);
      for (const [key, value] of Object.entries({ media: plan.baseline.sets.media.count, files: plan.baseline.sets.files.count, candidates: plan.baseline.sets.candidates.count, aliases: plan.baseline.sets.aliases.count, metadata_jobs: plan.baseline.sets.metadata_jobs.count, classification_audit: plan.baseline.sets.classification_audit.count, fts_rows: plan.baseline.sets.fts_rows.count })) {
        if (temp[key] !== value) throw new Error(`purge-set-drift:${key}`);
      }
      if (Object.values(plan.baseline.cross_boundary).some((value) => value !== 0)) throw new Error("cross-boundary-dependency");
      const anchorsBefore = database.prepare("SELECT id, category, media_type, title, original_title, year, is_active FROM media WHERE id IN (272158,1000727) ORDER BY id").all();
      const deleteAudit = database.prepare("DELETE FROM classification_audit WHERE id IN (SELECT id FROM purge_audit_ids)").run().changes;
      const deleteJobs = database.prepare("DELETE FROM metadata_jobs WHERE id IN (SELECT id FROM purge_metadata_job_ids)").run().changes;
      const deleteAliases = database.prepare("DELETE FROM media_aliases WHERE id IN (SELECT id FROM purge_alias_ids)").run().changes;
      const deleteFiles = database.prepare("DELETE FROM files WHERE id IN (SELECT id FROM purge_file_ids)").run().changes;
      if (options.failureAfter === "files") throw new Error("injected-transaction-failure");
      const deleteCandidates = database.prepare("DELETE FROM candidates WHERE id IN (SELECT id FROM purge_candidate_ids)").run().changes;
      const deleteMedia = deleteLeaves(database);
      const fts = resetFtsIndex(database);
      const deleteFts = plan.baseline.sets.fts_rows.count;
      deleted = { classification_audit: deleteAudit, metadata_jobs: deleteJobs, aliases: deleteAliases, fts_rows: deleteFts, files: deleteFiles, candidates: deleteCandidates, media: deleteMedia, fts_rebuilt: { ...fts, deferred: true, planned_purge_rows: deleteFts } };
      for (const [key, value] of Object.entries({ classification_audit: plan.baseline.sets.classification_audit.count, metadata_jobs: plan.baseline.sets.metadata_jobs.count, aliases: plan.baseline.sets.aliases.count, fts_rows: plan.baseline.sets.fts_rows.count, files: plan.baseline.sets.files.count, candidates: plan.baseline.sets.candidates.count, media: plan.baseline.sets.media.count })) {
        if (deleted[key] !== value) throw new Error(`delete-count-mismatch:${key}:${deleted[key]}!=${value}`);
      }
      if (database.prepare(`SELECT COUNT(*) AS count FROM media WHERE ${SCOPE_SQL}`).get().count !== 0) throw new Error("unclassified-remains");
      const anchorsAfter = database.prepare("SELECT id, category, media_type, title, original_title, year, is_active FROM media WHERE id IN (272158,1000727) ORDER BY id").all();
      assertEqualJson(anchorsAfter, anchorsBefore, "anchor-drift");
      const after = readCounts(database);
      const expectedAfter = plan.after_counts;
      for (const key of Object.keys(expectedAfter)) if (after[key] !== expectedAfter[key]) throw new Error(`after-count-mismatch:${key}:${after[key]}!=${expectedAfter[key]}`);
      if (after.orphan_files !== before.orphan_files || after.duplicate_file_ownership !== 0) throw new Error("file-integrity-invariant-failed");
      // Full-catalog integrity checks run on a fresh connection immediately after COMMIT.
      // Keeping them outside the write transaction avoids holding the WAL open for a second scan.
    });
    transaction();
    const after = readCounts(database);
    return {
      schema_version: 1,
      purge_policy_version: PURGE_POLICY_VERSION,
      run_id: options.runId || crypto.randomUUID(),
      plan_sha256: planHash,
      backup_path: backupPath,
      transaction_count: 1,
      transaction_duration_ms: Date.now() - started,
      committed: true,
      rolled_back: false,
      deleted,
      before,
      after,
      quick_check: database.pragma("quick_check", { simple: true }),
      foreign_key_check_count: foreignKeyErrors(database).length,
    };
  } finally {
    database.close();
  }
}

module.exports = {
  PURGE_POLICY_VERSION,
  REQUIRED_SCHEMA_VERSION,
  UNCLASSIFIED_CATEGORIES,
  SCOPE_SQL,
  sha256File,
  stableDigest,
  schemaVersion,
  readCounts,
  readPurgeData,
  validatePurgeData,
  writeJson,
  applyUnclassifiedPurge,
  rebuildFtsIndex,
};
