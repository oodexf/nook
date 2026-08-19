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
import {
  Marked,
  type TokenizerAndRendererExtension,
  type Tokens
} from "marked";
import markedKatex from "marked-katex-extension";

// `sub`/`sup`/`span`/`details`/`summary` are inert structure only: none of
// them carries a URL attribute, an event semantic, or a script surface, so
// adding them does not give the ordinary lane any style, SVG, MathML, or URL
// capability (quality-guidelines.md §Security Gate).
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
  "sub",
  "sup",
  "span",
  "details",
  "summary",
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

const STRICT_ALLOWED_ATTR = ["href", "title", "class", "open"];

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

/**
 * The complete element set KaTeX 0.17 can emit (derived from its bundle),
 * not just the corpus the first tests happened to cover. `mpadded` and
 * `mphantom` were missing, which silently dropped `\fcolorbox` padding and
 * `\phantom` semantics from the accessibility layer.
 *
 * Known, unfixable gap: KaTeX renders `\stackrel`/`\overset`/`\underset` as
 * `<mo><mover>…</mover></mo>`. HTML's MathML text integration point rules
 * make DOMPurify drop MathML children of `mo`/`mi`/`mn`/`ms`/`mtext`. That
 * only affects the hidden `.katex-mathml` layer; the visual `.katex-html`
 * lane and the `<annotation>` TeX source are unaffected.
 */
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
  "mpadded",
  "mphantom",
  "svg",
  "path",
  "line"
];

/**
 * Every attribute KaTeX 0.17 can set, minus its URL carriers.
 *
 * `href` (`\href`/`\url`), `src` and `alt` (`mglyph`/`\includegraphics`), and
 * `xlink:href` are the only URL-bearing attributes in KaTeX's set. They are
 * unreachable under `trust: false` anyway, and they are permanently excluded
 * here so a future KaTeX change cannot introduce a network or navigation
 * carrier into the message body. Tests lock this exclusion.
 */
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
  "columnlines",
  "columnspacing",
  "depth",
  "displaystyle",
  "fence",
  "largeop",
  "linebreak",
  "linethickness",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "notation",
  "rowlines",
  "rowspacing",
  "rspace",
  "scriptlevel",
  "separator",
  "stretchy",
  "valign",
  "voffset",
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

/**
 * Payload veto (first pass, applied to every declaration regardless of
 * property). A declaration survives only if every character is a letter,
 * digit, `#`, `%`, `.`, `+`, `-`, space, tab, or the `:` separator.
 *
 * This single allow-list closes, without enumerating anything dangerous:
 *
 * - all functional notation — `url()`, `var()`, `expression()`, `image-set()`,
 *   `attr()`, `element()`, `calc()` — because `(` can never appear;
 * - CSS escape sequences such as `\72 ed`, because `\` can never appear;
 * - CSS comment splicing, because neither `/` nor `*` can appear, and
 *   `!important` priority escalation, because `!` can never appear;
 * - markup and entity injection (`<`, `>`, `"`, `'`, `&`) and at-rules (`@`);
 * - control characters, and every non-ASCII code point (so homoglyph and
 *   bidi tricks cannot reach the CSS parser).
 */
const KATEX_STYLE_SAFE_CHARS = /^[a-zA-Z0-9#%.+\- \t:]*$/;

/** Lengths KaTeX emits: unitless zeroes plus em/ex/rem/pt/px/% dimensions. */
const KATEX_LENGTH_TOKEN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|rem|pt|px|%)?$/;

const KATEX_LINE_STYLE_TOKENS = new Set([
  "none",
  "hidden",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset"
]);

// Hex colors (3/4/6/8 digits) or a bare alphabetic keyword. Keywords cover
// `transparent`, `currentcolor`, and the CSS named colors; because no
// parenthesis, comma, or slash can reach here, `rgb()`/`color()` forms and
// any URL-bearing value are already impossible.
const KATEX_COLOR_TOKEN =
  /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+)$/;

type StyleTokenKind = "length" | "lineStyle" | "color";

type StyleRule =
  | { kind: "tokens"; accepts: readonly StyleTokenKind[]; maxTokens: number }
  | { kind: "keyword"; allowed: ReadonlySet<string> };

function tokenRule(
  accepts: readonly StyleTokenKind[],
  maxTokens: number
): StyleRule {
  return { kind: "tokens", accepts, maxTokens };
}

/**
 * The properties KaTeX 0.17 actually writes inline (derived from its bundle),
 * each with the value grammar of its own category. `position` stays limited
 * to `relative`: `absolute`/`fixed` would let a formula fragment escape the
 * message container and overlay the rest of the page (clickjacking surface),
 * and KaTeX's own absolute positioning comes from the self-hosted stylesheet
 * rather than inline styles.
 */
const KATEX_STYLE_RULES = new Map<string, StyleRule>([
  ["height", tokenRule(["length"], 4)],
  ["width", tokenRule(["length"], 4)],
  ["min-width", tokenRule(["length"], 4)],
  ["left", tokenRule(["length"], 4)],
  ["top", tokenRule(["length"], 4)],
  ["bottom", tokenRule(["length"], 4)],
  ["vertical-align", tokenRule(["length"], 4)],
  ["margin", tokenRule(["length"], 4)],
  ["margin-left", tokenRule(["length"], 4)],
  ["margin-right", tokenRule(["length"], 4)],
  ["margin-top", tokenRule(["length"], 4)],
  ["margin-bottom", tokenRule(["length"], 4)],
  ["padding-left", tokenRule(["length"], 4)],
  ["border-width", tokenRule(["length"], 4)],
  ["border-top-width", tokenRule(["length"], 4)],
  ["border-right-width", tokenRule(["length"], 4)],
  ["border-bottom-width", tokenRule(["length"], 4)],
  ["border-left-width", tokenRule(["length"], 4)],
  ["border-style", tokenRule(["lineStyle"], 4)],
  ["border-top-style", tokenRule(["lineStyle"], 4)],
  ["border-right-style", tokenRule(["lineStyle"], 4)],
  ["border-bottom-style", tokenRule(["lineStyle"], 4)],
  ["border-left-style", tokenRule(["lineStyle"], 4)],
  ["color", tokenRule(["color"], 4)],
  ["background-color", tokenRule(["color"], 4)],
  ["border-color", tokenRule(["color"], 4)],
  ["border-top-color", tokenRule(["color"], 4)],
  ["border-right-color", tokenRule(["color"], 4)],
  ["border-bottom-color", tokenRule(["color"], 4)],
  ["border-left-color", tokenRule(["color"], 4)],
  ["border", tokenRule(["length", "lineStyle", "color"], 3)],
  ["text-shadow", tokenRule(["length", "color"], 8)],
  ["position", { kind: "keyword", allowed: new Set(["relative"]) }]
]);

function matchesTokenKind(kind: StyleTokenKind, token: string): boolean {
  switch (kind) {
    case "length":
      return KATEX_LENGTH_TOKEN.test(token);
    case "lineStyle":
      return KATEX_LINE_STYLE_TOKENS.has(token);
    case "color":
      return KATEX_COLOR_TOKEN.test(token);
  }
}

function filterKatexDeclaration(declaration: string): string | undefined {
  if (declaration.trim() === "") return undefined;
  if (!KATEX_STYLE_SAFE_CHARS.test(declaration)) return undefined;

  const separator = declaration.indexOf(":");
  if (separator < 1) return undefined;
  const property = declaration.slice(0, separator).trim().toLowerCase();
  const value = declaration.slice(separator + 1).trim().toLowerCase();
  if (property === "" || value === "") return undefined;

  const rule = KATEX_STYLE_RULES.get(property);
  if (rule === undefined) return undefined;
  if (rule.kind === "keyword") {
    return rule.allowed.has(value) ? `${property}:${value}` : undefined;
  }

  const tokens = value.split(/[ \t]+/);
  if (tokens.length > rule.maxTokens) return undefined;
  const accepted = tokens.every((token) =>
    rule.accepts.some((kind) => matchesTokenKind(kind, token))
  );
  return accepted ? `${property}:${tokens.join(" ")}` : undefined;
}

/**
 * Rewrites a KaTeX `style` attribute declaration by declaration: legal
 * declarations are kept, illegal ones are dropped, and the survivors are
 * re-serialized. An empty result means nothing survived and the caller drops
 * the whole attribute.
 *
 * The previous all-or-nothing check discarded the entire attribute whenever
 * one declaration was unrecognized, which is what made `\phantom` visible and
 * collapsed `\boxed`. Per-declaration filtering does not widen the attack
 * surface: that surface is defined by the property and value grammars above,
 * each of which every surviving declaration passes on its own.
 *
 * Exported for the security matrix: `trust: false` KaTeX cannot be coerced
 * into emitting the hostile values this function must reject, so the payload
 * cases are unreachable through the pipeline alone.
 */
export function filterKatexStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const filtered = filterKatexDeclaration(declaration);
    if (filtered !== undefined) kept.push(filtered);
  }
  return kept.join(";");
}

type SanitizerLane = "strict" | "katex";

// The `uponSanitizeAttribute` hook is installed on the shared DOMPurify
// instance, so it fires for both lanes. The marker makes the lane explicit
// instead of relying on `style` being absent from the strict `ALLOWED_ATTR`.
let activeLane: SanitizerLane = "strict";

function sanitizeIn(
  lane: SanitizerLane,
  html: string,
  config: Parameters<typeof DOMPurify.sanitize>[1]
): string {
  activeLane = lane;
  try {
    return DOMPurify.sanitize(html, config);
  } finally {
    // Fail closed: any throw returns to the most restrictive lane rather than
    // leaking KaTeX style permission into the next ordinary render.
    activeLane = "strict";
  }
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

// Footnotes: Marked has no footnote support, so `[^1]: text` was consumed as
// a link reference definition and `[^1]` became an anchor pointing at a
// non-existent relative path while the note body disappeared. Both forms are
// recognized here and rendered as visible, inert text. Neither emits an
// `href`, so no URL surface is added. Only the `[^` prefix is claimed, which
// leaves ordinary reference definitions (`[ref]: url`) and reference links
// (`[text][ref]`) untouched.
// The label bound is generous rather than tight: a definition line this
// extension declines is swallowed by Marked's own `def` tokenizer, which
// discards the note body silently — the exact failure R8 exists to prevent.
// The bound only guards against a pathological single-line label; both classes
// exclude `]` and `\n`, so matching stays linear.
const FOOTNOTE_REFERENCE = /^\[\^([^\]\s][^\]\n]{0,255})\]/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\n]{1,256})\]:[ \t]*([^\n]*)(?:\n|$)/;
const FOOTNOTE_DEFINITION_SCAN = /^ {0,3}\[\^([^\]\n]{1,256})\]:/gm;

const NO_FOOTNOTE_LABELS: ReadonlySet<string> = new Set();

/**
 * References are recognized only in pairs (R8). `[^…]` is ordinary prose far
 * more often than it is a footnote — regex character classes (`[^a-z]`) and
 * array indexing (`array[^2]`) both hit the same shape — so an unpaired
 * reference must stay literal text instead of becoming a superscript that
 * silently drops its caret. Definitions need no pairing: `[^` can never begin
 * an ordinary link reference definition.
 */
let activeFootnoteLabels: ReadonlySet<string> = NO_FOOTNOTE_LABELS;

function collectFootnoteLabels(source: string): ReadonlySet<string> {
  const labels = new Set<string>();
  // Marked normalizes line endings before lexing; match that here so a CRLF
  // document pairs exactly the same way.
  for (const match of source.replace(/\r\n?/g, "\n").matchAll(
    FOOTNOTE_DEFINITION_SCAN
  )) {
    const label = match[1];
    if (label !== undefined) labels.add(label);
  }
  return labels.size === 0 ? NO_FOOTNOTE_LABELS : labels;
}

function definedFootnoteLabelAt(source: string): string | undefined {
  const match = FOOTNOTE_REFERENCE.exec(source);
  const label = match?.[1];
  if (label === undefined || !activeFootnoteLabels.has(label)) return undefined;
  return label;
}

function footnoteMarker(label: string): string {
  return `<sup class="footnote-ref">[${escapeHtml(label)}]</sup>`;
}

const footnoteExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "footnoteRef",
    level: "inline",
    start(source) {
      for (
        let index = source.indexOf("[^");
        index !== -1;
        index = source.indexOf("[^", index + 2)
      ) {
        if (definedFootnoteLabelAt(source.slice(index)) !== undefined) {
          return index;
        }
      }
      return undefined;
    },
    tokenizer(source) {
      const label = definedFootnoteLabelAt(source);
      if (label === undefined) return undefined;
      return { type: "footnoteRef", raw: `[^${label}]`, text: label };
    },
    renderer(token) {
      return footnoteMarker(String(token.text ?? ""));
    }
  },
  {
    name: "footnoteDef",
    level: "block",
    start(source) {
      const match = /(?:^|\n) {0,3}\[\^[^\]\n]{1,64}\]:/.exec(source);
      if (match === null) return undefined;
      return match.index + (match[0].startsWith("\n") ? 1 : 0);
    },
    tokenizer(source) {
      const match = FOOTNOTE_DEFINITION.exec(source);
      if (match === null) return undefined;
      return {
        type: "footnoteDef",
        raw: match[0],
        label: match[1],
        text: match[2],
        tokens: this.lexer.inlineTokens(match[2] ?? "")
      };
    },
    renderer(token) {
      const body = this.parser.parseInline(token.tokens ?? []);
      return `<p class="footnote-def">${footnoteMarker(
        String(token.label ?? "")
      )} ${body}</p>\n`;
    }
  }
];

const parser = new Marked({ gfm: true, breaks: true });
parser.use(mathExtension);
parser.use({ extensions: footnoteExtensions });
parser.use({
  renderer: {
    // Task list items carry their state on the `li` so the stylesheet needs
    // no `:has()`; the marker itself is a `span`, never an `input` (an input
    // would reintroduce `formaction` and `type=image` URL carriers).
    listitem(item) {
      if (item.task !== true) return false;
      const state = item.checked === true ? " task-item-checked" : "";
      return `<li class="task-item${state}">${this.parser.parse(item.tokens)}</li>\n`;
    },
    checkbox({ checked }) {
      const state = checked ? " task-marker-checked" : "";
      return `<span class="task-marker${state}"></span> `;
    },
    // Images degrade to a link instead of vanishing. `img` stays out of the
    // allow-list on purpose: a remote image in an assistant message would
    // leak the reader's IP and read time to a third-party host with no user
    // interaction. The href still passes the unchanged scheme allow-list and
    // picks up `target`/`rel` hardening in `afterSanitizeAttributes`.
    image({ href, text, tokens }) {
      const label =
        tokens !== undefined && tokens.length > 0
          ? this.parser.parseInline(tokens, this.parser.textRenderer)
          : text;
      const shown = label.trim() === "" ? href : label;
      return `<a href="${escapeHtmlKeepingEntities(
        href
      )}">${escapeHtmlKeepingEntities(shown)}</a>`;
    }
  }
});

let sanitizerHooksInstalled = false;

function ensureSanitizerHooks(): void {
  if (sanitizerHooksInstalled) return;
  sanitizerHooksInstalled = true;

  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "style") return;
    if (activeLane !== "katex") {
      data.keepAttr = false;
      return;
    }
    const kept = filterKatexStyle(data.attrValue);
    if (kept === "") {
      data.keepAttr = false;
      return;
    }
    data.attrValue = kept;
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

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// Markdown-authored text already carries decoded entities: `&amp;` in the
// source means a literal ampersand, so re-encoding it would surface
// `&amp;` to the reader. Leave a well-formed entity alone and escape every
// other `&`, matching Marked's own semantics for the same call sites. Output
// is still fully escaped markup — DOMPurify re-parses it as a text node, so
// this changes presentation only, never the parse.
const HTML_ESCAPES_KEEPING_ENTITIES =
  /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{0,31});)/g;

function escapeHtmlKeepingEntities(text: string): string {
  return text.replace(
    HTML_ESCAPES_KEEPING_ENTITIES,
    (char) => HTML_ESCAPES[char] ?? char
  );
}

// A backslash directly before a non-ASCII character can never open a valid
// control sequence, yet models routinely emit that form when annotating
// Chinese reaction conditions (`\xrightarrow{\点燃}`). KaTeX aborts the whole
// formula on it, so drop just that backslash. Backslashes are counted in runs
// because `\\` is a line break whose second character is not an opener.
const NON_ASCII_COMMAND_OPENER = /\\+(?=\P{ASCII})/gu;

function repairNonAsciiCommands(tex: string): string {
  return tex.replace(NON_ASCII_COMMAND_OPENER, (run) =>
    run.length % 2 === 0 ? run : run.slice(1)
  );
}

function renderKatex(record: MathRecord): string {
  let generated: string;
  try {
    generated = katex.renderToString(repairNonAsciiCommands(record.tex), {
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

  return sanitizeIn("katex", generated, KATEX_PURIFY_CONFIG);
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

  // Collected before the context is installed so a failure here cannot leave
  // `activeMathContext` set and wedge every later render on the re-entrancy
  // guard.
  const footnoteLabels = collectFootnoteLabels(source);
  activeMathContext = context;
  activeFootnoteLabels = footnoteLabels;
  let parsed: string;
  try {
    parsed = parser.parse(source, { async: false });
  } finally {
    activeMathContext = null;
    activeFootnoteLabels = NO_FOOTNOTE_LABELS;
  }

  const strictHtml = sanitizeIn("strict", parsed, STRICT_PURIFY_CONFIG);
  return insertRecordedMath(strictHtml, context);
}
