# Frontend State Management

## Baseline

Use Svelte's built-in reactive state. Do not add a third-party state library in
the MVP.

Evidence:

- MVP `design.md` section 12.

Phase A records the exact Svelte syntax selected by the generated project and
updates examples here.

## State Owners

### Session

```text
checking
unauthenticated
authenticated
fatal-configuration-error
```

Owns session status and in-memory CSRF token. Never owns the raw access token
after login.

### Model catalog

Owns normalized models, default, freshness/error state, and latest draft model.
It does not mutate an existing conversation model.

### Conversations

Owns sidebar pages, current conversation, persisted messages, rename/delete
results, and server reconciliation.

### Generation

Owns one active stream, transient assistant buffer, cancellation, and terminal
transition. It is keyed by conversation and stream identity.

Settled-overlay release contract (08-08): the streaming overlay
(`StreamingTurn`) owns the in-flight turn, but once the terminal transition
has fired AND the settled assistant message is present in the authoritative
list (reconciled via `onReconcile`), the pane must release the stream
(`generation.clear()`) so the persisted message — with its status notes and
the regenerate/retry affordance — takes over. Gate the release on the message
actually arriving, not on the terminal event alone:

- mid-stream stops/failures are persisted server-side, so they release too;
- pre-stream failures (`assistantMessageId === null`) have no server message:
  the overlay (and the composer-restore path in `ChatPane.handleSend`) must
  stay;
- a failed/silent reconciliation keeps the overlay until the next successful
  open/reload.

Releasing on the terminal event without checking message arrival can drop the
only visible copy of the reply when reconciliation silently keeps stale detail
(`reloadCurrent` swallows fetch errors).

### Component-local

Owns drawer visibility, dialog visibility, focus, hover, and input field state
that no sibling needs.

## Persistence

Allowed in localStorage:

- latest draft model ID;
- selected conversation ID;
- unsent draft;
- UI preferences.

Forbidden:

- raw access token;
- CSRF token;
- provider credentials;
- full conversation cache;
- generation authority/status used as a server source of truth.

Validate stored values before use. If the remembered model is absent from the
current catalog, fall back to `AI_DEFAULT_MODEL`.

## Server Authority

SQLite-backed server state wins after refresh, reconnect, or mutation failure.
Optimistic UI may add a pending user message, but it must reconcile by
`client_message_id`.

Do not:

- mutate store internals from components;
- duplicate the same conversation in independent stores;
- derive generation completion from fetch closure alone;
- update the current conversation with an event owned by another ID.

## Derived State

Derive:

- `canSend`;
- `canCancel`;
- `isEmptyConversation`;
- `isModelLocked`;
- `shouldAutoFollow`;

from authoritative state rather than storing parallel booleans that can drift.

