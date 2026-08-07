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
      DraftModelSelector
      AutoResizeTextarea
      SendOrStopButton
    ConfirmDialog
    ToastRegion
```

`DraftModelSelector` is only interactive before the first message. Existing
conversations show a non-editable model label.

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

Raw HTML, iframes, unsafe SVG, remote embeds, event attributes, and dangerous
URL schemes are disabled.

## Common Failure Modes

- Updating the visible stream after the user switches conversations;
- forcing scroll-to-bottom after the user intentionally scrolls upward;
- storing auth tokens in component or localStorage state;
- using toast-only errors for a failed message;
- allowing the model selector to change a non-empty conversation.

