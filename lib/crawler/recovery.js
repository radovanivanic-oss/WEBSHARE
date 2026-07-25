const fs = require("fs");
const { CrawlerError, RecoveryRequiredError } = require("./errors");

function detectLegacyCheckpoints(paths) {
  return paths
    .filter((checkpointPath) => fs.existsSync(checkpointPath))
    .map((checkpointPath) => {
      const stat = fs.statSync(checkpointPath);
      let validJson = false;
      try {
        JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
        validJson = true;
      } catch {
        validJson = false;
      }
      return {
        path: checkpointPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        validJson,
      };
    });
}

function assertNewRunCanStart(config) {
  const legacy = detectLegacyCheckpoints(config.legacyCheckpointPaths);
  if (legacy.length > 0 && !fs.existsSync(config.stateDbPath)) {
    throw new RecoveryRequiredError(
      "Bol zistený legacy checkpoint. V2 ho automaticky nemigruje ani nemaže.",
      { code: "legacy_checkpoint_detected" }
    );
  }
  return legacy;
}

function recoverRun({ runId, runStore, frontierStore, config, nowMs = Date.now() }) {
  const run = runStore.validateRunIdentity(runId, {
    schemaVersion: 2,
    algorithmVersion: config.algorithm.algorithmVersion,
    algorithmFingerprint: config.algorithmFingerprint,
  });
  if (run.status === "recovery_required") {
    throw new RecoveryRequiredError(
      `Run ${runId} je v stave recovery_required; automatický resume je zakázaný.`,
      { code: "run_recovery_required" }
    );
  }
  // Validate the durable state before making even a recovery mutation. A
  // corrupt frontier/counter relationship must fail closed and remain
  // available for operator diagnosis exactly as it was found.
  runStore.validateInvariants(runId, { persistCounts: false });
  const recoveredLeases = frontierStore.recoverExpiredLeases(runId, nowMs);
  runStore.validateInvariants(runId, { persistCounts: false });
  const counts = runStore.getCounts(runId);
  if (counts.inProgress > 0) {
    throw new CrawlerError(
      `Run ${runId} má ${counts.inProgress} lease, ktorému ešte nevypršala platnosť; resume neskúsi prefix dokončiť ani finalizovať.`,
      { code: "lease_not_expired" }
    );
  }
  runStore.setStatus(runId, "running", { reconciliationSafe: false });
  return { runId, recoveredLeases };
}

module.exports = {
  assertNewRunCanStart,
  detectLegacyCheckpoints,
  recoverRun,
};
