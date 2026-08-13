# Frontend Quality Guidelines

## Required Checks

Phase A selects the exact tools and scripts. The gate must include:

- formatting;
- Svelte/TypeScript type-check;
- lint with no warnings;
- unit/component tests;
- production build;
- browser E2E for critical flows.

The concrete Phase A commands are:

```text
npm --prefix frontend run check
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
```

Vitest is the unit-test runner, `svelte-check` is the Svelte/TypeScript gate,
and ESLint runs with warnings treated as failures. `make check-frontend`
executes the complete frontend gate.

## Test Responsibilities

### Unit

- API/error decoders;
- SSE chunk and Unicode handling;
- state reducers/transitions;
- localStorage validation;
- existing-conversation model mutation and historical fallback logic;
- Markdown sanitizer configuration.

### Component

- auth form and Remember me default;
- composer Enter/Shift+Enter/IME behavior;
- model selector visibility/locking;
- inline generation errors;
- delete confirmation;
- keyboard and focus behavior.

### E2E

- first visit, invalid login, valid login, sign-out;
- session-only and remembered authentication;
- model fetch/select/persist/switch lockout;
- stream, cancel, partial output, retry;
- refresh and container-backed history;
- rename and delete;
- mobile viewport and software keyboard;
- expired authentication during use.

## Browser and Accessibility Gate

Automated browser coverage includes Chromium. Release validation additionally
checks current Safari and iOS Safari.

Required:

- keyboard-only primary flow;
- visible focus;
- 44×44 touch targets;
- 4.5:1 normal-text contrast;
- reduced-motion support;
- controlled live-region announcements;
- no horizontal page scroll at documented viewports.

## Security Gate

Markdown tests cover:

```text
script
event attributes
javascript: URLs
dangerous data: URLs
iframe
unsafe SVG
malformed HTML
raw-source attempts to forge formula placeholders, KaTeX classes, style, or SVG
untrusted TeX URL/HTML commands under trust:false
```

Formula tests must also prove the positive isolated lane retains visual KaTeX,
MathML accessibility, verified numeric layout style, and required SVG/path
geometry. Never broaden ordinary Markdown style/SVG/URL permissions to make a
formula render.

Browser bundle inspection confirms provider credentials and instance token are
absent.

## Performance Gate

- Production compressed initial assets target under 250 KB, measured rather
  than assumed. The gate is the browser's actual initial JS + CSS transfer;
  self-hosted formula fonts requested on demand by CSS are reported separately,
  together with the all-formula-asset total.
- Streaming UI batches updates to animation frames.
- A 100 KB response remains interactive.
- Long histories do not trigger parsing of every message on every delta.

Targets may be revised only with recorded measurements and an approved design
change.

## Forbidden Patterns

- direct `fetch` in components;
- raw `{@html}` outside the single sanitized Markdown component;
- token or CSRF persistence;
- catch-all global store;
- model changes during an active generation;
- toast-only message failure;
- auto-scroll that overrides deliberate user scrolling;
- visual-only icon buttons;
- dependency addition without a requirement and bundle impact review.

## Review Checklist

- Is every network payload decoded centrally?
- Can navigation cause a stream to update the wrong conversation?
- Are loading, empty, error, stopped, interrupted, and completed states distinct?
- Does the change work with keyboard, IME, mobile, and reduced motion?
- Does sanitized content remain the only HTML insertion path?
- Are server state and transient UI state clearly separated?
- Are auth expiry and CSRF failures recoverable?
