/**
 * Shared compact copy control (Phase I-02; spec: component-guidelines.md
 * §Accessibility, quality-guidelines.md §Browser and Accessibility Gate).
 *
 * One implementation backs both Svelte views (via `CopyButton.svelte`) and
 * the post-sanitize code-block enhancement in `MarkdownContent`, so message
 * and code copy actions behave identically:
 *
 * - compact icon-only button with an accessible name (`aria-label` +
 *   `title`); the visual glyph stays small while the hit area keeps the
 *   44px touch target (`.copy-button` in global.css);
 * - resting border is transparent; hover, keyboard focus, copied, and
 *   failed states show a visible border (never hover-only);
 * - copied/failed feedback is exposed through `data-state` and announced
 *   via an adjacent polite live region, not a toast.
 */

import { copyText } from "./copy-text";

export type CopyControlOptions = {
  /** Base accessible name, e.g. "复制助手消息内容". */
  label: string;
  /** Polite announcement after a successful copy. */
  copiedAnnouncement: string;
  /** Polite announcement after a failed copy. */
  failedAnnouncement: string;
  /** Reads the text to copy at click time (never stale). */
  getText: () => string;
};

export type CopyControl = {
  button: HTMLButtonElement;
  status: HTMLSpanElement;
  destroy: () => void;
};

const FEEDBACK_MS = 1000;

// Trusted static icon markup (compact overlapping-rectangles "copy" glyph
// plus a "check" glyph for the copied state; CSS swaps them via
// `data-state`). This is application-owned markup appended after
// sanitization; it never carries user content, so the Markdown sanitizer
// is not involved.
const COPY_ICON_SVG =
  '<svg class="icon-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
const CHECK_ICON_SVG =
  '<svg class="icon-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';

export function createCopyControl(options: CopyControlOptions): CopyControl {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.dataset.state = "idle";
  button.setAttribute("aria-label", options.label);
  button.title = options.label;
  button.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;

  const status = document.createElement("span");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  let timer: ReturnType<typeof setTimeout> | null = null;

  button.addEventListener("click", () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void copyText(options.getText()).then((ok) => {
      button.dataset.state = ok ? "copied" : "failed";
      status.textContent = ok
        ? options.copiedAnnouncement
        : options.failedAnnouncement;
      timer = setTimeout(() => {
        timer = null;
        button.dataset.state = "idle";
        status.textContent = "";
      }, FEEDBACK_MS);
    });
  });

  return {
    button,
    status,
    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
