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
- The KaTeX lane filters `style` **per declaration**, not per attribute: each
  declaration is checked on its own, survivors are re-serialized, and the
  attribute is dropped only when nothing survives. Every declaration first
  passes a character allow-list (letters, digits, `#%.+-`, space, tab, `:`)
  that makes all CSS functional notation, escape sequences, comments, and
  `!important` unreachable, then a per-property value grammar (length /
  line-style / color / `position: relative`). Ordinary Markdown still gets
  zero `style`.
- `href`, `src`, `alt`, and `xlink:href` are the only URL carriers in KaTeX's
  attribute set and are permanently excluded from the KaTeX allow-list.
- Task lists, images, and footnotes degrade rather than disappear, and none of
  them adds a carrier: checkboxes are inert `span` markers (never `input`),
  images become scheme-checked links (never `img`, so an assistant message
  cannot trigger a third-party request), and footnotes render as visible text
  with no `href` at all.
- A footnote reference is recognized only when the same render has a matching
  definition. `[^…]` is ordinary prose (regex character classes, array
  indexing) far more often than it is a footnote, so an unpaired reference
  stays literal text instead of becoming a superscript that drops its caret.
  Definitions need no pairing and accept up to three leading spaces, matching
  the link-reference-definition shape they must out-tokenize.
- A degradation path must never lose content silently. Any `[^…]:` line the
  footnote tokenizer declines falls through to Marked's own definition
  tokenizer, which discards the note body without a trace, so its label bound
  stays generous rather than tight. For the same reason the degraded image
  link escapes its text and href while leaving a well-formed entity alone:
  `&amp;` in Markdown source already means a literal `&`, and re-encoding it
  would surface `&amp;` to the reader.
- Production is static output served by Rust; no Node.js server exists.

## Quality Check

Run the project-defined formatting, Svelte/TypeScript type-check, lint, unit
tests, production build, and critical browser E2E checks. For API or SSE
changes, review the Rust producer and central TypeScript decoder together.

See [Quality Guidelines](./quality-guidelines.md) for the full browser,
accessibility, security, and performance gate.
