# B.45.1 rolling recent-snapshot sentinel

B.45.1 adds a sentinel state machine to the existing daily-maintenance code. It
does not create a second crawler or alter the catalog schema.

The supported state transitions are:

```text
UNINITIALIZED -> BASELINE_CAPTURED -> ACTIVE
```

A baseline is an immutable, bounded observation only. It produces no catalog
delta. A later run can become `ACTIVE` only when the same provider query
contract re-encounters a distributed overlap with the prior sentinel window.
The default overlap gate requires at least 10 known identifiers, at least 10%
of the prior sentinel set, and overlap on at least two pages. Page expansion is
bounded by the request, page, and item capacities in `DEFAULT_POLICY`.

The current Webshare API does not satisfy the required provider contract. Live
tests showed that filename-prefix searches are fuzzy rather than partitions,
`what` empty/`*` searches return no global feed, and `sort=recent` exposes no
cursor or timestamp. Consequently the normal runner defaults to the rolling
snapshot adapter, but it remains fail-closed with
`NON_GLOBAL_QUERY_CONTRACT` or `SENTINEL_UNREACHABLE` until a genuine global
provider query is available.

The legacy prefix adapter remains available only with explicit
`--discovery-mode prefix`; it is diagnostic/compatibility behavior and must not
be used to authorize production advancement under the current evidence.

Example diagnostic baseline command:

```text
node scripts/run-daily-maintenance.js --database data/catalog.sqlite --output-dir runtime/daily-maintenance-<id> --discovery-mode rolling-snapshot --recent-query <query> --capture-baseline
```

The command may persist only the sidecar state when a non-empty baseline is
captured. It never writes `catalog.sqlite`, publishes a generation, or switches
`current.json`.
