const crypto = require("crypto");
const { CrawlerInvariantError } = require("./errors");

function pageFingerprint(items) {
  const hash = crypto.createHash("sha256");
  const idents = items
    .map((item) => String(item?.ident || ""))
    .sort();
  for (const ident of idents) {
    hash.update(String(Buffer.byteLength(ident)));
    hash.update(":");
    hash.update(ident);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function createItemStore(database) {
  const getFrontier = database.prepare(`
    SELECT * FROM crawl_frontier
    WHERE run_id = ? AND prefix = ? AND depth = ?
  `);
  const findPageAtOffset = database.prepare(`
    SELECT * FROM crawl_pages
    WHERE run_id = ? AND prefix = ? AND depth = ? AND offset = ?
  `);
  const findRepeatedFingerprint = database.prepare(`
    SELECT offset FROM crawl_pages
    WHERE run_id = ? AND prefix = ? AND depth = ?
      AND page_fingerprint = ? AND item_count > 0 AND offset != ?
    LIMIT 1
  `);
  const insertItem = database.prepare(`
    INSERT OR IGNORE INTO crawl_items (
      run_id, ident, item_json, first_observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertPage = database.prepare(`
    INSERT INTO crawl_pages (
      run_id, prefix, depth, page_number, offset, item_count,
      reported_total, page_fingerprint, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCommit = database.prepare(`
    INSERT INTO crawl_commits (
      run_id, prefix, depth, offset, page_fingerprint,
      inserted_items, duplicate_items, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const commitPageTransaction = database.transaction((page) => {
    const frontier = getFrontier.get(page.runId, page.prefix, page.depth);
    if (
      !frontier ||
      frontier.state !== "in_progress" ||
      frontier.lease_owner !== page.leaseOwner
    ) {
      throw new CrawlerInvariantError("Page commit bez platného lease.", {
        code: "page_commit_without_lease",
      });
    }
    const existing = findPageAtOffset.get(
      page.runId,
      page.prefix,
      page.depth,
      page.offset
    );
    if (existing) {
      if (existing.page_fingerprint !== page.fingerprint) {
        throw new CrawlerInvariantError(
          "Rovnaký offset má odlišný page fingerprint.",
          { code: "offset_fingerprint_mismatch" }
        );
      }
      return {
        alreadyCommitted: true,
        insertedItems: 0,
        duplicateItems: page.items.length,
      };
    }
    const expectedOffset =
      frontier.pages_processed === 0
        ? 0
        : frontier.last_offset + frontier.last_page_count;
    if (page.offset !== expectedOffset) {
      throw new CrawlerInvariantError(
        `Offset ${page.offset} nenadväzuje na ${expectedOffset}.`,
        { code: "offset_not_advancing" }
      );
    }
    if (
      frontier.total_reported !== null &&
      page.reportedTotal !== null &&
      frontier.total_reported !== page.reportedTotal
    ) {
      throw new CrawlerInvariantError("Reported total sa zmenil počas prefixu.", {
        code: "unstable_total",
      });
    }
    if (
      page.items.length > 0 &&
      findRepeatedFingerprint.get(
        page.runId,
        page.prefix,
        page.depth,
        page.fingerprint,
        page.offset
      )
    ) {
      throw new CrawlerInvariantError("API zopakovalo identickú stránku.", {
        code: "repeated_page",
      });
    }

    const now = new Date().toISOString();
    let insertedItems = 0;
    for (const item of page.items) {
      if (!item || typeof item.ident !== "string" || !item.ident.trim()) {
        throw new CrawlerInvariantError("Položka nemá platný ident.", {
          code: "invalid_item_ident",
        });
      }
      insertedItems += insertItem.run(
        page.runId,
        item.ident,
        JSON.stringify(item),
        now,
        now
      ).changes;
    }
    insertPage.run(
      page.runId,
      page.prefix,
      page.depth,
      frontier.pages_processed,
      page.offset,
      page.sourceItemCount,
      page.reportedTotal,
      page.fingerprint,
      now
    );
    insertCommit.run(
      page.runId,
      page.prefix,
      page.depth,
      page.offset,
      page.fingerprint,
      insertedItems,
      page.items.length - insertedItems,
      now
    );
    database
      .prepare(`
        UPDATE crawl_runs
        SET unique_items = unique_items + ?, updated_at = ?
        WHERE run_id = ?
      `)
      .run(insertedItems, now, page.runId);
    const frontierUpdate = database
      .prepare(`
        UPDATE crawl_frontier
        SET total_reported = COALESCE(total_reported, ?),
            pages_processed = pages_processed + 1,
            items_observed = items_observed + ?,
            last_offset = ?,
            last_page_count = ?,
            last_page_fingerprint = ?,
            updated_at = ?
        WHERE run_id = ? AND prefix = ? AND depth = ?
          AND state = 'in_progress' AND lease_owner = ?
      `)
      .run(
        page.reportedTotal,
        page.sourceItemCount,
        page.offset,
        page.sourceItemCount,
        page.fingerprint,
        now,
        page.runId,
        page.prefix,
        page.depth,
        page.leaseOwner
      );
    if (frontierUpdate.changes !== 1) {
      throw new CrawlerInvariantError(
        "Page watermark sa nepodarilo zapísať pod platným lease.",
        { code: "page_watermark_update_failed" }
      );
    }
    return {
      alreadyCommitted: false,
      insertedItems,
      duplicateItems: page.items.length - insertedItems,
    };
  });

  function commitPage(page) {
    const items = page.items || [];
    return commitPageTransaction.immediate({
      ...page,
      items,
      sourceItemCount:
        Number.isSafeInteger(page.sourceItemCount) && page.sourceItemCount >= 0
          ? page.sourceItemCount
          : items.length,
      fingerprint: page.fingerprint || pageFingerprint(items),
      reportedTotal:
        page.reportedTotal === undefined ? null : page.reportedTotal,
    });
  }

  function countItems(runId) {
    return database
      .prepare("SELECT COUNT(*) AS count FROM crawl_items WHERE run_id = ?")
      .get(runId).count;
  }

  function getItem(runId, ident) {
    const row = database
      .prepare(
        "SELECT item_json FROM crawl_items WHERE run_id = ? AND ident = ?"
      )
      .get(runId, ident);
    return row ? JSON.parse(row.item_json) : null;
  }

  function iterateItems(runId) {
    return database
      .prepare(
        "SELECT ident, item_json FROM crawl_items WHERE run_id = ? ORDER BY ident"
      )
      .iterate(runId);
  }

  return { commitPage, countItems, getItem, iterateItems };
}

module.exports = { createItemStore, pageFingerprint };
