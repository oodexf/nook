# Frontend Streaming and Data Access

## API Boundary

All HTTP calls go through one API client. It owns:

- same-origin base paths;
- cookie credentials;
- CSRF header on mutations;
- JSON decoding from `unknown`;
- normalized `ApiError`;
- request IDs;
- cancellation signals.

Evidence:

- MVP `design.md` sections 4, 5, 9, 10, and 11.

Components do not call `fetch` directly.

## Session Bootstrap

```text
checking-session
  ├── 401 → unauthenticated
  ├── success → authenticated
  └── fatal transport/config → recoverable error screen
```

The raw instance token exists only in the authentication form submission. After
the server sets the HttpOnly cookie, clear the input and do not copy it to
localStorage, sessionStorage, application stores, or logs.

The CSRF token returned by the authenticated session endpoint is held in memory
and added to every mutation.

## SSE Decoder

Message creation and retry use POST + `fetch`, then decode `response.body`.

One module owns:

- UTF-8 streaming decode;
- line buffering across chunks;
- SSE field parsing;
- JSON decoding from `unknown`;
- discriminated event variants;
- unknown event handling;
- terminal-event enforcement.

Components receive typed:

```text
MetaEvent
DeltaEvent
DoneEvent
StoppedEvent
ErrorEvent
```

No component casts raw event data.

## Generation Ownership

Each active stream records:

- conversation ID;
- generation ID after `meta`;
- assistant message ID;
- AbortController;
- accumulated text;
- terminal state.

Before applying an event, verify it belongs to the owning conversation and
stream instance. Navigating to another conversation does not transfer ownership.

Stop:

1. abort the current fetch;
2. send a separate authenticated cancel request using a different signal;
3. wait for server state reconciliation when needed.

## Rendering Backpressure

- Append deltas to an in-memory buffer.
- Update visible text at most once per animation frame.
- Do not fully reparse Markdown for every transport chunk.
- Perform final parse and sanitize on terminal state.
- A 100 KB response is part of the browser performance check.

## Error Behavior

- HTTP errors before SSE become typed API errors.
- `error` terminal events preserve partial text and message-local recovery.
- Network disconnect preserves local partial output until server state reload.
- Authentication expiry transitions to the auth page without leaking the draft
  token.
- Model-catalog failure is distinct from generation failure.


## Reasoning Channel (08-10)

- The central decoder accepts `reasoning_delta` events
  (`ChatStreamReasoningDelta`, same text bound as `delta`). Unknown-event
  tolerance means older frontends silently ignore them.
- The generation store accumulates reasoning on its own rAF-batched
  channel (`streamingReasoning`) separate from the answer text; both flush
  through the same scheduler.
- `ReasoningBlock` (lib/components) is the single collapsible thinking UI,
  shared by `StreamingTurn` (live, starts expanded, auto-collapses once
  when answer content starts unless the user already toggled) and
  `MessageItem` (history, starts collapsed). Reasoning renders as plain
  de-emphasized text, never Markdown.
