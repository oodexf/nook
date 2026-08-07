<script lang="ts">
  import { copyText } from "../clipboard/copy-text";
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
  };

  const { content, ariaLabel = "消息内容" }: Props = $props();

  const COPY_LABEL = "复制代码";
  const COPIED_LABEL = "已复制";
  const FAILED_LABEL = "复制失败";
  const FEEDBACK_MS = 1600;

  let root = $state<HTMLElement | null>(null);

  // Parsed + sanitized exactly once per distinct content value.
  const html = $derived(renderMarkdown(content));

  function codeTextOf(pre: HTMLElement): string {
    return pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
  }

  function attachCopyButton(pre: HTMLElement): void {
    if (pre.querySelector(":scope > .code-copy") !== null) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = COPY_LABEL;
    button.addEventListener("click", () => {
      void copyText(codeTextOf(pre)).then((ok) => {
        button.textContent = ok ? COPIED_LABEL : FAILED_LABEL;
        // The text change doubles as the status announcement; the button
        // keeps focus, so screen readers re-read its name.
        window.setTimeout(() => {
          button.textContent = COPY_LABEL;
        }, FEEDBACK_MS);
      });
    });
    pre.appendChild(button);
  }

  // Re-enhance whenever the sanitized markup re-renders. Effects run after
  // DOM updates, so the fresh `pre` nodes are in place.
  $effect(() => {
    void html;
    const element = root;
    if (!element) return;
    for (const pre of element.querySelectorAll<HTMLElement>("pre")) {
      attachCopyButton(pre);
    }
  });
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- the single sanctioned sanitized-HTML insertion point (quality-guidelines.md §Forbidden Patterns); `html` is always the output of renderMarkdown (parse + DOMPurify allow-list). -->
<div class="markdown" bind:this={root} aria-label={ariaLabel}>{@html html}</div>

<style>
  .markdown {
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

  /* Code blocks scroll internally instead of widening the page. */
  .markdown :global(pre) {
    position: relative;
    overflow-x: auto;
    padding: var(--space-3);
    padding-top: calc(var(--touch-target) + var(--space-3));
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

  /* Injected by the component after sanitization (real DOM node). */
  .markdown :global(.code-copy) {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    min-width: var(--touch-target);
    min-height: var(--touch-target);
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    background: var(--surface);
    font-size: 0.72rem;
    font-weight: 650;
    cursor: pointer;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .markdown :global(.code-copy):hover {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-muted);
  }
</style>
