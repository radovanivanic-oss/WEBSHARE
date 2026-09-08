#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VIDEO_ADDON_ID = "plugin.video.websharecrawler";
const REPOSITORY_ADDON_ID = "repository.websharecrawler";
const VIDEO_ADDON_SOURCE = path.join(VIDEO_ADDON_ID, "addon.xml");
const REPOSITORY_ADDON_SOURCE = path.join(REPOSITORY_ADDON_ID, "addon.xml");
const DEFAULT_PUBLIC_REPOSITORY = "/home/radeco/ag";
const DEFAULT_PUBLIC_BASE = "https://radovanivanic-oss.github.io/AG_repo/";
const DEFAULT_SHORT_PUBLIC_REPOSITORY = path.join(path.dirname(DEFAULT_PUBLIC_REPOSITORY), "wsa-pages");
const ROOT_SCHEMA = "webshare-atlas-kodi-distribution/v1";
const PRIVATE_TEXT_RE = /127\.0\.0\.1|localhost|192\.168\.|(?:^|[^0-9])10\.[0-9]+\.[0-9]+\.[0-9]+|\/home\/radeco|gho_[A-Za-z0-9]+|Authorization:\s*\S+/iu;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function parseArgument(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (argv[index + 1] === undefined) throw new Error("KODI_OPTION_VALUE_MISSING:" + name);
  return argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function addonAttribute(xml, attribute) {
  const root = stripDeclaration(xml).match(/^<addon\b([^>]*)>/iu);
  const match = root && root[1].match(new RegExp("\\b" + attribute + "=\"([^\"]+)\"", "u"));
  if (!match) throw new Error("KODI_ADDON_ATTRIBUTE_MISSING:" + attribute);
  return match[1];
}

function stripDeclaration(xml) {
  return xml.replace(/^\s*<\?xml[^>]*\?>\s*/iu, "").trim();
}

function ensureHttpsBase(value) {
  const base = String(value || "").trim();
  if (!/^https:\/\//iu.test(base) || /(?:localhost|127\.0\.0\.1|192\.168\.|10\.)/iu.test(base)) {
    throw new Error("KODI_PUBLIC_BASE_MUST_BE_PUBLIC_HTTPS");
  }
  return base.endsWith("/") ? base : base + "/";
}

function trackedFiles(repositoryRoot, addonId) {
  const output = run("git", ["-C", repositoryRoot, "ls-files", "--", addonId]);
  const files = output ? output.split(/\r?\n/u).filter(Boolean).sort() : [];
  if (!files.length) throw new Error("KODI_ADDON_SOURCE_EMPTY:" + addonId);
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/u).includes("..")) throw new Error("KODI_SOURCE_PATH_INVALID");
    const extension = path.extname(file).toLowerCase();
    if ([".py", ".xml", ".md", ".txt", ".json", ".cfg", ".ini"].includes(extension)) {
      const content = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
      if (PRIVATE_TEXT_RE.test(content)) throw new Error("KODI_PRIVATE_CONTENT:" + file);
    }
  }
  return files;
}

function copyTrackedAddon(repositoryRoot, addonId, destinationRoot) {
  for (const relative of trackedFiles(repositoryRoot, addonId)) {
    const source = path.join(repositoryRoot, relative);
    const target = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    fs.copyFileSync(source, target);
  }
}

function setFixedTimes(root) {
  const fixed = new Date("2000-01-01T00:00:00.000Z");
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      fs.utimesSync(target, fixed, fixed);
    }
  };
  walk(root);
}

function buildZip(stageRoot, addonId, zipPath) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else entries.push(path.relative(stageRoot, target).split(path.sep).join("/"));
    }
  };
  walk(path.join(stageRoot, addonId));
  if (!entries.length) throw new Error("KODI_ZIP_EMPTY:" + addonId);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true, mode: 0o750 });
  run("zip", ["-X", "-q", zipPath, "-@"], { cwd: stageRoot, input: entries.join("\n") + "\n" });
  return zipPath;
}

function writeIfUnchangedOrNew(filePath, bytes) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (!existing.equals(bytes)) throw new Error("KODI_PUBLIC_FILE_ALREADY_EXISTS_DIFFERENT:" + filePath);
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  fs.writeFileSync(filePath, bytes, { mode: 0o640, flag: "wx" });
  return true;
}

function writeGeneratedFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath).equals(bytes)) return false;
  fs.writeFileSync(filePath, bytes, { mode: 0o640 });
  return true;
}

function cleanRepository(repositoryRoot) {
  if (run("git", ["-C", repositoryRoot, "status", "--porcelain"])) throw new Error("KODI_PUBLIC_REPOSITORY_NOT_CLEAN:" + repositoryRoot);
}

function build(options) {
  const repositoryRoot = options.repositoryRoot;
  const publicBase = ensureHttpsBase(options.publicBase);
  const videoXml = fs.readFileSync(path.join(repositoryRoot, VIDEO_ADDON_SOURCE), "utf8");
  const repositoryXml = fs.readFileSync(path.join(repositoryRoot, REPOSITORY_ADDON_SOURCE), "utf8");
  const repositoryVersion = addonAttribute(repositoryXml, "version");
  if (addonAttribute(videoXml, "id") !== VIDEO_ADDON_ID || addonAttribute(videoXml, "version") !== options.videoVersion) throw new Error("KODI_VIDEO_ADDON_ID_OR_VERSION_MISMATCH");
  if (addonAttribute(repositoryXml, "id") !== REPOSITORY_ADDON_ID || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(repositoryVersion)) throw new Error("KODI_REPOSITORY_ADDON_ID_OR_VERSION_MISMATCH");
  if (!repositoryXml.includes(publicBase + "addons.xml") || !repositoryXml.includes(publicBase + "addons.xml.md5") || !repositoryXml.includes("<datadir zip=\"true\">" + publicBase + "</datadir>")) throw new Error("KODI_REPOSITORY_URL_CONTRACT_MISMATCH");

  const outputRoot = options.outputRoot || fs.mkdtempSync(path.join(os.tmpdir(), "webshare-kodi-build-"));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webshare-kodi-stage-"));
  try {
    copyTrackedAddon(repositoryRoot, VIDEO_ADDON_ID, stageRoot);
    const stageRepository = path.join(stageRoot, REPOSITORY_ADDON_ID);
    fs.mkdirSync(stageRepository, { recursive: true, mode: 0o750 });
    fs.copyFileSync(path.join(repositoryRoot, REPOSITORY_ADDON_SOURCE), path.join(stageRepository, "addon.xml"));
    setFixedTimes(stageRoot);

    const videoZipName = VIDEO_ADDON_ID + "-" + options.videoVersion + ".zip";
    const repositoryZipName = REPOSITORY_ADDON_ID + "-" + repositoryVersion + ".zip";
    const videoZip = path.join(outputRoot, VIDEO_ADDON_ID, videoZipName);
    const repositoryZip = path.join(outputRoot, REPOSITORY_ADDON_ID, repositoryZipName);
    buildZip(stageRoot, VIDEO_ADDON_ID, videoZip);
    buildZip(stageRoot, REPOSITORY_ADDON_ID, repositoryZip);

    const addonsXml = Buffer.from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<addons>\n" + stripDeclaration(videoXml) + "\n" + stripDeclaration(repositoryXml) + "\n</addons>\n", "utf8");
    const addonsMd5 = Buffer.from(md5(addonsXml), "ascii");
    const indexHtml = Buffer.from("<!doctype html>\n<html lang=\"sk\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Webshare Atlas Kodi</title></head>\n<body><main><h1>Webshare Atlas</h1><p>Verejný Kodi repozitár pre Webshare Atlas.</p><p>Aktuálna verzia addonu: <strong>" + options.videoVersion + "</strong></p><p><a href=\"" + repositoryZipName + "\">" + repositoryZipName + "</a></p><ol><li>V Kodi otvorte Nastavenia → Doplnky → Inštalovať zo ZIP súboru.</li><li>Ak treba, povoľte Neznáme zdroje.</li><li>Po inštalácii repozitára otvorte Webshare Atlas Repository → Video add-ons → Webshare Atlas.</li></ol></main></body>\n</html>\n", "utf8");
    const repositoryZipBytes = fs.readFileSync(repositoryZip);
    const files = [
      { relativePath: "index.html", bytes: indexHtml },
      { relativePath: "addons.xml", bytes: addonsXml },
      { relativePath: "addons.xml.md5", bytes: addonsMd5 },
      { relativePath: ".nojekyll", bytes: Buffer.alloc(0) },
      { relativePath: VIDEO_ADDON_ID + "/" + videoZipName, bytes: fs.readFileSync(videoZip) },
      { relativePath: REPOSITORY_ADDON_ID + "/" + repositoryZipName, bytes: repositoryZipBytes },
      { relativePath: repositoryZipName, bytes: repositoryZipBytes },
    ];
    for (const file of files) writeIfUnchangedOrNew(path.join(outputRoot, file.relativePath), file.bytes);
    const manifest = {
      schema: ROOT_SCHEMA,
      public_base_url: publicBase,
      video_addon: { id: VIDEO_ADDON_ID, version: options.videoVersion, zip: videoZipName },
      repository_addon: { id: REPOSITORY_ADDON_ID, version: repositoryVersion, zip: repositoryZipName, root_zip: repositoryZipName },
      files: files.map((file) => ({ path: file.relativePath, bytes: file.bytes.length, sha256: sha256(file.bytes) })),
    };
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o750 });
    fs.writeFileSync(path.join(outputRoot, "distribution-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o640 });
    return { outputRoot, manifest, files };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

function publish(options) {
  const publicRepository = options.publicRepository;
  cleanRepository(publicRepository);
  const built = build(options);
  if (options.dryRun) return { ...built, published: false };
  for (const file of built.files) writeIfUnchangedOrNew(path.join(publicRepository, file.relativePath), file.bytes);
  const currentRootInstaller = built.manifest.repository_addon.root_zip;
  const obsoleteRootInstallers = fs.readdirSync(publicRepository)
    .filter((name) => /^repository\.websharecrawler-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\.zip$/u.test(name) && name !== currentRootInstaller)
    .map((name) => path.join(publicRepository, name));
  for (const filePath of obsoleteRootInstallers) fs.rmSync(filePath, { force: true });
  const paths = built.files.map((file) => file.relativePath);
  run("git", ["-C", publicRepository, "add", "--", ...paths, ...obsoleteRootInstallers.map((filePath) => path.relative(publicRepository, filePath))]);
  const staged = run("git", ["-C", publicRepository, "diff", "--cached", "--name-only"]);
  if (staged) {
    run("git", ["-C", publicRepository, "commit", "-m", "Publish Kodi repository " + options.videoVersion]);
    run("git", ["-C", publicRepository, "push", "origin", "main"]);
  }
  let shortSite;
  if (options.shortPublicRepository) {
    const shortPublicRepository = options.shortPublicRepository;
    cleanRepository(shortPublicRepository);
    writeGeneratedFile(path.join(shortPublicRepository, "index.html"), Buffer.from("<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Webshare Atlas Kodi</title></head>\n<body><a href=\"" + currentRootInstaller + "\">" + currentRootInstaller + "</a></body></html>\n", "utf8"));
    writeGeneratedFile(path.join(shortPublicRepository, currentRootInstaller), fs.readFileSync(path.join(built.outputRoot, currentRootInstaller)));
    const obsoleteShortInstallers = fs.readdirSync(shortPublicRepository)
      .filter((name) => /^repository\.websharecrawler-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\.zip$/u.test(name) && name !== currentRootInstaller)
      .map((name) => path.join(shortPublicRepository, name));
    for (const filePath of obsoleteShortInstallers) fs.rmSync(filePath, { force: true });
    run("git", ["-C", shortPublicRepository, "add", "--", "index.html", currentRootInstaller, ...obsoleteShortInstallers.map((filePath) => path.relative(shortPublicRepository, filePath))]);
    const shortStaged = run("git", ["-C", shortPublicRepository, "diff", "--cached", "--name-only"]);
    if (shortStaged) {
      run("git", ["-C", shortPublicRepository, "commit", "-m", "Publish short Kodi installer " + options.videoVersion]);
      if (options.push !== false) run("git", ["-C", shortPublicRepository, "push", "origin", "main"]);
    }
    shortSite = { shortPublicRepository, published: Boolean(shortStaged), publicCommit: run("git", ["-C", shortPublicRepository, "rev-parse", "HEAD"]) };
  }
  return { ...built, publicRepository, published: Boolean(staged), publicCommit: run("git", ["-C", publicRepository, "rev-parse", "HEAD"]), shortSite };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] === "build" || argv[0] === "publish" ? argv[0] : "publish";
  const repositoryRoot = path.resolve(parseArgument(argv, "--repository-root", process.cwd()));
  const publicRepository = path.resolve(parseArgument(argv, "--public-repository", process.env.KODI_PUBLIC_REPOSITORY || DEFAULT_PUBLIC_REPOSITORY));
  const shortPublicRepository = path.resolve(parseArgument(argv, "--short-public-repository", process.env.KODI_SHORT_PUBLIC_REPOSITORY || DEFAULT_SHORT_PUBLIC_REPOSITORY));
  const publicBase = parseArgument(argv, "--public-base", process.env.KODI_PUBLIC_BASE || DEFAULT_PUBLIC_BASE);
  const videoVersion = parseArgument(argv, "--video-version", "0.8.25");
  const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const outputRoot = path.resolve(parseArgument(argv, "--output-root", path.join(repositoryRoot, "runtime", "kodi-public-distribution", timestamp)));
  const options = { repositoryRoot, publicRepository, shortPublicRepository, publicBase, videoVersion, outputRoot, dryRun: hasFlag(argv, "--dry-run"), push: !hasFlag(argv, "--no-push") };
  const result = command === "build" ? build(options) : publish(options);
  console.log(JSON.stringify({ command, output_root: result.outputRoot, public_repository: result.publicRepository || null, published: result.published || false, public_commit: result.publicCommit || null, short_site: result.shortSite || null, manifest: result.manifest }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message || "KODI_PUBLICATION_FAILED"); process.exitCode = 1; }
}

module.exports = { build, main, md5, publish, sha256 };
