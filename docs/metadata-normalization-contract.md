# Candidate metadata normalization contract

`files.normalized_name` is the production parser's normalized filename: the decoded
filename without its extension, with dot/underscore separators folded to spaces and
whitespace bounded. It is not a slug or catalog grouping key. The authoritative
generator is `parseMediaName(name, { extension }).normalizedName` in
`lib/media-name-parser.js`; both the catalog importer and Candidate Metadata use it.

`normalizedSlug` remains a separate parser output used for title/grouping matching
(`normalizedTitle` and match scoring). It must not be written into
`files.normalized_name`.

Candidate Metadata schema version 2 records the parser representation. Schema version
1 artifacts contain the former transport slug representation and are legacy evidence:
they are not reinterpreted and resume fails closed with `legacy metadata artifacts
require reprocessing`. Historical runtime roots, including B.22, remain immutable.
