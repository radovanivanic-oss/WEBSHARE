"use strict";

const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { SCHEMA } = require("./deployment-evidence");
const { resolveNginxIncludeGraph } = require("./nginx-include-graph");

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const now = () => new Date().toISOString();
const RELEVANT = /(webshare|catalog|crawler|metadata|publication|export)/iu;

function write(dir, name, value) {
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  fs.renameSync(tmp, file);
  return sha(fs.readFileSync(file));
}

function defaultRunner(bin, args, limit) {
  const result = cp.spawnSync(bin, args, { encoding: "utf8", maxBuffer: limit });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error || result.status !== 0) {
    const error = result.error || new Error("command failed");
    error.output = output;
    error.status = result.status;
    throw error;
  }
  return output;
}

function resolveCommit(repositoryRoot) {
  let commit;
  try {
    commit = cp.execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024,
    }).trim();
  } catch {
    throw new Error("repository commit unresolved");
  }
  if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error("repository commit unresolved");
  return commit.toLowerCase();
}

function nginxBin(options) {
  if (options.nginxBin) return options.nginxBin;
  for (const candidate of ["nginx", "/usr/sbin/nginx", "/usr/local/sbin/nginx", "/usr/bin/nginx"]) {
    if (candidate === "nginx" || fs.existsSync(candidate)) return candidate;
  }
  return "nginx";
}

function standardNginxMainConfig(options) {
  if (options.nginxMainConfig) return path.resolve(options.nginxMainConfig);
  for (const candidate of ["/etc/nginx/nginx.conf", "/usr/local/etc/nginx/nginx.conf"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function snapshotBase(type, startedAt, records, extra) {
  return {
    schema: SCHEMA[type],
    schema_version: 1,
    captured_at: startedAt,
    redaction_applied: true,
    capture_method: "committed read-only capture",
    records,
    ...extra,
  };
}

function linesOf(raw) {
  return String(raw || "").split(/\r?\n/u).filter(Boolean);
}

function cronRecords(raw) {
  const lines = linesOf(raw);
  const records = [];
  for (const line of lines.filter((value) => RELEVANT.test(value))) {
    const commented = /^\s*#/u.test(line);
    records.push({
      owner: "current-user",
      schedule: commented ? "" : line.trim().split(/\s+/u).slice(0, 5).join(" "),
      command: line.replace(/^\s*#?\s*/u, "").slice(0, 4096),
      commented,
      source: "user-crontab",
      relevant_role: /crawler/iu.test(line) ? "crawler" : "unknown_webshare",
    });
  }
  return { lines, records };
}

function processRecords(raw) {
  const lines = linesOf(raw);
  const records = [];
  for (const line of lines.filter((value) => RELEVANT.test(value))) {
    if (/capture-catalog-deployment-evidence|audit-catalog-consumer-deployment/iu.test(line)) continue;
    const fields = line.trim().split(/\s+/u);
    records.push({
      pid: Number(fields[0]) || 0,
      user: fields[1] || "unknown",
      started_at: "",
      command: line.slice(0, 4096),
      cwd: "/home/radeco/webshare-crawler",
      matching_unit: /catalog-api/iu.test(line) ? "webshare-catalog-api.service" : "",
      relevant_role: /catalog-api/iu.test(line) ? "catalog_api" : "unknown_webshare",
    });
  }
  return { lines, records };
}

function systemdRecords(raw, bin, runner) {
  const lines = linesOf(raw);
  const records = [];
  for (const line of lines.filter((value) => RELEVANT.test(value))) {
    const parts = line.trim().split(/\s+/u);
    const unit = parts[0] || "unknown";
    let show = "";
    try {
      show = String(runner(bin, [
        "show",
        unit,
        "-p",
        "ActiveState",
        "-p",
        "SubState",
        "-p",
        "ExecStart",
        "-p",
        "WorkingDirectory",
        "-p",
        "FragmentPath",
        "--no-pager",
      ]));
    } catch {
      show = "";
    }
    const get = (key) => (show.match(new RegExp(`^${key}=(.*)$`, "m")) || [])[1] || "";
    records.push({
      unit_name: unit,
      unit_type: unit.endsWith(".timer") ? "timer" : "service",
      load_state: parts[1] || "unknown",
      active_state: get("ActiveState") || "unknown",
      sub_state: get("SubState") || "unknown",
      enabled_state: parts[1] || "unknown",
      exec_start: get("ExecStart"),
      working_directory: get("WorkingDirectory"),
      environment_file_paths: [],
      fragment_path: get("FragmentPath"),
      triggered_by: "",
      wanted_by: "",
      required_by: "",
    });
  }
  return { lines, records };
}

function nginxRecords(options, bin, runner) {
  const limitations = [];
  let commandSucceeded = false;
  let commandFailed = false;
  try {
    runner(bin, ["-T"]);
    commandSucceeded = true;
  } catch {
    commandFailed = true;
    limitations.push("NGINX_T_FAILED_FILESYSTEM_FALLBACK");
  }
  const mainConfig = standardNginxMainConfig(options);
  if (!mainConfig) {
    return {
      value: snapshotBase("nginx", options.startedAt, [], {
        capture_status: "FAILED",
        coverage_status: "UNAVAILABLE",
        commands_attempted: 1,
        commands_succeeded: commandSucceeded ? 1 : 0,
        commands_failed: commandFailed ? 1 : 0,
        records_examined: 0,
        records_relevant: 0,
        limitations: ["NGINX_UNAVAILABLE"],
      }),
      graph: null,
    };
  }
  try {
    const graph = resolveNginxIncludeGraph({
      mainConfigPath: mainConfig,
      approvedRoots: options.nginxConfigRoot ? [options.nginxConfigRoot] : [],
      activeConfigLinkage: commandSucceeded ? "NGINX_T_ACTIVE_CONFIG" : "STANDARD_DEFAULT_WITH_ACTIVE_NGINX",
    });
    const records = graph.records;
    const snapshot = snapshotBase("nginx", options.startedAt, records, {
      capture_method: commandSucceeded ? "NGINX_T_WITH_ACTIVE_GRAPH" : "FILESYSTEM_ACTIVE_CONFIG",
      capture_status: "SUCCESS",
      coverage_status: "COMPLETE_FOR_DECLARED_SCOPE",
      commands_attempted: 1,
      commands_succeeded: 1,
      commands_failed: commandFailed ? 1 : 0,
      records_examined: graph.graph.files_examined,
      records_relevant: records.length,
      limitations,
      nginx_graph: graph.graph,
      active_static_catalog_path_found: graph.graph.active_static_catalog_path_found,
    });
    return { value: snapshot, graph: graph.graph };
  } catch (error) {
    return {
      value: snapshotBase("nginx", options.startedAt, [], {
        capture_method: "FILESYSTEM_ACTIVE_CONFIG",
        capture_status: "PARTIAL",
        coverage_status: "PARTIAL",
        commands_attempted: 1,
        commands_succeeded: commandSucceeded ? 1 : 0,
        commands_failed: commandFailed ? 1 : 0,
        records_examined: 0,
        records_relevant: 0,
        limitations: uniqueLimitations([...limitations, error.message || "NGINX_GRAPH_FAILED"]),
      }),
      graph: null,
    };
  }
}

function uniqueLimitations(values) {
  return [...new Set(values.filter(Boolean))];
}

function capture(options, runner = (bin, args) => defaultRunner(bin, args, options.maxCommandOutputBytes || 262144)) {
  if (!options.repositoryRoot || !options.outputDir || fs.existsSync(options.outputDir)) {
    throw new Error("unsafe capture output");
  }
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const commit = resolveCommit(repositoryRoot);
  const startedAt = now();
  const defs = {
    systemd: [options.systemctlBin || "systemctl", ["list-unit-files", "--type=service", "--type=timer", "--no-pager"]],
    cron: [options.crontabBin || "crontab", ["-l"]],
    process: [options.psBin || "ps", ["-eo", "pid,user,lstart,args"]],
  };
  const values = {};

  for (const [type, [bin, args]] of Object.entries(defs)) {
    let raw = "";
    let ok = false;
    const limitations = [];
    try {
      raw = String(runner(bin, args));
      ok = true;
    } catch {
      limitations.push(`${type.toUpperCase()}_UNAVAILABLE`);
    }
    const parsed =
      type === "systemd" ? systemdRecords(raw, bin, runner) :
      type === "cron" ? cronRecords(raw) :
      processRecords(raw);
    values[type] = snapshotBase(type, startedAt, parsed.records, {
      capture_status: ok ? "SUCCESS" : "FAILED",
      coverage_status: ok ? "COMPLETE_FOR_DECLARED_SCOPE" : "UNAVAILABLE",
      commands_attempted: 1,
      commands_succeeded: ok ? 1 : 0,
      commands_failed: ok ? 0 : 1,
      records_examined: parsed.lines.length,
      records_relevant: parsed.records.length,
      limitations,
    });
  }

  const nginx = nginxRecords({ ...options, startedAt }, nginxBin(options), runner);
  values.nginx = nginx.value;

  fs.mkdirSync(options.outputDir, { mode: 0o750 });
  const hashes = {};
  for (const [key, value] of Object.entries(values)) {
    hashes[`${key}-snapshot.json`] = write(options.outputDir, `${key}-snapshot.json`, value);
  }
  const materialEvidenceComplete = Object.values(values).every((value) =>
    value.capture_status === "SUCCESS" &&
    value.coverage_status === "COMPLETE_FOR_DECLARED_SCOPE" &&
    value.commands_attempted > 0 &&
    value.commands_succeeded > 0 &&
    value.records_examined > 0
  );
  const manifest = {
    schema: "webshare-deployment-capture/v1",
    schema_version: 1,
    capture_id: crypto.randomUUID(),
    started_at: startedAt,
    finished_at: now(),
    repository_root: repositoryRoot,
    repository_commit: commit,
    snapshot_hashes: hashes,
    snapshot_set_complete: true,
    material_evidence_complete: materialEvidenceComplete,
    capture_statuses: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.capture_status])),
    coverage_statuses: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.coverage_status])),
    read_only_capture: true,
    service_change_performed: false,
    nginx_reload_performed: false,
    cron_change_performed: false,
    systemd_change_performed: false,
    process_signal_performed: false,
    production_sqlite_opened: false,
    webshare_api_requests: 0,
    finished_reason: "completed",
  };
  write(options.outputDir, "capture.manifest.json", manifest);
  write(options.outputDir, "capture.log", { finished_reason: "completed" });
  return manifest;
}

module.exports = { capture, nginxBin, resolveCommit };
