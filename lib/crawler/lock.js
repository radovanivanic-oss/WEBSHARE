const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LockActiveError, RecoveryRequiredError } = require("./errors");

const SELF_START_TIME = new Date(Date.now() - process.uptime() * 1000).toISOString();

function processStartToken(pid) {
  if (process.platform === "win32") {
    try {
      return childProcess
        .execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ],
          { encoding: "utf8", timeout: 2_000, windowsHide: true }
        )
        .trim();
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return afterName[19] || null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function currentProcessStartToken() {
  return processStartToken(process.pid);
}

function inspectLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, active: false };
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      exists: true,
      active: null,
      recoverable: false,
      reason: "malformed_lock",
      rawFingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
    };
  }
  const localHost = os.hostname();
  if (payload.hostname !== localHost) {
    return {
      exists: true,
      active: null,
      recoverable: false,
      reason: "foreign_hostname",
      payload,
    };
  }
  const pid = Number(payload.pid);
  if (!processExists(pid)) {
    return {
      exists: true,
      active: false,
      recoverable: true,
      reason: "pid_not_running",
      payload,
    };
  }
  const actualToken = processStartToken(pid);
  if (
    actualToken &&
    payload.process_start_token &&
    actualToken !== payload.process_start_token
  ) {
    return {
      exists: true,
      active: false,
      recoverable: true,
      reason: "pid_reused",
      payload,
    };
  }
  return {
    exists: true,
    active: true,
    recoverable: false,
    reason:
      actualToken &&
      payload.process_start_token &&
      actualToken === payload.process_start_token
        ? "matching_process_identity"
        : "live_pid_unverifiable_start",
    payload,
  };
}

function removeProvenStaleLock(lockPath) {
  const inspection = inspectLock(lockPath);
  if (!inspection.exists) return false;
  if (!inspection.recoverable || inspection.active !== false) {
    throw new RecoveryRequiredError(
      `Lock nie je dokázateľne stale: ${inspection.reason}`,
      { code: "stale_lock_not_proven" }
    );
  }
  fs.unlinkSync(lockPath);
  return true;
}

function acquireCrawlerLock(lockPath, runId, options = {}) {
  const resolvedPath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const guardPath = `${resolvedPath}.acquire`;
  try {
    fs.mkdirSync(guardPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new RecoveryRequiredError(
        `Lock acquisition guard existuje: ${guardPath}`,
        { code: "lock_acquisition_in_progress" }
      );
    }
    throw error;
  }
  const payload = {
    pid: process.pid,
    hostname: os.hostname(),
    process_start_time: SELF_START_TIME,
    process_start_token: currentProcessStartToken(),
    owner_nonce: crypto.randomUUID(),
    run_id: runId || null,
    created_at: new Date().toISOString(),
  };
  let descriptor = null;
  let created = false;
  try {
    if (options.recoverStale === true && fs.existsSync(resolvedPath)) {
      removeProvenStaleLock(resolvedPath);
    }
    descriptor = fs.openSync(resolvedPath, "wx", 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === "EEXIST") {
      const inspection = inspectLock(resolvedPath);
      throw new LockActiveError(
        `Crawler lock existuje (${inspection.reason || "unknown"}): ${resolvedPath}`,
        { code: inspection.active ? "lock_active" : "stale_lock_requires_resume" }
      );
    }
    if (created) {
      try {
        fs.unlinkSync(resolvedPath);
      } catch {
        // The acquisition guard still blocks competitors; preserve original error.
      }
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmdirSync(guardPath);
  }
  let released = false;
  return {
    path: resolvedPath,
    payload,
    release() {
      if (released) return;
      const inspection = inspectLock(resolvedPath);
      if (
        !inspection.exists ||
        inspection.payload?.pid !== payload.pid ||
        inspection.payload?.process_start_token !== payload.process_start_token ||
        inspection.payload?.owner_nonce !== payload.owner_nonce
      ) {
        throw new RecoveryRequiredError(
          "Crawler lock sa zmenil; automatické odstránenie je zakázané.",
          { code: "lock_identity_changed" }
        );
      }
      fs.unlinkSync(resolvedPath);
      released = true;
    },
  };
}

module.exports = {
  acquireCrawlerLock,
  currentProcessStartToken,
  inspectLock,
  processExists,
  processStartToken,
};
