# B50 anonymous Webshare search audit

B50 audited the discovery transport only. It did not open SQLite, apply a
persistence plan, publish a catalog, mutate `AG_repo`, or change a scheduler.

## Finding

The Webshare search endpoint accepts the B47 discovery request without a WST:

```text
POST https://webshare.cz/api/search/
what=<literal>&limit=100&offset=<page offset>&sort=recent&category=video
```

The authenticated comparison used the same endpoint and fields plus the
authenticated form field `wst`. The public Webshare API reference documents
the five non-authenticated search fields and does not document WST as a
search argument.

The bounded live audit used 8 representative literals (`a`, `e`, `m`, `q`,
`z`, `0`, `5`, `9`) across five pages and then the complete 36-literal B47
portfolio at page 1. It performed 152 search requests: 76 anonymous and 76
authenticated. It used 8 authentication requests to establish four separate
comparison sessions. All 160 requests succeeded, with no retries, 429s, or
other errors.

Across the 40 five-page pairs and 36 full-portfolio page-1 pairs:

- ordered identifier equality: 100%;
- unordered identifier equality: 100%;
- Jaccard: 1.000 for every pair;
- anonymous-only and authenticated-only identifiers: 0;
- rank displacement: 0;
- metadata fingerprint differences: 0;
- paging/depth divergence: 0.

The short-interval anonymous/authenticated/anonymous/authenticated sequence
for `a` also produced identical results in both modes. This separates the
measured authentication effect (none) from the known longer-term rotating
historical reservoir behavior.

## Compatibility decision

Removing login from discovery is a transport/implementation change, not a
discovery semantic change. The semantic contract projection remains:

```text
d8069a78dd25ebb424610e2db6db85e7661731050952df85fe1d21846952f70f
```

The implementation identity is now `b50-anonymous-discovery-v1@<commit>` and
the full contract records `discovery_authentication_mode: anonymous`. The
existing B46.7/B47 observations remain semantically compatible because their
query portfolio, category, sort, pagination, depth, B39 policy, classifier,
deep-audit policy, and read-only state semantics are unchanged.

The daily observer now uses a dedicated anonymous search function. The
authenticated `WebshareSession` and login functions remain available for
file-existence, file-info, and playback-related operations that require
account state.

## Evidence

The complete reports are retained under:

```text
runtime/b50-anonymous-search/20260901T095000Z/
runtime/b50-anonymous-search/20260901T095500Z-group1/
runtime/b50-anonymous-search/20260901T095500Z-group2/
runtime/b50-anonymous-search/20260901T095500Z-group3/
```

The post-refactor read-only diagnostic observation is retained under:

```text
runtime/daily-observation/20260901T094334Z-diagnostic-2431867/
```

It completed with 140 anonymous search requests, zero authentication
requests, unchanged database identity before/after, and all mutation flags
false. It did not advance the observation series.

This result approves anonymous discovery for the daily observation workflow;
it does not turn the rotating search reservoir into a chronological feed and
does not authorize automatic persistence apply or publication.
