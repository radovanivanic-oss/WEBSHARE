# B47 hybrid persistence-gated controlled apply pilot

B47 treats the Webshare search portfolio as a rotating historical reservoir. A daily observation is read-only evidence; its first-seen time is never interpreted as an upload time.

## Pipeline

Successful immutable observations are validated against an explicit semantic contract. The semantic contract covers the query portfolio, category, sort, page size, page depth, request/discovery bounds, B39 filtering semantics, classifier policy, deep-audit policy, and the non-mutating safety mode. The implementation build and diagnostic/retry policy are recorded separately, so diagnostic-only implementation changes do not invalidate compatible historical evidence.

The persistence ledger is rebuilt from the successful observation manifests, set files, classification JSONL, freeze/audit artifacts, the validated B39 sidecar, and a read-only production snapshot. It records raw observation dates, accepted observation dates, recurrence, classification and parser evidence, deep-audit evidence, tombstone state, production-known state, and a conservative derived state:

- OBSERVED: observed but not accepted by the lightweight classifier.
- PENDING: accepted on one or two independent observation dates.
- ELIGIBLE: accepted on at least three independent dates, not known, not tombstoned, deep-approved, supported, and conflict-free.
- REJECTED: deep-audit, classification, grouping, or safety failure.
- TOMBSTONED: present in the B39 purge sidecar; permanently excluded.
- ALREADY_KNOWN: present in the production database.
- APPLIED: reserved for a future state that is provable from a B47 apply result; the current snapshot never infers it.

The report command writes ledger.json, eligibility.json, pilot-plan.json, and summary.json beneath runtime/b47-persistence/<run>. These artifacts include source digests, the production baseline fingerprint, B39 digest, deep-audit policy, semantic contract, tool identity, and deterministic candidate-set digests.

## Controlled plan and apply boundary

npm run persistence:report is always a dry-run and produces no database, state, file, or publication mutation. The pilot is ranked by accepted recurrence, consecutive recurrence, deep-audit evidence, then identifier, and is capped at 500 candidates. The hard existing safety threshold remains 1,000; it is not raised.

npm run persistence:apply -- --plan PATH validates the plan only. Production mutation requires the separately explicit --apply --confirm-production-apply flags and a new backup path. The apply path rechecks the source ledger and all digests, exact production baseline, SQLite health, B39 exclusion, deep audit, current-known state, and candidate safety before delegating to the existing atomic additive importer. It performs no deactivation, deletion, reconciliation, state advance, or publication. This milestone does not invoke that path.

## Failure observability

Future observation failures store sanitized request metadata: phase, endpoint name, safe query literal, page/offset/limit, sort/category, request ordinal, HTTP status, Axios/provider-safe code, sanitized message, attempt, authentication state, elapsed time, retry decision, and final failure reason. Secrets, WST, passwords, cookies, authorization headers, tokens, and signed URLs are not stored.

Only timeouts, network resets, selected 5xx errors, and bounded 429 handling may retry, with at most two search attempts per logical request and every attempt counted against the observation request budget. Deterministic malformed or ambiguous 4xx failures are fail-closed.
