const { pageFingerprint } = require("./item-store");

function validateSearchPage(page, frontier, algorithm) {
  if (!page || !Array.isArray(page.files)) {
    return {
      action: "blocked",
      reason: "invalid_page_shape",
      fingerprint: pageFingerprint([]),
    };
  }
  const fingerprint = pageFingerprint(page.files);
  const itemCount =
    Number.isSafeInteger(page.sourceItemCount) && page.sourceItemCount >= 0
      ? page.sourceItemCount
      : page.files.length;
  const totalPresent =
    page.total !== null &&
    page.total !== undefined &&
    !(typeof page.total === "string" && page.total.trim() === "");
  const numericTotal = Number(page.total);
  const reportedTotal =
    totalPresent &&
    Number.isSafeInteger(numericTotal) &&
    numericTotal >= 0
      ? numericTotal
      : null;
  const nextPageNumber = frontier.pages_processed + 1;
  const observedAfterPage = frontier.items_observed + itemCount;

  if (itemCount !== page.files.length) {
    return {
      action: "blocked",
      reason: "invalid_page_item",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  if (itemCount > algorithm.pageSize) {
    return {
      action: "blocked",
      reason: "page_size_exceeded",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  if (reportedTotal === null) {
    return {
      action: "blocked",
      reason: "invalid_reported_total",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  if (reportedTotal < observedAfterPage) {
    return {
      action: "blocked",
      reason: "total_below_observed",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }

  if (
    itemCount > 0 &&
    frontier.last_page_fingerprint &&
    frontier.last_page_fingerprint === fingerprint
  ) {
    return {
      action: "blocked",
      reason: "repeated_page",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  if (
    itemCount === algorithm.pageSize &&
    nextPageNumber >= algorithm.maxPagesPerPrefix
  ) {
    return {
      action: "blocked",
      reason: "max_pages_exceeded",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  if (
    reportedTotal !== null &&
    reportedTotal >= algorithm.serverResultCap
  ) {
    if (!algorithm.partitionCompletenessProven) {
      return {
        action: "blocked",
        reason: "unsupported_character_partition",
        fingerprint,
        itemCount,
        reportedTotal,
      };
    }
    if (frontier.depth >= algorithm.maxDepth) {
      return {
        action: "blocked",
        reason: "max_partition_depth",
        fingerprint,
        itemCount,
        reportedTotal,
      };
    }
    return {
      action: "split",
      reason: "server_result_cap",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  if (itemCount < algorithm.pageSize) {
    if (observedAfterPage < reportedTotal) {
      return {
        action: "blocked",
        reason: "premature_short_page",
        fingerprint,
        itemCount,
        reportedTotal,
      };
    }
    return {
      action: "complete",
      reason: "short_page",
      fingerprint,
      itemCount,
      reportedTotal,
    };
  }
  return {
    action: "continue",
    reason: "full_page_below_cap",
    fingerprint,
    itemCount,
    reportedTotal,
  };
}

module.exports = { validateSearchPage };
