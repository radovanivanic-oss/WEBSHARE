# B.46.7 daily discovery observation

`scripts/run-daily-discovery-observation.js` is a read-only observation command. It is deliberately separate from `scripts/run-daily-maintenance.js`, whose command surface includes the production apply path.

The B.46.7 observation contract is fixed to the B.46 best-effort portfolio: literal `a-z0-9`, category `video`, sort `recent`, page size 100, five pages per query, a bounded 180-request/18,000-record policy, B39 tombstone filtering, and `BEST_EFFORT` coverage. The contract fingerprint includes the runner and repository commit. A changed contract or deployed commit fails closed rather than mixing incompatible snapshots.

Each successful run creates a new timestamped directory beneath `runtime/daily-observation/`. The set files are sorted newline-delimited identifier sets with SHA-256 digests for raw unique identifiers, post-B39 identifiers, current-known identifiers, current-unknown identifiers, first-pass accepted identifiers, quarantined identifiers, deep-approved identifiers, and deep-rejected identifiers. Existing directories are never overwritten.

The runner opens SQLite read-only, validates quick-check, foreign keys, duplicate invariants, unclassified media, and B39 leakage, then checks the same invariants and file identity after discovery. It never imports, updates, deactivates, deletes, reconciles, publishes, switches a pointer, or advances production state. Empty, malformed, failed, concurrent, duplicate-day, and contract-mismatch observations are failed and are not counted as valid observations.

The series manifest requires seven valid observations. `scripts/analyze-daily-observation-series.js` can analyze an incomplete series for diagnostics and calculates adjacent set churn, lifetimes, disappearance/reappearance, stable-core thresholds, and hypothetical deep-approved persistence gates. It has no production apply path.

The intended systemd schedule is exactly once per day at 03:17 Europe/Bratislava. The unit is named `webshare-daily-observation.service`; it is not a maintenance or ingestion unit. The weekly stale verifier remains separate and disabled during this experiment.

