# Catalog publication readiness policy

This is an offline, fail-closed policy. It does not publish catalog data.

Evidence is `PROVEN` only for executable code or deployment configuration. Static references alone are `PARTIAL_EVIDENCE`. Unknown consumer, null-URL, ordering, manifest, or atomic-replacement behavior blocks publication.

Precedence is: failed core/source immutability; data loss; divergent duplicates; schema; manifest; null transport; ordering; atomic replacement; unknown consumer contract. Only positively proven compatible evidence can return `READY_FOR_ATOMIC_PUBLICATION`. B.28 must still execute the core and compatibility tools against immutable production inputs before any future publication decision.
