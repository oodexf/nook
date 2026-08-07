# Minimal AI Chat Web MVP — Technical Design

## 1. Design Summary

The application is a same-origin Svelte single-page application served by one
Rust/Axum process. The process embeds the built frontend, exposes an
authenticated JSON/SSE API, stores data in SQLite, and proxies one configured
OpenAI-compatible provider.

Production runtime:

```text
Browser
  │
  ├── static assets
  ├── JSON API
  └── POST response streamed as SSE
          │
          ▼
Rust / Axum / Tokio
  ├── authentication session
  ├── conversation service
  ├── generation service
  ├── model catalog
  ├── OpenAI-compatible provider
  └── SQLite repository
          │
          ├── /data/chat.db
          └── HTTPS → provider /v1/models and chat completions
```

No Node.js process, reverse-proxy sidecar, Redis, queue, or database server is
part of the application runtime. A deployment may place Caddy, Nginx, or
Traefik in front for TLS.

## 2. Technology Baseline

### Frontend

- Svelte + TypeScript;
- Vite for development and static production builds;
- plain CSS with project design tokens;
- one maintained Markdown parser;
- one maintained HTML sanitizer;
- no SSR, Tailwind, component library, frontend state library, or client router
  in the MVP.

### Backend

- Rust;
- Axum for routing, JSON, middleware composition, static assets, and SSE;
- Tokio for async runtime;
- Reqwest with rustls for the provider client;
- Serde for boundary serialization;
- Rusqlite for explicit SQL;
- Tokio CancellationToken for generation cancellation;
- Tracing for structured logs.

Feature flags should be limited to used features. Versions belong in lockfiles,
not duplicated in planning documents.

## 3. Module Boundaries

```text
crates/
  core/
    conversation domain
    generation state machine
    provider and repository traits
    application errors
  storage/
    SQLite connection
    migrations
    repository implementations
  server/
    configuration
    authentication
    HTTP DTOs and handlers
    SSE encoding
    static asset embedding
    process lifecycle
frontend/
  components
  application stores
  API client and stream decoder
  styles
```

The `core` crate must not depend on Axum, Reqwest, Rusqlite, or Svelte types.
HTTP handlers translate request DTOs into core commands. Repositories translate
database rows into core entities. The provider adapter owns upstream payload
formats.

If the workspace structure is disproportionate during the foundation slice,
the same boundaries may initially be Rust modules in one crate. Crossing a
module boundary must not change the contract.

## 4. Cross-Layer Contract Ownership

Each external or serialized format has one owner:

| Contract | Owner |
|---|---|
| Public HTTP request/response DTOs | server API module |
| Browser TypeScript API types | generated or maintained in one frontend API module |
| SSE event variants and encoder | server stream module |
| SSE decoding and narrowing from unknown | frontend stream module |
| Provider `/v1/models` and chat DTOs | provider adapter |
| Database rows and SQL | storage repository |
| Domain states and valid transitions | core |

Components must not cast raw API fields independently. Database schema types
must not leak into API DTOs.

All public timestamps use UTC Unix milliseconds. All identifiers are
application-generated UUID v7 or ULID values; implementation selects one and
uses it everywhere.

## 5. Authentication Design

### Configuration

The deployer supplies `APP_ACCESS_TOKEN`. It must contain at least 32 random
bytes of entropy. Startup fails if it is missing or too weak in production
mode.

### Login exchange

```text
1. GET / returns SPA.
2. SPA calls GET /api/v1/session.
3. Missing session → render authentication page.
4. User submits token and remember_me.
5. POST /api/v1/session compares token in constant time.
6. Server returns an authenticated session cookie.
7. SPA discards the raw token and loads the chat application.
```

The cookie is:

- `HttpOnly`;
- `Secure` when the external origin is HTTPS;
- `SameSite=Strict`;
- `Path=/`;
- a browser-session cookie when `remember_me=false`;
- limited to 30 days when `remember_me=true`.

The session is stateless and authenticated with a key derived from the instance
access token plus a fixed application context string. Its payload contains a
version, issued-at, expiry, and random nonce. Rotating `APP_ACCESS_TOKEN`
therefore invalidates existing cookies without a session database.

`DELETE /api/v1/session` clears the cookie. Authentication failures are
rate-limited. The health endpoints remain public; every other `/api/v1`
endpoint requires a valid session unless explicitly documented.

`GET /api/v1/session` returns a CSRF token derived from the authenticated
session nonce. The frontend keeps it in memory and sends it through
`X-CSRF-Token` on every state-changing request. The server validates the token
and the request Origin before executing mutations. CORS remains disabled.

The application must document that Secure cookies require HTTPS. A deliberate
development-mode exception may allow localhost HTTP but must not activate for a
public production bind.

## 6. Model Catalog

The server calls:

```text
GET {AI_BASE_URL}/models
Authorization: Bearer {AI_API_KEY}
```

`AI_BASE_URL` is normalized so an operator may configure a base ending in
`/v1` without producing `/v1/v1/models`. The provider adapter owns this
normalization and applies it consistently to model and chat endpoints.

The server exposes an authenticated normalized model catalog:

```json
{
  "models": [
    {
      "id": "provider-model-id",
      "label": "provider-model-id"
    }
  ],
  "default_model": "provider-model-id",
  "refreshed_at": 1786000000000
}
```

Rules:

- model IDs are opaque strings;
- the server does not infer capabilities from a model name;
- duplicate IDs are collapsed;
- results are sorted deterministically;
- malformed entries are ignored, but a fully malformed or empty response is an
  error;
- the API key and raw upstream body never reach the browser;
- a short in-memory cache limits provider calls;
- an explicit refresh path may bypass the cache;
- stale cache may be served with a visible stale indicator when refresh fails;
- no stale cache exists after process restart.

`AI_DEFAULT_MODEL` must be present in the fetched catalog before it is offered
as the default. If the configured default is absent, the authentication succeeds
but the chat screen shows a blocking model-configuration error.

## 7. Conversation Model Invariant

`conversations.model` is required.

Creation rules:

1. The frontend displays a model selector only for an empty draft conversation.
2. The first message request includes the selected model.
3. The server validates it against the current catalog.
4. Conversation creation, model assignment, user message creation, assistant
   placeholder creation, and generation creation occur in one transaction.
5. Once a conversation contains a message, attempts to change its model return
   `409 model_locked`.

Every generation and assistant message also stores the actual model ID. This is
intentional denormalization for auditability. The conversation model controls
new generations; the message model describes historical fact.

If the model later disappears from `/v1/models`, history remains readable but
new generation and retry requests return `409 model_unavailable`. The system
never silently substitutes another model.

## 8. Data Model

### conversations

```text
id              TEXT PRIMARY KEY
title           TEXT NOT NULL
model           TEXT NOT NULL
created_at      INTEGER NOT NULL
updated_at      INTEGER NOT NULL
```

Index `updated_at DESC` for sidebar ordering.

### messages

```text
id                  TEXT PRIMARY KEY
conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
client_message_id   TEXT NULL
role                TEXT NOT NULL          # user | assistant
content             TEXT NOT NULL
status              TEXT NOT NULL
model               TEXT NULL              # required for assistant
error_code          TEXT NULL
created_at          INTEGER NOT NULL
finished_at         INTEGER NULL
```

`client_message_id` has a partial unique index when non-null.

Assistant state machine:

```text
streaming → completed
          → stopped
          → error
          → interrupted
```

### generations

```text
id                    TEXT PRIMARY KEY
conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
assistant_message_id  TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
provider              TEXT NOT NULL
model                 TEXT NOT NULL
status                TEXT NOT NULL
input_tokens          INTEGER NULL
output_tokens         INTEGER NULL
started_at            INTEGER NOT NULL
finished_at           INTEGER NULL
```

A partial unique index permits one `pending`, `streaming`, or `cancelling`
generation per conversation.

### schema_migrations

Stores version, name, and application time. Migrations are embedded and applied
transactionally at startup.

SQLite initialization:

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

The database must live on a local persistent volume, not NFS or SMB.

## 9. Public API

Base path: `/api/v1`.

### Public

```text
GET  /health/live
GET  /health/ready
POST /session
```

### Session-authenticated

```text
GET    /session
DELETE /session
GET    /config
GET    /models
POST   /models/refresh
GET    /conversations
GET    /conversations/{id}
PATCH  /conversations/{id}
DELETE /conversations/{id}
POST   /conversations/new/messages
POST   /conversations/{id}/messages
POST   /generations/{id}/cancel
POST   /messages/{assistant_message_id}/retry
```

Errors use:

```json
{
  "error": {
    "code": "model_unavailable",
    "message": "The selected model is no longer available.",
    "request_id": "01J..."
  }
}
```

Messages are safe for display. Internal details and upstream bodies are never
included.

## 10. Streaming Protocol

Message creation and retry use POST and return `text/event-stream`. The browser
uses `fetch` and parses `response.body`; browser `EventSource` is not used
because it cannot send the JSON POST body required by this API.

Events:

```text
meta     conversation_id, user_message_id, assistant_message_id, generation_id, model
delta    text
done     finish_reason, optional usage
stopped  reason
error    stable error code, safe message
```

Contract:

- `meta` is the first business event;
- `delta` appends and never replaces text;
- exactly one terminal event is emitted;
- comments may be used for keep-alive;
- unknown event kinds are ignored by the client decoder;
- each data payload is one-line JSON;
- a request ID is available in response headers and error payloads.

During streaming, the server aggregates content in memory and writes the final
or partial assistant response once on completion, cancellation, or failure. On
process restart, leftover streaming rows become interrupted.

## 11. Generation and Cancellation Flow

```text
Browser submit
  → validate request and session
  → validate selected/locked model
  → idempotent database transaction
  → load bounded conversation context
  → register generation CancellationToken
  → call provider
  → normalize upstream chunks
  → encode public SSE events
  → aggregate content
  → finalize database state
  → unregister generation
```

Stop performs both:

- abort the browser fetch;
- send a separate authenticated cancel request.

The server also cancels when the downstream response body is dropped. Explicit
cancel is idempotent and covers proxies that delay disconnect propagation.

One conversation may have only one active generation. Context is selected from
newest to oldest using both message-count and character limits. The current
user message is never silently truncated; oversized input is rejected.

## 12. Frontend Design

Single application state decides between:

```text
checking-session
unauthenticated
authenticated
fatal-configuration-error
```

Authenticated component tree:

```text
AppShell
  Sidebar
    NewConversation
    ConversationList
  ChatHeader
    ConversationTitle
    LockedModelLabel
  MessageList
    MessageItem
      MarkdownContent
      MessageActions
  Composer
    DraftModelSelector     # only before first message
    AutoResizeTextarea
    SendOrStopButton
  ConfirmDialog
  ToastRegion
```

Frontend state owners:

- API module: request/response decoding;
- session store: authentication state only;
- model store: normalized model catalog and selected draft model;
- conversation store: list/current conversation/server messages;
- generation store: current stream, AbortController, transient buffer;
- component local state: open/closed state, draft input, focus.

Only UI preferences, latest draft model ID, selected conversation ID, and
unsent draft may use localStorage. Raw access tokens and full conversation data
must not.

Markdown is parsed without raw HTML and sanitized. Dangerous protocols, event
attributes, iframes, unsafe SVG, and remote embeds are rejected.

## 13. Runtime Configuration

Required:

```text
APP_ACCESS_TOKEN
AI_BASE_URL
AI_API_KEY
AI_DEFAULT_MODEL
```

Optional with safe defaults:

```text
APP_BIND=0.0.0.0:8080
APP_BASE_URL
DATABASE_PATH=/data/chat.db
AI_REQUEST_TIMEOUT_SECS
MODEL_CACHE_TTL_SECS
MAX_MESSAGE_CHARS
MAX_CONTEXT_MESSAGES
MAX_CONTEXT_CHARS
MAX_ACTIVE_GENERATIONS
RUST_LOG=info
```

Startup validates configuration without logging secret values. A public
production bind without a secure external URL emits a prominent warning or
fails when Secure cookie semantics cannot be guaranteed; the exact behavior is
covered by deployment tests.

## 14. Docker and Operations

Three build stages:

1. build Svelte assets;
2. compile the Rust release binary with embedded assets;
3. copy the binary and CA certificates into a non-root runtime image.

Runtime rules:

- `/data` is the only persistent writable path;
- root filesystem is read-only;
- `/tmp` is tmpfs if required;
- default Compose binding is `127.0.0.1:8080`;
- the process handles SIGTERM and drains active requests within a bounded time;
- readiness checks database access but does not call the provider;
- model-provider health is shown separately in authenticated UI.

Backups use SQLite's backup API or an application backup command. Copying only
the main database file while ignoring WAL is not an accepted backup procedure.

## 15. Security Boundaries

- Browser input is untrusted.
- Session cookies are authenticated but requests still require validation.
- Cookie authentication makes state-changing routes CSRF boundaries; both
  same-origin validation and the session-bound CSRF token are required.
- Provider model and stream responses are untrusted external data.
- Database content can contain hostile Markdown and must be sanitized when
  rendered.
- Proxy headers are trusted only when explicitly configured.

Security headers include CSP, `X-Content-Type-Options`, `Referrer-Policy`, and a
minimal `Permissions-Policy`. CORS is disabled by default because the API is
same-origin.

Logs include request ID, route, status, duration, provider/model identifiers,
generation ID, and error code. They exclude cookies, tokens, prompts, model
responses, and raw upstream errors.

## 16. Failure Behavior

| Failure | Behavior |
|---|---|
| Invalid login token | generic authentication error, rate-limited |
| `/v1/models` fails with no cache | authenticated blocking model error |
| `/v1/models` refresh fails with cache | stale catalog plus visible warning |
| Selected model removed | history readable; generation rejected |
| Provider fails before output | assistant error state; retry available |
| Provider fails mid-stream | partial output retained as error |
| User cancels | partial output retained as stopped |
| Process crashes mid-stream | startup recovery marks interrupted |
| SQLite unavailable | readiness fails; writes return safe 503 |
| Browser offline | current partial output retained locally until reload |

## 17. Compatibility and Migration

The initial release starts from an empty database and therefore has no legacy
migration. Every subsequent schema change must add a forward migration.

Future multi-user support requires an owner scope on every conversation query
and is intentionally not prepared through nullable owner columns now. Future
PostgreSQL support is enabled by repository boundaries, not by writing
database-generic SQL prematurely.

## 18. Trade-offs

- SQLite favors operational simplicity over multi-replica writes.
- Stateless cookie sessions favor no session table over per-device revocation.
- A single OpenAI-compatible provider favors a small MVP over native
  provider-specific features.
- One model per conversation favors predictable history over mid-conversation
  experimentation.
- In-memory stream aggregation favors low database write load over preserving
  every token during a process crash.
- No service worker favors predictable upgrades over installability and offline
  behavior.

## 19. Rollback

- Application images use immutable version tags.
- Before applying a new migration, create a verified database backup.
- Destructive schema changes require expand/contract releases.
- If application startup fails before migration, roll back the image.
- If migration completes, confirm the previous image can read the new schema
  before rolling back; otherwise restore the pre-upgrade backup.
- Provider configuration changes require no data migration and can be rolled
  back by restoring environment variables.
