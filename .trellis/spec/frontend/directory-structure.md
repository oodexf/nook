# Frontend Directory Structure

## Planned Layout

```text
frontend/
  src/
    lib/
      api/
        client.ts
        contracts.ts
        sse.ts
      auth/
      models/
      conversations/
      generation/
      markdown/
      components/
      styles/
    App.svelte
    main.ts
```

Evidence:

- MVP `design.md` sections 3, 4, and 12.

The exact generated Svelte/Vite scaffold may add build files, but feature
ownership must remain visible.

## Ownership

- `api/`: fetch wrapper, unknown-payload decoding, public contract types, SSE
  parser.
- `auth/`: session bootstrap, login/logout, CSRF token, auth page.
- `models/`: normalized model catalog and draft selection.
- `conversations/`: list/current conversation, rename/delete, message history.
- `generation/`: active stream, AbortController, transient buffer, state
  transitions.
- `markdown/`: parser/sanitizer configuration and rendered-content helpers.
- `components/`: presentation pieces that are genuinely reused across features.
- `styles/`: design tokens, reset, and global layout rules.

Feature-specific components stay with the owning feature until reused.

## Naming

- Svelte component files use `PascalCase.svelte`.
- TypeScript modules and folders use `kebab-case`; Svelte component files remain
  `PascalCase.svelte`.
- Stores use conceptual names such as `sessionStore`, not generic `appStore`.
- Event handlers describe intent: `handleSend`, `handleCancel`.
- Boolean values read as predicates: `isStreaming`, `hasMessages`.

## Import Direction

- Components may import decoded feature APIs/stores.
- Feature modules may import shared API and style utilities.
- API decoders do not import UI components.
- No feature reaches into another feature's private store internals.
- Avoid a barrel file that hides cycles; add exports only when they clarify a
  public feature boundary.

## Forbidden Catch-Alls

Do not create:

```text
utils/
helpers/
misc/
common/
```

without a named domain. Shared code must have a concrete owner such as
`markdown`, `api`, or `generation`.

The completed Phase F browser implementation now lives in the feature-owned
paths above. `AppShell.svelte` owns the responsive desktop sidebar and
focus-trapped mobile drawer; `ChatPane.svelte` owns conversation-local drafts,
auto-follow, return-to-bottom, rename/delete intent, and stream visibility;
`Composer.svelte` owns auto-resize and IME-safe Enter behavior. Persisted
assistant content has exactly one HTML insertion path:
`markdown/MarkdownContent.svelte` calls `markdown/render.ts`, which parses with
Marked and sanitizes through an explicit DOMPurify tag/attribute/URI allow-list.
Stream deltas remain escaped plain text until terminal state. Draft persistence
is keyed by conversation and validates bounded strings; auth, CSRF, full
conversation data, and generation authority never enter browser storage.

### Vite configuration gotcha

`vite.config.ts` exports a mode-aware config function. Add Svelte's `browser`
resolution condition only when `mode === "test"`; production must omit
`resolve.conditions`. Do not read `process.env` in the config unless Node types
are an intentional project dependency: a clean `npm ci`/Docker context exposed
that ambient global as a type error even when a developer's existing
`node_modules` happened to mask it. `vite.config.test.ts` must assert both test
and production branches by invoking the config function directly.


The authentication boundary lives in `frontend/src/lib/api/session.ts`, with
contract tests in `session.test.ts`. `App.svelte` owns only the current
top-level screen transition; the raw token stays in component memory and is
cleared immediately after a successful exchange, while the CSRF token remains
in the decoded in-memory session state.
