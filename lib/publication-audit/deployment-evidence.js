"use strict";

const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAX = 2 * 1024 * 1024;
const LIMIT = { systemd: 256, nginx: 256, cron: 128, process: 256 };
const SCHEMA = {
  systemd: "webshare-systemd-snapshot/v1",
  nginx: "webshare-nginx-snapshot/v1",
  cron: "webshare-cron-snapshot/v1",
  process: "webshare-process-snapshot/v1",
};
const FIELDS = {
  systemd: [
    "unit_name",
    "unit_type",
    "load_state",
    "active_state",
    "sub_state",
    "enabled_state",
    "exec_start",
    "working_directory",
    "environment_file_paths",
    "fragment_path",
    "triggered_by",
    "wanted_by",
    "required_by",
  ],
  nginx: [
    "config_file",
    "server_names",
    "listen",
    "location",
    "root",
    "alias",
    "proxy_pass",
    "try_files",
    "include_chain",
    "active",
    "target_kind",
    "effective_target",
    "source_file",
    "canonical_source_file",
    "include_depth",
    "symlink_source",
    "symlink_target",
    "config_file_sha256",
    "record_index",
  ],
  cron: ["owner", "schedule", "command", "commented", "source", "relevant_role"],
  process: ["pid", "user", "started_at", "command", "cwd", "matching_unit", "relevant_role"],
};
const META = [
  "capture_status",
  "coverage_status",
  "commands_attempted",
  "commands_succeeded",
  "commands_failed",
  "records_examined",
  "records_relevant",
  "limitations",
];
const NGINX_TOP = ["nginx_graph", "active_static_catalog_path_found"];

const digest = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function safe(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return true;
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") > 4096) return true;
  return /(password|passwd|secret|wst|authorization|bearer|cookie|api[_-]?key|credential)\s*[:=]\s*\S+/iu.test(text);
}

function isUtc(value) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function material(value) {
  return value.capture_status === "SUCCESS" &&
    value.coverage_status === "COMPLETE_FOR_DECLARED_SCOPE" &&
    value.commands_attempted > 0 &&
    value.commands_succeeded > 0 &&
    value.records_examined > 0;
}

function validateObjectValue(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      if (entry.some((item) => typeof item === "object" ? !validateObjectValue(item) : safe(item))) return false;
    } else if (entry && typeof entry === "object") {
      if (!validateObjectValue(entry)) return false;
    } else if (safe(entry)) {
      return false;
    }
  }
  return true;
}

function snapshot(file, type) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX) throw new Error("unsafe snapshot");
  const raw = fs.readFileSync(file);
  if (raw.includes(0)) throw new Error("invalid snapshot UTF-8");
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("invalid snapshot JSON");
  }
  const top = [
    "schema",
    "schema_version",
    "captured_at",
    "redaction_applied",
    "records",
    "capture_method",
    "capture_host",
    ...META,
    ...(type === "nginx" ? NGINX_TOP : []),
  ];
  if (!value || typeof value !== "object" ||
      Object.keys(value).some((key) => !top.includes(key)) ||
      value.schema !== SCHEMA[type] ||
      value.schema_version !== 1 ||
      value.redaction_applied !== true ||
      !Array.isArray(value.records) ||
      value.records.length > LIMIT[type] ||
      !isUtc(value.captured_at)) {
    throw new Error("invalid snapshot schema");
  }
  for (const key of META) if (!(key in value)) throw new Error("MATERIAL_EVIDENCE_INCOMPLETE");
  if (!["SUCCESS", "PARTIAL", "FAILED"].includes(value.capture_status) ||
      !["COMPLETE_FOR_DECLARED_SCOPE", "PARTIAL", "UNAVAILABLE"].includes(value.coverage_status) ||
      !META.slice(2, 7).every((key) => Number.isInteger(value[key]) && value[key] >= 0) ||
      !Array.isArray(value.limitations) ||
      value.limitations.some(safe)) {
    throw new Error("invalid snapshot metadata");
  }
  if (type === "nginx" && value.nginx_graph && !validateObjectValue(value.nginx_graph)) {
    throw new Error("invalid nginx graph metadata");
  }
  for (const record of value.records) {
    if (!record || Array.isArray(record) || typeof record !== "object" ||
        Object.keys(record).some((key) => !FIELDS[type].includes(key))) {
      throw new Error("unknown snapshot record field");
    }
    for (const entry of Object.values(record)) {
      if (Array.isArray(entry) ? entry.some(safe) : safe(entry)) throw new Error("unsafe snapshot value");
    }
  }
  if (!material(value)) throw new Error("MATERIAL_EVIDENCE_INCOMPLETE");
  return { value, digest: digest(raw) };
}

function gitCommit(root) {
  let output;
  try {
    output = cp.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024,
    }).trim();
  } catch {
    throw new Error("repository commit unresolved");
  }
  if (!/^[0-9a-f]{40}$/iu.test(output)) throw new Error("repository commit unresolved");
  return output.toLowerCase();
}

function normalizeRepoPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
  if (path.isAbsolute(normalized) || normalized.includes("../") || normalized === "..") return null;
  return normalized;
}

function sourceRole(repoPath) {
  if (!repoPath) return "unknown";
  if (repoPath.startsWith("tests/")) return "test";
  if (/\.md$/iu.test(repoPath) || repoPath.startsWith("docs/")) return "documentation";
  return "runtime";
}

function provenance(snapshotType, snaps, index, kind, confidence = "STRONG_EVIDENCE") {
  return {
    snapshot_type: snapshotType,
    snapshot_sha256: snaps[snapshotType].digest,
    record_index: index,
    evidence_kind: kind,
    confidence_contribution: confidence,
  };
}

function textMatches(text, needle) {
  return Boolean(needle && text.includes(needle));
}

function readTextIfSmall(repositoryRoot, repoPath) {
  if (!repoPath) return "";
  const file = path.join(repositoryRoot, repoPath);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function packageScripts(repositoryRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    return pkg.scripts || {};
  } catch {
    return {};
  }
}

function candidatePaths(candidate) {
  return [
    normalizeRepoPath(candidate.repository_path),
    normalizeRepoPath(candidate.file_path),
  ].filter(Boolean);
}

function repositoryDependencies(repositoryRoot, repoPath, scripts, seen = new Set()) {
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized || seen.has(normalized) || seen.size > 256) return seen;
  seen.add(normalized);
  const text = readTextIfSmall(repositoryRoot, normalized);
  for (const match of text.matchAll(/require\(["'](\.{1,2}\/[^"']+)["']\)/gu)) {
    const resolved = path.resolve(path.dirname(path.join(repositoryRoot, normalized)), match[1]);
    const candidates = [resolved, `${resolved}.js`, path.join(resolved, "index.js")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        repositoryDependencies(repositoryRoot, path.relative(repositoryRoot, candidate).replaceAll("\\", "/"), scripts, seen);
        break;
      }
    }
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (text.includes(`npm run ${name}`) || text.includes(`npm run ${name.split(":").at(-1)}`)) {
      for (const match of String(command).matchAll(/\b([\w./-]+\.js)\b/gu)) {
        repositoryDependencies(repositoryRoot, match[1].replace(/^\.\//u, ""), scripts, seen);
      }
    }
  }
  for (const match of text.matchAll(/\b(node|bash|sh)\s+([\w./-]+)\b/gu)) {
    const referenced = match[2].replace(/^\.\//u, "");
    if (/^[-]/u.test(referenced)) continue;
    const resolved = path.resolve(path.dirname(path.join(repositoryRoot, normalized)), referenced);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      repositoryDependencies(repositoryRoot, path.relative(repositoryRoot, resolved).replaceAll("\\", "/"), scripts, seen);
    } else {
      repositoryDependencies(repositoryRoot, referenced, scripts, seen);
    }
  }
  return seen;
}

function buildContext(repositoryRoot, inventory, snaps) {
  const scripts = packageScripts(repositoryRoot);
  const inactiveCronPaths = new Map();
  snaps.cron.value.records.forEach((record, index) => {
    if (!record.commented) return;
    const command = String(record.command || "");
    const direct = [...command.matchAll(/(?:^|\s)(?:\/[\w./-]+webshare-crawler\/)?([\w./-]+(?:\.js|\.sh))/gu)]
      .map((match) => normalizeRepoPath(match[1]))
      .filter(Boolean);
    const paths = new Set();
    for (const repoPath of direct) {
      repositoryDependencies(repositoryRoot, repoPath, scripts, paths);
    }
    for (const repoPath of paths) {
      if (!inactiveCronPaths.has(repoPath)) inactiveCronPaths.set(repoPath, []);
      inactiveCronPaths.get(repoPath).push(provenance("cron", snaps, index, "commented_cron_transitive_wrapper", "STRONG_EVIDENCE"));
    }
  });
  return { inactiveCronPaths };
}

function exactReferences(candidate, snaps) {
  const paths = candidatePaths(candidate);
  const artifact = typeof candidate.artifact_path_reference === "string" ? candidate.artifact_path_reference : "";
  const refs = [];
  for (const [type, snapshotValue] of Object.entries(snaps)) {
    snapshotValue.value.records.forEach((record, index) => {
      const text = JSON.stringify(record);
      if (paths.some((repoPath) => textMatches(text, repoPath)) || textMatches(text, artifact)) {
        refs.push(provenance(type, snaps, index, "exact_path_or_artifact_match"));
      }
    });
  }
  return refs;
}

function isActiveRecord(record) {
  return record.active_state === "active" || record.active === true || record.commented === false;
}

function isCatalogApi(candidate, snaps) {
  const paths = candidatePaths(candidate);
  if (!paths.includes("server/catalog-api.js")) return null;
  const systemIndex = snaps.systemd.value.records.findIndex((record) =>
    record.unit_name === "webshare-catalog-api.service" &&
    record.active_state === "active" &&
    String(record.exec_start || "").includes("server/catalog-api.js")
  );
  const processIndex = snaps.process.value.records.findIndex((record) =>
    String(record.command || "").includes("server/catalog-api.js") &&
    String(record.cwd || "").includes("webshare-crawler")
  );
  if (systemIndex >= 0 && processIndex >= 0) {
    return [
      provenance("systemd", snaps, systemIndex, "active_unit_exact_entrypoint", "PROVEN"),
      provenance("process", snaps, processIndex, "matching_process_and_cwd", "PROVEN"),
    ];
  }
  return null;
}

function deploymentComplete(snaps) {
  return Object.values(snaps).every((snapshotValue) => material(snapshotValue.value));
}

function classify(candidate, snaps, context, repositoryRoot) {
  const repoPath = candidatePaths(candidate)[0] || null;
  const role = sourceRole(repoPath);
  if (role === "test") return ["TEST_ONLY", [], "PROVEN"];
  if (role === "documentation") return ["DOCUMENTATION_ONLY", [], "PROVEN"];

  const catalogApiEvidence = isCatalogApi(candidate, snaps);
  if (catalogApiEvidence) return ["ACTIVE_PRODUCTION", catalogApiEvidence, "PROVEN"];

  const refs = exactReferences(candidate, snaps);
  const activeRefs = refs.filter((reference) => {
    const record = snaps[reference.snapshot_type].value.records[reference.record_index];
    return isActiveRecord(record);
  });
  if (activeRefs.length > 0) return ["ACTIVE_PRODUCTION", activeRefs, "STRONG_EVIDENCE"];

  if (repoPath && context.inactiveCronPaths.has(repoPath)) {
    return ["INSTALLED_BUT_INACTIVE", context.inactiveCronPaths.get(repoPath), "STRONG_EVIDENCE"];
  }

  if (refs.length > 0) return ["INSTALLED_BUT_INACTIVE", refs, "PARTIAL_EVIDENCE"];

  if (repoPath && deploymentComplete(snaps) && fs.existsSync(path.join(repositoryRoot, repoPath))) {
    return ["LEGACY_NOT_DEPLOYED", [], "STRONG_EVIDENCE"];
  }

  return ["UNKNOWN", [], "UNKNOWN"];
}

function staticServingConclusion(snaps, rows) {
  if (snaps.nginx.value.active_static_catalog_path_found === true) return "ACTIVE_STATIC_SERVING";
  const graph = snaps.nginx.value.nginx_graph;
  const nginxComplete = graph?.full_graph_resolved === true &&
    graph.parser_status === "SUCCESS" &&
    snaps.nginx.value.coverage_status === "COMPLETE_FOR_DECLARED_SCOPE";
  if (!nginxComplete || !deploymentComplete(snaps)) return "UNKNOWN";
  const unresolvedStatic = rows.some((row) =>
    row.deployment_status === "UNKNOWN" &&
    /jsonl|manifest/iu.test(row.artifact_path_reference || "") &&
    !sourceRole(row.repository_path).match(/test|documentation/u)
  );
  return unresolvedStatic ? "UNKNOWN" : "NO_ACTIVE_STATIC_SERVING_PROVEN";
}

function write(dir, name, value) {
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(tmp, file);
  return digest(fs.readFileSync(file));
}

function run(options) {
  for (const input of [options.repositoryRoot, options.compatibilityDir]) {
    if (!fs.existsSync(input) || fs.lstatSync(input).isSymbolicLink()) throw new Error("unsafe input");
  }
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const commit = gitCommit(repositoryRoot);
  const snaps = Object.fromEntries(Object.keys(SCHEMA).map((key) => [key, snapshot(options[key], key)]));
  const inventoryPath = path.join(options.compatibilityDir, "consumer-inventory.json");
  const manifestPath = path.join(options.compatibilityDir, "compatibility.manifest.json");
  if (!fs.existsSync(inventoryPath) || !fs.existsSync(manifestPath) || fs.existsSync(options.outputDir)) {
    throw new Error("unsafe output or source");
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const compatibilityManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(inventory)) throw new Error("invalid inventory");
  void compatibilityManifest;

  const context = buildContext(repositoryRoot, inventory, snaps);
  const rows = inventory.map((candidate) => {
    const repositoryPath = candidatePaths(candidate)[0] || null;
    const [deploymentStatus, deploymentEvidence, confidence] = classify(candidate, snaps, context, repositoryRoot);
    return {
      ...candidate,
      repository_path: repositoryPath,
      repository_path_status: repositoryPath ? "PRESENT" : "ABSENT_ALLOWED",
      deployment_status: deploymentStatus,
      confidence,
      jsonl_publication_impact: candidate.consumer_type === "SQLITE_DIRECT" ? "NOT_AFFECTED" : "UNKNOWN",
      deployment_evidence: deploymentEvidence,
      blocking_unknowns: deploymentStatus === "UNKNOWN" ? ["no matching deployment evidence"] : [],
    };
  });

  const summary = {
    active_production: 0,
    installed_but_inactive: 0,
    legacy_not_deployed: 0,
    test_only: 0,
    documentation_only: 0,
    unknown: 0,
    active_jsonl_consumers: 0,
    active_manifest_consumers: 0,
    active_sqlite_consumers: 0,
    unknown_jsonl_consumers: 0,
    unknown_manifest_consumers: 0,
    systemd_snapshot_valid: true,
    nginx_snapshot_valid: true,
    cron_snapshot_valid: true,
    process_snapshot_valid: true,
    snapshot_set_complete: true,
    material_evidence_complete: true,
    static_serving_conclusion: "UNKNOWN",
  };
  for (const row of rows) {
    summary[row.deployment_status.toLowerCase()] += 1;
    const reference = row.artifact_path_reference || "";
    if (row.deployment_status === "ACTIVE_PRODUCTION" && row.consumer_type === "SQLITE_DIRECT") summary.active_sqlite_consumers += 1;
    if (row.deployment_status === "ACTIVE_PRODUCTION" && /jsonl/iu.test(reference)) summary.active_jsonl_consumers += 1;
    if (row.deployment_status === "ACTIVE_PRODUCTION" && /manifest/iu.test(reference)) summary.active_manifest_consumers += 1;
    if (row.deployment_status === "UNKNOWN" && /jsonl/iu.test(reference)) summary.unknown_jsonl_consumers += 1;
    if (row.deployment_status === "UNKNOWN" && /manifest/iu.test(reference)) summary.unknown_manifest_consumers += 1;
  }
  summary.static_serving_conclusion = staticServingConclusion(snaps, rows);

  fs.mkdirSync(options.outputDir, { mode: 0o750 });
  const sources = {
    repository_commit: commit,
    compatibility_manifest_sha256: digest(fs.readFileSync(manifestPath)),
    consumer_inventory_sha256: digest(fs.readFileSync(inventoryPath)),
    snapshots: Object.fromEntries(Object.entries(snaps).map(([key, value]) => [key, {
      schema: value.value.schema,
      sha256: value.digest,
      captured_at: value.value.captured_at,
      capture_status: value.value.capture_status,
      coverage_status: value.value.coverage_status,
    }])),
  };
  const hashes = {};
  hashes["source-reference.json"] = write(options.outputDir, "source-reference.json", sources);
  hashes["consumer-deployment.json"] = write(options.outputDir, "consumer-deployment.json", rows);
  for (const key of Object.keys(snaps)) hashes[`${key}-evidence.json`] = write(options.outputDir, `${key}-evidence.json`, snaps[key].value);
  hashes["deployment-summary.json"] = write(options.outputDir, "deployment-summary.json", summary);
  const manifest = {
    schema_version: 1,
    run_id: crypto.randomUUID(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    repository_commit: commit,
    audit_only: true,
    consumer_migration_performed: false,
    publication_performed: false,
    catalog_replacement_performed: false,
    production_generation_created: false,
    current_pointer_modified: false,
    production_sqlite_write_performed: false,
    wal_checkpoint_performed: false,
    service_restart_performed: false,
    nginx_reload_performed: false,
    cron_change_performed: false,
    systemd_change_performed: false,
    webshare_api_requests: 0,
    snapshot_set_complete: true,
    material_evidence_complete: true,
    snapshot_digests: Object.fromEntries(Object.entries(snaps).map(([key, value]) => [key, value.digest])),
    classification_counters: summary,
    artifact_hashes: hashes,
    finished_reason: "completed",
  };
  write(options.outputDir, "audit.manifest.json", manifest);
  write(options.outputDir, "audit.log", { run_id: manifest.run_id, finished_reason: "completed" });
  return manifest;
}

module.exports = {
  run,
  snapshot,
  MAX,
  LIMIT,
  SCHEMA,
  FIELDS,
  material,
  gitCommit,
  classify,
  buildContext,
  staticServingConclusion,
};
