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

const INLINE_OPENING_CJK_PUNCTUATION = /[：，。！？；、]/;
const INLINE_CLOSING_BOUNDARY = /[\s?!.,:？！。，：；、]/;

function isEscapedAt(source: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function findClosingDelimiter(
  source: string,
  openingIndex: number,
  delimiterLength: 1 | 2
): number | undefined {
  const delimiter = delimiterLength === 2 ? "$$" : "$";
  let cursor = openingIndex + delimiterLength;

  while (cursor < source.length && source[cursor] !== "\n") {
    const closingIndex = source.indexOf(delimiter, cursor);
    if (closingIndex === -1 || source.slice(cursor, closingIndex).includes("\n")) {
      return undefined;
    }
    if (!isEscapedAt(source, closingIndex)) {
      if (delimiterLength === 2) return closingIndex;

      // A double-dollar pair starts a different formula kind. Treat the
      // current single-dollar opener as unmatched instead of stealing either
      // dollar from a later valid display formula.
      if (source[closingIndex + 1] === "$") return undefined;

      const next = source[closingIndex + 1];
      if (next === undefined || INLINE_CLOSING_BOUNDARY.test(next)) {
        return closingIndex;
      }
    }
    cursor = closingIndex + delimiterLength;
  }
  return undefined;
}

function delimiterLengthAt(source: string, index: number): 1 | 2 {
  return source[index + 1] === "$" ? 2 : 1;
}

function escapedDollarFormEnd(source: string): number {
  const openingIndex = 1;
  const delimiterLength = delimiterLengthAt(source, openingIndex);
  const delimiter = delimiterLength === 2 ? "$$" : "$";
  const candidate = source.indexOf(delimiter, openingIndex + delimiterLength);

  if (
    candidate !== -1 &&
    !source.slice(openingIndex + delimiterLength, candidate).includes("\n") &&
    !isEscapedAt(source, candidate)
  ) {
    const next = source[candidate + delimiterLength];
    // Pair an escaped construct only when its first possible closing delimiter
    // has a valid closing boundary. If that candidate begins later valid math
    // (for example `\$literal then $x$`), consume only the escaped opener so
    // the later formula remains available to the ordinary math tokenizer.
    if (next === undefined || INLINE_CLOSING_BOUNDARY.test(next)) {
      return candidate + delimiterLength;
    }
  }

  return openingIndex + delimiterLength;
}

function findMathStart(source: string): number | undefined {
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf("$", cursor);
    if (index === -1) return undefined;

    if (isEscapedAt(source, index)) {
      cursor = index + delimiterLengthAt(source, index);
      continue;
    }

    const delimiterLength = delimiterLengthAt(source, index);
    if (delimiterLength === 2) {
      // Triple dollars are outside the approved syntax.
      if (source[index + 2] === "$") {
        cursor = index + 3;
        continue;
      }

      const closingIndex = findClosingDelimiter(source, index, 2);
      if (closingIndex !== undefined) {
        // Consume an empty/whitespace-only pair as literal syntax so its
        // closing delimiter cannot be paired with a later valid formula.
        if (source.slice(index + 2, closingIndex).trim() !== "") return index;
        cursor = closingIndex + 2;
        continue;
      }
      cursor = index + 2;
      continue;
    }

    const previous = source[index - 1];
    const hasOpeningBoundary =
      index === 0 ||
      previous === " " ||
      (previous !== undefined && INLINE_OPENING_CJK_PUNCTUATION.test(previous));
    if (!hasOpeningBoundary) {
      cursor = index + 1;
      continue;
    }

    const closingIndex = findClosingDelimiter(source, index, 1);
    if (
      closingIndex !== undefined &&
      source.slice(index + 1, closingIndex).trim() !== ""
    ) {
      return index;
    }
    cursor = closingIndex === undefined ? index + 1 : closingIndex + 1;
  }
  return undefined;
}

function tokenizeMathAtStart(source: string): Tokens.Generic | undefined {
  if (!source.startsWith("$") || isEscapedAt(source, 0)) return undefined;

  const delimiterLength = delimiterLengthAt(source, 0);
  if (delimiterLength === 2 && source[2] === "$") return undefined;
  const closingIndex = findClosingDelimiter(source, 0, delimiterLength);
  if (closingIndex === undefined) return undefined;

  const text = source.slice(delimiterLength, closingIndex).trim();
  if (text === "") return undefined;
  return {
    type: "inlineKatex",
    raw: source.slice(0, closingIndex + delimiterLength),
    text,
    displayMode: delimiterLength === 2
  };
}

function tokenizeEscapedMathAtStart(source: string): Tokens.Generic | undefined {
  if (!source.startsWith("\\$")) return undefined;

  const end = escapedDollarFormEnd(source);
  return {
    type: "escapedKatex",
    raw: source.slice(0, end),
    text: source.slice(1, end)
  };
}

type LatexDelimiter = {
  opening: "\\(" | "\\[";
  closing: "\\)" | "\\]";
  displayMode: boolean;
  allowNewlines: boolean;
};

const LATEX_DELIMITERS: readonly LatexDelimiter[] = [
  {
    opening: "\\(",
    closing: "\\)",
    displayMode: false,
    allowNewlines: false
  },
  {
    opening: "\\[",
    closing: "\\]",
    displayMode: true,
    allowNewlines: true
  }
];

function findUnescapedSequence(
  source: string,
  sequence: string,
  fromIndex: number,
  allowNewlines: boolean
): number | undefined {
  let cursor = fromIndex;
  while (cursor < source.length) {
    const index = source.indexOf(sequence, cursor);
    if (index === -1) return undefined;
    if (!allowNewlines && source.slice(fromIndex, index).includes("\n")) {
      return undefined;
    }
    if (!isEscapedAt(source, index)) return index;
    cursor = index + sequence.length;
  }
  return undefined;
}

function tokenizeLatexMathAtStart(
  source: string
): Tokens.Generic | undefined {
  const delimiter = LATEX_DELIMITERS.find(({ opening }) =>
    source.startsWith(opening)
  );
  if (delimiter === undefined || isEscapedAt(source, 0)) return undefined;

  const contentStart = delimiter.opening.length;
  const closingIndex = findUnescapedSequence(
    source,
    delimiter.closing,
    contentStart,
    delimiter.allowNewlines
  );
  if (closingIndex === undefined) return undefined;

  // Do not let an unmatched outer opener consume a later complete formula.
  // The scanner will retry from the nested opener. Reject both same- and
  // mixed-type nesting so delimiter text is never passed through as TeX.
  const nestedOpening = LATEX_DELIMITERS.map(({ opening }) =>
    findUnescapedSequence(
      source,
      opening,
      contentStart,
      delimiter.allowNewlines
    )
  )
    .filter((index): index is number => index !== undefined)
    .reduce<number | undefined>(
      (earliest, index) =>
        earliest === undefined || index < earliest ? index : earliest,
      undefined
    );
  if (nestedOpening !== undefined && nestedOpening < closingIndex) {
    return undefined;
  }

  const text = source.slice(contentStart, closingIndex).trim();
  if (text === "") return undefined;
  return {
    type: "latexKatex",
    raw: source.slice(0, closingIndex + delimiter.closing.length),
    text,
    displayMode: delimiter.displayMode
  };
}

function findLatexMathStart(source: string): number | undefined {
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf("\\", cursor);
    if (index === -1) return undefined;

    const candidate = source.slice(index);
    const isOpening = LATEX_DELIMITERS.some(({ opening }) =>
      candidate.startsWith(opening)
    );
    if (!isEscapedAt(source, index)) {
      const token = tokenizeLatexMathAtStart(candidate);
      if (token !== undefined) return index;
    }
    // An empty or otherwise invalid closed pair is a literal unit. Skip its
    // closing delimiter so it cannot become an opener of the opposite form.
    if (isOpening) {
      const delimiter = LATEX_DELIMITERS.find(({ opening }) =>
        candidate.startsWith(opening)
      );
      if (delimiter !== undefined) {
        const closingIndex = findUnescapedSequence(
          candidate,
          delimiter.closing,
          delimiter.opening.length,
          delimiter.allowNewlines
        );
        if (closingIndex !== undefined) {
          cursor = index + closingIndex + delimiter.closing.length;
          continue;
        }
      }
    }
    cursor = index + 1;
  }
  return undefined;
}

// Common OpenAI-compatible models emit LaTeX's \(...\) and \[...\]
// delimiters instead of dollar delimiters. Intercept those forms before
// Marked treats their backslashes as Markdown escapes, but retain the same
// per-render placeholder and provenance-isolated KaTeX sanitizer path.
mathExtension.extensions?.push({
  name: "latexKatex",
  level: "inline",
  start(source) {
    return findLatexMathStart(source);
  },
  tokenizer(source) {
    return tokenizeLatexMathAtStart(source);
  },
  renderer: placeholderFor
});

// Treat an escaped dollar opener as literal syntax. A clearly paired escaped
// construct is consumed whole; otherwise only the opener is consumed so an
// unmatched escape cannot steal delimiters from valid math farther right.
mathExtension.extensions?.push({
  name: "escapedKatex",
  level: "inline",
  start(source) {
    const index = source.indexOf("\\$");
    return index === -1 ? undefined : index;
  },
  tokenizer(source) {
    return tokenizeEscapedMathAtStart(source);
  },
  renderer(token) {
    return escapeHtml(String(token.text ?? ""));
  }
});

// marked-katex-extension also recognizes double-dollar formulas as inline
// math and single-dollar formulas as blocks. Own the inline scanner so escaped
// dollar forms and literal empty pairs cannot cross-pair with later formulas.
// Keep one dollar inline, accept any closed non-empty same-line double dollars
// as display math, and retain line-isolated display blocks without broadening
// the sanitizer lanes below.
for (const extension of mathExtension.extensions ?? []) {
  if (extension.name === "inlineKatex" && "tokenizer" in extension) {
    extension.start = findMathStart;
    extension.tokenizer = function (source) {
      return tokenizeMathAtStart(source);
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
      return token?.displayMode === true &&
        String(token.text ?? "").trim() !== ""
        ? token
        : undefined;
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
