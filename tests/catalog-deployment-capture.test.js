"use strict";

const a = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { capture } = require("../lib/publication-audit/deployment-capture");
const { run } = require("../lib/publication-audit/deployment-evidence");
const { resolveNginxIncludeGraph } = require("../lib/publication-audit/nginx-include-graph");

function runner(bin, args) {
  if (bin === "systemctl" && args[0] === "show") {
    return "ActiveState=active\nSubState=running\nExecStart={ path=/usr/bin/env ; argv[]=/usr/bin/env node server/catalog-api.js ; }\nWorkingDirectory=/home/radeco/webshare-crawler\nFragmentPath=/etc/systemd/system/webshare-catalog-api.service\n";
  }
  if (bin === "systemctl") return "webshare-catalog-api.service enabled\n";
  if (bin === "nginx") throw new Error("nginx -T unavailable");
  if (bin === "crontab") return "# 0 8,20 * * * /bin/bash /home/radeco/webshare-crawler/scripts/run-crawler-and-update.sh\n";
  return "  1 user Jan 1 00:00 node server/catalog-api.js\n";
}

function mkdirp(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function nginxFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-graph-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = mkdirp(path.join(root, "nginx.conf"));
  fs.writeFileSync(main, [
    "events {}",
    "http {",
    "  include mime.types;",
    "  include conf.d/*.conf;",
    "  include sites-enabled/*;",
    "}",
  ].join("\n"));
  fs.writeFileSync(mkdirp(path.join(root, "mime.types")), "types { text/plain txt; }\n");
  fs.writeFileSync(mkdirp(path.join(root, "conf.d", "api.conf")), "server { listen 80; include ../snippets/api.conf; }\n");
  fs.writeFileSync(mkdirp(path.join(root, "snippets", "api.conf")), "location /api/ { proxy_pass http://127.0.0.1:8787; }\n");
  fs.mkdirSync(path.join(root, "sites-enabled"), { recursive: true });
  fs.mkdirSync(path.join(root, "sites-available"), { recursive: true });
  fs.writeFileSync(path.join(root, "sites-available", "static"), "server { root /srv/www; location /catalog-items.jsonl { try_files /catalog-items.jsonl =404; } }\n");
  let symlinkExpected = true;
  try {
    fs.symlinkSync(path.join(root, "sites-available", "static"), path.join(root, "sites-enabled", "static"));
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    symlinkExpected = false;
    fs.copyFileSync(path.join(root, "sites-available", "static"), path.join(root, "sites-enabled", "static"));
  }
  return { root, main, symlinkExpected };
}

test("nginx include graph resolves globs, nested includes and sites-enabled symlinks", (t) => {
  const { root, main, symlinkExpected } = nginxFixture(t);
  const result = resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root] });
  a.equal(result.graph.full_graph_resolved, true);
  a.equal(result.graph.symlinks_resolved, symlinkExpected ? 1 : 0);
  a.equal(result.graph.include_files_resolved, 4);
  a.equal(result.graph.approved_config_roots.some((rootPath) => /\/etc\/nginx$/u.test(rootPath)), false);
  a.equal(result.records.length, 2);
  a.deepEqual(result.records.map((record) => record.target_kind).sort(), ["PROXY", "TRY_FILES"]);
  a.equal(result.graph.active_static_catalog_path_found, true);
});

test("nginx graph accepts complete negative evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-negative-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "nginx.conf");
  fs.writeFileSync(main, "events {}\nhttp { include conf.d/*.conf; server { root /var/www/html; location / { try_files $uri =404; } } }\n");
  fs.mkdirSync(path.join(root, "conf.d"));
  const result = resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root] });
  a.equal(result.records.length, 0);
  a.equal(result.graph.active_static_catalog_path_found, false);
  a.equal(result.graph.full_graph_resolved, true);
});

test("nginx prefix-relative includes resolve from active config roots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-prefix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "nginx.conf");
  fs.mkdirSync(path.join(root, "sites-enabled"), { recursive: true });
  fs.mkdirSync(path.join(root, "snippets"), { recursive: true });
  fs.writeFileSync(main, "events {}\nhttp { include sites-enabled/default; }\n");
  fs.writeFileSync(path.join(root, "sites-enabled", "default"), "server { listen 80; include snippets/webshare-catalog-api.conf; }\n");
  fs.writeFileSync(path.join(root, "snippets", "webshare-catalog-api.conf"), "location /api/ { proxy_pass http://127.0.0.1:8787; }\n");
  const result = resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root] });
  a.equal(result.graph.full_graph_resolved, true);
  a.equal(result.records.length, 1);
  a.equal(result.records[0].target_kind, "PROXY");
});

test("nginx graph rejects cycles, symlink escape, oversized and invalid UTF-8 inputs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "nginx.conf");
  fs.writeFileSync(main, "include loop.conf;\n");
  fs.writeFileSync(path.join(root, "loop.conf"), "include nginx.conf;\n");
  a.throws(() => resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root] }), /NGINX_INCLUDE_CYCLE/);
  fs.writeFileSync(main, "include sites-enabled/*;\n");
  fs.mkdirSync(path.join(root, "sites-enabled"), { recursive: true });
  const outsideTarget = path.join(os.tmpdir(), `outside-${process.pid}.conf`);
  fs.writeFileSync(outsideTarget, "server {}\n");
  let symlinkCreated = true;
  try {
    fs.symlinkSync(outsideTarget, path.join(root, "sites-enabled", "outside"));
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    a.throws(() => resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root] }), /NGINX_SYMLINK_ESCAPE/);
    fs.rmSync(path.join(root, "sites-enabled", "outside"));
  }
  fs.rmSync(outsideTarget, { force: true });
  fs.writeFileSync(path.join(root, "bad.conf"), Buffer.from([0xc3, 0x28]));
  fs.writeFileSync(main, "include bad.conf;\n");
  a.throws(() => resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root] }), /NGINX_INVALID_UTF8/);
  fs.writeFileSync(path.join(root, "large.conf"), Buffer.alloc(1025));
  fs.writeFileSync(main, "include large.conf;\n");
  a.throws(() => resolveNginxIncludeGraph({ mainConfigPath: main, approvedRoots: [root], limits: { maxFileBytes: 1024 } }), /NGINX_FILE_OVERSIZED/);
});

test("capture to audit pipeline is material and resolves commit", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capture-"));
  const compatibility = path.join(directory, "c");
  const snapshots = path.join(directory, "s");
  const output = path.join(directory, "o");
  const root = path.resolve(__dirname, "..");
  const nginxRoot = path.join(directory, "nginx");
  fs.mkdirSync(compatibility);
  fs.mkdirSync(nginxRoot);
  fs.writeFileSync(path.join(nginxRoot, "nginx.conf"), "events {}\nhttp { server { location /api/ { proxy_pass http://127.0.0.1:8787; } } }\n");
  fs.writeFileSync(path.join(compatibility, "consumer-inventory.json"), JSON.stringify([{ file_path: "server/catalog-api.js", artifact_path_reference: "data/catalog.sqlite", consumer_type: "SQLITE_DIRECT" }]));
  fs.writeFileSync(path.join(compatibility, "compatibility.manifest.json"), "{}");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  a.equal(capture({ repositoryRoot: root, outputDir: snapshots, nginxMainConfig: path.join(nginxRoot, "nginx.conf"), nginxConfigRoot: nginxRoot }, runner).material_evidence_complete, true);
  const manifest = run({
    repositoryRoot: root,
    compatibilityDir: compatibility,
    outputDir: output,
    systemd: path.join(snapshots, "systemd-snapshot.json"),
    nginx: path.join(snapshots, "nginx-snapshot.json"),
    cron: path.join(snapshots, "cron-snapshot.json"),
    process: path.join(snapshots, "process-snapshot.json"),
  });
  a.equal(manifest.material_evidence_complete, true);
  a.match(JSON.parse(fs.readFileSync(path.join(output, "source-reference.json"))).repository_commit, /^[0-9a-f]{40}$/u);
  a.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(snapshots, "nginx-snapshot.json")))).includes("catalog-items.jsonl"), false);
});

test("zero attempt placeholders are rejected before root", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
  const compatibility = path.join(directory, "c");
  const output = path.join(directory, "out");
  const root = path.resolve(__dirname, "..");
  fs.mkdirSync(compatibility);
  fs.writeFileSync(path.join(compatibility, "consumer-inventory.json"), "[]");
  fs.writeFileSync(path.join(compatibility, "compatibility.manifest.json"), "{}");
  for (const key of ["systemd", "nginx", "cron", "process"]) {
    fs.writeFileSync(path.join(directory, `${key}.json`), JSON.stringify({
      schema: `webshare-${key}-snapshot/v1`,
      schema_version: 1,
      captured_at: "2026-08-03T00:00:00Z",
      redaction_applied: true,
      records: [],
      capture_status: "SUCCESS",
      coverage_status: "COMPLETE_FOR_DECLARED_SCOPE",
      commands_attempted: 0,
      commands_succeeded: 0,
      commands_failed: 0,
      records_examined: 0,
      records_relevant: 0,
      limitations: [],
    }));
  }
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  a.throws(() => run({
    repositoryRoot: root,
    compatibilityDir: compatibility,
    outputDir: output,
    systemd: path.join(directory, "systemd.json"),
    nginx: path.join(directory, "nginx.json"),
    cron: path.join(directory, "cron.json"),
    process: path.join(directory, "process.json"),
  }), /MATERIAL_EVIDENCE_INCOMPLETE/);
  a.equal(fs.existsSync(output), false);
});
