const crypto = require("crypto");
const { CrawlerInvariantError, RecoveryRequiredError } = require("./errors");

const RUN_STATUSES = Object.freeze({
  RUNNING: "running",
  COMPLETE: "complete",
  COMPLETE_WITH_FAILURES: "complete_with_failures",
  INCOMPLETE: "incomplete",
  ABORTED: "aborted",
  RECOVERY_REQUIRED: "recovery_required",
});

function createRunStore(database) {
  const insertRun = database.prepare(`
    INSERT INTO crawl_runs (
      run_id, schema_version, algorithm_version, algorithm_fingerprint,
      status, reconciliation_safe, partition_completeness_proven,
      started_at, updated_at, root_prefix_count
    ) VALUES (
      @runId, @schemaVersion, @algorithmVersion, @algorithmFingerprint,
      'running', 0, @partitionCompletenessProven,
      @now, @now, @rootPrefixCount
    )
  `);
  const getRunStatement = database.prepare(
    "SELECT * FROM crawl_runs WHERE run_id = ?"
  );
  const latestRunStatement = database.prepare(
    "SELECT * FROM crawl_runs ORDER BY started_at DESC, run_id DESC LIMIT 1"
  );
  const stateCountsStatement = database.prepare(`
    SELECT state, COUNT(*) AS count
    FROM crawl_frontier
    WHERE run_id = ?
    GROUP BY state
  `);
  const uniqueItemsStatement = database.prepare(
    "SELECT unique_items AS count FROM crawl_runs WHERE run_id = ?"
  );
  const updateCountsStatement = database.prepare(`
    UPDATE crawl_runs SET
      queued_count = @queued,
      in_progress_count = @inProgress,
      complete_count = @complete,
      failed_count = @failed,
      blocked_count = @blocked,
      unique_items = @uniqueItems,
      updated_at = @now
    WHERE run_id = @runId
  `);

  function createRun(config, runId = crypto.randomUUID()) {
    const now = new Date().toISOString();
    insertRun.run({
      runId,
      schemaVersion: config.schemaVersion,
      algorithmVersion: config.algorithmVersion,
      algorithmFingerprint: config.algorithmFingerprint,
      partitionCompletenessProven:
        config.partitionCompletenessProven === true ? 1 : 0,
      now,
      rootPrefixCount: config.rootPrefixCount,
    });
    return getRun(runId);
  }

  function getRun(runId) {
    return getRunStatement.get(runId) || null;
  }

  function getLatestRun() {
    return latestRunStatement.get() || null;
  }

  function validateRunIdentity(runId, expected) {
    const run = getRun(runId);
    if (!run) {
      throw new RecoveryRequiredError(`Neznámy run_id: ${runId}`, {
        code: "run_not_found",
      });
    }
    if (Number(run.schema_version) !== Number(expected.schemaVersion)) {
      throw new RecoveryRequiredError(
        `Run ${runId} má nekompatibilnú schema_version.`,
        { code: "schema_version_mismatch" }
      );
    }
    if (
      run.algorithm_version !== expected.algorithmVersion ||
      run.algorithm_fingerprint !== expected.algorithmFingerprint
    ) {
      throw new RecoveryRequiredError(
        `Run ${runId} patrí inému crawler algoritmu.`,
        { code: "algorithm_fingerprint_mismatch" }
      );
    }
    return run;
  }

  function getCounts(runId) {
    const counts = {
      queued: 0,
      inProgress: 0,
      complete: 0,
      failed: 0,
      blocked: 0,
    };
    for (const row of stateCountsStatement.all(runId)) {
      if (row.state === "in_progress") {
        counts.inProgress = row.count;
      } else if (Object.hasOwn(counts, row.state)) {
        counts[row.state] = row.count;
      }
    }
    counts.uniqueItems = uniqueItemsStatement.get(runId).count;
    return counts;
  }

  function refreshCounts(runId) {
    const counts = getCounts(runId);
    updateCountsStatement.run({
      runId,
      ...counts,
      now: new Date().toISOString(),
    });
    return { ...counts, run: getRun(runId) };
  }

  function setStatus(runId, status, options = {}) {
    if (!Object.values(RUN_STATUSES).includes(status)) {
      throw new TypeError(`Neplatný run status: ${status}`);
    }
    const current = getRun(runId);
    if (!current) {
      throw new CrawlerInvariantError(`Run ${runId} neexistuje.`, {
        code: "run_not_found",
      });
    }
    if (status === RUN_STATUSES.COMPLETE) {
      const counts = getCounts(runId);
      if (
        counts.queued ||
        counts.inProgress ||
        counts.failed ||
        counts.blocked ||
        current.partition_completeness_proven !== 1
      ) {
        throw new CrawlerInvariantError(
          `Run ${runId} nemožno označiť complete bez úplného frontieru a dôkazu partitioningu.`,
          { code: "unsafe_complete_status" }
        );
      }
    }
    if (
      options.reconciliationSafe === true &&
      (status !== RUN_STATUSES.COMPLETE ||
        current.partition_completeness_proven !== 1)
    ) {
      throw new CrawlerInvariantError(
        `Run ${runId} nemožno označiť reconciliation_safe.`,
        { code: "unsafe_reconciliation_status" }
      );
    }
    const now = new Date().toISOString();
    const terminal = status !== RUN_STATUSES.RUNNING;
    database
      .prepare(`
        UPDATE crawl_runs
        SET status = ?,
            reconciliation_safe = ?,
            error_message = ?,
            updated_at = ?,
            finished_at = ?
        WHERE run_id = ?
      `)
      .run(
        status,
        options.reconciliationSafe === true ? 1 : 0,
        options.errorMessage || null,
        now,
        terminal ? now : null,
        runId
      );
    return getRun(runId);
  }

  function validateInvariants(runId, options = {}) {
    const run = getRun(runId);
    if (!run) {
      throw new CrawlerInvariantError(`Run ${runId} neexistuje.`, {
        code: "run_not_found",
      });
    }
    const invalidLeases = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM crawl_frontier
        WHERE run_id = ?
          AND (
            (state = 'in_progress' AND (
              lease_owner IS NULL OR lease_started_at IS NULL OR lease_expires_at IS NULL
            ))
            OR
            (state != 'in_progress' AND (
              lease_owner IS NOT NULL OR lease_started_at IS NOT NULL OR lease_expires_at IS NOT NULL
            ))
          )
      `)
      .get(runId).count;
    if (invalidLeases > 0) {
      throw new CrawlerInvariantError(
        `Run ${runId} má ${invalidLeases} nekonzistentných lease riadkov.`,
        { code: "lease_invariant_violation" }
      );
    }
    const orphanPages = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM crawl_pages p
        LEFT JOIN crawl_frontier f
          ON f.run_id = p.run_id AND f.prefix = p.prefix AND f.depth = p.depth
        WHERE p.run_id = ? AND f.id IS NULL
      `)
      .get(runId).count;
    if (orphanPages > 0) {
      throw new CrawlerInvariantError(
        `Run ${runId} má ${orphanPages} strán bez frontier riadku.`,
        { code: "orphan_page" }
      );
    }
    const actualRootCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM crawl_frontier WHERE run_id = ? AND parent_prefix IS NULL"
      )
      .get(runId).count;
    if (actualRootCount !== run.root_prefix_count) {
      throw new CrawlerInvariantError(
        `Run ${runId} má ${actualRootCount} koreňov, očakáva ${run.root_prefix_count}.`,
        { code: "root_frontier_mismatch" }
      );
    }
    for (const direction of ["ASC", "DESC"]) {
      const sample = database
        .prepare(
          `SELECT ident, item_json FROM crawl_items WHERE run_id = ? ORDER BY ident ${direction} LIMIT 1`
        )
        .get(runId);
      if (sample) {
        try {
          const parsed = JSON.parse(sample.item_json);
          if (parsed?.ident !== sample.ident) {
            throw new Error("ident mismatch");
          }
        } catch (error) {
          throw new CrawlerInvariantError(
            `Run ${runId} má neplatnú hraničnú crawl_items vzorku.`,
            { code: "item_sample_invalid", cause: error }
          );
        }
      }
    }
    const counts = getCounts(runId);
    const persistedCounts = {
      queued: run.queued_count,
      inProgress: run.in_progress_count,
      complete: run.complete_count,
      failed: run.failed_count,
      blocked: run.blocked_count,
      uniqueItems: run.unique_items,
    };
    if (
      Object.keys(counts).some(
        (key) => Number(counts[key]) !== Number(persistedCounts[key])
      )
    ) {
      throw new CrawlerInvariantError(
        `Run ${runId} má nekonzistentné persistentné counters.`,
        { code: "run_counter_mismatch" }
      );
    }
    if (options.persistCounts !== false) {
      refreshCounts(runId);
    }
    if (
      run.status === RUN_STATUSES.COMPLETE &&
      (counts.queued ||
        counts.inProgress ||
        counts.failed ||
        counts.blocked ||
        !run.partition_completeness_proven)
    ) {
      throw new CrawlerInvariantError(
        `Run ${runId} porušuje complete invariant.`,
        { code: "invalid_complete_status" }
      );
    }
    return { run: getRun(runId), counts };
  }

  function finalizeInternal(runId) {
    const { run, counts } = validateInvariants(runId);
    let status;
    if (counts.queued || counts.inProgress || counts.blocked) {
      status = RUN_STATUSES.INCOMPLETE;
    } else if (counts.failed) {
      status = RUN_STATUSES.COMPLETE_WITH_FAILURES;
    } else if (!run.partition_completeness_proven) {
      status = RUN_STATUSES.INCOMPLETE;
    } else {
      status = RUN_STATUSES.COMPLETE;
    }
    return setStatus(runId, status, {
      reconciliationSafe:
        status === RUN_STATUSES.COMPLETE &&
        run.partition_completeness_proven === 1,
    });
  }
  const finalizeTransaction = database.transaction(finalizeInternal);

  function finalize(runId) {
    return finalizeTransaction.immediate(runId);
  }

  function markRecoveryRequired(runId, error) {
    return setStatus(runId, RUN_STATUSES.RECOVERY_REQUIRED, {
      errorMessage: error?.message || String(error),
      reconciliationSafe: false,
    });
  }

  return {
    createRun,
    finalize,
    getCounts,
    getLatestRun,
    getRun,
    markRecoveryRequired,
    refreshCounts,
    setStatus,
    validateInvariants,
    validateRunIdentity,
  };
}

module.exports = { RUN_STATUSES, createRunStore };
