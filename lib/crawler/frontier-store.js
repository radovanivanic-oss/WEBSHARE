const { CrawlerInvariantError } = require("./errors");

function createFrontierStore(database) {
  const insertFrontier = database.prepare(`
    INSERT OR IGNORE INTO crawl_frontier (
      run_id, prefix, depth, parent_prefix, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `);
  const getFrontierStatement = database.prepare(`
    SELECT * FROM crawl_frontier
    WHERE run_id = ? AND prefix = ? AND depth = ?
  `);
  const insertFailure = database.prepare(`
    INSERT INTO crawl_failures (
      run_id, prefix, depth, attempt_count, failure_class,
      error_code, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedRoots = database.transaction((runId, roots) => {
    const now = new Date().toISOString();
    for (const prefix of roots) {
      insertFrontier.run(runId, prefix, 1, null, now, now);
    }
  });

  const insertChildren = database.transaction(
    (runId, parent, children, leaseOwner) => {
      const current = getFrontier(runId, parent.prefix, parent.depth);
      assertLease(current, leaseOwner);
      const now = new Date().toISOString();
      for (const prefix of children) {
        insertFrontier.run(
          runId,
          prefix,
          parent.depth + 1,
          parent.prefix,
          now,
          now
        );
      }
      const completed = completeStatement.run(
        now,
        now,
        runId,
        parent.prefix,
        parent.depth,
        leaseOwner
      );
      if (completed.changes !== 1) {
        throw new CrawlerInvariantError(
          "Parent prefix sa po vložení detí nepodarilo dokončiť.",
          { code: "split_parent_complete_failed" }
        );
      }
    }
  );

  const leaseNext = database.transaction(
    (runId, leaseOwner, leaseDurationMs, nowMs) => {
      const now = new Date(nowMs).toISOString();
      const candidate = database
        .prepare(`
          SELECT * FROM crawl_frontier
          WHERE run_id = ? AND state = 'queued'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY depth, created_at, id
          LIMIT 1
        `)
        .get(runId, now);
      if (!candidate) return null;
      const expires = new Date(nowMs + leaseDurationMs).toISOString();
      const result = database
        .prepare(`
          UPDATE crawl_frontier
          SET state = 'in_progress',
              attempt_count = attempt_count + 1,
              lease_owner = ?,
              lease_started_at = ?,
              lease_expires_at = ?,
              next_attempt_at = NULL,
              updated_at = ?
          WHERE id = ? AND state = 'queued'
        `)
        .run(leaseOwner, now, expires, now, candidate.id);
      if (result.changes !== 1) {
        throw new CrawlerInvariantError("Atomický lease sa nepodaril.", {
          code: "lease_race",
        });
      }
      return getFrontier(runId, candidate.prefix, candidate.depth);
    }
  );

  const completeStatement = database.prepare(`
    UPDATE crawl_frontier
    SET state = 'complete',
        lease_owner = NULL,
        lease_started_at = NULL,
        lease_expires_at = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE run_id = ? AND prefix = ? AND depth = ?
      AND state = 'in_progress' AND lease_owner = ?
  `);

  function getFrontier(runId, prefix, depth) {
    return getFrontierStatement.get(runId, prefix, depth) || null;
  }

  function assertLease(frontier, leaseOwner) {
    if (
      !frontier ||
      frontier.state !== "in_progress" ||
      frontier.lease_owner !== leaseOwner
    ) {
      throw new CrawlerInvariantError("Worker nevlastní požadovaný prefix lease.", {
        code: "lease_not_owned",
      });
    }
  }

  function recoverExpiredLeases(runId, nowMs = Date.now()) {
    const now = new Date(nowMs).toISOString();
    return database
      .prepare(`
        UPDATE crawl_frontier
        SET state = 'queued',
            lease_owner = NULL,
            lease_started_at = NULL,
            lease_expires_at = NULL,
            next_attempt_at = NULL,
            updated_at = ?,
            last_error_code = 'expired_lease_recovered',
            last_error_message = 'Expired worker lease returned to queue'
        WHERE run_id = ? AND state = 'in_progress' AND lease_expires_at <= ?
      `)
      .run(now, runId, now).changes;
  }

  function lease(runId, leaseOwner, leaseDurationMs, nowMs = Date.now()) {
    return leaseNext.immediate(runId, leaseOwner, leaseDurationMs, nowMs);
  }

  function renewLease(runId, prefix, depth, leaseOwner, leaseDurationMs) {
    const nowMs = Date.now();
    const result = database
      .prepare(`
        UPDATE crawl_frontier
        SET lease_expires_at = ?, updated_at = ?
        WHERE run_id = ? AND prefix = ? AND depth = ?
          AND state = 'in_progress' AND lease_owner = ?
      `)
      .run(
        new Date(nowMs + leaseDurationMs).toISOString(),
        new Date(nowMs).toISOString(),
        runId,
        prefix,
        depth,
        leaseOwner
      );
    if (result.changes !== 1) {
      throw new CrawlerInvariantError("Lease sa nepodarilo obnoviť.", {
        code: "lease_renew_failed",
      });
    }
  }

  function complete(runId, prefix, depth, leaseOwner) {
    const now = new Date().toISOString();
    const result = completeStatement.run(
      now,
      now,
      runId,
      prefix,
      depth,
      leaseOwner
    );
    if (result.changes !== 1) {
      throw new CrawlerInvariantError("Prefix sa nepodarilo označiť complete.", {
        code: "complete_without_lease",
      });
    }
  }

  function addChildrenAndCompleteParent(
    runId,
    parent,
    childPrefixes,
    leaseOwner
  ) {
    insertChildren.immediate(runId, parent, childPrefixes, leaseOwner);
  }

  function writeFailure(frontier, failureClass, error) {
    insertFailure.run(
      frontier.run_id,
      frontier.prefix,
      frontier.depth,
      frontier.attempt_count,
      failureClass,
      error?.code || null,
      String(error?.message || error || "unknown").slice(0, 1000),
      new Date().toISOString()
    );
  }

  const failTransaction = database.transaction(
    (runId, prefix, depth, leaseOwner, failureClass, error, options) => {
      const frontier = getFrontier(runId, prefix, depth);
      assertLease(frontier, leaseOwner);
      writeFailure(frontier, failureClass, error);
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      let state = "failed";
      let nextAttemptAt = null;
      if (
        failureClass === "temporary" &&
        frontier.attempt_count < options.maxAttempts
      ) {
        state = "queued";
        nextAttemptAt = new Date(nowMs + options.backoffMs).toISOString();
      }
      const updated = database
        .prepare(`
          UPDATE crawl_frontier
          SET state = ?, next_attempt_at = ?,
              lease_owner = NULL, lease_started_at = NULL, lease_expires_at = NULL,
              last_error_code = ?, last_error_message = ?, updated_at = ?,
              completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
          WHERE run_id = ? AND prefix = ? AND depth = ?
            AND state = 'in_progress' AND lease_owner = ?
        `)
        .run(
          state,
          nextAttemptAt,
          error?.code || null,
          String(error?.message || error || "unknown").slice(0, 1000),
          now,
          state,
          now,
          runId,
          prefix,
          depth,
          leaseOwner
        );
      if (updated.changes !== 1) {
        throw new CrawlerInvariantError(
          "Failure transition stratil platný prefix lease.",
          { code: "failure_transition_without_lease" }
        );
      }
      return state;
    }
  );

  function fail(
    runId,
    prefix,
    depth,
    leaseOwner,
    failureClass,
    error,
    options
  ) {
    return failTransaction.immediate(
      runId,
      prefix,
      depth,
      leaseOwner,
      failureClass,
      error,
      options
    );
  }

  const blockTransaction = database.transaction(
    (runId, prefix, depth, leaseOwner, reason, error) => {
      const frontier = getFrontier(runId, prefix, depth);
      assertLease(frontier, leaseOwner);
      writeFailure(frontier, "blocked", {
        code: reason,
        message: error?.message || reason,
      });
      const now = new Date().toISOString();
      const updated = database
        .prepare(`
          UPDATE crawl_frontier
          SET state = 'blocked', saturation_reason = ?,
              last_error_code = ?, last_error_message = ?,
              lease_owner = NULL, lease_started_at = NULL, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
          WHERE run_id = ? AND prefix = ? AND depth = ?
            AND state = 'in_progress' AND lease_owner = ?
        `)
        .run(
          reason,
          reason,
          String(error?.message || reason).slice(0, 1000),
          now,
          now,
          runId,
          prefix,
          depth,
          leaseOwner
        );
      if (updated.changes !== 1) {
        throw new CrawlerInvariantError(
          "Blocked transition stratil platný prefix lease.",
          { code: "blocked_transition_without_lease" }
        );
      }
    }
  );

  function block(runId, prefix, depth, leaseOwner, reason, error = null) {
    blockTransaction.immediate(runId, prefix, depth, leaseOwner, reason, error);
  }

  function retryFailed(runId) {
    const now = new Date().toISOString();
    return database
      .prepare(`
        UPDATE crawl_frontier
        SET state = 'queued', next_attempt_at = NULL,
            completed_at = NULL, updated_at = ?,
            last_error_code = 'explicit_retry_failed',
            last_error_message = 'Requeued by --retry-failed'
        WHERE run_id = ? AND state = 'failed'
      `)
      .run(now, runId).changes;
  }

  function releaseOwnedLeases(runId, leaseOwner, reason = "worker_shutdown") {
    const now = new Date().toISOString();
    return database
      .prepare(`
        UPDATE crawl_frontier
        SET state = 'queued',
            lease_owner = NULL, lease_started_at = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, updated_at = ?,
            last_error_code = ?, last_error_message = ?
        WHERE run_id = ? AND state = 'in_progress' AND lease_owner = ?
      `)
      .run(now, reason, reason, runId, leaseOwner).changes;
  }

  function countByState(runId, state) {
    return database
      .prepare(
        "SELECT COUNT(*) AS count FROM crawl_frontier WHERE run_id = ? AND state = ?"
      )
      .get(runId, state).count;
  }

  function queuedWork(runId) {
    return database
      .prepare(`
        SELECT COUNT(*) AS count, MIN(next_attempt_at) AS next_attempt_at
        FROM crawl_frontier
        WHERE run_id = ? AND state = 'queued'
      `)
      .get(runId);
  }

  return {
    addChildrenAndCompleteParent,
    block,
    complete,
    countByState,
    fail,
    getFrontier,
    lease,
    recoverExpiredLeases,
    releaseOwnedLeases,
    renewLease,
    retryFailed,
    queuedWork,
    seedRoots(runId, roots) {
      return seedRoots.immediate(runId, roots);
    },
  };
}

module.exports = { createFrontierStore };
