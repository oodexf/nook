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

## Chat Stream

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

