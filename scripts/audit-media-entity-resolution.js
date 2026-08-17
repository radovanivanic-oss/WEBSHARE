#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { parseMediaName } = require("../lib/media-name-parser");
const { fold, planGroup } = require("../lib/media-entity-resolver");

function parseArgs(argv) {
  const options = { database: process.env.CATALOG_DB_PATH, report: null, limit: 200, inception: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") options.database = argv[++i];
    else if (arg === "--report") options.report = argv[++i];
    else if (arg === "--limit") options.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 200);
    else if (arg === "--no-inception") options.inception = false;
    else if (arg === "--help") {
      console.log("usage: node scripts/audit-media-entity-resolution.js --database PATH [--report PATH] [--limit N] [--no-inception]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.database) throw new Error("--database is required");
  return options;
}

function count(database, sql) { return database.prepare(sql).get().count; }

function mediaRows(database, ids) {
  if (!ids.length) return [];
  return database.prepare(`SELECT m.*, COALESCE((SELECT GROUP_CONCAT(alias, '|||') FROM media_aliases WHERE media_id=m.id), '') aliases_text FROM media m WHERE m.id IN (${ids.map(() => "?").join(",")})`).all(...ids)
    .map((row) => ({ ...row, aliases: row.aliases_text ? row.aliases_text.split("|||") : [] }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const database = openCatalogDatabase(path.resolve(options.database), { readonly: true, fileMustExist: true });
  try {
    const report = {
      mode: "READ_ONLY_DRY_RUN",
      database: path.resolve(options.database),
      quick_check: database.pragma("quick_check", { simple: true }),
      global: {
        movie_entities: count(database, "SELECT COUNT(*) count FROM media WHERE media_type='movie'"),
        active_movie_entities: count(database, "SELECT COUNT(*) count FROM media WHERE media_type='movie' AND is_active=1"),
        active_playable_movie_files: count(database, "SELECT COUNT(*) count FROM files f JOIN media m ON m.id=f.media_id WHERE m.media_type='movie' AND f.is_active=1 AND f.is_playable_video=1"),
        movie_entities_one_file: count(database, "SELECT COUNT(*) count FROM (SELECT m.id FROM media m JOIN files f ON f.media_id=m.id AND f.is_active=1 AND f.is_playable_video=1 WHERE m.media_type='movie' GROUP BY m.id HAVING COUNT(*)=1)"),
        movie_entities_many_files: count(database, "SELECT COUNT(*) count FROM (SELECT m.id FROM media m JOIN files f ON f.media_id=m.id AND f.is_active=1 AND f.is_playable_video=1 WHERE m.media_type='movie' GROUP BY m.id HAVING COUNT(*)>1)"),
        duplicate_external_id_groups: count(database, "SELECT COUNT(*) count FROM (SELECT external_source,external_id,media_type,season_number,episode_number FROM media WHERE external_source IS NOT NULL AND external_id IS NOT NULL GROUP BY external_source,external_id,media_type,season_number,episode_number HAVING COUNT(*)>1)"),
        same_title_year_groups: count(database, "SELECT COUNT(*) count FROM (SELECT lower(title),year,media_type FROM media WHERE media_type='movie' GROUP BY lower(title),year,media_type HAVING COUNT(*)>1)"),
        same_original_title_year_groups: count(database, "SELECT COUNT(*) count FROM (SELECT lower(original_title),year FROM media WHERE media_type='movie' AND original_title IS NOT NULL GROUP BY lower(original_title),year HAVING COUNT(*)>1)"),
      },
      plan: { safe_groups: [], approved_additional_groups: [], partial_groups: [], ambiguous_groups: [], conflicting_groups: [], entities_affected: 0, files_affected: 0 },
    };

    const duplicateRows = database.prepare(`SELECT lower(title) title_key, year, GROUP_CONCAT(id) ids FROM media WHERE media_type='movie' AND is_active=1 GROUP BY lower(title),year HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC, lower(title) LIMIT ?`).all(options.limit);
    for (const group of duplicateRows) {
      const ids = group.ids.split(",").map(Number);
      const rows = mediaRows(database, ids);
      const files = database.prepare(`SELECT id,media_id,original_name,parsed_title,parsed_year,normalized_name FROM files WHERE media_id IN (${ids.map(() => "?").join(",")}) AND is_active=1 AND is_playable_video=1`).all(...ids);
      const filesByMediaId = new Map(ids.map((id) => [id, files.filter((file) => file.media_id === id)]));
      const plan = planGroup(rows, filesByMediaId);
      plan.group_key = `${group.title_key}|${group.year || "unknown"}`;
      plan.before = { entities: rows.length, files: files.length };
      plan.after_if_applied = { entities: rows.length - plan.mergeable.length, files: files.length };
      if (plan.status === "SAFE") report.plan.safe_groups.push(plan);
      else if (plan.status === "PARTIAL") report.plan.partial_groups.push(plan);
      else if (plan.rejected.some((item) => item.status === "PROVEN_DIFFERENT_MOVIE")) report.plan.conflicting_groups.push(plan);
      else report.plan.ambiguous_groups.push(plan);
    }
    for (const group of [...report.plan.safe_groups, ...report.plan.partial_groups]) {
      report.plan.entities_affected += group.mergeable.length;
      report.plan.files_affected += group.files_to_reassign.length;
    }

    if (options.inception) {
      const candidates = database.prepare("SELECT DISTINCT f.media_id FROM files f JOIN media m ON m.id=f.media_id WHERE f.parsed_year=2010 AND f.is_active=1 AND f.is_playable_video=1 AND m.media_type='movie'").all()
        .map((row) => row.media_id);
      const relevantFiles = database.prepare(`SELECT f.* FROM files f WHERE f.media_id IN (${candidates.map(() => "?").join(",")}) AND f.is_active=1 AND f.is_playable_video=1`).all(...candidates)
        .filter((file) => /inception|pocatek|počiatok/i.test(`${file.original_name} ${file.parsed_title || ""}`));
      const ids = [...new Set(relevantFiles.map((file) => file.media_id))];
      const rows = mediaRows(database, ids);
      const byId = new Map(ids.map((id) => [id, relevantFiles.filter((file) => file.media_id === id)]));
      const inceptionPlan = planGroup(rows, byId);
      report.inception = { current_entities: rows.length, active_playable_files: relevantFiles.length, files: relevantFiles.map((file) => ({ ident: file.ident, original_name: file.original_name, parsed_title: file.parsed_title, parsed_year: file.parsed_year, media_id: file.media_id, parser: parseMediaName(file.original_name) })), plan: inceptionPlan };
      const approved = inceptionPlan.mergeable.filter((item) => item.status === "PROVEN_SAME_MOVIE" || item.status === "STRONG_SAME_MOVIE");
      const approvedSources = new Set(approved.map((item) => item.source));
      if (approved.length && inceptionPlan.rejected.every((item) => item.status === "AMBIGUOUS")) {
        const approvedGroup = {
          ...inceptionPlan,
          status: "SAFE_APPROVED_SUBSET",
          approval: "B33_REVIEWED_SAFE_SUBSET",
          source_ids: approved.map((item) => item.source),
          mergeable: approved,
          files_to_reassign: relevantFiles.filter((file) => approvedSources.has(file.media_id)).map((file) => file.id),
          rejected: inceptionPlan.rejected,
        };
        report.plan.approved_additional_groups.push(approvedGroup);
        report.plan.entities_affected += approvedGroup.mergeable.length;
        report.plan.files_affected += approvedGroup.files_to_reassign.length;
      }
    }
    const text = JSON.stringify(report, null, 2);
    if (options.report) { fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true }); fs.writeFileSync(path.resolve(options.report), `${text}\n`); }
    console.log(text);
  } finally { database.close(); }
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; } }

module.exports = { main, parseArgs };
