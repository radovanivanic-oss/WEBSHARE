const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { openCatalogDatabase, nowIso } = require("../src/db/catalog-db");
const { compareMedia } = require("./media-entity-resolver");

const MIGRATION_POLICY_VERSION = "b33-safe-media-reassignment-v1";
const ALLOWED_STATUSES = new Set(["PROVEN_SAME_MOVIE", "STRONG_SAME_MOVIE"]);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function count(database, sql, ...args) {
  return database.prepare(sql).get(...args).count;
}

function quickCheck(database) {
  return database.pragma("quick_check", { simple: true });
}

function foreignKeyErrors(database) {
  return database.prepare("PRAGMA foreign_key_check").all();
}

function readCounts(database) {
  return {
    files: count(database, "SELECT COUNT(*) count FROM files"),
    active_files: count(database, "SELECT COUNT(*) count FROM files WHERE is_active=1"),
    active_playable_files: count(database, "SELECT COUNT(*) count FROM files WHERE is_active=1 AND is_playable_video=1"),
    media: count(database, "SELECT COUNT(*) count FROM media"),
    movie_entities: count(database, "SELECT COUNT(*) count FROM media WHERE media_type='movie'"),
    active_movie_entities: count(database, "SELECT COUNT(*) count FROM media WHERE media_type='movie' AND is_active=1"),
    active_playable_movie_files: count(database, "SELECT COUNT(*) count FROM files f JOIN media m ON m.id=f.media_id WHERE m.media_type='movie' AND f.is_active=1 AND f.is_playable_video=1"),
    orphan_files: count(database, "SELECT COUNT(*) count FROM files WHERE media_id IS NULL"),
    duplicate_file_ownership: count(database, "SELECT COUNT(*) count FROM (SELECT ident FROM files GROUP BY ident HAVING COUNT(*)>1)"),
  };
}

function validatePlan(plan) {
  if (!plan || plan.mode !== "READ_ONLY_DRY_RUN" || !plan.global || !plan.plan) throw new Error("invalid-resolution-plan-envelope");
  if (!Array.isArray(plan.plan.safe_groups) || plan.plan.partial_groups?.length || plan.plan.ambiguous_groups?.length) throw new Error("plan-contains-non-safe-groups");
  if (!Array.isArray(plan.plan.conflicting_groups)) throw new Error("invalid-conflicting-groups");
  const seenSources = new Set();
  const seenFiles = new Set();
  const seenGroups = new Set();
  for (const group of plan.plan.safe_groups) {
    if (group.status !== "SAFE" || !group.canonical?.id || !Array.isArray(group.source_ids) || !Array.isArray(group.mergeable) || group.rejected?.length) throw new Error("unsafe-group-envelope");
    if (seenGroups.has(group.group_key)) throw new Error("duplicate-group");
    seenGroups.add(group.group_key);
    const sources = new Set(group.source_ids);
    if (sources.has(group.canonical.id) || sources.size !== group.source_ids.length) throw new Error("duplicate-or-canonical-source");
    for (const item of group.mergeable) {
      if (!ALLOWED_STATUSES.has(item.status) || item.target !== group.canonical.id || !sources.has(item.source) || seenSources.has(item.source)) throw new Error("invalid-merge-item");
      seenSources.add(item.source);
    }
    for (const fileId of group.files_to_reassign || []) {
      if (!Number.isInteger(fileId) || seenFiles.has(fileId)) throw new Error("duplicate-file-reassignment");
      seenFiles.add(fileId);
    }
    if (group.mergeable.length !== group.source_ids.length) throw new Error("source-merge-count-mismatch");
  }
  if (seenSources.size !== plan.plan.entities_affected || seenFiles.size !== plan.plan.files_affected) throw new Error("plan-aggregate-mismatch");
  return { sourceIds: [...seenSources], fileIds: [...seenFiles], groupCount: plan.plan.safe_groups.length };
}

function assertCounts(actual, expected, label) {
  for (const [key, value] of Object.entries(expected || {})) {
    if (actual[key] !== value) throw new Error(`${label}-count-drift:${key}:${actual[key]}!=${value}`);
  }
}

function selectByIds(database, table, ids) {
  if (!ids.length) return [];
  return database.prepare(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
}

function validateCurrentState(database, plan, expectedCounts, fileIds, sourceIds) {
  if (quickCheck(database) !== "ok") throw new Error("preflight-quick-check-failed");
  if (foreignKeyErrors(database).length) throw new Error("preflight-foreign-key-check-failed");
  const actual = readCounts(database);
  assertCounts(actual, expectedCounts, "expected");
  assertCounts(actual, {
    movie_entities: plan.global.movie_entities,
    active_movie_entities: plan.global.active_movie_entities,
    active_playable_movie_files: plan.global.active_playable_movie_files,
  }, "plan");
  if (actual.duplicate_file_ownership) throw new Error("duplicate-file-ownership");
  const files = selectByIds(database, "files", fileIds);
  if (files.length !== fileIds.length || files.some((file) => !sourceIds.includes(file.media_id))) throw new Error("file-owner-drift");
  const sources = selectByIds(database, "media", sourceIds);
  if (sources.length !== sourceIds.length || sources.some((row) => row.media_type !== "movie")) throw new Error("source-entity-drift");
  return actual;
}

function buildAssignments(plan) {
  const assignments = [];
  for (const group of plan.plan.safe_groups) {
    for (const item of group.mergeable) assignments.push({ source: item.source, target: item.target, status: item.status });
  }
  return assignments;
}

async function applyMediaEntityMigration(options) {
  const databasePath = path.resolve(options.databasePath);
  const planPath = path.resolve(options.planPath);
  const planHash = sha256File(planPath);
  if (options.expectedPlanSha256 && planHash !== options.expectedPlanSha256) throw new Error(`plan-digest-mismatch:${planHash}`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const shape = validatePlan(plan);
  if (options.expectedGroups !== undefined && shape.groupCount !== options.expectedGroups) throw new Error("plan-group-count-mismatch");
  if (options.maxGroups !== undefined && shape.groupCount > options.maxGroups) throw new Error("plan-group-limit-exceeded");
  if (options.maxFileReassignments !== undefined && shape.fileIds.length > options.maxFileReassignments) throw new Error("plan-file-limit-exceeded");
  const expectedCounts = options.expectedCounts || {};
  const database = openCatalogDatabase(databasePath, { fileMustExist: true });
  const runId = options.runId || crypto.randomUUID();
  const started = Date.now();
  let before;
  let backupPath = null;
  try {
    before = validateCurrentState(database, plan, expectedCounts, shape.fileIds, shape.sourceIds);
    if (options.backupPath) {
      backupPath = path.resolve(options.backupPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      await database.backup(backupPath);
      const backupDb = openCatalogDatabase(backupPath, { readonly: true, fileMustExist: true });
      try {
        if (quickCheck(backupDb) !== "ok") throw new Error("backup-quick-check-failed");
        assertCounts(readCounts(backupDb), before, "backup");
      } finally { backupDb.close(); }
    }

    const assignments = buildAssignments(plan);
    const sourceToTarget = new Map(assignments.map((item) => [item.source, item.target]));
    const transaction = database.transaction(() => {
      validateCurrentState(database, plan, expectedCounts, shape.fileIds, shape.sourceIds);
      const targetRows = new Map(selectByIds(database, "media", [...new Set(assignments.map((item) => item.target))]).map((row) => [row.id, row]));
      const sourceRows = new Map(selectByIds(database, "media", shape.sourceIds).map((row) => [row.id, row]));
      for (const item of assignments) {
        const source = sourceRows.get(item.source);
        const target = targetRows.get(item.target);
        if (!source || !target || source.media_type !== "movie" || target.media_type !== "movie") throw new Error("entity-missing-or-type-drift");
        const evidence = compareMedia(source, target);
        if (!ALLOWED_STATUSES.has(evidence.status) || evidence.status !== item.status) throw new Error("entity-identity-drift");
      }
      const updateFile = database.prepare("UPDATE files SET media_id = ?, updated_at = ? WHERE id = ? AND media_id = ?");
      let updatedFiles = 0;
      for (const fileId of shape.fileIds) {
        const file = database.prepare("SELECT id,media_id FROM files WHERE id = ?").get(fileId);
        const target = sourceToTarget.get(file?.media_id);
        if (!file || !target) throw new Error("unexpected-file-owner");
        const result = updateFile.run(target, nowIso(), fileId, file.media_id);
        if (result.changes !== 1) throw new Error("file-reassignment-count-mismatch");
        updatedFiles += 1;
        if (options.failureAfterFiles && updatedFiles >= options.failureAfterFiles) throw new Error("injected-transaction-failure");
      }
      for (const [source, target] of sourceToTarget) {
        database.prepare("UPDATE candidates SET media_id = ?, updated_at = ? WHERE media_id = ?").run(target, nowIso(), source);
        database.prepare(`
          INSERT OR IGNORE INTO media_aliases(media_id, alias, normalized_alias, language, source, created_at)
          SELECT ?, alias, normalized_alias, language, source, created_at FROM media_aliases WHERE media_id = ?
        `).run(target, source);
        database.prepare("DELETE FROM media_aliases WHERE media_id = ?").run(source);
        database.prepare("UPDATE classification_audit SET media_id = ? WHERE media_id = ?").run(target, source);
        const remaining = count(database, "SELECT COUNT(*) count FROM files WHERE media_id=?", source)
          + count(database, "SELECT COUNT(*) count FROM candidates WHERE media_id=?", source)
          + count(database, "SELECT COUNT(*) count FROM media_aliases WHERE media_id=?", source)
          + count(database, "SELECT COUNT(*) count FROM classification_audit WHERE media_id=?", source)
          + count(database, "SELECT COUNT(*) count FROM media WHERE tvshow_id=?", source);
        if (remaining !== 0) throw new Error("source-entity-still-referenced");
        if (database.prepare("DELETE FROM media WHERE id = ?").run(source).changes !== 1) throw new Error("source-retirement-failed");
      }
      database.exec("DELETE FROM media_fts;");
      database.exec(`
        INSERT INTO media_fts(media_id, title, original_title, aliases)
        SELECT CAST(media.id AS TEXT), media.title, COALESCE(media.original_title, ''),
          COALESCE((SELECT GROUP_CONCAT(alias, ' ') FROM media_aliases WHERE media_id = media.id), '')
        FROM media
      `);
      const after = readCounts(database);
      if (after.files !== before.files || after.active_files !== before.active_files || after.active_playable_files !== before.active_playable_files || after.orphan_files !== before.orphan_files || after.duplicate_file_ownership !== 0) throw new Error("file-invariant-failed");
      if (after.movie_entities !== before.movie_entities - shape.sourceIds.length || after.active_movie_entities !== before.active_movie_entities - shape.sourceIds.length) throw new Error("entity-count-invariant-failed");
      if (quickCheck(database) !== "ok" || foreignKeyErrors(database).length) throw new Error("in-transaction-integrity-failed");
    });
    transaction();
    const after = validateCurrentState(database, { global: { movie_entities: before.movie_entities - shape.sourceIds.length, active_movie_entities: before.active_movie_entities - shape.sourceIds.length, active_playable_movie_files: before.active_playable_movie_files } }, {}, [], []);
    return { schema_version: 1, migration_policy_version: MIGRATION_POLICY_VERSION, run_id: runId, plan_sha256: planHash, backup_path: backupPath, groups_planned: shape.groupCount, groups_applied: shape.groupCount, files_planned: shape.fileIds.length, files_reassigned: shape.fileIds.length, entities_retired: shape.sourceIds.length, transaction_count: 1, transaction_duration_ms: Date.now() - started, committed: true, rolled_back: false, before, after, quick_check: quickCheck(database), foreign_key_check_count: foreignKeyErrors(database).length };
  } catch (error) {
    throw error;
  } finally { database.close(); }
}

module.exports = { MIGRATION_POLICY_VERSION, applyMediaEntityMigration, readCounts, sha256File, validatePlan };
