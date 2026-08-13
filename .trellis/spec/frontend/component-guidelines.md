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

`ComposerModelSelector` (08-13) is interactive for drafts and existing
conversations: draft selection remains local/persisted in the model store,
while an existing conversation invokes the authenticated server model mutation
and renders the server response as authority. The selector is disabled during
an active generation. Existing conversations also keep a compact current-model
label in the header; historical messages render their own persisted model.

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

## Common Failure Modes

- Updating the visible stream after the user switches conversations;
- forcing scroll-to-bottom after the user intentionally scrolls upward;
- storing auth tokens in component or localStorage state;
- using toast-only errors for a failed message;
- allowing model changes during an active generation.

