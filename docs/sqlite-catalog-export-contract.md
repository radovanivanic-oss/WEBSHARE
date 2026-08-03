# SQLite catalog export contract

The explicit SQLite exporter selects `files.is_active=1` in `ident ASC, id ASC`
order. It emits the historical crawler JSONL field set. SQLite fields supply identity,
names, media attributes and UI flags; unavailable Webshare transport fields are `null`.
One `ident` is required per output row; duplicate or malformed identities fail closed.
The manifest describes only successful export of the selected SQLite scope. It does not
claim Webshare enumeration completeness, publication, or reconciliation safety.
