function buildCrawlerStatus(runStore, runId = null) {
  const run = runId ? runStore.getRun(runId) : runStore.getLatestRun();
  if (!run) {
    return { state: "not_initialized", run: null };
  }
  const counts = runStore.getCounts(run.run_id);
  const refreshedRun = {
    ...run,
    queued_count: counts.queued,
    in_progress_count: counts.inProgress,
    complete_count: counts.complete,
    failed_count: counts.failed,
    blocked_count: counts.blocked,
    unique_items: counts.uniqueItems,
  };
  return {
    state: refreshedRun.status,
    run: {
      ...refreshedRun,
      reconciliation_safe: refreshedRun.reconciliation_safe === 1,
      partition_completeness_proven:
        refreshedRun.partition_completeness_proven === 1,
    },
  };
}

module.exports = { buildCrawlerStatus };
