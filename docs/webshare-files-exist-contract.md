# Webshare `file_exists` contract

Verified 2026-07-31 against the official Webshare API reference:
<https://webshare.cz/apidoc/> (`file_exists(string ident)`).

- Endpoint: `POST https://webshare.cz/api/file_exists/`
- Request encoding: `application/x-www-form-urlencoded; charset=UTF-8`
- Request field: `ident` (one identifier per request)
- The authenticated session adapter also supplies its current `wst` session field; credentials and tokens are never persisted.
- Response: XML `<response>` with exactly one `<status>` and `<exists>` field.
- `<status>OK</status><exists>1</exists>` maps to `exists: true`.
- `<status>OK</status><exists>0</exists>` maps to `exists: false`.
- Missing, contradictory, malformed, oversized, or unsupported responses fail closed.
- HTTP/network failures are normalized to bounded transport errors; timeout, network, rate-limit, and server failures are retryable, but this adapter performs no retries.
- Authentication and transport request accounting remains explicit through the existing session/request-meter boundary.

The endpoint is single-ident. Batching is not used. The adapter does not retain raw response bodies or unrelated file metadata.

These facts are documentation-verified; no production probe was required.
