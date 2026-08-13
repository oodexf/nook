# Backend Error Handling

## Error Layers

Errors are translated once at each boundary:

```text
Provider / SQLite / config error
            ↓
typed adapter error
            ↓
core application error
            ↓
public API error or terminal SSE event
```

Evidence:

- MVP `design.md` sections 4, 9, 10, and 16.

## Required Types

Use distinct error enums for:

- configuration/startup;
- authentication/session;
- provider model catalog;
- provider generation stream;
- repository/storage;
- application/domain;
- public API.

Use `thiserror` or an equivalent derived error mechanism for typed causes.
Preserve source errors internally, but never serialize their raw display text to
the browser.

Do not use string matching to decide status codes or recovery actions.

## Stable Public Errors

Every JSON error has:

```json
{
  "error": {
    "code": "model_unavailable",
    "message": "The selected model is no longer available.",
    "request_id": "opaque-id"
  }
}
```

- `code` is stable and machine-readable.
- `message` is safe for direct display.
- `request_id` connects the user-visible error to logs.
- One HTTP boundary generates the ID once per request; the response
  `X-Request-ID` header, JSON error field, and request completion log reuse it.
- Health bodies remain minimal; their request ID exists only in the response
  header and contains no request-derived data.
- Internal causes, paths, SQL, cookies, tokens, and upstream bodies are omitted.

SSE terminal errors use the same public code/message semantics.

The model-catalog mapping is executable in `crates/core/src/model.rs` and
`crates/server/src/models.rs`: upstream 401/403 map to
`model_provider_unauthorized`/502, 429 to `model_provider_rate_limited`/429,
timeout to `model_provider_timeout`/504, transport and 5xx to
`model_provider_unavailable`/503, and malformed or empty usable catalogs to a
stable 422 configuration/provider response. `model_default_missing` is also a
blocking authenticated 422 response. When a stale catalog exists, refresh
failures remain HTTP 200 catalog responses with explicit `stale=true` and safe
`refresh_error`; this is data plus degradation metadata, not an error-shaped
success body.

## HTTP Mapping

Use consistent categories:

```text
400 invalid payload or validation
401 missing/invalid session
403 Origin or CSRF rejection
404 absent resource
409 state conflict, model_mismatch, generation_in_progress, or model_unavailable
413 bounded input exceeded
429 application or provider rate limit
502 malformed/invalid provider response
503 unavailable storage or provider
504 provider timeout
500 unexpected internal failure
```

Do not return `200` with an error-shaped JSON body for non-streaming endpoints.

## Streaming Failures

- Before SSE begins: return a normal HTTP error.
- After `meta`: emit exactly one `error` terminal event.
- Preserve already received text in the assistant message.
- Distinguish user cancellation (`stopped`) from provider/network failure
  (`error`).
- A dropped downstream body triggers cancellation but must not cause a second
  terminal state write.

## Logging

Expected operational errors are logged once at the boundary that has request or
generation context. Do not log the same error at every propagation layer.

Panic is reserved for broken internal invariants during development; handlers
must not panic on browser, provider, configuration, or database input.

## Tests

Every public error mapping requires:

- status or SSE terminal-kind assertion;
- stable code assertion;
- redaction assertion;
- final database-state assertion when a generation is involved.

