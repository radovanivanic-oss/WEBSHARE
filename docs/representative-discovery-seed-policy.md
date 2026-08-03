# Representative discovery seed policy (B.19C)

This policy is a preflight for a future, separately authorized discovery run. It does not claim complete enumeration and does not execute discovery.

An operator must explicitly supply one query. It is NFC-normalized, trimmed, whitespace-collapsed, lowercased, limited to 64 UTF-8 bytes, cannot contain control characters or `*`, and must be at least three characters. Any token in the denylist is rejected: `test`, `sample`, `demo`, `upload`, `video`, `file`. The manifest provenance must record policy version, normalized query, explicit supply, denylist check, wildcard rejection, and `enumeration_complete=false`.

## Conservative quality gate

Before `file_info` or import planning, stop unless all aggregate checks pass:

| Metric | Threshold |
| --- | ---: |
| Test-like content | at most 1% |
| Parser low confidence | at most 10% |
| Unsupported media | at most 5% |
| Valid video | at least 85% |

Discovery evaluates the in-memory search items with the existing parser and classifier, then persists only per-page and cumulative integer counters (`items_evaluated`, valid-video, test-like, parser-low-confidence, unsupported-media, and invalid-quality-input). Rates are derived from these counters. It persists parser, classifier, and query-policy versions plus at most five reason codes. Names, raw items, URLs, owners, and raw responses are never written. A legacy root without this evidence is `NOT_EVALUABLE` and fails closed; its historical counts are never inferred.

## Ranked representative candidates

These are catalog-derived seeds, not API results or completeness claims:

1. `2025` — recent release-year token with 29,931 playable catalog rows.
2. `2024` — second recent release-year token with 24,486 playable rows.
3. `dr house` — stable series title token; 5,071 playable catalog rows.
4. `akta x` — stable series title token; 3,316 playable catalog rows.
5. `teorie velkeho tresku` — stable series title token; 2,917 playable catalog rows.

Recommended later controlled seed: `2025`, because it is explicit, non-generic under this policy, recent, and independently attributable to a release-year cohort. A future bounded discovery must record the provenance object verbatim in its manifest before authentication.
