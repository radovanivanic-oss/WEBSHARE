# B.41 classified metadata completeness backfill

The B.41 audit is read-only. It measures canonical `movie` rows in category
`movies` and canonical `tv` rows in category `series`; episode rows are not
included in completeness statistics.

Only a persisted `external_source=tmdb`, numeric `external_id`,
`metadata_status=matched`, and `metadata_confidence >= 0.8` qualifies for
automatic provider lookup. The lookup uses the exact TMDb ID and the existing
`TmdbClient` language fallback (`sk-SK`, `cs-CZ`, `en-US`). It never performs
title search and never opens SQLite writable.

Example local/read-only audit:

```text
node scripts/audit-classified-metadata-backfill.js \
  --database /path/to/catalog.sqlite \
  --output-dir runtime/b41-audit \
  --provider tmdb \
  --mode candidate-audit \
  --max-provider-requests 0 \
  --dry-run
```

Bounded live sampling additionally requires a protected `TMDB_API_KEY` in the
environment and writes only sanitized artifacts plus a versioned file cache:

```text
node scripts/audit-classified-metadata-backfill.js \
  --database /path/to/catalog.sqlite \
  --output-dir runtime/b41-live-sample \
  --provider tmdb \
  --mode live-sample \
  --limit 200 \
  --max-provider-requests 400 \
  --cache-dir runtime/b41-live-sample/provider-cache \
  --dry-run
```

The provider cache and checkpoint contain no API key. `--resume` validates the
sample selection and configuration before continuing. The generated
`metadata-migration-plan.json` is evidence for later review only. It is not a
production write instruction, and no B.41 command writes media metadata,
provider IDs, classifications, or the public static generation.

Field policy is fill-missing-only: overview, poster, backdrop, genres,
release date, and original title are independent fields. Existing non-empty
values are preserved. A provider conflict or malformed response is rejected.
