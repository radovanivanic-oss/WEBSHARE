const os = require("os");
const crypto = require("crypto");
const { CrawlerInvariantError } = require("./errors");
const { buildChildPrefixes } = require("./prefix-partitioner");
const { classifySearchError } = require("./search-client");
const { validateSearchPage } = require("./page-validator");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt, config) {
  return Math.min(
    config.retryMaxDelayMs,
    config.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
  );
}

function createShutdownController() {
  let requested = false;
  let signal = null;
  const abortController = new AbortController();
  return {
    request(reason = "shutdown") {
      if (!requested) {
        requested = true;
        signal = reason;
        abortController.abort(reason);
      }
    },
    get requested() {
      return requested;
    },
    get signal() {
      return signal;
    },
    get abortSignal() {
      return abortController.signal;
    },
  };
}

function correctnessBlockCode(error) {
  return new Set([
    "repeated_page",
    "unstable_total",
    "offset_not_advancing",
    "offset_fingerprint_mismatch",
  ]).has(error?.code)
    ? error.code
    : null;
}

async function withLeaseHeartbeat(context, frontier, operation) {
  const {
    runId,
    leaseOwner,
    frontierStore,
    config,
  } = context;
  const intervalMs = Math.max(
    10,
    Math.min(5_000, Math.floor(config.leaseDurationMs / 3))
  );
  let heartbeatError = null;
  const heartbeat = setInterval(() => {
    try {
      frontierStore.renewLease(
        runId,
        frontier.prefix,
        frontier.depth,
        leaseOwner,
        config.leaseDurationMs
      );
    } catch (error) {
      heartbeatError = error;
    }
  }, intervalMs);
  heartbeat.unref?.();
  try {
    const result = await operation();
    if (heartbeatError) throw heartbeatError;
    frontierStore.renewLease(
      runId,
      frontier.prefix,
      frontier.depth,
      leaseOwner,
      config.leaseDurationMs
    );
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

async function processLeasedPrefix(context, leased) {
  const {
    runId,
    leaseOwner,
    frontierStore,
    itemStore,
    transport,
    normalizeItem,
    config,
    fault,
    shutdown,
  } = context;
  await fault("after_prefix_lease", { runId, leased });
  let frontier = leased;

  while (!shutdown.requested) {
    const offset =
      frontier.pages_processed === 0
        ? 0
        : frontier.last_offset + frontier.last_page_count;
    let page;
    try {
      page = await withLeaseHeartbeat(context, frontier, () =>
        transport.fetchPage({
          prefix: frontier.prefix,
          offset,
          limit: config.algorithm.pageSize,
          signal: shutdown.abortSignal,
        })
      );
      await fault("after_page_fetch", { runId, frontier, page });
      if (!page || !Array.isArray(page.files)) {
        frontierStore.block(
          runId,
          frontier.prefix,
          frontier.depth,
          leaseOwner,
          "invalid_page_shape"
        );
        return "blocked";
      }
      const rawItems = page.files || [];
      const normalizedItems = [];
      for (const rawItem of rawItems) {
        const item = normalizeItem(rawItem);
        if (item?.ident) normalizedItems.push(item);
      }
      const normalizedPage = {
        total: page.total,
        files: normalizedItems,
        sourceItemCount: rawItems.length,
      };
      const decision = validateSearchPage(
        normalizedPage,
        frontier,
        config.algorithm
      );
      itemStore.commitPage({
        runId,
        prefix: frontier.prefix,
        depth: frontier.depth,
        leaseOwner,
        offset,
        reportedTotal: decision.reportedTotal,
        fingerprint: decision.fingerprint,
        items: normalizedItems,
        sourceItemCount: rawItems.length,
      });
      await fault("after_item_commit", {
        runId,
        frontier,
        page: normalizedPage,
        decision,
      });

      if (shutdown.requested) {
        frontierStore.releaseOwnedLeases(runId, leaseOwner, "graceful_shutdown");
        return "aborted";
      }
      if (decision.action === "blocked") {
        frontierStore.block(
          runId,
          frontier.prefix,
          frontier.depth,
          leaseOwner,
          decision.reason
        );
        return "blocked";
      }
      if (decision.action === "split") {
        const partition = buildChildPrefixes(
          frontier.prefix,
          config.algorithm
        );
        if (!partition.supported) {
          frontierStore.block(
            runId,
            frontier.prefix,
            frontier.depth,
            leaseOwner,
            partition.reason
          );
          return "blocked";
        }
        frontierStore.addChildrenAndCompleteParent(
          runId,
          frontier,
          partition.prefixes,
          leaseOwner
        );
        return "split";
      }
      if (decision.action === "complete") {
        await fault("before_prefix_complete", { runId, frontier, decision });
        frontierStore.complete(
          runId,
          frontier.prefix,
          frontier.depth,
          leaseOwner
        );
        return "complete";
      }
      frontierStore.renewLease(
        runId,
        frontier.prefix,
        frontier.depth,
        leaseOwner,
        config.leaseDurationMs
      );
      frontier = frontierStore.getFrontier(
        runId,
        frontier.prefix,
        frontier.depth
      );
    } catch (error) {
      if (error?.simulateCrash === true) throw error;
      if (shutdown.requested) {
        frontierStore.releaseOwnedLeases(
          runId,
          leaseOwner,
          "graceful_shutdown"
        );
        return "aborted";
      }
      const blockReason = correctnessBlockCode(error);
      if (blockReason) {
        frontierStore.block(
          runId,
          frontier.prefix,
          frontier.depth,
          leaseOwner,
          blockReason,
          error
        );
        return "blocked";
      }
      if (error instanceof CrawlerInvariantError) throw error;
      const failureClass = classifySearchError(error);
      return frontierStore.fail(
        runId,
        frontier.prefix,
        frontier.depth,
        leaseOwner,
        failureClass,
        error,
        {
          maxAttempts: config.maxAttempts,
          backoffMs: retryDelay(frontier.attempt_count, config),
        }
      );
    }
  }
  frontierStore.releaseOwnedLeases(runId, leaseOwner, "graceful_shutdown");
  return "aborted";
}

async function runWorkers(options) {
  const workerCount = Math.max(
    1,
    Math.min(16, Number(options.config.workerConcurrency) || 1)
  );
  const workerTasks = Array.from({ length: workerCount }, (_, index) => {
    const leaseOwner = `${os.hostname()}:${process.pid}:${index}:${crypto.randomUUID()}`;
    return (async () => {
      try {
        while (!options.shutdown.requested) {
          const leased = options.frontierStore.lease(
            options.runId,
            leaseOwner,
            options.config.leaseDurationMs
          );
          if (leased) {
            await processLeasedPrefix({ ...options, leaseOwner }, leased);
            continue;
          }
          const queued = options.frontierStore.queuedWork(options.runId);
          if (!queued.count) return;
          const dueMs = queued.next_attempt_at
            ? new Date(queued.next_attempt_at).getTime() - Date.now()
            : 0;
          await sleep(Math.max(1, Math.min(1000, dueMs || 10)));
        }
      } catch (error) {
        options.shutdown.request("worker_error");
        throw error;
      }
    })();
  });
  const results = await Promise.allSettled(workerTasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

module.exports = {
  createShutdownController,
  processLeasedPrefix,
  retryDelay,
  runWorkers,
  withLeaseHeartbeat,
};
