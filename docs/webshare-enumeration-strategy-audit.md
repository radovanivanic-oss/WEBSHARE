# B.4 – Webshare Enumeration Strategy Audit

## Scope and safety status

This document records the static evidence and the bounded probe design for
choosing a replacement for the invalid filename-prefix frontier. It does not
declare the Webshare public search endpoint complete and does not authorize a
production crawl, import, reconciliation, publication, or deactivation.

B.3.1 established:

```text
PREFIX_PARTITION_INVALID
```

The literal queries `0`, `test`, and `a` returned the same ordered samples as
their `*` variants, result names were not prefix-matched, and query result sets
could overlap. Prefix expansion therefore cannot prove a disjoint or complete
partition.

## Evidence classes

The conclusions below distinguish:

- **documented fact** – stated by the current public Webshare API reference;
- **project observation** – present in this repository or a bounded B.2/B.3.1
  artifact;
- **external implementation** – behavior in a pinned public source revision;
- **hypothesis** – requires the bounded B.4 API probe or provider confirmation.

Absence from public documentation is evidence that a feature is not
documented, not proof that a private or undocumented feature cannot exist.

## Current project implementation

### Endpoints

The production code currently knows these Webshare endpoints:

| Endpoint | Purpose | Authentication/use |
|---|---|---|
| `/api/salt/` | password salt | one step of login |
| `/api/login/` | WST acquisition | one step of login |
| `/api/search/` | public file search | WST is included by this project |
| `/api/file_link/` | stream URL resolution | WST and one ident |

The B.4 diagnostic additionally proposes one read-only `/api/file_info/`
request. The project has no global listing, cursor, created-time filter,
ident-range filter, or batch-detail transport.

### Search request and response

`fetchSearchPage` sends a URL-encoded POST form:

```text
what
limit
offset
sort
category
wst
```

The crawler algorithm fixes:

```text
category=video
sort=recent
pageSize=100
serverResultCap=1000
wildcardSuffix=*
```

The parsed project response contains only `total` and the `file[]` collection.
Normalization uses `ident`, `name`, `size`, and type/media fields. Search
results observed in B.3.1 did not contain a creation or upload timestamp.

The project treats `ident` as an opaque string and deduplicates by exact ident.
B.3.1 samples were ten-character mixed ASCII alphanumeric values. No code or
evidence decodes a timestamp or sequence from an ident.

### Ordering and pagination assumptions

The legacy crawler increments offset by 100 until a short or empty page. The
SQLite crawler derives the next offset from the last committed page count. It
blocks repeated pages, changing totals, offset fingerprint conflicts, and
unproven saturation, but these checks do not create a stable snapshot or a
tie-breaker.

`recent` is not accompanied by a returned timestamp, cursor, snapshot ID, or
secondary ident ordering. Concurrent uploads can therefore shift rows between
offset pages. A short-term repeated-page match is useful telemetry, not a
completeness proof.

### Sort suitability

| Search sort | Primary key evidence | Stability risk | Full crawl | Daily incremental |
|---|---|---|---|---|
| `recent` | undocumented internal recency | new uploads move every later offset; no returned timestamp/tie-breaker | unsuitable | bounded discovery only |
| `rating` | mutable vote-derived rank | votes can reorder old and new rows at any time | unsuitable | unsuitable |
| `largest` | file size is returned | size is non-unique; secondary ordering undocumented | unproven and capped | weak discovery value |
| `smallest` | file size is returned | size is non-unique; secondary ordering undocumented | unproven and capped | weak discovery value |

None provides the preferred `(stable key, unique ident tie-breaker)` contract.

## Public Webshare API documentation

Primary source: [Webshare Web API Reference](https://webshare.cz/apidoc/).

### Documented global search

The documented `/api/search/` arguments are:

```text
what
sort = recent | rating | largest | smallest
limit
offset
category = video | images | audio | docs | archives
```

Its documented file response fields are:

```text
ident
name
type
img
stripe
stripe_count
size
queued
positive_votes
negative_votes
password
```

The reference documents no cursor, continuation token, snapshot token,
creation/upload timestamp, created-time range, or ident range for search.
It does not document an empty-`what` global feed.

No other documented function is described as a global public newest feed.
`folder`, `files`, `uploads`, and `history` are scoped to a folder or the
authenticated user's own activity.

### Detail and existence

`/api/file_info/` is a single-ident detail endpoint. It documents name,
description, size, type, availability, `removed`, `removed_at`, and
`removal_reason`, but no created/upload timestamp.

`/api/file_exists/` checks one ident. `/api/files_exist/` accepts an ident
array and returns per-ident `exists` and `downloadable`. The documentation does
not state a maximum batch size, rate limit, or negative-result grace policy.

There is no documented batch file-detail endpoint.

### User-owned listings are not a global feed

`/api/files/` lists the authenticated user's files/folders and supports:

```text
sort_by = name | size | downloads | created
sort_order = asc | desc
include_removed
limit
offset
```

Its records include `created`, `removed`, and `removed_at`.

`/api/uploads/` likewise lists files uploaded by the authenticated user and
includes `uploaded`. Neither endpoint is documented as a global public file
feed, so neither can enumerate the catalogue owned by all Webshare users.

## External implementation audit

### CZCerberus/plugin.video.stream-cinema-2

Pinned source:
[webshare.py at 06045ed](https://github.com/CZCerberus/plugin.video.stream-cinema-2/blob/06045ed570f5f7aab8f64fb438150e1798e3ad10/resources/lib/providers/webshare.py).

The Webshare provider implements salt/login, `user_data`, and `file_link`.
It is a link resolver for idents obtained elsewhere. It contains no Webshare
search, listing, cursor, pagination, timestamp extraction, incremental
discovery, or deletion enumeration.

### Tomikrys/ymovie

Pinned source:
[Webshare.ts at 342fc15](https://github.com/Tomikrys/ymovie/blob/342fc15c868bfd07633feb737d7bb6c886593dd5/client/src/shared/api/Webshare.ts).

The client uses the same `/api/search/` endpoint with:

```text
sort=recent
limit=100
offset=page*100
category=video
```

It computes UI page count from `total`, calls `/api/file_info/` per selected
ident, and uses file-protection and file-link endpoints for playback. It has no
cursor, search timestamp, ident range, global feed, batch detail, incremental
checkpoint, or deleted-file sweep.

The two required external projects therefore provide no hidden enumeration
primitive beyond the API reference and this repository.

## Bounded B.4 probe design

The diagnostic is `scripts/audit-webshare-enumeration.js`. It must run only
after a reviewed commit, push, fast-forward Ubuntu deployment, and a fully
passing Ubuntu test suite.

The proposed one-shot command uses:

```text
query=test
page size=20
concurrency=1
timeout=15 seconds/request
total request hard limit=12
```

Request allocation:

```text
1 salt
1 login
5 recent searches at offsets 0, 100, 900, 1000, 1100
1 repeated recent search at offset 0
3 searches at offset 0: rating, largest, smallest
1 file_info request for an ident from the bounded sample
```

The tool sends the query literally, adds no wildcard, performs no retry loop,
and writes only:

```text
/tmp/webshare-enumeration-audit-<timestamp>/
  report.json
  report.md
  sanitized.log
```

It persists at most 20 bounded item samples per page and at most 64 response
field names. Raw response bodies, credentials, WST, authorization headers,
imports, crawler state, and catalogue data are not persisted.

### Probe interpretation

- Non-empty pages at offsets 1000/1100 would show that `total=1000` is at
  least partly a reporting cap. They would not prove unbounded pagination.
- Empty pages at and beyond 1000 would be consistent with a hard result cap.
- Equal repeated offset-0 fingerprints show only short-term stability.
- Different repeated fingerprints prove a moving result window.
- Cross-offset overlap quantifies duplicates caused by movement/ranking.
- Alternate sorts are useful for behavior comparison, but none is a proven
  monotonic enumeration key without a returned key and deterministic
  tie-breaker.
- A file-info timestamp would be new observed behavior; its absence is
  consistent with the public reference.

## Ident and timestamp assessment

Under current evidence, ident is opaque:

- mixed alphanumeric form is compatible with random/base-N identifiers;
- it is not proven numeric, ordered, or time-derived;
- lexicographic ordering is not documented;
- no `after`, `before`, `greater_than`, or ident range filter is documented.

An ID-range crawler would therefore be speculative and is rejected.

Search has no timestamp. `file_info` documents no upload timestamp. A
per-ident detail call would cost at least 1.6 million requests for the existing
catalogue even if it did expose a timestamp, so it would be unsuitable for
historical enrichment without a batch primitive. User-owned `files/uploads`
timestamps do not solve global discovery.

## Deleted-file strategy

Discovery and deletion must remain separate.

Recommended existence pipeline:

1. select a bounded batch of existing local idents;
2. call documented `files_exist` in a conservatively sized batch;
3. record `exists/downloadable`, observation time, and transport confidence;
4. treat transport/API ambiguity as unknown, never absent;
5. require repeated negative confirmations separated by a grace period;
6. optionally confirm ambiguous records with `file_info?maybe_removed=1`;
7. produce tombstone candidates for review;
8. deactivate only through the existing reconciliation consent gates.

For approximately 1.6 million current idents, a batch size `B` costs
`ceil(1,600,000 / B)` API requests per complete sweep. Illustratively, `B=100`
is about 16,000 requests and `B=1000` about 1,600. Because Webshare documents
neither a maximum batch size nor rate limits for `files_exist`, B.5 must first
measure a conservative batch size and must spread any sweep across bounded
runs.

Useful supplements are lazy verification during playback, targeted verification
after an explicit API not-found, and a periodic bounded sweep. Absence from any
search result is never deletion evidence.

## Candidate strategies

### Variant A – Stable newest-feed incremental

This would be preferred if Webshare exposed a stable global newest feed with a
cursor or `(uploaded_at, ident)` ordering. No such public endpoint is currently
documented or observed. `search?sort=recent` alone does not satisfy the
conditions.

### Variant B – Offset crawl with overlap windows

If B.4 proves that offsets beyond 1000 return results and repeated pages are
short-term stable, a daily bounded recent-window reader can discover some new
items:

- always rescan an overlap window;
- deduplicate by ident;
- record ordered page fingerprints and observed time;
- stop at an explicit page/request limit;
- never mark the result complete;
- never derive deletion from absence.

This cannot guarantee the complete historical catalogue or all newly uploaded
files during high churn.

### Variant C – External seed/index source

An authorized external source may provide idents, while Webshare provides
detail/existence validation. Completeness, licensing, provenance, availability,
and source checkpoint semantics must be independently established.

### Variant D – Hybrid discovery

Preserve the current local SQLite catalogue as the historical authority.
Combine:

- one or more explicitly non-authoritative discovery feeds;
- ident-based normalization and deduplication;
- optional detail enrichment for newly discovered items;
- independent `files_exist` verification;
- conservative tombstone policy;
- guarded export/publication.

This is the recommended architecture under current evidence.

### Variant E – Full catalogue impossible with the public endpoint

If the bounded offset probe confirms a hard cap or unstable moving pages and no
authorized external source exists, a complete public-API enumeration must be
declared unavailable. The application can still maintain the existing
catalogue and perform bounded opportunistic discovery and existence checks
without claiming completeness.

## Provisional scoring

For quality properties, HIGH is better. For request cost, complexity, and
undocumented dependency, LOW is better.

| Variant | Completeness guarantee | Incremental reliability | Deletion handling | Request cost | Complexity | Recoverability | Determinism | Production safety | Undocumented dependency |
|---|---|---|---|---|---|---|---|---|---|
| A newest feed, current evidence | LOW | LOW | LOW | LOW | MEDIUM | MEDIUM | LOW | HIGH | HIGH |
| B offset overlap | LOW | MEDIUM | LOW | MEDIUM | MEDIUM | HIGH | LOW | HIGH | MEDIUM |
| C external seed | MEDIUM | MEDIUM | LOW | MEDIUM | HIGH | HIGH | MEDIUM | HIGH | HIGH |
| D hybrid | MEDIUM | MEDIUM | HIGH | MEDIUM | HIGH | HIGH | MEDIUM | HIGH | LOW |
| E acknowledge no full enumeration | LOW | LOW | MEDIUM | LOW | LOW | HIGH | HIGH | HIGH | LOW |

Provisional selection:

```text
recommended: D – hybrid discovery and independent existence verification
fallback:    E – explicitly no full-catalogue guarantee
conditional: B – bounded recent discovery only, subject to offset probe
conditional: C – only with an authorized and auditable seed source
rejected:    filename-prefix partitioning and speculative ident ranges
```

## Required architecture boundary

SQLite remains the application's authoritative state. A future implementation
must keep these stages separate:

```text
discovery observations
→ normalization
→ ident deduplication
→ optional detail enrichment
→ independent existence verification
→ grace/confirmation-based deactivation policy
→ guarded export/publication
```

Each discovery source needs its own durable checkpoint and evidence class.
Search observations may add or refresh items but may not directly deactivate
an item or set a full/reconciliation-safe manifest.

## Proposed next milestone

After reviewing the real B.4 probe, define **B.5 – Isolated Incremental
Discovery Prototype**:

- shadow-only discovery ledger separate from the prefix frontier;
- one bounded recent-offset source adapter if B.4 supports it;
- explicit overlap window and ordered fingerprint drift detection;
- source-specific checkpoints that never claim completeness;
- batch `files_exist` fixture adapter and negative-confirmation ledger;
- no import, deactivation, publication, or production cron;
- deterministic replay tests and a comparison report against the local
  authoritative SQLite catalogue.

If B.4 shows a hard 1000-result cap with moving pages, B.5 should instead be
limited to external-seed feasibility and batch existence verification.
