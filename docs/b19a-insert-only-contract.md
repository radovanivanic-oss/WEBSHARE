# B.19A insert-only contract

The production `scripts/import-catalog-jsonl.js` path is an UPSERT workflow: it upserts candidates, media, and `files`, then rebuilds derived catalog state.  It is not an acceptable implementation for the first controlled import.

The future B.20 importer must use one transaction containing only `INSERT INTO files` with these columns and named parameters, in this exact order:

`ident, original_name, normalized_name, extension, mime, size_bytes, webshare_category, placeholder_url, first_seen_at, last_seen_at, last_seen_run_id, is_active, is_playable_video, candidate_id, media_id, parsed_title, parsed_year, parsed_season, parsed_episode, parsed_resolution, parsed_source, parsed_video_codec, parsed_audio_codec, parsed_hdr, parsed_dolby_vision, parsed_languages_json, parsed_has_dubbing, parsed_has_subtitles, parsed_release_group, parse_confidence, parse_reason, parse_version, img, stripe, stripe_count, queued, positive_votes, negative_votes, password_protected, raw_json, created_at, updated_at`.

Parameters are the same names prefixed with `@`.  A conflict, missing required value, source digest mismatch, or row-count mismatch must abort the transaction and roll back every row.  `UPDATE`, `UPSERT`, `REPLACE`, and `DELETE` are prohibited.

## Field-source matrix

| Field(s) | Database column(s) | Contract | Authoritative source |
| --- | --- | --- | --- |
| Identity and observed metadata | `ident`, `original_name`, `extension`, `mime`, `size_bytes`, `webshare_category`, `first_seen_at`, `last_seen_at`, `raw_json` | `ident`, names, size, seen times, parser version and raw projection are required; MIME/category nullable | `B18_METADATA` |
| Canonical name | `normalized_name` | required; B.18's transport normalization is retained only as evidence, while the database value must match the existing parser | `DETERMINISTIC_PARSER` |
| Parsed media values | `parsed_title`, `parsed_year`, `parsed_season`, `parsed_episode`, `parsed_resolution`, `parsed_source`, `parsed_video_codec`, `parsed_audio_codec`, `parsed_hdr`, `parsed_dolby_vision`, `parsed_languages_json`, `parsed_has_dubbing`, `parsed_has_subtitles`, `parsed_release_group`, `parse_confidence`, `parse_reason`, `parse_version` | nullable except `parsed_languages_json`, confidence and version; parser must be consistent | `DETERMINISTIC_PARSER` |
| Playability | `is_playable_video` | required, default `0`; must be parser-derived for reviewed input | `DETERMINISTIC_PARSER` |
| Existing safe defaults | `is_active`, `placeholder_url`, `last_seen_run_id`, `img`, `stripe`, `stripe_count`, `queued`, `positive_votes`, `negative_votes`, `password_protected` | required defaults where defined; nullable values remain `NULL` | `SCHEMA_DEFAULT` |
| Import-owned timestamps | `created_at`, `updated_at` | required; only the future importer may create these | `IMPORT_TIMESTAMP` |
| Catalog relations | `candidate_id`, `media_id` | nullable in schema, but linkage evidence is required before a candidate is import-ready | `CATALOG_LOOKUP` or `UNAVAILABLE` |

No source class may be guessed.  In particular, B.18 has no approved download URL, so `placeholder_url` is `NULL`; B.19A never constructs `webshare://` values.  There is no schema default for catalog relations, so an unresolved required linkage remains unavailable and is reviewed rather than fabricated.
