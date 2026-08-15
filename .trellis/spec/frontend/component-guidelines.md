# Svelte Component Guidelines

## Component Responsibilities

Components render typed state and emit user intent. API decoding, provider
payload knowledge, database concepts, and generation finalization do not belong
inside `.svelte` files.

Evidence:

- MVP `design.md` section 12;
- MVP `prd.md` R3.

Split a component when it has an independently testable interaction or is
reused. Do not split simple markup solely to minimize file length.

## Planned Component Tree

```text
App
  AuthenticationPage
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
      ComposerModelSelector
      AutoResizeTextarea
      SendOrStopButton
    ConfirmDialog
    ToastRegion
```

`ComposerModelSelector` (08-10) is only interactive before the first
message: ChatPane injects it into the composer's `beforeSend` slot only in
the draft view, where its trigger sits left of the send button and opens an
upward popover owning the catalog states (loading, error, stale, refresh).
Existing conversations show a non-editable model label.

## Props and Events

- Define explicit TypeScript props.
- Prefer domain-specific props over large untyped option objects.
- Pass callbacks or typed events that describe user intent.
- Never pass raw `Response`, provider JSON, database rows, or `unknown` into a
  rendering component.
- Derived display values belong near their typed source, not duplicated across
  multiple components.

## Styling

- Use plain CSS and CSS custom properties.
- Global tokens define colors, spacing, radius, typography, and motion.
- Component styles are locally scoped unless they intentionally define layout
  primitives.
- Do not introduce Tailwind, CSS-in-JS, or a component library without a new
  approved decision.
- Use inline SVG for the small icon set; icon-only buttons require accessible
  names.
- The palette is theme-aware (08-08): `App` owns the theme store
  (`lib/theme/theme-store.svelte.ts`), which persists the preference
  (system/light/dark) in localStorage under `chat.theme-preference` and
  applies it as `data-theme` on the document root. All colors must come from
  the CSS custom properties in `global.css` (add a token to both palettes when
  a new semantic color is needed); never hard-code hex colors in component
  styles.
- Copy feedback contract (08-08): all copy actions share `createCopyControl`.
  Success swaps the glyph to a green check (`data-state="copied"`, ~1s),
  failure uses the danger state; the swap is CSS-driven off `data-state`, the
  factory stays markup-only. Hover-revealed controls (e.g. the code-block copy
  button) must also appear on `:focus-within` so keyboard users can reach them
  without reserving layout space.

## Accessibility

- All actions are keyboard reachable with visible focus.
- Touch targets are at least 44×44 CSS pixels.
- Normal text contrast is at least 4.5:1.
- Dialogs trap focus, have a labelled title, and restore focus on close.
- Streaming content does not announce every token to assistive technology.
  Announce generation state changes at a controlled cadence.
- Respect `prefers-reduced-motion`.
- Desktop Enter sends and Shift+Enter creates a newline.
- IME composition suppresses send-on-Enter.
- Mobile preserves the composer when the software keyboard opens.

## Markdown

Only `MarkdownContent` inserts sanitized HTML. Other components render text
through normal Svelte escaping.

Assistant formulas are part of that same boundary. Formula tokens become
per-render cryptographic placeholders before ordinary Markdown is sanitized;
ordinary source keeps the strict no-style/no-SVG policy. Only matching
in-memory `trust: false` KaTeX fragments pass through the separate exact
KaTeX sanitizer and replace surviving placeholders. Do not add KaTeX layout
permissions to the ordinary Markdown policy or create another `{@html}` path.

Raw HTML, iframes, unsafe SVG, remote embeds, event attributes, and dangerous
URL schemes are disabled.

## Visual Rebuilds of Test-Locked Components

When rebuilding a component that an existing component test asserts against
(e.g. `AuthPage.test.ts` locks the auth form DOM), the visual redesign must
preserve the **test-asserted DOM contract** verbatim, even while the chrome
around it changes completely:

- Keep the exact roles, input `type`s, and `button[type]` the tests select
  (`role="status"` for loading regions, `role="alert"` for errors,
  `input[type="password"]`, `input[type="checkbox"]` default-unchecked,
  `button[type="submit"]`).
- Keep the disabled-when-empty and submit-semantics logic unchanged:
  clearing the field on a successful exchange, retaining it on failure or a
  thrown callback, disabling all controls while submitting.
- Decorative mega-typography / background text must be a `<div>` (or span),
  **not** a heading. `aria-hidden` on a heading element triggers an svelte-check
  a11y warning (`a11y_hidden`), and the lint gate treats warnings as failures,
  so the production build breaks. Use a real heading (`<h1>`/`<h2>`) only for
  the document's primary title; hide purely visual text as a non-heading
  element.

Evidence: 08-14 auth-page-redesign twice rebuilt `AuthPage.svelte` — first
into a particle-canvas scene, then (08-15) into the current calm card — while
keeping every `AuthPage.test.ts` assertion green.

## Auth Page

The auth stage is deliberately quiet and shares the app's design language
(08-15 rebuild):

- `AuthScene` owns the backdrop and the centering; `AuthPage` and the
  `unavailable` state each render only a card, so all three auth states share
  one shape and one position.
- The backdrop is two low-contrast CSS radial glows (`--auth-glow-1/2`, the
  only auth-specific tokens). No canvas, no rAF loop, no pointer tracking —
  atmosphere must not cost a per-frame budget.
- Everything else reads the ordinary `--surface` / `--text` / `--border` /
  `--accent` tokens, so the page is genuinely light in the light theme instead
  of a permanently dark stage.
- Depth comes from `color-mix(in srgb, var(--text) N%, transparent)` over the
  card, not from new hard-coded tints.
- Primary actions use the shared `PrimaryButton` (`background: var(--text)`),
  the same language as the composer's send button — do not hand-roll an
  accent-colored CTA for one page. Snippet content is compiled in the parent's
  scope, so the caller can still style the label/glyph row it passes in.
- A rejected login is expressed **on the token field**, not in a separate
  panel: danger border/tint, the key glyph swapped for an alert glyph, one
  400ms shake, and the `[role="alert"]` message as the field's caption
  (`aria-invalid` + `aria-describedby` on the input). Editing the token clears
  all of it. Only a locally rejected submit paints the field — a message that
  arrives without one (session expiry) explains itself without reddening an
  empty field.
- Restart a CSS animation by flushing the class removal (`await tick()`) and
  forcing a style recalc (`void el.offsetWidth`) before re-adding it. A
  same-batch off/on is coalesced away, and a `requestAnimationFrame` callback
  never runs while the tab is hidden.
- The theme control is a three-segment radio pill (native radios in labels for
  grouping and arrow-key roving); a keyboard-only ring via
  `:has(input:focus-visible)` keeps mouse clicks from leaving a ring behind.

## Common Failure Modes

- Updating the visible stream after the user switches conversations;
- forcing scroll-to-bottom after the user intentionally scrolls upward;
- storing auth tokens in component or localStorage state;
- using toast-only errors for a failed message;
- allowing the model selector to change a non-empty conversation;
- putting `aria-hidden` on a heading element — breaks the lint/build gate; use a
  non-heading element for decorative typography.

