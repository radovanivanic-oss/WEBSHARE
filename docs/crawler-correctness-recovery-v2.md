# Crawler correctness and recovery v2

Status: implementation design for Phase B
Scope: Windows working copy; no production crawl, import, reconciliation, or deployment
State schema: 2
Algorithm version: `webshare-search-v2`

## 1. Invariants

The v2 crawler is fail-closed. A run can preserve useful discovered data without
claiming that it is a complete Webshare catalogue.

| ID | Invariant |
| --- | --- |
| INV-01 | Every frontier prefix is in exactly one state: `queued`, `in_progress`, `complete`, `failed`, or `blocked`. |
| INV-02 | A prefix is never removed from the persistent frontier. It remains present and is changed to a terminal state only after an atomic state transition. |
| INV-03 | On recovery, every expired `in_progress` lease is returned to `queued`. A live, non-expired lease is not stolen. |
| INV-04 | A missing, malformed, or incompatible legacy checkpoint never causes JSONL, seen data, failure data, or exports to be deleted. |
| INV-05 | An ident is not “seen” independently of its item. Deduplication and item persistence are the same `crawl_items` insert in one SQLite transaction. |
| INV-06 | A run is not `complete` while any frontier row is `queued`, `in_progress`, `failed`, or `blocked`. |
| INV-07 | A saturated prefix without positive end-of-results evidence is never `complete`. |
| INV-08 | Any change to roots, partition alphabet, maximum depth, query construction, category, sort, page size, page cap, or validation rules changes the algorithm fingerprint. |
| INV-09 | Frontier, pages, failures, commits, and items reference one `run_id`; the run’s stored algorithm fingerprint must match the requested algorithm. |
| INV-10 | Recovery has no destructive reset path. Starting over is a separate, explicit operator action outside the crawler. |
| INV-11 | A page fingerprint is unique per `(run_id, prefix, depth, offset)` and a repeated non-empty fingerprint at a different offset blocks the prefix. |
| INV-12 | Only the current lease owner can commit a page or complete/requeue/block its prefix. |
| INV-13 | `reconciliation_safe` remains false unless both frontier validation and the search partition strategy have independent completeness evidence. |
| INV-14 | Controlled shutdown never reports success and never leases new work after shutdown begins. |
| INV-15 | Production fault injection is disabled; injected faults require an explicit test-only dependency. |

## 2. Frontier model

The persistent state is `runtime/crawler-state.sqlite`. It is a crawler spool and
ledger, not the serving catalogue database. SQLite WAL, foreign keys, a busy
timeout, prepared statements, bounded workers, and short transactions are used.

Tables:

- `crawl_runs`: run identity, schema/algorithm identity, lifecycle state,
  reconciliation safety, aggregate counters, timestamps, and last error.
- `crawl_frontier`: one durable row per `(run_id, prefix, depth)`, including
  lease, progress, saturation, and error fields.
- `crawl_pages`: page offset, ordered-ident fingerprint, reported total, item
  count, and commit time.
- `crawl_failures`: append-only attempt and correctness-failure audit.
- `crawl_items`: raw normalized item JSON with `PRIMARY KEY (run_id, ident)`.
- `crawl_commits`: append-only page-commit audit with inserted/duplicate counts.
- `crawler_state`: schema metadata and operational key/value state.

Required indexes are `(run_id, state, depth, created_at)`,
`(run_id, lease_expires_at)`, and deterministic item iteration by the
`(run_id, ident)` primary key.
No operation loads the entire frontier or item set into JavaScript memory.

Initial roots are configuration, not proof of coverage. The currently observed
Webshare search semantics do not provide a finite, disjoint root partition.
Consequently the shipped algorithm is explicitly
`partition_completeness_proven=false`.

## 3. Prefix states

- `queued`: eligible for an atomic lease when `next_attempt_at` is due.
- `in_progress`: owned by `lease_owner` until `lease_expires_at`.
- `complete`: the crawler observed an unambiguous short/empty terminal page for
  this query and all children (if split) are accounted for.
- `failed`: a permanent request failure occurred, or temporary retries were
  exhausted. `--retry-failed` may explicitly requeue it.
- `blocked`: a correctness condition prevents proof of completion. Examples are
  repeated pages, an unstable total, result-cap saturation, maximum partition
  depth, or unsupported partition semantics. Blocked rows are never
  automatically retried.

Splitting inserts children and marks the parent complete only in the same
transaction after all child rows exist. Because observed search is not
starts-with and therefore children are neither disjoint nor exhaustive, the
default v2 policy does not use a saturated query to claim coverage. It records
`unsupported_character_partition` or `server_result_cap` as `blocked`.

## 4. Checkpoint schema

State schema 2 is SQLite-only:

```text
crawler_state.schema_version = 2
crawl_runs.schema_version = 2
crawl_runs.algorithm_version = webshare-search-v2
crawl_runs.algorithm_fingerprint = sha256(canonical algorithm config)
```

`runtime/webshare-crawler.checkpoint.json` and
`runtime/checkpoint.json` are legacy v3 candidates. They are detected read-only.
The v2 crawler does not parse them as authoritative state and does not migrate or
delete them automatically. If legacy state exists without a v2 state database,
`--crawl` fails with `legacy_checkpoint_detected`; an explicit, separately
reviewed migration is required.

On open, v2 checks a bounded `PRAGMA quick_check('crawler_state')`, schema
version, run identity, lease invariants, and algorithm fingerprint. It does not
implicitly scan a multi-million-row item table. A full offline integrity check
is a separately approved operator action. Failure sets or reports
`recovery_required`; the database and every legacy runtime artifact stay in
place.

## 5. Atomic commit model

Leasing and page commits use `BEGIN IMMEDIATE`. The `better-sqlite3`
transaction wrapper guarantees COMMIT on return and ROLLBACK on every thrown
exception:

1. select one due `queued` row (expired leases are requeued by validated recovery);
2. update it to `in_progress`, increment `attempt_count`, and set owner/start/end;
3. commit.

Page commit also uses one transaction:

1. verify the caller still owns a non-terminal leased frontier row;
2. verify offset and fingerprint invariants;
3. `INSERT OR IGNORE` each normalized item into `crawl_items`;
4. insert the page in `crawl_pages`;
5. insert a `crawl_commits` audit row;
6. update page counters, item counters, last offset/fingerprint, and lease;
7. commit.

There is no separate seen index. A duplicate ident is the unique-constraint
conflict on `crawl_items`; therefore a crash cannot create “seen without item”.
A crash before commit persists nothing. A crash after commit persists item,
page, audit, and watermark together.

Frontier insert/state-update triggers maintain the five persistent run counters
inside the same SQLite statement/transaction. Validation independently derives
the counts and fails with `run_counter_mismatch`; it never silently repairs
drift during read-only status/validation.

## 6. Recovery rules

- `SIGINT`/`SIGTERM`: stop leasing, allow bounded active work to settle, requeue
  any lease owned by this process, mark the run `aborted`, close SQLite, release
  the crawler lock. A signal during export removes only that unpublished
  temporary generation and also leaves the run `aborted`.
- server/process crash: the lease expires; `--resume` first validates the
  database without writes, atomically returns expired leases to `queued`, then
  validates again. If a lease has not expired yet, resume fails without
  stealing or finalizing it; the operator retries after its recorded expiry.
- malformed legacy checkpoint: report it; do not modify it or other runtime data.
- corrupt state database: report `recovery_required`; do not recreate it.
- fingerprint mismatch: refuse resume with `recovery_required`. A new algorithm
  needs a new run, not mutation of the old run.
- incomplete JSONL export: the run-specific temporary export is removed by that
  failed export attempt; the spool and every previously published generation
  remain authoritative and unchanged.
- failed prefix: `--retry-failed` requeues `failed` rows after validation.
- blocked prefix: requires a reviewed algorithm/configuration change or explicit
  operator decision; it is not silently retried.

No recovery rule unlinks JSONL, legacy seen buckets, failed-prefix files,
checkpoint files, or the state database.

Operator runbook:

| Situation | Safe procedure | Never do automatically |
| --- | --- | --- |
| Process received SIGTERM/SIGINT | Confirm the run is `aborted`, confirm the lock is gone, run `node main.js --validate-crawl`, then `node main.js --resume`. | Do not delete state or JSONL. |
| Server rebooted/process disappeared | Confirm no crawler process is alive. Use `--status`; after the lease expiry use `--resume`, which requeues expired leases. | Do not edit frontier rows or remove item data. |
| State DB exists | Start with `--status` and `--validate-crawl`. Resume only when schema and fingerprint match. | Do not create a second DB over it. |
| Crawler lock remains | `--resume` verifies hostname, PID, and process-start token. It removes only a lock proven stale. | Do not remove a lock based on PID alone. |
| Legacy checkpoint is malformed | Preserve it and all legacy artifacts; v2 reports `legacy_checkpoint_detected`. Plan an explicit migration or archive after review. | Do not let v2 “start clean”. |
| V2 state DB fails validation | Stop. Preserve the DB, WAL, and SHM together; report `recovery_required` and take a filesystem-level copy before offline diagnosis. | Do not recreate or vacuum the DB. |
| JSONL export is incomplete | Ignore the uncommitted run-specific temporary file and re-export from the spool after state validation. | Do not treat the temporary file as import input. |
| Prefix is `blocked` | Inspect its reason and page audit. Change the algorithm only through a new fingerprint and shadow run. | Do not use `--retry-failed` to bypass it. |
| Prefix is `failed` | After the upstream fault is resolved, use `node main.js --retry-failed`; the failure audit remains. | Do not clear failure history. |
| Algorithm/search parameters changed | Start a new run with the new fingerprint and retain the old run read-only. | Do not resume old frontier rows with new semantics. |

## 7. Seen/file consistency

Variant A is selected. Raw normalized items are persisted directly in
`crawl_items` with `PRIMARY KEY (run_id, ident)`. Deduplication and durability
are a single SQLite operation in the page transaction. JSON is stored as UTF-8
text and validated at insertion boundaries.

The spool database is separate from `data/catalog.sqlite`. It has no `is_active`
or reconciliation behavior. It cannot deactivate serving-catalogue files.
After a validated terminal run, a run-specific JSONL is streamed in stable
`ORDER BY ident` order. That export is the only compatibility boundary with the
existing guarded import.

## 8. Failed-prefix retry model

Errors are classified:

- temporary: HTTP 429/500/502/503/504, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`,
  and transient socket errors;
- permanent: invalid request, unsupported query, or authentication failure after
  one credential refresh;
- blocked correctness: cap/saturation, repeated page, unstable total,
  non-advancing page, maximum-page guard, maximum depth, or unsupported
  partition.

Temporary failures are requeued with bounded exponential backoff and
`attempt_count`. Exhaustion moves the row to `failed`. Permanent failures move
directly to `failed`. Every transition appends a redacted `crawl_failures` row.
`--retry-failed` requeues only `failed`, clears no audit, and never touches
`blocked`.

## 9. Repeated-page detection

The page fingerprint is SHA-256 of the canonically sorted, length-delimited
ident multiset. Sorting makes it independent of non-contractual API ordering;
duplicate idents remain present and therefore change the fingerprint.
Before a page commit, the store checks:

- the same offset cannot have a different fingerprint;
- a non-empty fingerprint cannot already exist at another offset for the prefix;
- offset must advance by the previous committed item count;
- the configured maximum page count cannot be exceeded.

A violation blocks the prefix with `repeated_page`, `offset_not_advancing`, or
`max_pages_exceeded`. Empty pages share the empty fingerprint and are excluded
from cross-offset repetition checks.

## 10. Saturation detection

`total` is treated as required consistency evidence, not as an independently
trustworthy count. A prefix is not complete merely because processed rows reach
`total`.

It is blocked when any of these applies:

- a full page occurs at the configured server-result cap or maximum page count;
- the server repeats a non-empty page at a new offset;
- the next offset does not advance;
- `total` is missing, non-integral, negative, or below the observed row count;
- the API returns more rows than the requested page size;
- a short page arrives while `total` says more rows remain;
- reported totals change incompatibly within a prefix;
- a saturated query needs a split but the partition is not proven exhaustive;
- maximum depth is reached while the page remains saturated.

A short page (including empty) is local end-of-results evidence only when the
reported total is valid and equals the observed row count. It does not prove
that the configured set of queries covers Webshare.

## 11. Run completeness model

- `running`: workers may lease work.
- `complete`: all frontier rows are complete, validation passes, and the
  partition strategy is proven exhaustive.
- `complete_with_failures`: no queued/in-progress work remains, but one or more
  prefixes are failed.
- `incomplete`: blocked or otherwise unprocessed prefixes remain, or the query
  partition strategy is not proven exhaustive.
- `aborted`: controlled interruption; resume is possible after validation.
- `recovery_required`: database, run identity, fingerprint, or invariants are
  inconsistent; automatic resume is forbidden.

`reconciliation_safe` is true only for `complete` plus independently proven
partition completeness. For the current Webshare algorithm it is always false.

## 12. Lock model

The crawler lock namespace is `runtime/locks/crawler-v2.lock`. It is created
with `open(..., "wx")`, which maps to exclusive creation. The JSON payload has:

```text
pid, hostname, process_start_time, process_start_token, owner_nonce, run_id,
created_at
```

On Linux, the token is `/proc/<pid>/stat` field 22. On Windows it is the UTC
`Get-Process.StartTime` value queried through non-interactive PowerShell. If a
live process start time cannot be verified, lock recovery fails closed. A
matching hostname, live PID, owner nonce, and matching start token means the
lock is active. PID alone is never sufficient. A short-lived atomic acquisition
guard serializes stale-check/unlink/create so two conforming processes cannot
race stale recovery.

Malformed, remote-host, or unverifiable locks fail closed. A provably stale lock
may be recovered only by the explicit resume path; lock recovery is limited to
the crawler-v2 namespace. If the process dies during the very short acquisition
guard window, the guard itself remains and requires offline operator review; it
is never guessed stale recursively. Export/import keep their existing separate
locks.

## 13. Compatibility and migration

- Existing JSONL, seen buckets, failed-prefix JSON, checkpoint, exports, and
  serving database are read-only to v2.
- No automatic checkpoint migration exists in Phase B.
- The v2 state database does not replace `data/catalog.sqlite`.
- JSONL and its manifest are streamed into a new run/export-specific temporary
  directory, fsynced, then published together by one atomic directory rename.
  Existing generations and legacy `catalog-items.jsonl` are never overwritten.
- The directory rename is the publication commit point. Failure to fsync its
  parent afterwards is returned as an explicit durability warning, not
  misreported as an unpublished or partially published pair.
- The exported manifest uses schema 2 and carries `run_status`,
  `reconciliation_safe=false`, source fingerprint, byte size, and item count.
- Published generations are intentionally retained; Phase B has no automatic
  retention cleanup, so production capacity planning must include them.
- `scripts/import-catalog-jsonl.js` and `lib/catalog-exporter.js` remain unchanged.
- Direct spool-to-serving-database import is deferred.

CLI:

```text
node main.js --crawl
node main.js --resume
node main.js --retry-failed
node main.js --status
node main.js --validate-crawl
```

No-argument execution fails closed. It cannot enter the legacy crawler.
`--classify-only` remains available for the existing export-only flow.
Production cron must not be changed to `--crawl` until shadow validation is
approved.

## 14. Testing strategy

All tests use temporary directories and fixture transports; they never contact
Webshare. Fault hooks exist only as explicitly injected test dependencies at:

```text
after_prefix_lease
after_page_fetch
after_item_commit
before_prefix_complete
before_run_finalize
after_export_item
before_export_publish
```

Hooks require both `NODE_ENV=test` and the programmatic
`allowTestFaultInjection=true`; the production CLI exposes neither.

Coverage includes lease crash/recovery, both sides of item commit, duplicate
idents, malformed legacy state, corrupt SQLite, fingerprint mismatch,
repeated pages, result caps, maximum depth, retry classification/requeue,
blocked prefixes, controlled abort, concurrent locks, stale lock recovery,
complete/incomplete invariants, and proof that recovery does not delete legacy
artifacts.

A representative benchmark inserts at least 100,000 full normalized items in
100-item pages, includes page/commit indexes, representative failure rows, WAL,
SHM, JSONL, manifest, and export temporary space, and reports heap delta.
Runtime work remains O(items) on disk; JavaScript memory is O(page size +
worker count).

### Algorithm fingerprint inputs

The SHA-256 fingerprint uses canonical JSON with recursively sorted object keys.
Array order remains significant. It includes algorithm version, root
partitions, partition characters and proof flag, exact search endpoint, query
mode and wildcard suffix, category, sort, normalizer version, page size,
reported-result cap, maximum pages, maximum depth, page-fingerprint rule, and
completion rule. The Webshare transport consumes the same wildcard/category/
sort configuration, avoiding a documentation-only fingerprint.

### Lease heartbeat

While a Webshare request is pending, the owner renews its lease every
`min(5 seconds, leaseDuration/3)` with a 10 ms test floor. After the request it
renews once more before normalization and the synchronous page transaction.
SIGTERM stops new leasing but the heartbeat protects the in-flight request until
its result is committed or safely requeued. The shutdown controller also passes
an `AbortSignal` through Webshare login/search Axios requests; cancellation
requeues the owned prefix without recording a permanent search failure.

### Representative storage benchmark

The 2026-07-25 Windows benchmark used 100,000 anonymized full normalized items
averaging 677 JSON bytes, 1,001 pages/commits and 10 representative failure
rows. SQLite DB+WAL+SHM used 86,790,584 bytes; JSONL+manifest used 67,803,352
bytes; combined live storage was 154,593,936 bytes. Repeated runs processed
about 53,000–55,500 items/second with a 2.8–4.5 MB observed heap delta.
Linear capacity planning from this sample is approximately 2.47 GB for 1.6
million items, 7.73 GB for 5 million, and 15.46 GB for 10 million, before
filesystem overhead, backups, legacy exports, and multiple retained export
generations. Real filenames can move these estimates materially.

## 15. Rollout strategy

1. Review and commit Phase B without deployment.
2. Deploy code with v2 commands unused; do not alter cron.
3. Run `--status` and legacy-artifact detection only.
4. Create a tiny fixture/mocked smoke run outside production runtime.
5. Run a deliberately bounded shadow Webshare sample into a separate state path;
   verify leases, blocked saturation, abort/resume, JSONL fingerprint, and disk
   growth.
6. Compare shadow discoveries with the legacy catalogue. Do not import them.
7. Investigate a server-supported cursor or disjoint partition key. The observed
   search endpoint cannot currently prove full coverage.
8. Only after completeness evidence, update the algorithm fingerprint and repeat
   shadow validation.
9. Approve a production v2 crawl separately. Keep reconciliation disabled.
10. Approve JSONL import only after the final manifest and item counts pass.

### Empirical Webshare search evidence

Read-only probes were executed on 2026-07-25 from the Ubuntu host using the
existing credentials without printing them. No response body or runtime file was
persisted.

| Request | HTTP | reported total | returned | page fingerprint | observation |
| --- | ---: | ---: | ---: | --- | --- |
| `what=test*`, `limit=100`, `offset=0`, `sort=recent`, `category=video` | 200 | 1000 | 100 | `8cf04b4aeea1e7d51240` | only 4/100 names started with `test`; this is not starts-with partitioning |
| same, offset 900 | 200 | 1000 | 100 | `9c7110d69af902fdf127` | full nominal last page |
| same, offset 1000 | 200 | 1000 | 100 | `e9c05f531704a76b4e01` | data continues beyond reported total |
| same, offset 1100 | 200 | 1000 | 100 | `3cec324fd7d29a154807` | data continues beyond reported total |
| same, offset 2000 | 200 | 1000 | 0 | empty fingerprint | reported total still 1000 despite empty page |
| `what=a*`, limit 20, offset 0 | 200 | 1000 | 20 | `14dd806dcd98eca24199` | 0/20 names started with `a`; all contained `a` |
| `what=č*`, limit 20, offset 0 | 200 | 1000 | 20 | `91e87705f09c9693b408` | Unicode query is accepted; ASCII-only roots cannot cover query space |
| `what=.*`, `-*`, `_*`, space+`*`, `[*` | 200 | 0 | 0 | empty fingerprint | no leading-punctuation coverage can be inferred from these zero results |

Two immediate identical `test*` requests with limit 5 returned the same ordered
fingerprint, but `sort=recent` provides no contractual stability guarantee.
The observed XML schema exposed `status`, `total`, repeated `file`, and
`app_version`; it exposed no server cursor, stable snapshot ID, ident range, or
timestamp partition key. Therefore offset pagination and prefix strings cannot
currently establish global completeness.
