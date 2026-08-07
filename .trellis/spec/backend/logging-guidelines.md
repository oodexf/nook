# Backend Logging Guidelines

## Format

Use `tracing` with structured fields. Production logs are JSON; development may
use a readable formatter without changing field names.

Evidence:

- MVP `design.md` sections 15 and 16.

## Required Request Fields

Where available:

```text
request_id
method
route
status
duration_ms
conversation_id
generation_id
provider
model
error_code
```

Use route templates such as `/conversations/{id}`, not raw URLs containing
identifiers or query strings.

## Levels

- `error`: internal invariant failure or operation requiring operator action.
- `warn`: rejected auth bursts, stale model catalog, provider degradation,
  interrupted shutdown, or recoverable database contention.
- `info`: startup, shutdown, migration version, request completion, generation
  completion summary, and backup completion.
- `debug`: safe protocol/state transitions useful during development.
- `trace`: disabled by default; must still obey redaction rules.

Normal client validation failures are not `error`.

The HTTP request boundary generates one application-owned ULID per request,
places it in request extensions, emits it as `X-Request-ID`, and records the
same value in completion logs and public JSON failures. Completion logging uses
Axum's matched route template and never reads the raw URI, query, headers, or
body.

## Never Log

- `Authorization`, Cookie, Set-Cookie, access tokens, API keys, CSRF tokens;
- user prompts, assistant bodies, system prompts, raw SSE chunks;
- raw provider responses or request bodies;
- database row contents;
- full environment dumps;
- stack traces sent to the client.

Provider/model IDs and message length/count are allowed. If a URL can contain
credentials or sensitive query parameters, log only a configured provider name
or sanitized origin.

The Phase D provider and model-catalog paths emit no URL, key, response-body, or
transport-error fields. Typed provider errors contain only a stable category,
and the explicit stale response exposes only its stable safe code/message plus
the middleware request ID. Fake-provider tests use recognizable body/key
sentinels and assert they are absent from provider errors and public bodies.

## Event Ownership

- HTTP middleware owns request completion logs.
- Generation service owns one generation completion/failure log.
- Migration runner owns migration logs.
- Backup command owns backup lifecycle logs.

Lower layers attach context to errors but do not duplicate lifecycle events.

## Redaction Tests

Tests inject recognizable sentinel secrets and conversation text, then assert
they are absent from captured logs for success and failure paths.

