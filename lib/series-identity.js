"use strict";

const crypto = require("node:crypto");
const { normalizedSlug } = require("./media-name-parser");
const { nowIso } = require("../src/db/catalog-db");

const SERIES_IDENTITY_POLICY_VERSION = "B55-series-identity-v1";
const SERIES_ROOT_SQL = `
  SELECT * FROM media
  WHERE media_type = 'tv' AND category = 'series' AND tvshow_id IS NULL
`;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function titleKey(value) {
  return normalizedSlug(String(value || ""));
}

function isUsableTitleKey(value) {
  const key = titleKey(value);
  return Boolean(key) && !new Set(["unknown", "untitled", "undefined", "null"]).has(key);
}

function isLocalRoot(root) {
  return String(root?.media_key || "").startsWith("local:");
}

function isTmdbRoot(root) {
  return root?.external_source === "tmdb" && Boolean(root.external_id);
}

function compatibleYear(left, right) {
  return left == null || right == null || Number(left) === Number(right);
}

function coordinateKey(season, episode) {
  return Number.isInteger(season) && season >= 1 && Number.isInteger(episode) && episode >= 1
    ? `${season}:${episode}`
    : null;
}

function loadRootDetails(database, { activeOnly = false, authoritativeOnly = false } = {}) {
  const where = `${activeOnly ? " AND is_active = 1" : ""}${authoritativeOnly ? " AND external_source = 'tmdb' AND external_id IS NOT NULL" : ""}`;
  const roots = database.prepare(`${SERIES_ROOT_SQL}${where} ORDER BY id`).all();
  if (!roots.length) return [];
  const rootIds = new Set(roots.map((root) => root.id));
  const aliasRows = database.prepare("SELECT media_id, alias, normalized_alias, language, source FROM media_aliases ORDER BY media_id, id").all();
  const episodeRows = database.prepare(`
    SELECT id, tvshow_id, external_source, external_id, season_number, episode_number, is_active
    FROM media WHERE tvshow_id IS NOT NULL AND media_type = 'episode'
    ORDER BY tvshow_id, season_number, episode_number, id
  `).all();
  const sourceRows = database.prepare(`
    SELECT CASE WHEN owner.tvshow_id IS NULL THEN owner.id ELSE owner.tvshow_id END AS root_id, COUNT(*) AS count
    FROM files file JOIN media owner ON owner.id = file.media_id
    WHERE file.is_active = 1 AND file.is_playable_video = 1
    GROUP BY root_id
  `).all();
  const directRows = database.prepare("SELECT media_id, COUNT(*) AS count FROM files GROUP BY media_id").all();
  const aliasesByRoot = new Map();
  for (const row of aliasRows) {
    if (!rootIds.has(row.media_id)) continue;
    if (!aliasesByRoot.has(row.media_id)) aliasesByRoot.set(row.media_id, []);
    aliasesByRoot.get(row.media_id).push({ alias: row.alias, normalized_alias: row.normalized_alias, language: row.language, source: row.source });
  }
  const episodesByRoot = new Map();
  for (const row of episodeRows) {
    if (!rootIds.has(row.tvshow_id)) continue;
    if (!episodesByRoot.has(row.tvshow_id)) episodesByRoot.set(row.tvshow_id, []);
    episodesByRoot.get(row.tvshow_id).push(row);
  }
  const sourceCountByRoot = new Map(sourceRows.map((row) => [Number(row.root_id), Number(row.count)]));
  const directCountByRoot = new Map(directRows.map((row) => [Number(row.media_id), Number(row.count)]));
  return roots.map((root) => {
    const rootEpisodes = episodesByRoot.get(root.id) || [];
    return {
      ...root,
      aliases: aliasesByRoot.get(root.id) || [],
      episodes: rootEpisodes,
      activeEpisodes: rootEpisodes.filter((episode) => episode.is_active === 1),
      sourceCount: sourceCountByRoot.get(root.id) || 0,
      directFileCount: directCountByRoot.get(root.id) || 0,
    };
  });
}

function rootTitleKeys(root) {
  return new Set([
    root.title,
    root.original_title,
    ...(root.aliases || []).map((alias) => alias.alias),
  ].map(titleKey).filter(Boolean));
}

function episodeExternalSeriesId(episode) {
  if (episode?.external_source !== "tmdb" || !episode.external_id) return null;
  return String(episode.external_id).split(":", 1)[0];
}

function hasConflictingEpisodeIdentity(root, canonicalExternalId) {
  return root.activeEpisodes.some((episode) => {
    const seriesId = episodeExternalSeriesId(episode);
    return seriesId !== null && String(seriesId) !== String(canonicalExternalId);
  });
}

function validLocalEpisodeCoordinates(root) {
  return root.activeEpisodes.every((episode) => coordinateKey(episode.season_number, episode.episode_number));
}

function coordinateSet(root) {
  return new Set(root.activeEpisodes.map((episode) => coordinateKey(episode.season_number, episode.episode_number)).filter(Boolean));
}

function classifyGroup(normalizedTitle, roots) {
  const tmdbRoots = roots.filter(isTmdbRoot);
  const localRoots = roots.filter(isLocalRoot);
  const years = roots.map((root) => root.year).filter((year) => year != null);
  const canonical = tmdbRoots.length === 1 ? tmdbRoots[0] : null;
  const yearCompatible = canonical ? roots.every((root) => compatibleYear(root.year, canonical.year)) : false;
  const allHaveActiveEpisodes = roots.every((root) => root.activeEpisodes.length > 0);
  const validCoordinates = localRoots.every(validLocalEpisodeCoordinates);
  const noConflictingEpisodeIdentity = canonical
    ? localRoots.every((root) => !hasConflictingEpisodeIdentity(root, canonical.external_id))
    : false;
  const coordinateSets = roots.map(coordinateSet);
  const union = new Set(coordinateSets.flatMap((set) => [...set]));
  const overlap = coordinateSets.some((set, index) => coordinateSets.some((other, otherIndex) => index !== otherIndex && [...set].some((item) => other.has(item))));
  const complementary = union.size > Math.max(...coordinateSets.map((set) => set.size), 0);
  const episodeEvidence = coordinateSets.every((set) => set.size > 0) && (overlap || complementary);
  let confidence = "AMBIGUOUS";
  let reason = "MULTIPLE_AUTHORITATIVE_OR_LOCAL_IDENTITIES";
  if (canonical && localRoots.length > 0 && yearCompatible && allHaveActiveEpisodes && validCoordinates && noConflictingEpisodeIdentity && episodeEvidence) {
    confidence = "HIGH";
    reason = "UNIQUE_TMDB_ROOT_COMPATIBLE_YEAR_AND_EPISODE_EVIDENCE";
  } else if (canonical && localRoots.length > 0 && yearCompatible) {
    confidence = "MEDIUM";
    reason = "AUTHORITATIVE_ROOT_WITH_INCOMPLETE_RECONCILIATION_EVIDENCE";
  } else if (canonical && localRoots.length > 0 && years.length > 1) {
    reason = "YEAR_CONFLICT";
  } else if (tmdbRoots.length > 1) {
    reason = "CONFLICTING_TMDB_IDENTITIES";
  } else if (tmdbRoots.length === 0) {
    reason = "NO_AUTHORITATIVE_IDENTITY";
  }
  return {
    normalizedTitle,
    confidence,
    reason,
    canonical: canonical ? summarizeRoot(canonical) : null,
    roots: roots.map(summarizeRoot),
    tmdbRootCount: tmdbRoots.length,
    localRootCount: localRoots.length,
    compatibleYear: yearCompatible,
    episodeEvidence,
    activeEpisodeCount: roots.reduce((sum, root) => sum + root.activeEpisodes.length, 0),
    sourceVariantCount: roots.reduce((sum, root) => sum + root.sourceCount, 0),
  };
}

function summarizeRoot(root) {
  return {
    id: root.id,
    media_key: root.media_key,
    external_source: root.external_source,
    external_id: root.external_id,
    title: root.title,
    original_title: root.original_title,
    year: root.year,
    metadata_status: root.metadata_status,
    metadata_confidence: root.metadata_confidence,
    seasons: [...new Set(root.activeEpisodes.map((episode) => episode.season_number).filter((season) => season != null))].sort((a, b) => a - b),
    episode_count: root.activeEpisodes.length,
    source_count: root.sourceCount,
    direct_file_count: root.directFileCount,
  };
}

function auditSeriesIdentities(database) {
  const roots = loadRootDetails(database, { activeOnly: true });
  const groups = new Map();
  const excluded = [];
  const excludedGroups = new Map();
  for (const root of roots) {
    const key = titleKey(root.title);
    if (!isUsableTitleKey(key)) {
      excluded.push({ id: root.id, title: root.title, media_key: root.media_key, reason: "UNUSABLE_NORMALIZED_TITLE" });
      if (!excludedGroups.has(key)) excludedGroups.set(key, []);
      excludedGroups.get(key).push(root);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(root);
  }
  const candidates = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => classifyGroup(key, group));
  const confidence = candidates.reduce((result, item) => {
    result[item.confidence] = (result[item.confidence] || 0) + 1;
    return result;
  }, { HIGH: 0, MEDIUM: 0, AMBIGUOUS: 0 });
  const activeTmdbRoots = roots.filter(isTmdbRoot).length;
  const activeLocalRoots = roots.filter(isLocalRoot).length;
  return {
    policy_version: SERIES_IDENTITY_POLICY_VERSION,
    root_count: roots.length,
    tmdb_root_count: activeTmdbRoots,
    local_root_count: activeLocalRoots,
    other_root_count: roots.length - activeTmdbRoots - activeLocalRoots,
    raw_duplicate_group_count: candidates.length + [...excludedGroups.values()].filter((group) => group.length > 1).length,
    candidate_group_count: candidates.length,
    roots_in_candidate_groups: candidates.reduce((sum, item) => sum + item.roots.length, 0),
    episodes_in_candidate_groups: candidates.reduce((sum, item) => sum + item.activeEpisodeCount, 0),
    source_variants_in_candidate_groups: candidates.reduce((sum, item) => sum + item.sourceVariantCount, 0),
    confidence,
    excluded_root_count: excluded.length,
    candidates,
    excluded,
  };
}

function resolveCanonicalSeriesRoot(database, parsed, { cache = null } = {}) {
  if (!parsed || parsed.candidateType !== "episode") return { status: "NOT_APPLICABLE", root_id: null };
  const key = titleKey(parsed.normalizedTitle || parsed.title);
  const cacheKey = `${key}|${parsed.year ?? ""}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  if (!isUsableTitleKey(key)) {
    const result = { status: "NO_MATCH", root_id: null, reason: "UNUSABLE_NORMALIZED_TITLE" };
    cache?.set(cacheKey, result);
    return result;
  }
  let roots = cache?.get("__tmdb_root_details");
  if (!roots) {
    roots = loadRootDetails(database, { activeOnly: true, authoritativeOnly: true });
    cache?.set("__tmdb_root_details", roots);
  }
  roots = roots
    .filter(isTmdbRoot)
    .filter((root) => root.activeEpisodes.length > 0)
    .filter((root) => rootTitleKeys(root).has(key))
    .filter((root) => compatibleYear(parsed.year, root.year));
  const unique = [...new Map(roots.map((root) => [String(root.external_id), root])).values()];
  let result;
  if (unique.length === 1) {
    const root = unique[0];
    result = {
      status: "MATCHED",
      root_id: root.id,
      root: summarizeRoot(root),
      evidence: {
        normalized_title: key,
        unique_tmdb_identity: root.external_id,
        compatible_year: true,
        existing_episode_evidence: root.activeEpisodes.length,
        episode_coordinates: coordinateKey(parsed.season, parsed.episode),
      },
    };
  } else if (unique.length > 1) {
    result = { status: "AMBIGUOUS", root_id: null, reason: "CONFLICTING_TMDB_IDENTITIES", candidates: unique.map(summarizeRoot) };
  } else {
    result = { status: "NO_MATCH", root_id: null, reason: "NO_UNIQUE_AUTHORITATIVE_ROOT" };
  }
  cache?.set(cacheKey, result);
  return result;
}

function buildGroupPlan(database, candidate, details = null) {
  if (candidate.confidence !== "HIGH" || !candidate.canonical) return null;
  const rootDetails = details || loadRootDetails(database, { activeOnly: false });
  const byId = new Map(rootDetails.map((root) => [root.id, root]));
  const target = byId.get(candidate.canonical.id);
  const sources = candidate.roots.filter((root) => root.id !== target.id).map((root) => byId.get(root.id));
  if (!target || !sources.length || sources.some((root) => !isLocalRoot(root) || root.directFileCount > 0)) return null;
  const targetByCoordinate = new Map();
  for (const episode of target.episodes) {
    const coordinate = coordinateKey(episode.season_number, episode.episode_number);
    if (!coordinate) continue;
    const previous = targetByCoordinate.get(coordinate);
    if (previous) return null;
    if (!previous || episode.is_active === 1) targetByCoordinate.set(coordinate, episode);
  }
  const sourceEpisodes = [];
  const fileIds = [];
  let collisionCount = 0;
  for (const source of sources) {
    const sourceCoordinates = new Set();
    for (const episode of source.episodes) {
      const coordinate = coordinateKey(episode.season_number, episode.episode_number);
      if (!coordinate && episode.is_active === 1) return null;
      if (coordinate && sourceCoordinates.has(coordinate)) return null;
      if (coordinate) sourceCoordinates.add(coordinate);
      const targetEpisode = targetByCoordinate.get(coordinate) || null;
      if (targetEpisode) {
        if (episodeExternalSeriesId(episode) && episodeExternalSeriesId(episode) !== String(target.external_id)) return null;
        collisionCount += 1;
      }
      const files = database.prepare("SELECT id FROM files WHERE media_id = ? ORDER BY id").all(episode.id).map((row) => row.id);
      fileIds.push(...files);
      sourceEpisodes.push({ source_root_id: source.id, source_id: episode.id, target_id: targetEpisode?.id || null, season_number: episode.season_number, episode_number: episode.episode_number, active: episode.is_active === 1, file_ids: files, collision: Boolean(targetEpisode) });
    }
  }
  return {
    group_key: candidate.normalizedTitle,
    confidence: candidate.confidence,
    reason: candidate.reason,
    canonical: candidate.canonical,
    source_roots: sources.map(summarizeRoot),
    source_episode_count: sourceEpisodes.length,
    episodes_to_reassign: sourceEpisodes,
    files_to_reassign: [...new Set(fileIds)].sort((a, b) => a - b),
    collision_count: collisionCount,
    source_root_ids: sources.map((root) => root.id),
  };
}

function databaseFingerprint(database) {
  const rows = database.prepare(`
    SELECT id, media_key, external_source, external_id, media_type, category, title, year,
      season_number, episode_number, tvshow_id, is_active
    FROM media ORDER BY id
  `).all();
  return sha256(rows);
}

function buildSeriesReconciliationPlan(database) {
  const audit = auditSeriesIdentities(database);
  const details = loadRootDetails(database, { activeOnly: false });
  const groups = audit.candidates
    .filter((candidate) => candidate.confidence === "HIGH")
    .map((candidate) => buildGroupPlan(database, candidate, details))
    .filter(Boolean);
  return {
    schema_version: 1,
    policy_version: SERIES_IDENTITY_POLICY_VERSION,
    status: "READ_ONLY_DRY_RUN",
    created_at: nowIso(),
    database_fingerprint: databaseFingerprint(database),
    audit: {
      root_count: audit.root_count,
      tmdb_root_count: audit.tmdb_root_count,
      local_root_count: audit.local_root_count,
      candidate_group_count: audit.candidate_group_count,
      confidence: audit.confidence,
    },
    groups,
    totals: {
      groups: groups.length,
      source_roots: groups.reduce((sum, group) => sum + group.source_root_ids.length, 0),
      episodes: groups.reduce((sum, group) => sum + group.source_episode_count, 0),
      files: groups.reduce((sum, group) => sum + group.files_to_reassign.length, 0),
      collisions: groups.reduce((sum, group) => sum + group.collision_count, 0),
    },
  };
}

function mergeAliases(database, targetId, sourceId) {
  database.prepare(`
    INSERT OR IGNORE INTO media_aliases(media_id, alias, normalized_alias, language, source, created_at)
    SELECT ?, alias, normalized_alias, language, source, created_at
    FROM media_aliases WHERE media_id = ?
  `).run(targetId, sourceId);
  database.prepare("DELETE FROM media_aliases WHERE media_id = ?").run(sourceId);
}

function applyGroup(database, group) {
  const now = nowIso();
  const updateFile = database.prepare("UPDATE files SET media_id = ?, updated_at = ? WHERE id = ? AND media_id = ?");
  const targetId = group.canonical.id;
  let reassignedFiles = 0;
  let reassignedEpisodes = 0;
  let mergedEpisodes = 0;
  for (const item of group.episodes_to_reassign) {
    for (const fileId of item.file_ids) {
      const result = updateFile.run(item.target_id || item.source_id, now, fileId, item.source_id);
      if (result.changes !== 1) throw new Error(`SERIES_FILE_OWNER_DRIFT:${fileId}`);
      reassignedFiles += 1;
    }
    if (item.target_id) {
      database.prepare("UPDATE candidates SET media_id = ?, updated_at = ? WHERE media_id = ?").run(item.target_id, now, item.source_id);
      database.prepare("UPDATE classification_audit SET media_id = ? WHERE media_id = ?").run(item.target_id, item.source_id);
      mergeAliases(database, item.target_id, item.source_id);
      database.prepare("UPDATE media SET is_active = 0, updated_at = ? WHERE id = ?").run(now, item.source_id);
      mergedEpisodes += 1;
    } else {
      database.prepare("UPDATE media SET tvshow_id = ?, updated_at = ? WHERE id = ? AND tvshow_id = ?").run(targetId, now, item.source_id, item.source_root_id);
      const changed = database.prepare("SELECT tvshow_id FROM media WHERE id = ?").get(item.source_id)?.tvshow_id === targetId;
      if (!changed) throw new Error(`SERIES_EPISODE_OWNER_DRIFT:${item.source_id}`);
      reassignedEpisodes += 1;
    }
  }
  for (const sourceId of group.source_root_ids) {
    database.prepare("UPDATE candidates SET media_id = ?, updated_at = ? WHERE media_id = ?").run(targetId, now, sourceId);
    database.prepare("UPDATE classification_audit SET media_id = ? WHERE media_id = ?").run(targetId, sourceId);
    mergeAliases(database, targetId, sourceId);
    database.prepare("UPDATE media SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1").run(now, sourceId);
  }
  return { reassignedFiles, reassignedEpisodes, mergedEpisodes, retiredRoots: group.source_root_ids.length };
}

function rebuildDerivedData(database) {
  database.exec("DELETE FROM media_fts;");
  database.exec(`
    INSERT INTO media_fts(media_id, title, original_title, aliases)
    SELECT CAST(media.id AS TEXT), media.title, COALESCE(media.original_title, ''),
      COALESCE((SELECT GROUP_CONCAT(alias, ' ') FROM media_aliases WHERE media_id = media.id), '')
    FROM media
  `);
  database.exec("UPDATE media SET is_active = 0;");
  database.exec(`
    UPDATE media SET is_active = 1 WHERE id IN (
      SELECT DISTINCT media_id FROM files
      WHERE media_id IS NOT NULL AND is_active = 1 AND is_playable_video = 1
    )
  `);
  database.exec(`
    UPDATE media SET is_active = 1 WHERE id IN (
      SELECT DISTINCT episode.tvshow_id
      FROM media episode JOIN files ON files.media_id = episode.id
      WHERE episode.tvshow_id IS NOT NULL AND files.is_active = 1 AND files.is_playable_video = 1
    )
  `);
}

function validatePlanCurrent(database, plan) {
  if (!plan || plan.status !== "READ_ONLY_DRY_RUN" || plan.policy_version !== SERIES_IDENTITY_POLICY_VERSION) throw new Error("SERIES_PLAN_INVALID");
  if (databaseFingerprint(database) !== plan.database_fingerprint) throw new Error("SERIES_DATABASE_BASELINE_DRIFT");
  for (const group of plan.groups) {
    const target = database.prepare("SELECT id,external_source,external_id,media_type,category,tvshow_id,is_active FROM media WHERE id = ?").get(group.canonical.id);
    if (!target || target.external_source !== "tmdb" || !target.external_id || target.media_type !== "tv" || target.category !== "series" || target.tvshow_id !== null || target.is_active !== 1) throw new Error(`SERIES_CANONICAL_DRIFT:${group.canonical.id}`);
    for (const sourceId of group.source_root_ids) {
      const source = database.prepare("SELECT id,media_key,media_type,category,tvshow_id,is_active FROM media WHERE id = ?").get(sourceId);
      if (!source || !isLocalRoot(source) || source.media_type !== "tv" || source.category !== "series" || source.tvshow_id !== null || source.is_active !== 1) throw new Error(`SERIES_SOURCE_DRIFT:${sourceId}`);
    }
  }
}

function applySeriesReconciliation(database, plan) {
  validatePlanCurrent(database, plan);
  const before = {
    root_count: database.prepare("SELECT COUNT(*) AS count FROM media WHERE media_type='tv' AND category='series' AND tvshow_id IS NULL AND is_active=1").get().count,
    files: database.prepare("SELECT COUNT(*) AS count FROM files").get().count,
    active_playable_files: database.prepare("SELECT COUNT(*) AS count FROM files WHERE is_active=1 AND is_playable_video=1").get().count,
  };
  const result = database.transaction(() => {
    const groups = plan.groups.map((group) => applyGroup(database, group));
    rebuildDerivedData(database);
    const after = {
      root_count: database.prepare("SELECT COUNT(*) AS count FROM media WHERE media_type='tv' AND category='series' AND tvshow_id IS NULL AND is_active=1").get().count,
      files: database.prepare("SELECT COUNT(*) AS count FROM files").get().count,
      active_playable_files: database.prepare("SELECT COUNT(*) AS count FROM files WHERE is_active=1 AND is_playable_video=1").get().count,
    };
    if (after.files !== before.files || after.active_playable_files !== before.active_playable_files) throw new Error("SERIES_FILE_INVARIANT_FAILED");
    return { before, after, groups };
  })();
  return { policy_version: SERIES_IDENTITY_POLICY_VERSION, committed: true, ...result, database_fingerprint_after: databaseFingerprint(database) };
}

function reconcileCanonicalSeriesInPlace(database, canonicalRootId, { title, year = null } = {}) {
  const roots = loadRootDetails(database, { activeOnly: true });
  const details = loadRootDetails(database, { activeOnly: false });
  const target = roots.find((root) => root.id === canonicalRootId && isTmdbRoot(root));
  if (!target) return { status: "NO_MATCH", groups: 0, reason: "CANONICAL_ROOT_NOT_FOUND" };
  const key = titleKey(title || target.title);
  const matching = roots.filter((root) => root.id !== target.id && isLocalRoot(root) && titleKey(root.title) === key && compatibleYear(root.year, year ?? target.year) && root.activeEpisodes.length > 0);
  const competingTmdb = roots.filter((root) => root.id !== target.id && isTmdbRoot(root) && rootTitleKeys(root).has(key));
  if (competingTmdb.length > 0) return { status: "AMBIGUOUS", groups: 0, reason: "CONFLICTING_TMDB_IDENTITIES" };
  let merged = 0;
  let files = 0;
  for (const source of matching) {
    const candidate = classifyGroup(key, [target, source]);
    const group = buildGroupPlan(database, candidate, details);
    if (!group) continue;
    const counts = applyGroup(database, group);
    merged += 1;
    files += counts.reassignedFiles;
  }
  if (merged) rebuildDerivedData(database);
  return { status: merged ? "RECONCILED" : "NO_CHANGES", groups: merged, files };
}

module.exports = {
  SERIES_IDENTITY_POLICY_VERSION,
  auditSeriesIdentities,
  applySeriesReconciliation,
  buildSeriesReconciliationPlan,
  compatibleYear,
  databaseFingerprint,
  findCanonicalSeriesRoot: resolveCanonicalSeriesRoot,
  isLocalRoot,
  isTmdbRoot,
  normalizeSeriesTitle: titleKey,
  reconcileCanonicalSeriesInPlace,
  resolveCanonicalSeriesRoot,
  stableJson,
  titleKey,
};
