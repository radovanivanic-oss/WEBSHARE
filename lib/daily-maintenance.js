"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { classifyMedia } = require("./media-classifier");
const { parseMediaName } = require("./media-name-parser");
const { buildCandidate } = require("./candidate-grouper");
const { normalizeFile } = require("../main");
const { acquireCrawlerLock } = require("./crawler/lock");
const {
  applyImportEntries,
  prepareStatements,
  rebuildCatalogIndexesAndCounts,
  rebuildMediaVisibility,
} = require("../scripts/import-catalog-jsonl");
const { openCatalogDatabase, nowIso } = require("../src/db/catalog-db");

const STATE_SCHEMA_VERSION = 1;
const PLAN_SCHEMA_VERSION = 1;
const DEFAULT_POLICY = Object.freeze({
  prefixes: Object.freeze([...("abcdefghijklmnopqrstuvwxyz0123456789")]),
  pageSize: 100,
  maxPagesPerPrefix: 3,
  overlapPages: 1,
  maxRequests: 150,
  maxDiscoveredItems: 5000,
  maxAcceptedItems: 1000,
  staleBucketCount: 180,
  maxStaleChecks: 500,
  missingConfirmations: 2,
  maxDeactivations: 1000,
  maxDeletionFraction: 0.01,
});
const ACCEPTED_TYPES = new Set(["movie", "episode", "concert", "sports"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function planDigestInput(plan) {
  const copy = { ...plan };
  delete copy.created_at;
  delete copy.plan_sha256;
  return copy;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(temporary, filePath);
}

function defaultState() {
  return { schema_version: STATE_SCHEMA_VERSION, last_success_at: null, frontiers: {}, verifications: {} };
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) return defaultState();
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (state.schema_version !== STATE_SCHEMA_VERSION || !state.frontiers || !state.verifications) {
    throw new Error("DAILY_STATE_SCHEMA_MISMATCH");
  }
  return state;
}

function snapshotDatabase(database) {
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM files) AS files,
      (SELECT COUNT(*) FROM files WHERE is_active = 1) AS active_files,
      (SELECT COUNT(*) FROM files WHERE is_active = 1 AND is_playable_video = 1) AS active_playable_files,
      (SELECT COUNT(*) FROM media) AS media,
      (SELECT COUNT(*) FROM media WHERE category IN ('unknown', 'unclassified')) AS unclassified,
      (SELECT COUNT(*) FROM media_fts) AS fts,
      (SELECT COUNT(*) FROM files f LEFT JOIN media m ON m.id = f.media_id WHERE f.media_id IS NULL) AS orphan_files
  `).get();
  const schema = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  const categories = Object.fromEntries(database.prepare(`
    SELECT category || ':' || CASE WHEN is_active = 1 THEN 'active' ELSE 'inactive' END AS key, COUNT(*) AS count
    FROM media GROUP BY category, is_active ORDER BY key
  `).all().map((row) => [row.key, row.count]));
  const ids = crypto.createHash("sha256");
  for (const row of database.prepare("SELECT id, ident, is_active, is_playable_video, COALESCE(media_id, 0) AS media_id FROM files ORDER BY id").iterate()) {
    ids.update(`${row.id}|${row.ident}|${row.is_active}|${row.is_playable_video}|${row.media_id}\n`);
  }
  return { schema_version: Number(schema), ...counts, categories, file_identity_sha256: ids.digest("hex") };
}

function validateNormalizedItem(item) {
  return item && typeof item === "object" && typeof item.ident === "string" && item.ident.length > 0
    && Buffer.byteLength(item.ident, "utf8") <= 256 && typeof item.name === "string" && item.name.length > 0;
}

function classifyItem(item) {
  if (!validateNormalizedItem(item)) return { eligible: false, reason: "INVALID_INPUT", parsed: null, classification: null };
  const parsed = parseMediaName(item.name, { extension: item.extension || item.type });
  const classification = classifyMedia({
    candidate: { candidateType: parsed.candidateType, parseConfidence: parsed.confidence, title: parsed.title },
    sampleName: item.name,
  });
  const eligible = parsed.isVideoExtension && parsed.confidence >= 0.6
    && ACCEPTED_TYPES.has(parsed.candidateType) && classification.category !== "unknown";
  return { eligible, reason: eligible ? "CLASSIFIABLE_INCREMENTAL_MEDIA" : "INSUFFICIENT_CLASSIFICATION", parsed, classification };
}

function normalizeDiscoveryItems(rawItems) {
  const byIdent = new Map();
  for (const raw of rawItems || []) {
    const item = raw && raw.ident && raw.name && raw.size !== undefined ? raw : normalizeFile(raw);
    if (!validateNormalizedItem(item)) continue;
    if (!byIdent.has(item.ident)) byIdent.set(item.ident, item);
  }
  return [...byIdent.values()].sort((left, right) => left.ident.localeCompare(right.ident));
}

function getKnownFiles(database, idents) {
  const result = new Map();
  const statement = database.prepare("SELECT id, ident, is_active, is_playable_video, media_id FROM files WHERE ident = ?");
  for (const ident of idents) result.set(ident, statement.get(ident) || null);
  return result;
}

function buildDiscoveryDelta(database, items) {
  const known = getKnownFiles(database, items.map((item) => item.ident));
  const records = [];
  const counters = { accepted: 0, already_known: 0, reactivation: 0, ignored_unclassified: 0, conflicting: 0, invalid: 0 };
  for (const item of items) {
    const decision = classifyItem(item);
    const existing = known.get(item.ident);
    let action = "IGNORE";
    if (!decision.parsed) {
      counters.invalid += 1;
    } else if (existing && existing.media_id === null) {
      counters.conflicting += 1;
      action = "BLOCK_CONFLICT";
    } else if (!decision.eligible) {
      counters.ignored_unclassified += 1;
      action = "QUARANTINE_UNCLASSIFIED";
    } else if (existing?.is_active === 1) {
      counters.already_known += 1;
      action = "ALREADY_ACTIVE";
    } else if (existing) {
      counters.reactivation += 1;
      action = "REACTIVATE";
    } else {
      counters.accepted += 1;
      action = "INSERT";
    }
    records.push({
      ident: item.ident,
      action,
      media_id: existing?.media_id ?? null,
      file_id: existing?.id ?? null,
      classification: decision.classification,
      parser: decision.parsed && { candidate_type: decision.parsed.candidateType, confidence: decision.parsed.confidence, title: decision.parsed.title, year: decision.parsed.year },
      item: action === "INSERT" || action === "REACTIVATE" ? item : null,
    });
  }
  return { records, counters };
}

function selectStaleCandidates(database, state, now, policy = DEFAULT_POLICY) {
  const day = Math.floor(Date.parse(now) / 86400000);
  const bucket = day % policy.staleBucketCount;
  const rows = database.prepare(`
    SELECT id, ident, media_id, is_active, is_playable_video
    FROM files
    WHERE is_active = 1 AND is_playable_video = 1 AND (id % ?) = ?
    ORDER BY id LIMIT ?
  `).all(policy.staleBucketCount, bucket, policy.maxStaleChecks);
  const seen = new Set(rows.map((row) => row.ident));
  for (const [ident, verification] of Object.entries(state.verifications)) {
    if (seen.has(ident) || verification?.state !== "SUSPECT") continue;
    const row = database.prepare("SELECT id, ident, media_id, is_active, is_playable_video FROM files WHERE ident = ? AND is_active = 1 AND is_playable_video = 1").get(ident);
    if (row) { rows.push(row); seen.add(ident); }
    if (rows.length >= policy.maxStaleChecks) break;
  }
  return rows;
}

function applyVerificationResults(state, outcomes, now) {
  const next = JSON.parse(JSON.stringify(state));
  for (const outcome of outcomes || []) {
    const previous = next.verifications[outcome.ident] || { missing_streak: 0 };
    if (outcome.result === "present") {
      next.verifications[outcome.ident] = { state: "PRESENT", missing_streak: 0, last_checked_at: now };
    } else if (outcome.result === "definitive_missing") {
      next.verifications[outcome.ident] = { state: "SUSPECT", missing_streak: Number(previous.missing_streak || 0) + 1, last_checked_at: now };
    } else {
      next.verifications[outcome.ident] = { ...previous, state: "RETRY_LATER", last_checked_at: now };
    }
  }
  return next;
}

function buildDailyPlan({ database, items = [], staleCandidates = [], verificationOutcomes = [], state = defaultState(), now = new Date().toISOString(), policy = DEFAULT_POLICY, discovery = {} }) {
  const baseline = snapshotDatabase(database);
  const delta = buildDiscoveryDelta(database, normalizeDiscoveryItems(items));
  const nextState = applyVerificationResults(state, verificationOutcomes, now);
  const discoverySummary = {
    complete: discovery.complete === true,
    requests: Number(discovery.requests || 0),
    page_reports: discovery.page_reports || [],
    proposed_frontiers: discovery.proposed_frontiers || {},
    stop_reason: discovery.stop_reason || null,
    observed_items: normalizeDiscoveryItems(items).length,
  };
  const deactivations = [];
  for (const outcome of verificationOutcomes) {
    if (outcome.result !== "definitive_missing") continue;
    const verification = nextState.verifications[outcome.ident];
    const row = staleCandidates.find((candidate) => candidate.ident === outcome.ident);
    if (row && verification?.missing_streak >= policy.missingConfirmations) {
      deactivations.push({ id: row.id, ident: row.ident, media_id: row.media_id, reason: "CONFIRMED_MISSING" });
    }
  }
  const reasons = [];
  if (discovery.complete !== true) reasons.push("DISCOVERY_FRONTIER_NOT_CONFIRMED");
  if (delta.counters.accepted + delta.counters.reactivation > policy.maxAcceptedItems) reasons.push("NEW_DELTA_THRESHOLD");
  if (deactivations.length > policy.maxDeactivations) reasons.push("DELETION_THRESHOLD");
  if (deactivations.length > baseline.active_files * policy.maxDeletionFraction) reasons.push("DELETION_FRACTION_THRESHOLD");
  if (delta.counters.conflicting > 0) reasons.push("CATALOG_CONFLICT");
  if ((verificationOutcomes || []).some((outcome) => outcome.result === "error")) reasons.push("STALE_VERIFICATION_ERRORS");
  const changes = delta.counters.accepted + delta.counters.reactivation + deactivations.length;
  const status = reasons.length ? "BLOCKED" : changes === 0 ? "NO_CHANGES" : "READY_FOR_REVIEW";
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    policy_version: "b45-daily-v1",
    created_at: now,
    status,
    blocked_reasons: reasons,
    baseline,
    discovery: discoverySummary,
    discovery_delta: delta.records,
    counters: {
      ...delta.counters,
      stale_checked: verificationOutcomes.length,
      stale_present: verificationOutcomes.filter((outcome) => outcome.result === "present").length,
      stale_definitive_missing: verificationOutcomes.filter((outcome) => outcome.result === "definitive_missing").length,
      stale_errors: verificationOutcomes.filter((outcome) => outcome.result === "error").length,
      confirmed_missing: deactivations.length,
    },
    deactivations,
    next_state: { ...nextState, frontiers: discovery.proposed_frontiers || nextState.frontiers, last_success_at: null },
    safety: {
      sqlite_write_performed: false,
      import_performed: false,
      deactivation_performed: false,
      reconciliation_performed: false,
      publication_performed: false,
      pointer_switched: false,
    },
  };
  plan.plan_sha256 = sha256(planDigestInput(plan));
  return plan;
}

function assertPlanCurrent(database, plan, policy = DEFAULT_POLICY) {
  const current = snapshotDatabase(database);
  if (sha256(planDigestInput(plan)) !== plan.plan_sha256) throw new Error("DAILY_PLAN_DIGEST_MISMATCH");
  if (stableJson(current) !== stableJson(plan.baseline)) throw new Error("DAILY_DATABASE_BASELINE_DRIFT");
  if (plan.status !== "READY_FOR_REVIEW") throw new Error("DAILY_PLAN_NOT_APPLYABLE");
  if (plan.blocked_reasons?.length) throw new Error("DAILY_PLAN_BLOCKED");
  const actions = plan.discovery_delta.filter((row) => row.action === "INSERT" || row.action === "REACTIVATE");
  if (actions.length > policy.maxAcceptedItems || plan.deactivations.length > policy.maxDeactivations) throw new Error("DAILY_PLAN_THRESHOLD");
  return current;
}

function applyDailyPlan({ databasePath, plan, backupPath, runId = crypto.randomUUID(), policy = DEFAULT_POLICY }) {
  if (!backupPath) throw new Error("DAILY_BACKUP_REQUIRED");
  if (fs.existsSync(backupPath)) throw new Error("DAILY_BACKUP_PATH_MUST_BE_NEW");
  const source = openCatalogDatabase(databasePath, { readonly: true, fileMustExist: true });
  assertPlanCurrent(source, plan, policy);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o750 });
  return source.backup(backupPath).then(() => {
    source.close();
    const database = openCatalogDatabase(databasePath);
    try {
      const result = database.transaction(() => {
        const now = nowIso();
        const crawlRunId = database.prepare(`INSERT INTO crawl_runs(started_at,status,is_full,items_seen,source_manifest,created_at,updated_at) VALUES (?, 'running', 0, ?, ?, ?, ?)`).run(now, plan.discovery_delta.length, JSON.stringify({ daily_plan_sha256: plan.plan_sha256 }), now, now).lastInsertRowid;
        const statements = prepareStatements(database);
        const entries = plan.discovery_delta.filter((row) => row.action === "INSERT" || row.action === "REACTIVATE").map((row) => ({ item: row.item, rawJson: JSON.stringify(row.item) }));
        const imported = entries.length ? applyImportEntries(database, statements, entries, { crawlRunId }) : { inserted: 0, updated: 0 };
        let deactivated = 0;
        for (const row of plan.deactivations) {
          const changed = database.prepare("UPDATE files SET is_active = 0, updated_at = ? WHERE id = ? AND ident = ? AND is_active = 1").run(now, row.id, row.ident).changes;
          if (changed !== 1) throw new Error("DAILY_DEACTIVATION_ROW_DRIFT");
          deactivated += changed;
        }
        rebuildCatalogIndexesAndCounts(database);
        rebuildMediaVisibility(database);
        database.prepare("UPDATE crawl_runs SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, crawlRunId);
        return { crawlRunId, ...imported, deactivated };
      })();
      const post = snapshotDatabase(database);
      return { result, post };
    } finally {
      database.close();
    }
  }).catch((error) => {
    try { source.close(); } catch {}
    throw error;
  });
}

async function discoverRecent({ prefixes = DEFAULT_POLICY.prefixes, state = defaultState(), fetchPage, normalize = normalizeFile, policy = DEFAULT_POLICY }) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage dependency required");
  const items = [];
  const pageReports = [];
  const lastPages = new Map();
  let requests = 0;
  for (const prefix of prefixes) {
    const previous = state.frontiers[prefix] || { idents: [] };
    const previousSet = new Set(previous.idents || []);
    let hit = false;
    let lastPage = [];
    let frontierPage = null;
    for (let page = 0; page < policy.maxPagesPerPrefix; page += 1) {
      if (requests >= policy.maxRequests) return { items: normalizeDiscoveryItems(items), complete: false, requests, page_reports: pageReports, proposed_frontiers: state.frontiers, stop_reason: "MAX_REQUESTS" };
      const response = await fetchPage({ prefix, offset: page * policy.pageSize, limit: policy.pageSize });
      requests += 1;
      const rawPage = Array.isArray(response?.files) ? response.files : [];
      const pageItems = rawPage.map(normalize).filter(validateNormalizedItem);
      lastPage = pageItems;
      items.push(...pageItems);
      if (pageItems.some((item) => previousSet.has(item.ident))) {
        hit = true;
        frontierPage ||= pageItems;
      }
      if (hit && page >= policy.overlapPages) break;
      if (rawPage.length < policy.pageSize) break;
    }
    pageReports.push({ prefix, frontier_hit: hit, last_page_count: lastPage.length });
    lastPages.set(prefix, frontierPage || lastPage);
  }
  const proposed = { ...state.frontiers };
  for (const report of pageReports) {
    const pageItems = lastPages.get(report.prefix) || [];
    proposed[report.prefix] = { idents: pageItems.slice(-Math.min(policy.pageSize, 32)).map((item) => item.ident) };
  }
  return { items: normalizeDiscoveryItems(items), complete: pageReports.length === prefixes.length && pageReports.every((report) => report.frontier_hit), requests, page_reports: pageReports, proposed_frontiers: proposed, stop_reason: "COMPLETED" };
}

module.exports = {
  ACCEPTED_TYPES,
  DEFAULT_POLICY,
  PLAN_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  applyDailyPlan,
  applyVerificationResults,
  assertPlanCurrent,
  buildDailyPlan,
  buildDiscoveryDelta,
  classifyItem,
  defaultState,
  discoverRecent,
  getKnownFiles,
  normalizeDiscoveryItems,
  planDigestInput,
  readState,
  selectStaleCandidates,
  sha256,
  snapshotDatabase,
  stableJson,
  writeJsonAtomic,
};
