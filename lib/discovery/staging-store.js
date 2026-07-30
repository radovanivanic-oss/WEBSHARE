"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WINDOWS_DRIVE_RELATIVE = /^[a-zA-Z]:[^\\/]/u;
const WINDOWS_UNC_OR_DEVICE = /^(?:[\\/]{2}|[\\/]{2}[?.][\\/])/u;
const STAGING_BASENAME = /^hybrid-discovery(?:-[a-zA-Z0-9._-]+)?$/u;
const MAX_IDENT_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_STAGING_JSON_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;

function pathIdentityKey(value) {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/u.test(resolved)
    ? resolved.toLowerCase()
    : resolved;
}

function isWithin(root, target) {
  const relative = path.relative(
    pathIdentityKey(root),
    pathIdentityKey(target)
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateStagingInput(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(
      "Discovery staging cesta musí byť neprázdny reťazec bez NUL."
    );
  }
  if (WINDOWS_DRIVE_RELATIVE.test(value)) {
    throw new Error("Windows drive-relative discovery cesta je zakázaná.");
  }
  if (WINDOWS_UNC_OR_DEVICE.test(value)) {
    throw new Error("UNC/device discovery cesta je zakázaná.");
  }
  if (value.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("Discovery staging cesta nesmie obsahovať .. traversal.");
  }
}

function assertRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} musí byť reálny adresár bez symlinku/junctionu.`);
  }
  return stat;
}

function assertNoSymlinkComponents(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(
        `Discovery staging cesta nesmie obsahovať symlink/junction: ${current}`
      );
    }
  }
}

function createPathGuard(root) {
  const resolvedRoot = path.resolve(root);
  assertNoSymlinkComponents(resolvedRoot);
  const stat = assertRealDirectory(resolvedRoot, "Discovery staging root");
  const identity = Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    realpath: pathIdentityKey(fs.realpathSync.native(resolvedRoot)),
  });

  function verify(target = resolvedRoot, label = "discovery staging path") {
    const resolvedTarget = path.resolve(target);
    if (!isWithin(resolvedRoot, resolvedTarget)) {
      throw new Error(`${label} smeruje mimo discovery staging root.`);
    }
    assertNoSymlinkComponents(resolvedTarget);
    const current = assertRealDirectory(
      resolvedRoot,
      "Discovery staging root"
    );
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      pathIdentityKey(fs.realpathSync.native(resolvedRoot)) !== identity.realpath
    ) {
      throw new Error(
        "Discovery staging root identity sa zmenila (swap/rename race)."
      );
    }
    if (fs.existsSync(resolvedTarget)) {
      const targetStat = fs.lstatSync(resolvedTarget);
      if (targetStat.isSymbolicLink()) {
        throw new Error(`${label} nesmie byť symlink/junction.`);
      }
    }
    return resolvedTarget;
  }

  return Object.freeze({
    root: resolvedRoot,
    identity,
    verify,
  });
}

function buildStagingPaths(projectRoot, stagingDir) {
  const resolvedProject = path.resolve(projectRoot);
  const runtimeRoot = path.join(resolvedProject, "runtime");
  validateStagingInput(stagingDir);
  const root = path.resolve(
    stagingDir || path.join(runtimeRoot, "hybrid-discovery")
  );
  if (
    pathIdentityKey(path.dirname(root)) !== pathIdentityKey(runtimeRoot) ||
    !STAGING_BASENAME.test(path.basename(root))
  ) {
    throw new Error(
      "Discovery staging musí byť priamy runtime/hybrid-discovery[-id] adresár."
    );
  }
  const paths = Object.freeze({
    root,
    checkpoint: path.join(root, "checkpoint.json"),
    manifest: path.join(root, "manifest.json"),
    idents: path.join(root, "discovered-idents.json"),
    log: path.join(root, "discovery.log"),
    lock: path.join(root, "discovery.lock"),
  });
  return Object.freeze({
    projectRoot: resolvedProject,
    runtimeRoot,
    paths,
  });
}

function prepareStagingRoot(layout, options = {}) {
  const { runtimeRoot, paths } = layout;
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(
      `Projektový runtime musí existovať pred discovery: ${runtimeRoot}`
    );
  }
  assertNoSymlinkComponents(runtimeRoot);
  const runtimeBefore = assertRealDirectory(
    runtimeRoot,
    "Projektový runtime"
  );
  const runtimeRealpath = pathIdentityKey(fs.realpathSync.native(runtimeRoot));

  if (options.resume === true) {
    if (!fs.existsSync(paths.root)) {
      throw new Error("Discovery resume vyžaduje existujúci staging root.");
    }
  } else {
    if (fs.existsSync(paths.root)) {
      throw new Error(
        "Fresh discovery odmieta existujúci staging root; použi nový root alebo explicitný resume."
      );
    }
    fs.mkdirSync(paths.root, { mode: 0o750 });
  }

  const runtimeAfter = assertRealDirectory(runtimeRoot, "Projektový runtime");
  if (
    runtimeAfter.dev !== runtimeBefore.dev ||
    runtimeAfter.ino !== runtimeBefore.ino ||
    pathIdentityKey(fs.realpathSync.native(runtimeRoot)) !== runtimeRealpath
  ) {
    throw new Error("Projektový runtime identity sa počas prípravy zmenila.");
  }

  const guard = createPathGuard(paths.root);
  for (const [label, target] of Object.entries(paths)) {
    guard.verify(target, label);
  }
  return guard;
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWriteJson(targetPath, value, guard) {
  guard.verify(targetPath, "atomic discovery JSON");
  const directory = path.dirname(targetPath);
  const temporary = path.join(
    directory,
    `.tmp-${path.basename(targetPath)}-${process.pid}-${crypto.randomUUID()}`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o640,
    });
    const descriptor = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    guard.verify(targetPath, "atomic discovery JSON");
    fs.renameSync(temporary, targetPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function readJson(targetPath, guard, label) {
  guard.verify(targetPath, label);
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} musí byť bežný súbor.`);
  }
  const maximum = targetPath.endsWith("discovered-idents.json")
    ? MAX_IDENT_SNAPSHOT_BYTES
    : MAX_STAGING_JSON_BYTES;
  if (stat.size > maximum) {
    throw new Error(`${label} prekračuje bounded veľkosť ${maximum} bajtov.`);
  }
  return JSON.parse(fs.readFileSync(targetPath, "utf8"));
}

function appendLog(targetPath, entry, guard) {
  guard.verify(targetPath, "discovery log");
  const encoded = `${entry}\n`;
  const existingSize = fs.existsSync(targetPath)
    ? fs.lstatSync(targetPath).size
    : 0;
  if (existingSize + Buffer.byteLength(encoded, "utf8") > MAX_LOG_BYTES) {
    throw new Error(`Discovery log prekračuje ${MAX_LOG_BYTES} bajtov.`);
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(targetPath, flags, 0o640);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Discovery log nie je bežný súbor.");
    fs.writeSync(descriptor, encoded, null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function acquireLock(lockPath, runId, guard) {
  guard.verify(lockPath, "discovery lock");
  const nonce = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o640
    );
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Discovery lock už existuje; automatické stale-lock recovery nie je povolené."
      );
    }
    throw error;
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ run_id: runId, pid: process.pid, nonce })}\n`
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(lockPath));
  return Object.freeze({ nonce, runId });
}

function releaseLock(lockPath, ownership, guard) {
  guard.verify(lockPath, "discovery lock");
  if (!fs.existsSync(lockPath)) return;
  const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (
    current.nonce !== ownership.nonce ||
    current.run_id !== ownership.runId
  ) {
    throw new Error("Discovery lock ownership sa zmenilo; lock neuvoľňujem.");
  }
  fs.unlinkSync(lockPath);
  fsyncDirectory(path.dirname(lockPath));
}

module.exports = {
  MAX_IDENT_SNAPSHOT_BYTES,
  MAX_LOG_BYTES,
  MAX_STAGING_JSON_BYTES,
  STAGING_BASENAME,
  acquireLock,
  appendLog,
  atomicWriteJson,
  buildStagingPaths,
  createPathGuard,
  isWithin,
  pathIdentityKey,
  prepareStagingRoot,
  readJson,
  releaseLock,
  validateStagingInput,
};
