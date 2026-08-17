# B.32 media entity resolution

The catalog distinguishes a canonical `media` entity from Webshare `files`.
`files.media_id` is the only file ownership relation consumed by the API; a
movie row is therefore an entity and its playable files are variants.

## Resolution policy

The dry-run resolver in `lib/media-entity-resolver.js` is deliberately
fail-closed:

1. Same trusted provider, external ID, and compatible media type is
   `PROVEN_SAME_MOVIE`.
2. A local movie row with the same year whose title tokens match the trusted
   canonical title, original title, or aliases, with only technical/release
   tokens left over, is `STRONG_SAME_MOVIE`.
3. Matching title/year without trusted metadata, filename similarity, missing
   year, and conflicting metadata are `AMBIGUOUS`.
4. Conflicting trusted IDs or media types are `PROVEN_DIFFERENT_MOVIE`.

Same title/year is never sufficient by itself. This protects remakes,
sequels, shorts, documentaries, concerts, TV rows, and incorrect filename
years. Technical fields remain on each file and are never copied to the
canonical entity.

## Canonical selection

Among rows in a candidate group, the deterministic survivor is selected by
trusted external identity, matched metadata, metadata confidence, poster,
overview, release date, and finally stable numeric ID. Filename order, SQLite
insertion order, and Webshare ident are not identity evidence.

## Dry run

The following command opens SQLite with `readonly=true` and
`fileMustExist=true`. It does not migrate, checkpoint WAL, or write SQLite:

```text
npm run media:audit -- --database PATH --report PATH
```

The report contains aggregate quality counts, bounded title/year groups, a
dedicated Inception report, proposed survivor, file reassignments, evidence,
rejections, and before/after counts. There is intentionally no apply flag in
this milestone; production reassignment remains an explicit authorization
boundary.

## API contract after reassignment

No API or Kodi redesign is required. Once an authorized migration updates
`files.media_id` and rebuilds derived visibility/FTS state, the existing
repository exposes one canonical movie from `/api/media`, canonical metadata
from `/api/media/:id`, and all active playable variants from
`/api/media/:id/files`. Search uses the same entity rows and therefore does
not need UI deduplication.
