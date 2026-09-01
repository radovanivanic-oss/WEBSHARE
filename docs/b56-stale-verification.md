# B56 stale verification read-only pilot

B56 separates existence evidence from production mutation. It never updates a
`files` row, deactivates a source, deletes data, publishes a catalog, or
advances a public pointer.

## Contract

The contract is `webshare-stale-verification/v1`. The 52-bucket contract is
`webshare-stale-buckets/v1`; bucket assignment is

```text
parseInt(SHA256(ident)[0:8], 16) % 52
```

The weekly bucket is `(ISO week number - 1) % 52`, using the
`Europe/Bratislava` calendar. Every active, playable, Webshare-backed file
with a valid ident is assigned exactly once. Current B56 production rows are
about 22.7 thousand per bucket and the default request batch is 50.

The stale result taxonomy is `webshare-stale-result/v1`:

* `PRESENT` is a complete item-level positive answer;
* `DEFINITIVE_MISSING` is a complete item-level negative answer from a valid
  `files_exist` response;
* `TRANSIENT_FAILURE` is an exhausted transport/rate/server failure;
* `INVALID_RESPONSE` is a malformed, partial, contradictory, or unsupported
  response;
* `NOT_CHECKED` is reserved for identifiers not reached by a bounded run.

No request-level failure becomes a missing answer.

## Lifecycle

The ledger is rebuilt from immutable B56 result artifacts, not from a mutable
streak sidecar. Only independent calendar dates count. A first definitive
missing date is `SUSPECT`; a second independent definitive missing date is
`WOULD_DEACTIVATE`. Retries in one run and duplicate runs on one calendar date
do not add strikes. A later `PRESENT` clears the active stale progression,
while the old evidence remains in its immutable run artifact.

## Commands

Run one read-only production bucket:

```text
npm run stale:run -- --run-id b56-YYYYMMDDTHHMMSSZ
```

Inspect the concise operator status:

```text
npm run stale:status
```

Run isolated lifecycle examples:

```text
npm run stale:demo
```

Artifacts are written under `runtime/stale-verification/<run-id>/`:
`run.json`, `bucket-input.json`, `request-log.json`, `results.json`,
`stale-ledger.json`, `lifecycle-preview.json`, `would-deactivate.json`, and
`artifact-index.json`. Artifact fields contain no credentials, WST, cookies,
authorization headers, or raw provider bodies.

The verifier serializes with the existing maintenance lock, so it cannot run
beside an additive maintenance apply or publication freeze. Daily discovery
has its own read-only observation lock and is not a stale mutation. A future
mutating stale operation must use the same shared mutation lock and a separate
explicit authorization boundary.

## B56 boundary and future work

The weekly scheduler remains disabled. B56 does not run a 52-week sweep, does
not call a deactivation SQL path, and does not publish. A later deactivation
milestone must separately review last-active variants, media visibility, FTS,
episode ownership, rollback, and explicit publication consequences.
