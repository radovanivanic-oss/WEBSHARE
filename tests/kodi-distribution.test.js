"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { build, md5 } = require("../scripts/publish-kodi-repository");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildFixture(root) {
  return build({
    repositoryRoot: process.cwd(),
    publicBase: "https://radovanivanic-oss.github.io/AG_repo/",
    videoVersion: "0.8.37",
    outputRoot: root,
  });
}

test("Kodi distribution build is complete, deterministic and publicly addressed", (t) => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kodi-dist-test-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kodi-dist-test-"));
  t.after(() => {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  const first = buildFixture(firstRoot);
  const second = buildFixture(secondRoot);
  assert.deepEqual(first.manifest, second.manifest);
  for (const file of first.manifest.files) {
    assert.equal(sha256(path.join(firstRoot, file.path)), file.sha256);
    assert.equal(sha256(path.join(secondRoot, file.path)), file.sha256);
  }

  const addonsXml = fs.readFileSync(path.join(firstRoot, "addons.xml"));
  assert.equal(fs.readFileSync(path.join(firstRoot, "addons.xml.md5"), "ascii"), md5(addonsXml));
  assert.match(addonsXml.toString("utf8"), /repository\.websharecrawler/);
  assert.match(addonsXml.toString("utf8"), /plugin\.video\.websharecrawler/);
  assert.match(addonsXml.toString("utf8"), /radovanivanic-oss\.github\.io\/AG_repo/);
  assert.doesNotMatch(addonsXml.toString("utf8"), /raw\.githubusercontent\.com|localhost|127\.0\.0\.1|192\.168\./iu);

  const pluginZip = path.join(firstRoot, "plugin.video.websharecrawler", "plugin.video.websharecrawler-0.8.37.zip");
  const repositoryZip = path.join(firstRoot, "repository.websharecrawler", "repository.websharecrawler-1.0.8.zip");
  const pluginEntries = execFileSync("unzip", ["-Z1", pluginZip], { encoding: "utf8" }).trim().split(/\r?\n/u);
  const repositoryEntries = execFileSync("unzip", ["-Z1", repositoryZip], { encoding: "utf8" }).trim().split(/\r?\n/u);
  assert.ok(pluginEntries.includes("plugin.video.websharecrawler/addon.xml"));
  assert.ok(repositoryEntries.includes("repository.websharecrawler/addon.xml"));
  assert.ok(pluginEntries.every((entry) => !/(?:\.git|runtime|__pycache__|\.pyc|\.sqlite|\.env)/iu.test(entry)));
  assert.deepEqual(sha256(pluginZip), sha256(path.join(secondRoot, "plugin.video.websharecrawler", "plugin.video.websharecrawler-0.8.37.zip")));
  assert.deepEqual(sha256(repositoryZip), sha256(path.join(secondRoot, "repository.websharecrawler", "repository.websharecrawler-1.0.8.zip")));
});
