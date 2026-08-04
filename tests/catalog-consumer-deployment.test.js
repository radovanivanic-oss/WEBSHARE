"use strict";

const a = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { run } = require("../lib/publication-audit/deployment-evidence");
const { args } = require("../scripts/audit-catalog-consumer-deployment");

function snapshotFile(directory, type, records = [], extra = {}) {
  const file = path.join(directory, `${type}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema: `webshare-${type}-snapshot/v1`,
    schema_version: 1,
    captured_at: "2026-08-03T00:00:00Z",
    redaction_applied: true,
    records,
    capture_status: "SUCCESS",
    coverage_status: "COMPLETE_FOR_DECLARED_SCOPE",
    commands_attempted: 1,
    commands_succeeded: 1,
    commands_failed: 0,
    records_examined: 1,
    records_relevant: records.length,
    limitations: [],
    ...extra,
  }));
  return file;
}

function fixture(t, inventory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-"));
  const compatibility = path.join(directory, "c");
  const output = path.join(directory, "o");
  fs.mkdirSync(compatibility);
  fs.writeFileSync(path.join(compatibility, "consumer-inventory.json"), JSON.stringify(inventory));
  fs.writeFileSync(path.join(compatibility, "compatibility.manifest.json"), "{}");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    repositoryRoot: path.resolve(__dirname, ".."),
    compatibilityDir: compatibility,
    outputDir: output,
  };
}

function baseOptions(t, inventory) {
  const options = fixture(t, inventory);
  return {
    ...options,
    systemd: snapshotFile(options.directory, "systemd", [{ unit_name: "webshare-catalog-api.service", active_state: "active", exec_start: "server/catalog-api.js", working_directory: "/home/radeco/webshare-crawler" }]),
    nginx: snapshotFile(options.directory, "nginx", [], {
      nginx_graph: {
        full_graph_resolved: true,
        parser_status: "SUCCESS",
        files_examined: 3,
        active_static_catalog_path_found: false,
      },
      active_static_catalog_path_found: false,
    }),
    cron: snapshotFile(options.directory, "cron", [{ owner: "current-user", schedule: "", command: "0 8,20 * * * /bin/bash /home/radeco/webshare-crawler/scripts/run-crawler-and-update.sh", commented: true, source: "user-crontab", relevant_role: "crawler" }]),
    process: snapshotFile(options.directory, "process", [{ pid: 1, user: "x", command: "node server/catalog-api.js", cwd: "/home/radeco/webshare-crawler", matching_unit: "webshare-catalog-api.service", relevant_role: "catalog_api" }]),
  };
}

test("snapshots validate before output and derive active evidence", (t) => {
  const options = baseOptions(t, [
    { file_path: "server/catalog-api.js", artifact_path_reference: "data/catalog.sqlite", consumer_type: "SQLITE_DIRECT" },
    { repository_path: "tests/a.test.js", consumer_type: "UNKNOWN" },
  ]);
  const manifest = run(options);
  const rows = JSON.parse(fs.readFileSync(path.join(options.outputDir, "consumer-deployment.json"), "utf8"));
  a.equal(manifest.material_evidence_complete, true);
  a.match(manifest.repository_commit, /^[0-9a-f]{40}$/u);
  a.equal(rows[0].deployment_status, "ACTIVE_PRODUCTION");
  a.equal(rows[0].repository_path, "server/catalog-api.js");
});

test("missing arguments and malformed snapshots create no root", (t) => {
  const options = baseOptions(t, []);
  a.throws(() => args([]));
  fs.writeFileSync(options.nginx, "{");
  a.throws(() => run(options));
  a.equal(fs.existsSync(options.outputDir), false);
});

test("production-shaped JSONL and manifest candidates resolve without static serving", (t) => {
  const options = baseOptions(t, [
    { file_path: "server/catalog-api.js", artifact_path_reference: "data/catalog.sqlite", consumer_type: "SQLITE_DIRECT" },
    { file_path: "lib/catalog-safety.js", artifact_path_reference: "catalog-items.manifest.json", consumer_type: "MANIFEST_VALIDATOR" },
    { file_path: "lib/crawler/config.js", artifact_path_reference: "catalog-items.jsonl", consumer_type: "UNKNOWN" },
    { file_path: "main.js", artifact_path_reference: "catalog-items.jsonl", consumer_type: "UNKNOWN" },
    { file_path: "scripts/benchmark-crawler-state.js", artifact_path_reference: "catalog-items.jsonl", consumer_type: "UNKNOWN" },
    { file_path: "scripts/create-catalog-manifest.js", artifact_path_reference: "catalog-items.jsonl", consumer_type: "UNKNOWN" },
    { file_path: "scripts/update-catalog-database.js", artifact_path_reference: "catalog-items.jsonl", consumer_type: "UNKNOWN" },
  ]);
  run(options);
  const rows = JSON.parse(fs.readFileSync(path.join(options.outputDir, "consumer-deployment.json"), "utf8"));
  const summary = JSON.parse(fs.readFileSync(path.join(options.outputDir, "deployment-summary.json"), "utf8"));
  a.equal(rows.find((row) => row.file_path === "server/catalog-api.js").deployment_status, "ACTIVE_PRODUCTION");
  for (const row of rows.filter((entry) => /catalog-items/iu.test(entry.artifact_path_reference || ""))) {
    a.notEqual(row.deployment_status, "UNKNOWN", row.file_path);
  }
  a.equal(summary.unknown_jsonl_consumers, 0);
  a.equal(summary.unknown_manifest_consumers, 0);
  a.equal(summary.static_serving_conclusion, "NO_ACTIVE_STATIC_SERVING_PROVEN");
});

test("active nginx static records are counted independently", (t) => {
  const options = baseOptions(t, [
    { file_path: "scripts/static-reader.js", artifact_path_reference: "runtime/catalog-items.jsonl", consumer_type: "JSONL_STREAM" },
    { file_path: "scripts/static-manifest.js", artifact_path_reference: "runtime/catalog-items.manifest.json", consumer_type: "MANIFEST_VALIDATOR" },
  ]);
  options.nginx = snapshotFile(options.directory, "nginx", [
    { config_file: "nginx", server_names: "_", listen: "80", location: "/catalog-items.jsonl", root: "", alias: "/home/radeco/webshare-crawler/runtime/catalog-items.jsonl", proxy_pass: "", try_files: "", include_chain: "nginx.conf", active: true, target_kind: "FILESYSTEM_ALIAS", effective_target: "/home/radeco/webshare-crawler/runtime/catalog-items.jsonl", source_file: "nginx.conf", canonical_source_file: "nginx.conf", include_depth: 0, symlink_source: "", symlink_target: "", config_file_sha256: "0".repeat(64), record_index: 0 },
    { config_file: "nginx", server_names: "_", listen: "80", location: "/catalog-items.manifest.json", root: "", alias: "/home/radeco/webshare-crawler/runtime/catalog-items.manifest.json", proxy_pass: "", try_files: "", include_chain: "nginx.conf", active: true, target_kind: "FILESYSTEM_ALIAS", effective_target: "/home/radeco/webshare-crawler/runtime/catalog-items.manifest.json", source_file: "nginx.conf", canonical_source_file: "nginx.conf", include_depth: 0, symlink_source: "", symlink_target: "", config_file_sha256: "1".repeat(64), record_index: 1 },
  ], {
    nginx_graph: { full_graph_resolved: true, parser_status: "SUCCESS", active_static_catalog_path_found: true },
    active_static_catalog_path_found: true,
  });
  run(options);
  const summary = JSON.parse(fs.readFileSync(path.join(options.outputDir, "deployment-summary.json"), "utf8"));
  a.equal(summary.active_jsonl_consumers, 1);
  a.equal(summary.active_manifest_consumers, 1);
  a.equal(summary.static_serving_conclusion, "ACTIVE_STATIC_SERVING");
});
