# B.45 daily incremental catalog maintenance

The full crawler remains an exceptional audit/recovery tool. Daily operation is
implemented by `scripts/run-daily-maintenance.js` and `lib/daily-maintenance.js`.

The runner has three separate safety boundaries:

1. Recent discovery uses `sort=recent` with configured search buckets, bounded
   pages, and an overlap checkpoint. A bucket is not considered complete until
   it re-encounters its previous boundary. The first run therefore fails closed
   and cannot advance the frontier.
2. Existing files are checked by a deterministic rotating `id % bucket_count`
   slice. A definitive absence becomes `SUSPECT`; two observations on separate
   maintenance runs are required before deactivation. Timeouts, authentication
   failures, rate limits, malformed responses, and provider outages never become
   deletion evidence.
3. A staged plan records the exact catalog baseline, discovery decisions,
   verification outcomes, thresholds, and SHA-256 digest. Applying a plan
   requires the expected digest and a consistent backup. The catalog transaction
   reuses the existing importer statements, rebuilds FTS/visibility in the same
   transaction, and fails closed on baseline drift.

New files that do not meet the existing parser/classifier threshold are accounted
for as `QUARANTINE_UNCLASSIFIED`; they are not inserted into `media` or `files`.
Existing active identities are idempotent, inactive identities can be reactivated
only by the reviewed plan, and confirmed missing files are deactivated rather
than hard-deleted.

`current.json` is intentionally not changed by the daily runner in the discovery
or blocked state. A future production invocation must run the existing public
exporter/validator and content-addressed publication workflow after the catalog
transaction, then advance the maintenance state only after the public generation
has passed its gates. A no-change run can advance the overlap checkpoint after
its complete discovery and integrity checks.

Use a dedicated systemd timer only after bounded live acceptance and operator
review. The B.45 implementation does not install or enable a timer.
