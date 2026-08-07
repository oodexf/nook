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
- TypeScript modules and folders use `kebab-case` or `camelCase` consistently;
  Phase A selects one and records the choice here.
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

## Spec Update Requirement

After the auth vertical slice, replace planned paths with real files and record
the chosen Svelte state syntax and test tooling.

