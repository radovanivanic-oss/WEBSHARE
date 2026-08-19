# B.45.2 complete enumeration audit

## Historical crawler

The original path in `main.js` recursively split `what=<prefix>*` queries,
fetched every page of each unsaturated leaf, deduplicated identifiers with the
legacy seen-index, and streamed normalized records to JSONL. The later local
classification/export phase operated on that JSONL. The current v2 crawler
reuses the same provider shape with durable frontier leases, page fingerprints,
recovery, and a shadow-only mode.

The production import recorded 1,639,152 observed items and completed in about
eight minutes. The historical more-than-24-hour duration was therefore not
SQLite import time; it was dominated by the provider enumeration request count,
recursive prefix splitting, retries/throttling, duplicate pages, and the
legacy mixed crawl/normalization/export workflow.

## Partition audit

The only documented search dimensions are `what`, `sort`, `limit`, `offset`,
and category. `sort` values are `recent`, `rating`, `largest`, and `smallest`.
There is no exact extension filter, cursor, upload-time filter, ident range, or
global snapshot token.

Live extension probes for `mkv`, `mp4`, `avi`, and `webm` were all observed as
substring/token searches with a reported total of `1000`; they are not exact
extension filters. Category `video` is useful for restricting media type but
does not partition files. Size and rating are sort modes, not proven filters.

Filename prefixes are rejected as partitions because returned names do not
consistently begin with the requested value. Empty/global `what` also returns
zero records. No complete union or catch-all partition is currently proven.

## Enumeration-only fast path

The existing shadow crawler remains the provider enumeration engine. It writes
only its isolated shadow state/export and never writes the catalog. The new
`lib/enumeration-only.js` layer provides:

- minimal records containing ident/name/size/type/extension and provenance;
- an in-memory known-ident index built from the indexed SQLite `files.ident`;
- O(1)-average known/new classification;
- duplicate and malformed-record accounting;
- deterministic snapshot digests;
- complete-run certificates;
- absence comparison only when both completion and coverage are proven.

`compare-enumeration-snapshot.js` consumes an existing crawler/shadow JSONL
export, so it does not create a second crawler. Existing idents bypass all
classification, metadata, entity-resolution, and provider enrichment work.
Only new observed records are written to the bounded `new-items.jsonl` delta.

Partial or unproven enumeration never creates `not_seen` deletion candidates.

## Local measurements

Known-ident comparison benchmark:

| records | elapsed | records/sec |
| ---: | ---: | ---: |
| 1,000 | 0.28 ms | 3.58 M/s |
| 10,000 | 2.14 ms | 4.66 M/s |
| 50,000 | 12.20 ms | 4.10 M/s |

Loading all 1,176,972 production idents read-only took 1.16 seconds and about
119 MB heap growth / 198 MB RSS growth. This is acceptable for a bounded
enumeration process, but the index must not be built inside the catalog write
transaction.

## Certificate rules

Only this combination permits absence comparison:

```text
completion_status = COMPLETE
coverage_status = PROVEN_COMPLETE
errors = []
malformed_count = 0
```

The current Webshare contract cannot produce that certificate. The new code is
therefore deployed inertly and remains safe for future provider-contract work.

The comparison CLI also requires a separate partition-proof artifact before it
will accept `--coverage-status PROVEN_COMPLETE`; the flag alone cannot elevate
an unproven export.
