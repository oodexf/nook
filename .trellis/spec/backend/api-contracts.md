# Backend API Contracts

## Boundary Rule

Axum handlers own HTTP decoding and encoding. Core services do not know HTTP
status codes, headers, cookies, or SSE wire syntax.

Evidence:

- MVP `design.md` sections 4, 5, 9, and 10.

## DTO Rules

- Define request and response DTOs in one API module.
- `serde` DTOs are not database records or core entities.
- Apply body-size limits before JSON decoding.
- Reject unknown or malformed state-changing payloads rather than coercing them.
- Model IDs are opaque strings and receive length/control-character validation,
  not capability inference.
- Public timestamps are UTC Unix milliseconds.

Frontend consumers decode responses through one central TypeScript API module.

## Session Boundary

Public:

```text
GET /api/v1/health/live
GET /api/v1/health/ready
POST /api/v1/session
```

Authenticated:

```text
GET /api/v1/session
DELETE /api/v1/session
all configuration, model, conversation, message, and generation routes
```

Every authenticated mutation requires:

1. valid session cookie;
2. accepted same-origin `Origin`;
3. valid session-bound `X-CSRF-Token`;
4. request validation.

Do not accept credentials in URL parameters.

## SSE Contract

Business events:

```text
meta
delta
done
stopped
error
```

Rules:

- `meta` is first;
- `delta` appends;
- exactly one terminal event follows;
- payload data is one-line JSON;
- comments may provide keep-alive;
- errors after streaming begins are terminal events, not a second HTTP response.

The server SSE enum and frontend decoder must change in the same implementation
slice. Add a round-trip contract test for every event variant.

## Idempotency and Conflicts

- `client_message_id` is required for message creation.
- A repeated ID resolves to the existing logical result and does not insert
  duplicate messages.
- A conversation with an active generation rejects another generation and current-model updates.
- Existing conversations change their current model only through the explicit authenticated model mutation; message creation does not implicitly switch it.
- A removed current model rejects generation with `model_unavailable`.
- Cancel and delete operations are idempotent where documented.

## Cache and Proxy Headers

- Static hashed assets receive long immutable caching.
- `index.html`, session, model, and conversation responses do not receive
  immutable caching.
- SSE disables proxy buffering and response caching.
- Health endpoints expose no configuration or dependency secrets.

The Phase A implementation is in `crates/server/src/main.rs`. Both health
responses are JSON, and the embedded SPA fallback is implemented by
`crates/server/src/static_assets.rs`.

The session contract is implemented in `crates/server/src/auth.rs`. Session
cookies are named `chat_session`; browser sessions have no `Max-Age`, remembered
sessions use `Max-Age=2592000`, and both use `HttpOnly`, `SameSite=Strict`, and
`Path=/`. `Secure` defaults on and may be disabled only through the explicit
`APP_COOKIE_SECURE=false` development setting. Mutations compare `Origin`
exactly with normalized `APP_ORIGIN`.

Conversation CRUD is implemented in `crates/server/src/conversations.rs`; shared
HTTP request context and public error serialization are implemented in
`crates/server/src/request_context.rs`:

```text
GET    /api/v1/conversations?cursor=<opaque>&limit=<1..100>
GET    /api/v1/conversations/{ulid}
PATCH  /api/v1/conversations/{ulid}
PUT    /api/v1/conversations/{ulid}/model
DELETE /api/v1/conversations/{ulid}
```

List/open require the existing session middleware. Rename/delete require the
existing session + exact Origin + session-bound CSRF middleware. Rename bodies
are capped at 4 KiB, unknown fields are rejected, titles are trimmed and limited
to 200 non-control characters, and path IDs must be canonical ULID values.
Conversation errors reuse the middleware-owned request ID in both the
`X-Request-ID` response header and public `request_id` field; repository causes
and request bodies are not serialized. Request completion logs contain only the
request ID, HTTP method, matched route template, status, and duration. Permanent
delete is idempotent: a valid ULID returns `204` whether it existed or had
already been removed.

The Phase D model API is implemented in `crates/server/src/models.rs`:

```text
GET  /api/v1/models
POST /api/v1/models/refresh
```

GET requires the session middleware. POST requires the existing exact-Origin,
session, and session-bound CSRF middleware. Both responses use
`Cache-Control: no-store`. The normalized success body adds `stale` and nullable
`refresh_error`; stale metadata repeats the current request ID and a stable safe
model-provider code/message. Provider keys, raw response bodies, full provider
URLs, and transport details never enter the public DTO. A configured default
missing from the fetched catalog returns authenticated blocking
`model_default_missing` and is never replaced.

Existing-conversation model updates use the dedicated `PUT .../{id}/model` mutation, require exact catalog membership, persist immediately, and reject active generations. `ConversationResponse.model` is the server-authoritative current model for the next generation; assistant message and generation model fields remain immutable historical snapshots.

Phase E adds authenticated mutation-protected POST routes for new/existing
messages, generation cancellation, and assistant retry in
`crates/server/src/chat.rs`. Message JSON rejects unknown fields, uses a bounded
body, requires a global `client_message_id`, enforces configured character
limits, and validates exact model availability. SSE emits `meta` first, append-
only `delta` events, and exactly one `done`, `stopped`, or `error` terminal event;
responses carry `Cache-Control: no-store`, `X-Accel-Buffering: no`, keepalive
comments, and the request ID header owned by request middleware.

## Scenario: Authenticated Streamed Message Creation

### 1. Scope / Trigger

This scenario applies whenever the browser creates or retries a message. It
crosses session authentication, CSRF, API DTOs, conversation/model invariants,
SQLite transactions, provider streaming, cancellation, public SSE, and frontend
state.

### 2. Signatures

Public HTTP shape:

```text
POST /api/v1/conversations/new/messages
POST /api/v1/conversations/{conversation_id}/messages
POST /api/v1/messages/{assistant_message_id}/retry
POST /api/v1/generations/{generation_id}/cancel
```

Core service shape:

```rust
async fn create_generation(
    command: CreateGeneration,
    cancel: CancellationToken,
) -> Result<GenerationStream, ApplicationError>;
```

Database transaction shape:

```text
create/validate conversation
insert idempotent user message
insert streaming assistant message
insert active generation
commit
```

### 3. Contracts

New-message request:

```json
{
  "client_message_id": "opaque-application-id",
  "content": "non-empty bounded UTF-8 text",
  "model": "required only for a new draft conversation"
}
```

Required headers/cookies:

```text
Cookie: authenticated HttpOnly session
Origin: configured same origin
X-CSRF-Token: token bound to the current session nonce
Content-Type: application/json
```

First SSE event:

```json
{
  "event": "meta",
  "conversation_id": "id",
  "user_message_id": "id",
  "assistant_message_id": "id",
  "generation_id": "id",
  "model": "opaque-provider-model-id"
}
```

Following events are zero or more `delta` values and exactly one `done`,
`stopped`, or `error`.

Relevant environment keys:

```text
APP_ACCESS_TOKEN
AI_BASE_URL
AI_API_KEY
AI_DEFAULT_MODEL
MAX_MESSAGE_CHARS
MAX_CONTEXT_MESSAGES
MAX_CONTEXT_CHARS
MAX_ACTIVE_GENERATIONS
AI_REQUEST_TIMEOUT_SECS
```

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/invalid session | `401 unauthorized` before stream |
| Wrong/missing Origin or CSRF | `403 csrf_rejected` before stream |
| Empty/oversized content | `400` or `413` before transaction |
| Duplicate `client_message_id` | return/reconcile existing logical result; no duplicate rows |
| New conversation model absent from catalog | `409 model_unavailable` |
| Existing conversation supplied a different model | `409 model_mismatch`; use the model mutation first |
| Active generation already exists | `409 generation_in_progress` |
| Provider fails before `meta` | normal mapped HTTP error |
| Provider fails after `meta` | one terminal `error`, partial content persisted |
| User cancel | one terminal `stopped`, partial content persisted |
| Downstream disconnect | cancel upstream, finalize at most once |

### 5. Good / Base / Bad Cases

- Good: a valid new conversation selects an available model, commits its four
  related rows, streams ordered deltas, and persists a completed assistant
  message.
- Base: an existing conversation omits `model`; the server uses its current
  server-persisted model and streams normally.
- Bad: the browser sends a different model without first persisting it; the
  server rejects it before provider I/O and does not change stored state.
- Bad: a retry repeats after transport uncertainty; idempotency and active
  generation constraints prevent duplicate work.

### 6. Tests Required

- API integration: assert auth, Origin, CSRF, body limits, and public error code.
- Repository integration: assert one transaction creates consistent rows and
  duplicate IDs do not add rows.
- Provider integration: assert Unicode chunk boundaries and mapped failures.
- SSE contract: assert `meta` first and exactly one terminal event.
- Cancellation: assert upstream connection closes and final database status is
  `stopped` or `error` exactly once.
- Cross-conversation E2E: navigate during streaming and assert no event mutates
  the newly selected conversation.
- Redaction: assert token, cookie, prompt, and provider body sentinels are absent
  from captured logs.

### 7. Wrong vs Correct

#### Wrong

```text
component fetches provider directly
→ component parses raw upstream SSE
→ component chooses a model from its name
→ handler writes each token to SQLite
```

This leaks credentials and provider contracts into the browser, bypasses the
conversation model invariant, and creates high-frequency writes.

#### Correct

```text
typed frontend API client
→ authenticated/CSRF-protected server DTO
→ core generation command
→ provider adapter normalizes upstream stream
→ server emits project SSE variants
→ frontend central decoder updates the owning generation
→ server finalizes one persisted assistant state
```

## Reasoning Chain Contract (08-10)

- The public SSE protocol adds a `reasoning_delta` event
  (`{"event":"reasoning_delta","text":"..."}`), emitted between `meta` and
  the first `delta` while the provider streams thinking content. Terminal
  accounting is unchanged: exactly one of `done` / `stopped` / `error`.
- Replay of a terminal generation re-sends the persisted reasoning as one
  `reasoning_delta` before the full-content `delta`, preserving the live
  event order.
- `MessageResponse` carries `reasoning: string | null`; persisted in
  `messages.reasoning` (migration 0002, assistant-only via column CHECK).
  Frontend decoders tolerate the field being absent (older payloads).
