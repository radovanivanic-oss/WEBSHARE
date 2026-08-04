# Production publication operations

Publication is a controlled, manual workflow. Each run begins with a read-only SQLite snapshot, a validated staging export, a B.30A candidate bundle, and a release audit. A new immutable generation is copied by `scripts/publish-catalog-generation.js` into `catalog-publications`; `current.json` is changed only through the atomic activator after fresh resolver and hash checks.

Verification uses:

```text
node scripts/verify-production-publication.js --publication-root <repo>/catalog-publications --database <repo>/data/catalog.sqlite --staging-jsonl <repo>/runtime/sqlite-export-.../catalog-from-sqlite.jsonl --staging-manifest <repo>/runtime/sqlite-export-.../catalog-from-sqlite.manifest.json --output-dir <repo>/runtime/production-verification-b31-<UTC>
node scripts/check-publication-health.js --publication-root <repo>/catalog-publications --mode FAST
node scripts/check-publication-health.js --publication-root <repo>/catalog-publications --mode FULL
```

FAST checks pointer, manifest, identity, size, temporary files, and locks. FULL additionally streams the payload hash and performs the SQLite comparison when run through the verifier. Failed generations and audit roots are retained; generations are never reused or deleted. Rollback restores the previous pointer bytes atomically, or restores pointer absence for the first publication.

Future updates remain manually authorized controlled batches: discovery, files-exist, metadata, review, SQLite import, export validation, candidate/release audit, generation activation, and only later reconciliation. Do not schedule crawler or publication automation until repeated operational audits establish a separate authorization and monitoring milestone.
