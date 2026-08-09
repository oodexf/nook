/**
 * Safe assistant Markdown rendering.
 *
 * Ordinary Markdown and KaTeX deliberately have separate provenance lanes:
 *
 * 1. `marked-katex-extension` recognizes the approved dollar syntax, but its
 *    renderers emit per-call cryptographic placeholders rather than HTML.
 * 2. Marked's complete ordinary HTML is sanitized with the original strict
 *    policy. That policy still has no `style`, MathML, or SVG permission.
 * 3. Only formulas recorded in the current in-memory render context are
 *    rendered by KaTeX (`trust: false`) and sanitized with the KaTeX-only
 *    policy below. A fragment is inserted only at its own surviving marker.
 *
 * The public API stays synchronous and `MarkdownContent` remains the only
 * `{@html}` boundary.
 */

import DOMPurify from "dompurify";
import katex from "katex";
import { Marked, type Tokens } from "marked";
import markedKatex from "marked-katex-extension";

const STRICT_ALLOWED_TAGS = [
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

const STRICT_ALLOWED_ATTR = ["href", "title", "class"];

// Explicit scheme allow-list: http(s), mailto, tel, plus relative URLs and
// fragments. The KaTeX lane permits no URL-bearing attribute at all.
const ALLOWED_URI =
  /^(?:(?:https?|mailto|tel):|(?:[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$)))/i;

const STRICT_PURIFY_CONFIG = {
  ALLOWED_TAGS: STRICT_ALLOWED_TAGS,
  ALLOWED_ATTR: STRICT_ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false
};

/** Tags observed in the fixed common-formula corpus covered by tests. */
const KATEX_ALLOWED_TAGS = [
  "span",
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mo",
  "mn",
  "mtext",
  "mspace",
  "mstyle",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mover",
  "munder",
  "munderover",
  "mtable",
  "mtr",
  "mtd",
  "menclose",
  "svg",
  "path",
  "line"
];

/** No href/src/xlink or other URL carrier is present in this list. */
const KATEX_ALLOWED_ATTR = [
  "class",
  "style",
  "aria-hidden",
  "xmlns",
  "display",
  "encoding",
  "accent",
  "accentunder",
  "columnalign",
  "columnspacing",
  "displaystyle",
  "fence",
  "linethickness",
  "mathvariant",
  "notation",
  "rowspacing",
  "scriptlevel",
  "stretchy",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "d",
  "x1",
  "x2",
  "y1",
  "y2",
  "stroke-width"
];

/**
 * Class names are not allow-listed here. They come only from KaTeX's
 * `trust: false` output after a current-render placeholder is matched, and
 * KaTeX legitimately adds command- and layout-specific classes over time.
 * Restricting them to a handwritten corpus would silently break rendering.
 */
const KATEX_PURIFY_CONFIG = {
  ALLOWED_TAGS: KATEX_ALLOWED_TAGS,
  ALLOWED_ATTR: KATEX_ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false
};

const KATEX_STYLE_PROPERTIES = new Set([
  "border-bottom-width",
  "height",
  "left",
  "margin-left",
  "margin-right",
  "min-width",
  "padding-left",
  "position",
  "top",
  "vertical-align",
  "width"
]);

// KaTeX 0.17 emits only numeric layout values (unitless, em, or percent),
// plus `position:relative`, for the supported corpus. This intentionally
// excludes url(), CSS variables, colors, transforms, and arbitrary tokens.
const KATEX_NUMERIC_STYLE_VALUE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|%)?$/;

function isAllowedKatexStyle(style: string): boolean {
  const declarations = style.split(";").filter((part) => part.trim() !== "");
  if (declarations.length === 0) return false;

  return declarations.every((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 1) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (!KATEX_STYLE_PROPERTIES.has(property)) return false;
    return (
      (property === "position" && value === "relative") ||
      (property !== "position" && KATEX_NUMERIC_STYLE_VALUE.test(value))
    );
  });
}

type MathRecord = {
  marker: string;
  tex: string;
  displayMode: boolean;
};

type MathRenderContext = {
  nonce: string;
  records: Map<string, MathRecord>;
};

let activeMathContext: MathRenderContext | null = null;

function randomNonce(): string {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(36)).join("-");
}

function placeholderFor(token: Tokens.Generic): string {
  const context = activeMathContext;
  if (context === null) {
    throw new Error("Math renderer used outside renderMarkdown");
  }

  const index = context.records.size;
  const marker = `math-${context.nonce}-${index}`;
  context.records.set(marker, {
    marker,
    tex: String(token.text ?? ""),
    displayMode: token.displayMode === true
  });

  // `code` and `title` already belong to the strict Markdown policy. No
  // privileged class/data attribute is needed for a placeholder.
  return `<code title="${marker}">${marker}</code>`;
}

const SAFE_KATEX_OPTIONS = {
  output: "htmlAndMathml" as const,
  strict: "warn" as const,
  trust: false,
  maxSize: 50
};

const mathExtension = markedKatex({
  ...SAFE_KATEX_OPTIONS,
  throwOnError: false,
  nonStandard: false
});

// marked-katex-extension also recognizes inline `$$...$$` and block
// `$...$`. Narrow its tokenizers to the product syntax: one dollar inline,
// and line-isolated double dollars for display math.
for (const extension of mathExtension.extensions ?? []) {
  if (extension.name === "inlineKatex" && "tokenizer" in extension) {
    const tokenize = extension.tokenizer;
    extension.tokenizer = function (source, tokens) {
      const token = tokenize.call(this, source, tokens);
      return token?.displayMode === true ? undefined : token;
    };
  }
  if (extension.name === "blockKatex" && "tokenizer" in extension) {
    const tokenize = extension.tokenizer;
    extension.start = (source) => {
      const match = /(?:^|\n)(?=\$\$\n)/.exec(source);
      return match === null ? undefined : match.index + match[0].length;
    };
    extension.tokenizer = function (source, tokens) {
      const token = tokenize.call(this, source, tokens);
      return token?.displayMode === true ? token : undefined;
    };
  }
  if (
    (extension.name === "inlineKatex" || extension.name === "blockKatex") &&
    "renderer" in extension
  ) {
    extension.renderer = placeholderFor;
  }
}

const parser = new Marked({ gfm: true, breaks: true });
parser.use(mathExtension);

let sanitizerHooksInstalled = false;

function ensureSanitizerHooks(): void {
  if (sanitizerHooksInstalled) return;
  sanitizerHooksInstalled = true;

  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style" && !isAllowedKatexStyle(data.attrValue)) {
      data.keepAttr = false;
    }
  });

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

function stripSourceKatexIdentity(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[class]")) {
    const kept = Array.from(element.classList).filter(
      (className) => className !== "katex" && !className.startsWith("katex-")
    );
    if (kept.length === 0) element.removeAttribute("class");
    else element.setAttribute("class", kept.join(" "));
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderKatex(record: MathRecord): string {
  let generated: string;
  try {
    generated = katex.renderToString(record.tex, {
      ...SAFE_KATEX_OPTIONS,
      throwOnError: true,
      displayMode: record.displayMode
    });
  } catch {
    const classes = record.displayMode
      ? "katex-error katex-error-display"
      : "katex-error";
    generated = `<span class="${classes}">${escapeHtml(record.tex)}</span>`;
  }

  return DOMPurify.sanitize(generated, KATEX_PURIFY_CONFIG);
}

function insertRecordedMath(
  sanitizedMarkdown: string,
  context: MathRenderContext
): string {
  const template = document.createElement("template");
  template.innerHTML = sanitizedMarkdown;
  stripSourceKatexIdentity(template.content);

  for (const candidate of template.content.querySelectorAll<HTMLElement>(
    "code[title]"
  )) {
    const marker = candidate.getAttribute("title");
    if (marker === null || candidate.textContent !== marker) continue;
    const record = context.records.get(marker);
    if (record === undefined || record.marker !== marker) continue;

    const fragmentTemplate = document.createElement("template");
    fragmentTemplate.innerHTML = renderKatex(record);
    candidate.replaceWith(fragmentTemplate.content);
    context.records.delete(marker);
  }

  return template.innerHTML;
}

/**
 * Parses and sanitizes one assistant message. Input is untrusted persisted or
 * streamed text; output is safe for `MarkdownContent`'s single HTML boundary.
 */
export function renderMarkdown(source: string): string {
  ensureSanitizerHooks();
  const context: MathRenderContext = {
    nonce: randomNonce(),
    records: new Map()
  };

  if (activeMathContext !== null) {
    throw new Error("renderMarkdown must not be called re-entrantly");
  }

  activeMathContext = context;
  let parsed: string;
  try {
    parsed = parser.parse(source, { async: false });
  } finally {
    activeMathContext = null;
  }

  const strictHtml = DOMPurify.sanitize(parsed, STRICT_PURIFY_CONFIG);
  return insertRecordedMath(strictHtml, context);
}
