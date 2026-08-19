"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { buildPurgedSidecar, readAndValidatePurgedSidecar, digestIdents } = require("../lib/daily-candidate-provenance");

function db(file, idents) {
  const d = new Database(file);
  d.exec("CREATE TABLE files (id INTEGER PRIMARY KEY, ident TEXT NOT NULL UNIQUE); CREATE TABLE media (id INTEGER PRIMARY KEY, category TEXT, media_type TEXT, title TEXT, year INTEGER, classifier_version TEXT);");
  const insert = d.prepare("INSERT INTO files(id,ident) VALUES (?,?)");
  for (const [id, ident] of idents.entries()) insert.run(id, ident);
  d.close();
}

test("B39 purged sidecar is sorted, digest protected and does not mutate databases", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const currentPath = path.join(root, "current.sqlite");
  const b39Path = path.join(root, "b39.sqlite");
  const sidecarPath = path.join(root, "purged.json");
  db(currentPath, new Map([[1, "keep"], [2, "also-keep"]]));
  db(b39Path, new Map([[1, "keep"], [2, "also-keep"], [3, "z-purged"], [4, "a-purged"]]));
  const before = crypto.createHash("sha256").update(fs.readFileSync(currentPath)).digest("hex");
  const sidecar = buildPurgedSidecar({ currentDatabasePath: currentPath, b39DatabasePath: b39Path, sourceSha256: "source", outputPath: sidecarPath });
  assert.deepEqual(sidecar.idents, ["a-purged", "z-purged"]);
  assert.equal(sidecar.idents_sha256, digestIdents(sidecar.idents));
  assert.equal(readAndValidatePurgedSidecar(sidecarPath).ident_count, 2);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(currentPath)).digest("hex"), before);
  const corrupt = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  corrupt.idents[0] = "tampered";
  fs.writeFileSync(sidecarPath, JSON.stringify(corrupt));
  assert.throws(() => readAndValidatePurgedSidecar(sidecarPath), /DIGEST_MISMATCH/);
});
