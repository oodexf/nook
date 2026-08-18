<script lang="ts">
  import { createCopyControl } from "../clipboard/copy-control";
  import { renderMarkdown } from "./render";

  /**
   * The single sanitized-HTML insertion point in the app (spec:
   * component-guidelines.md §Markdown; quality-guidelines.md forbids raw
   * `{@html}` anywhere else).
   *
   * - Input is final/persisted message content; the parse+sanitize runs
   *   once per content change (derived memo), never per stream delta.
   * - Every fenced code block gets an accessible copy control injected
   *   after sanitization as a real DOM button (not HTML strings), so the
   *   sanitizer configuration stays the only markup authority.
   */
  type Props = {
    content: string;
    /** Accessible name for the rendered region (e.g. the speaker). */
    ariaLabel?: string;
    /**
     * Suppresses the injected code-block copy controls while still
     * rendering sanitized Markdown live. Used for non-terminal streaming
     * snapshots, where the markup is recreated per throttle tick and an
     * interactive control would be exposed on transient content;
     * persisted/terminal output keeps the controls.
     */
    suppressCodeCopy?: boolean;
  };

  const {
    content,
    ariaLabel = "消息内容",
    suppressCodeCopy = false
  }: Props = $props();

  const COPY_LABEL = "复制代码";

  let root = $state<HTMLElement | null>(null);

  // Parsed + sanitized exactly once per distinct content value.
  const html = $derived(renderMarkdown(content));

  function codeTextOf(pre: HTMLElement): string {
    return pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
  }

  function attachCopyButton(pre: HTMLElement): void {
    if (pre.querySelector(":scope > .copy-slot") !== null) return;
    // The same shared control as message-level copy (Phase I-02): compact
    // icon button with accessible name and polite copied/failed feedback.
    const control = createCopyControl({
      label: COPY_LABEL,
      copiedAnnouncement: "代码已复制到剪贴板",
      failedAnnouncement: "复制失败，请手动选择文本复制",
      getText: () => codeTextOf(pre)
    });
    const slot = document.createElement("span");
    slot.className = "copy-slot";
    slot.append(control.button, control.status);
    pre.appendChild(slot);
  }

  // Re-enhance whenever the sanitized markup re-renders. Effects run after
  // DOM updates, so the fresh `pre` nodes are in place. Suppressed
  // snapshots simply skip injection; the next non-suppressed render
  // attaches the controls to the fresh nodes.
  $effect(() => {
    void html;
    const element = root;
    if (!element || suppressCodeCopy) return;
    for (const pre of element.querySelectorAll<HTMLElement>("pre")) {
      attachCopyButton(pre);
    }
  });
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- the single sanctioned sanitized-HTML insertion point (quality-guidelines.md §Forbidden Patterns); `html` is always the output of renderMarkdown (parse + DOMPurify allow-list). -->
<div class="markdown" bind:this={root} aria-label={ariaLabel}>{@html html}</div>

<style>
  .markdown {
    min-width: 0;
    max-width: 100%;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }

  .markdown > :global(:first-child) {
    margin-top: 0;
  }

  .markdown > :global(:last-child) {
    margin-bottom: 0;
  }

  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(blockquote),
  .markdown :global(pre),
  .markdown :global(table) {
    margin: var(--space-3) 0;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: var(--space-4) 0 var(--space-2);
    letter-spacing: -0.01em;
    line-height: 1.35;
  }

  .markdown :global(h1) {
    font-size: 1.25rem;
  }

  .markdown :global(h2) {
    font-size: 1.15rem;
  }

  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    font-size: 1rem;
  }

  .markdown :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .markdown :global(code) {
    padding: 0.1em 0.35em;
    border-radius: 6px;
    background: var(--surface-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.86em;
  }

  /* Code blocks scroll internally instead of widening the page. The code
     starts flush at the top: the copy control no longer reserves layout
     space because it is revealed on hover/focus only (see below). */
  .markdown :global(pre) {
    position: relative;
    overflow-x: auto;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-muted);
  }

  .markdown :global(pre code) {
    padding: 0;
    background: transparent;
    font-size: 0.82rem;
    line-height: 1.6;
    white-space: pre;
  }

  /* Task list markers. The renderer emits an inert `span`, never an
     `input`, so the checkbox is drawn here. The checked state is expressed
     by the `::after` tick geometry as well as color, so it stays legible
     without color perception and at low contrast. */
  .markdown :global(li.task-item) {
    list-style: none;
  }

  .markdown :global(.task-marker) {
    display: inline-block;
    position: relative;
    width: 1em;
    height: 1em;
    margin-right: 0.15em;
    border: 1.5px solid var(--border-strong);
    border-radius: 4px;
    background: var(--surface);
    vertical-align: -0.15em;
  }

  .markdown :global(.task-marker-checked) {
    border-color: var(--accent);
    background: var(--accent);
  }

  .markdown :global(.task-marker-checked)::after {
    content: "";
    position: absolute;
    top: 0.08em;
    left: 0.3em;
    width: 0.28em;
    height: 0.55em;
    border: solid var(--accent-contrast);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  /* Keep sub/sup from stretching the line box (chemistry, units, footnotes). */
  .markdown :global(sub),
  .markdown :global(sup) {
    position: relative;
    font-size: 0.75em;
    line-height: 0;
    vertical-align: baseline;
  }

  .markdown :global(sup) {
    top: -0.5em;
  }

  .markdown :global(sub) {
    bottom: -0.25em;
  }

  /* Footnotes render as visible text (never as a link); the reference is a
     superscript marker and the definition a muted trailing line. */
  .markdown :global(.footnote-ref) {
    color: var(--muted);
  }

  .markdown :global(.footnote-def) {
    color: var(--muted);
    font-size: 0.9em;
  }

  .markdown :global(details) {
    margin: var(--space-3) 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .markdown :global(summary) {
    cursor: pointer;
    font-weight: 600;
  }

  .markdown :global(blockquote) {
    padding-left: var(--space-3);
    border-left: 3px solid var(--border-strong);
    color: var(--muted);
  }

  .markdown :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    font-size: 0.9rem;
  }

  .markdown :global(th),
  .markdown :global(td) {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    text-align: left;
  }

  .markdown :global(th) {
    background: var(--surface-muted);
  }

  /* KaTeX's internal positioning is owned by its self-hosted stylesheet.
     These rules affect only the outer formula states: inline math follows
     the surrounding baseline, while display math scrolls locally on narrow
     screens instead of widening the message lane or page. */
  .markdown :global(.katex) {
    font-size: 1em;
  }

  .markdown :global(.katex-display) {
    max-width: 100%;
    margin: var(--space-4) 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding-block: var(--space-1);
    text-align: center;
    -webkit-overflow-scrolling: touch;
  }

  .markdown :global(.katex-display > .katex) {
    display: inline-block;
    min-width: max-content;
    text-align: initial;
  }

  .markdown :global(.katex-error) {
    color: var(--danger);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    white-space: pre-wrap;
    user-select: text;
  }

  .markdown :global(.katex-error-display) {
    display: block;
    max-width: 100%;
    margin: var(--space-4) 0;
    overflow-x: auto;
    white-space: pre;
  }

  /* Injected by the component after sanitization (real DOM node); the
     shared `.copy-button` chrome lives in global.css, only the code-block
     placement is local. Hidden until the block is hovered or the button
     itself receives keyboard focus (focus-within), so the code stays
     flush while the control remains keyboard reachable. */
  .markdown :global(pre .copy-button) {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    border-color: var(--border);
    background: var(--surface);
    opacity: 0;
    transition:
      opacity var(--motion-fast),
      border-color var(--motion-fast),
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .markdown :global(pre:hover .copy-button),
  .markdown :global(pre:focus-within .copy-button) {
    opacity: 1;
  }
</style>
