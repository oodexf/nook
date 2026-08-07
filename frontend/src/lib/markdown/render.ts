/**
 * Safe Markdown rendering (Phase F-04; spec: component-guidelines.md
 * §Markdown, quality-guidelines.md §Security Gate, design.md §12/§15).
 *
 * Pipeline, applied once per persisted/final assistant message:
 *
 * 1. Parse with one maintained parser (`marked`, GFM + line breaks). Raw
 *    HTML in the source is not honored: anything the parser passes through
 *    is treated as untrusted markup by the next stage.
 * 2. Sanitize with one maintained sanitizer (`DOMPurify`) against an
 *    explicit tag/attribute allow-list. Scripts, event attributes,
 *    iframes, forms, unsafe SVG, remote embeds (img/video/audio/...), and
 *    style tags have no allowed carrier and are stripped; URLs are limited
 *    to http/https/mailto/tel plus relative and fragment links, so
 *    `javascript:`, `vbscript:`, and `data:` payloads are rejected.
 * 3. A post-sanitize hook hardens surviving links (`target=_blank` with
 *    `noopener noreferrer`).
 *
 * The returned string is sanitized HTML. `MarkdownContent` is the only
 * component allowed to insert it into the DOM; streamed deltas never reach
 * this module (the streaming overlay renders plain text until terminal).
 *
 * Dependencies were added under the Phase F requirement R3/AC-07 with a
 * bundle-impact review recorded in the task report.
 */

import DOMPurify from "dompurify";
import { Marked } from "marked";

const parser = new Marked({
  gfm: true,
  breaks: true
});

const ALLOWED_TAGS = [
  "a",
  "p",
  "br",
  "hr",
  "pre",
  "code",
  "blockquote",
  "ul",
  "ol",
  "li",
  "em",
  "strong",
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td"
];

const ALLOWED_ATTR = ["href", "title", "class"];

// Explicit scheme allow-list: http(s), mailto, tel, plus relative URLs and
// fragments. Everything else (`javascript:`, `vbscript:`, `data:`, `file:`,
// protocol-relative smuggling with embedded schemes, ...) is dropped.
const ALLOWED_URI =
  /^(?:(?:https?|mailto|tel):|(?:[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$)))/i;

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false
};

let linkHookInstalled = false;

function ensureLinkHook(): void {
  if (linkHookInstalled) return;
  linkHookInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      // Chat content opens outside the app: never give it window access
      // or referral leakage, and keep the current tab untouched.
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

/**
 * Parses and sanitizes one final message. Input is untrusted (database
 * content can contain hostile Markdown); the output is safe for the single
 * sanitized `{@html}` insertion point in `MarkdownContent`.
 */
export function renderMarkdown(source: string): string {
  ensureLinkHook();
  const parsed = parser.parse(source, { async: false });
  return DOMPurify.sanitize(parsed, PURIFY_CONFIG);
}
