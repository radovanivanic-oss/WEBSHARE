const TEMPORARY_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const TEMPORARY_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ENETUNREACH",
  "EPIPE",
]);

function classifySearchError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || "");
  if (TEMPORARY_HTTP_STATUSES.has(status) || TEMPORARY_CODES.has(code)) {
    return "temporary";
  }
  return "permanent";
}

function createWebshareSearchTransport(options) {
  const { client, session, fetchSearchPage, stats, algorithm, requestMeter } =
    options;
  if (!client || !session || typeof fetchSearchPage !== "function") {
    throw new TypeError("Chýba Webshare search transport dependency.");
  }
  return {
    countsSearchRequests: Boolean(requestMeter),
    async fetchPage({ prefix, offset, limit, signal }) {
      return fetchSearchPage(
        client,
        session,
        {
          prefix,
          offset,
          limit,
          wildcardSuffix: algorithm?.wildcardSuffix || "*",
          sort: algorithm?.sort || "recent",
          category: algorithm?.category || "video",
          signal,
          requestMeter,
        },
        stats
      );
    },
  };
}

module.exports = {
  TEMPORARY_CODES,
  TEMPORARY_HTTP_STATUSES,
  classifySearchError,
  createWebshareSearchTransport,
};
