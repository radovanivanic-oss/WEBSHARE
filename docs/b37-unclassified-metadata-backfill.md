# B.37 unclassified metadata backfill

The B.37 enrichment layer is deliberately read-only. It separates three future
operations:

1. **Identity match** — provider, external ID, provider type, score and evidence
   digest are reviewed without changing SQLite.
2. **Metadata enrichment** — canonical metadata and aliases are written only by
   an explicitly authorized, audited migration after identity review.
3. **Classification** — primary type and secondary tags are derived from the
   trusted identity and provider details; documentary and anime remain secondary
   tags unless the catalog taxonomy is explicitly extended.

The audit harness uses bounded batches and file-backed provider cache entries
keyed by provider/version/request digest. Its state machine is:

`PENDING → SEARCHED → MATCHED | AMBIGUOUS | NO_MATCH | RETRY_LATER | FAILED`

`--resume` requires the original checkpoint, policy version, database identity,
batch configuration and result count to match. It advances only to the stored
`next_offset`; it never rewrites SQLite and never repeats an accepted batch.

Only `PROVEN` and `HIGH` matches can enter a future reviewed migration plan.
Close candidates, conflicting years/types, keyword-only signals and provider
errors remain non-actionable. The harness never persists API keys, URLs with
credentials, raw provider responses, or catalog writes.
