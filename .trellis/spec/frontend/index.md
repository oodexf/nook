# Frontend Development Guidelines

## Status and Evidence

This is a greenfield Svelte frontend. No application source exists at the time
of this baseline. Rules come from the approved MVP PRD and design:

- `.trellis/tasks/08-06-minimal-ai-chat-web-mvp/prd.md`
- `.trellis/tasks/08-06-minimal-ai-chat-web-mvp/design.md`

After the first vertical slice, update the guides with real component, store,
API, and test paths.

## Guides

| Guide | Owns |
|---|---|
| [Directory Structure](./directory-structure.md) | Feature and shared-module placement |
| [Component Guidelines](./component-guidelines.md) | Svelte components, styling, accessibility |
| [Streaming and Data Access](./streaming-data-access.md) | API decoder, SSE, auth, cancellation |
| [State Management](./state-management.md) | Local, session, model, conversation, generation state |
| [Type Safety](./type-safety.md) | TypeScript boundary decoding and shared contracts |
| [Quality Guidelines](./quality-guidelines.md) | Tests, browser support, performance, and review |

## Frontend Invariants

- The frontend never receives the provider API key.
- The raw instance access token is discarded after session exchange.
- Unknown network payloads are decoded centrally before reaching components.
- One draft conversation may select one model; a non-empty conversation only
  displays its locked model.
- Streaming updates cannot mutate a different conversation after navigation.
- Markdown is sanitized before insertion into the DOM. Assistant formulas use
  conservative `$...$` inline syntax and closed, non-empty `$$...$$` display
  syntax (either same-line or line-isolated), plus common model-emitted closed,
  non-empty `\\(...\\)` inline and `\\[...\\]` display syntax; ordinary
  Markdown remains under the strict no-style/no-SVG policy, while only
  per-render provenance-matched `trust: false` KaTeX fragments receive the
  exact KaTeX-only sanitizer needed for MathML and layout geometry.
- Production is static output served by Rust; no Node.js server exists.

## Quality Check

Run the project-defined formatting, Svelte/TypeScript type-check, lint, unit
tests, production build, and critical browser E2E checks. For API or SSE
changes, review the Rust producer and central TypeScript decoder together.

See [Quality Guidelines](./quality-guidelines.md) for the full browser,
accessibility, security, and performance gate.
