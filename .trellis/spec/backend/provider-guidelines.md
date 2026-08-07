# OpenAI-Compatible Provider Guidelines

## Scope

The MVP has one configured OpenAI-compatible provider. The adapter owns both
`/v1/models` discovery and streamed chat-completions behavior.

Evidence:

- MVP `prd.md` R1 and R6;
- MVP `design.md` sections 6, 7, 10, and 11.

## URL Construction

Normalize `AI_BASE_URL` once. Operators may supply an origin with or without a
trailing slash and with a single `/v1` suffix.

Forbidden:

- string concatenation independently in model and chat code;
- producing `/v1/v1/...`;
- logging full URLs that may contain sensitive query values.

Test a matrix of allowed base URL forms.

Implemented Phase D contract:

- `crates/server/src/provider.rs` owns a parsed `ProviderBaseUrl`; it accepts an
  HTTPS origin with optional trailing slash or one `/v1` suffix. Plain HTTP is
  accepted only for loopback test/development providers. Credentials, query,
  fragment, additional paths, control characters, repeated `/v1`, and
  surrounding whitespace are rejected without displaying the configured URL.
- The same `endpoint` method constructs `/v1/models` and is the required Phase E
  construction path for chat endpoints.
- `OpenAiProvider` uses Reqwest without default TLS, with rustls/platform
  verification, server-held bearer auth, configured whole-request/connect
  timeout, and a 1 MiB model response limit. Raw response bodies and full URLs
  are neither retained in typed errors nor logged.

## Model Catalog

- Fetch with server-held credentials.
- Treat model IDs as opaque.
- Ignore malformed individual rows, but fail a fully malformed or empty list.
- Collapse duplicate IDs and sort deterministically.
- Validate `AI_DEFAULT_MODEL` against the normalized catalog.
- Cache in memory for a short TTL.
- Serve a clearly marked stale cache after refresh failure when one exists.
- Never invent or silently substitute a model.

Historical conversations remain readable when a model disappears. New
generation and retry requests fail safely.

Phase D does not invent an empty-conversation database row. Existing
conversation detail reads return their stored model without consulting the
current catalog. The schema trigger already rejects model updates after the
first message. Phase E must call the reusable catalog availability validator
and persist conversation/model + user message + assistant placeholder +
generation atomically in the documented first-message transaction.

`crates/core/src/model.rs` owns `ModelCatalog`, normalized entries, exact model
availability validation, provider-facing `ModelCatalogProvider`, and stable safe
`ModelCatalogError` categories. `crates/server/src/provider.rs` alone owns the
upstream JSON DTO. IDs are trimmed at the untrusted provider boundary, reject
controls/empty/over-200-character values, process at most 10,000 rows from the
bounded response, deduplicate exactly, and sort lexically. Exact
application/default-model validation does not trim or substitute.

`crates/server/src/model_catalog.rs` owns a process-local TTL cache. The default
`MODEL_CACHE_TTL_SECS` is 60 and must be positive. Its async mutex intentionally
spans refresh I/O to collapse concurrent misses; it never spans SQLite work. An
explicit refresh bypasses a fresh entry. Failed refresh returns an existing
catalog with `stale=true` and stable `refresh_error` metadata; a refresh whose
new catalog omits the configured default is treated the same way, preserving
the last valid catalog. No entry is persisted and an invalid/missing default is
never cached as usable.

## Chat Stream

Phase E implements the provider-independent chat boundary in
`crates/core/src/provider.rs`: stable redacted generation errors, streamed delta
and terminal events, and newest-to-oldest bounded context selection restored to
chronological provider order. The OpenAI-compatible adapter in
`crates/server/src/provider.rs` reuses `ProviderBaseUrl::endpoint` for
`/v1/chat/completions`, sends `stream=true` with server-held bearer auth through
the existing rustls client, and incrementally decodes SSE across arbitrary byte
and UTF-8 boundaries. Raw upstream bodies are never included in typed errors or
public output.

- Build provider requests from bounded core conversation context.
- Decode upstream bytes incrementally; handle Unicode split across chunks.
- Normalize provider chunks into internal deltas before public SSE encoding.
- Do not forward raw upstream events or error bodies.
- Begin no automatic retry after the first output delta.
- Before the first delta, retry only if the policy is explicitly bounded and
  proven not to duplicate a paid generation.

## Error Taxonomy

Distinguish:

```text
unauthorized
rate_limited
timeout
unavailable
invalid_response
stream_interrupted
cancelled
```

Provider errors retain safe status/metadata internally but must redact raw
headers and bodies.

## Cancellation

The provider request is owned by the generation cancellation token. Cancellation
must drop the HTTP response stream and stop decoding promptly.

## Tests

Use a local deterministic fake provider for:

- model success, duplicates, empty/malformed data, 401, 429, timeout, 5xx;
- stream success, Unicode splits, malformed SSE, partial disconnect;
- never-ending stream and delayed cancellation;
- usage metadata present and absent.

