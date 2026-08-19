# B.46 best-effort daily discovery and weekly stale verification

B.46 deliberately separates two non-equivalent observations:

* `daily-best-effort` searches `category=video`, `sort=recent` with the
  deterministic literal query portfolio `a-z0-9`. It is a bounded candidate
  stream and is always reported as `coverage_declaration=BEST_EFFORT`.
* `weekly-stale` selects a deterministic rotating slice of active playable
  catalog files and checks their existence independently. A daily miss is
  never used as absence evidence.

The daily operation is additive-only. It may insert safely classified new
files, but it cannot reactivate, deactivate, or delete a file. Known idents
are resolved before classification so they do not repeat expensive processing.
Unclassifiable candidates are reported as quarantine decisions and are not
inserted into the catalog.

The weekly operation uses `/api/files_exist/` in bounded batches (default 50,
with a hard client limit of 50). A definitive missing result first becomes
`SUSPECT`; two definitive results on distinct verifier runs are required before
deactivation. Timeout, authentication, rate-limit, malformed, and provider
errors never count as missing.

The default weekly rotation uses 52 deterministic buckets and up to 25,000
checks per run. At the current catalog size this is approximately one full
verification cycle per year. The state sidecar is advanced only after a
successful accepted run. No-change runs do not create a public generation.

The runner still requires an explicit plan digest, backup, and publication
verification gate before a production write. A changed plan must go through the
existing static catalog build/validation/content-addressed publication workflow
before the maintenance state is advanced. The B.46 runner does not claim
complete discovery and must never use daily search absence for deletion.
