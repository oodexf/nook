// @vitest-environment jsdom
/**
 * AC-07 payload matrix for the Markdown pipeline (quality-guidelines.md
 * §Security Gate). Every case renders through the production
 * `renderMarkdown` entry point and inspects the resulting DOM: scripts,
 * event attributes, dangerous URL schemes, iframes, unsafe SVG, remote
 * embeds, and malformed HTML must never produce executable carriers.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./render";

function render(source: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source);
  return host;
}

function expectNoExecutableCarrier(host: HTMLElement): void {
  expect(
    host.querySelector(
      "script, iframe, object, embed, form, input, foreignObject, a[href], img, video, audio"
    )
  ).toBeNull();
  for (const element of host.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i);
      if (["href", "src", "xlink:href"].includes(attribute.name)) {
        expect(attribute.value).not.toMatch(/^(?:javascript|vbscript|data):/i);
      }
    }
  }
}

describe("renderMarkdown security matrix (AC-07)", () => {
  it("strips script elements from raw HTML", () => {
    const host = render("Hello <script>alert(1)</script> world");
    expect(host.querySelector("script")).toBeNull();
    expect(host.innerHTML).not.toContain("alert(1)");
  });

  it("strips markdown image-with-script and nested script payloads", () => {
    const host = render("<div><script>alert(document.cookie)</script></div>");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("div")).toBeNull();
  });

  it("removes event handler attributes from surviving tags", () => {
    const host = render(
      '<p onclick="alert(1)">text</p><a href="https://example.com" onmouseover="alert(2)">link</a>'
    );
    expect(host.querySelector("p")?.getAttribute("onclick")).toBeNull();
    const anchor = host.querySelector("a");
    expect(anchor?.getAttribute("onmouseover")).toBeNull();
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
  });

  it("removes onerror-bearing img tags (remote embeds are rejected)", () => {
    const host = render('<img src="x" onerror="alert(1)">');
    expect(host.querySelector("img")).toBeNull();
    expect(host.innerHTML).not.toContain("onerror");
  });

  it("rejects javascript: URLs in raw anchors", () => {
    const host = render('<a href="javascript:alert(1)">x</a>');
    const anchor = host.querySelector("a");
    expect(anchor?.getAttribute("href")).toBeNull();
  });

  it("rejects javascript: URLs in markdown links", () => {
    const host = render("[click](javascript:alert(1))");
    const anchor = host.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBeNull();
    expect(host.innerHTML).not.toContain("javascript:");
  });

  it("rejects entity-encoded javascript: URLs", () => {
    const host = render("[click](&#106;avascript:alert(1))");
    const anchor = host.querySelector("a");
    const href = anchor?.getAttribute("href") ?? "";
    expect(href.toLowerCase()).not.toContain("javascript");
  });

  it("rejects vbscript: URLs", () => {
    const host = render('[click](vbscript:msgbox("x"))');
    const anchor = host.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toContain("vbscript");
  });

  it("rejects dangerous data: URLs", () => {
    const host = render(
      "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"
    );
    const anchor = host.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/^data:/i);
    expect(host.innerHTML).not.toContain("data:text/html");
  });

  it("strips iframes", () => {
    const host = render('<iframe src="https://evil.example"></iframe>');
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("strips unsafe SVG including script and handler payloads", () => {
    const host = render(
      '<svg onload="alert(1)"><script>alert(2)</script><circle r="10"/></svg>'
    );
    expect(host.querySelector("svg")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.innerHTML).not.toContain("onload");
  });

  it("strips SVG-based remote embeds and object/embed carriers", () => {
    const host = render(
      '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/y">'
    );
    expect(host.querySelector("object")).toBeNull();
    expect(host.querySelector("embed")).toBeNull();
  });

  it("contains malformed HTML without emitting executable markup", () => {
    const host = render('<div><script>alert(1)</script><img src=x onerror=alert(2)>');
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("div")).toBeNull();
  });

  it("strips form and input carriers", () => {
    const host = render(
      '<form action="https://evil.example"><input name="t"></form>'
    );
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector("input")).toBeNull();
  });

  it("strips style tags and style attributes", () => {
    const host = render(
      '<style>body{display:none}</style><p style="background:url(javascript:alert(1))">x</p>'
    );
    expect(host.querySelector("style")).toBeNull();
    expect(host.querySelector("p")?.getAttribute("style")).toBeNull();
  });

  it("keeps code-fence payloads as inert escaped text", () => {
    const host = render("```html\n<script>alert(1)</script>\n```");
    expect(host.querySelector("script")).toBeNull();
    const code = host.querySelector("pre code");
    expect(code?.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("renderMarkdown math syntax and output", () => {
  it("renders conservative inline dollar syntax with HTML and MathML", () => {
    const host = render("Euler wrote $e^{i\\pi}+1=0$. ");
    expect(host.querySelector("p > .katex")).not.toBeNull();
    expect(host.querySelector(".katex-html")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(host.querySelector(".katex-mathml math")).not.toBeNull();
    expect(host.querySelector("annotation")?.textContent).toBe(
      "e^{i\\pi}+1=0"
    );
  });

  it("renders only line-isolated double dollars as display math", () => {
    const host = render("Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter");
    const display = host.querySelector(".katex-display");
    expect(display).not.toBeNull();
    expect(display?.querySelector("math")?.getAttribute("display")).toBe(
      "block"
    );
    expect(display?.querySelector("mfrac")).not.toBeNull();

    const notDisplay = render("Text $$x+1$$ stays text.");
    expect(notDisplay.querySelector(".katex")).toBeNull();
    expect(notDisplay.textContent).toContain("$$x+1$$");
  });

  it("covers superscripts, subscripts, roots, sums, integrals, and matrices", () => {
    const host = render(
      [
        "$x^2+y_1$. ",
        "",
        "$$",
        "\\sqrt{\\frac{a}{b}}+\\sum_{i=1}^n i+\\int_0^1 x\\,dx+\\begin{matrix}a&b\\\\c&d\\end{matrix}",
        "$$"
      ].join("\n")
    );
    expect(host.querySelector("msup")).not.toBeNull();
    expect(host.querySelector("msub")).not.toBeNull();
    expect(host.querySelector("msqrt mfrac")).not.toBeNull();
    expect(host.querySelector("munderover, msubsup")).not.toBeNull();
    expect(host.querySelector("mtable mtr mtd")).not.toBeNull();
    expect(host.querySelector("svg path")).not.toBeNull();
    expect(host.querySelector("[style*='height']")).not.toBeNull();
  });

  it("retains indexed-root MathML and annotation accessibility semantics", () => {
    const host = render("$\\sqrt[3]{x}$. ");
    const semantics = host.querySelector(".katex-mathml math semantics");
    expect(semantics?.querySelector("mroot > mi")?.textContent).toBe("x");
    expect(semantics?.querySelector("mroot > mn")?.textContent).toBe("3");
    expect(semantics?.querySelector("annotation")?.textContent).toBe(
      "\\sqrt[3]{x}"
    );
    expect(host.querySelector(".katex-html")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });

  it("caps untrusted TeX dimensions while preserving normal formulas", () => {
    const host = render(
      "$\\raisebox{1000000000em}{x} + \\rule{1000000000em}{1000000000em}$. " +
        "$\\frac{a}{b}$. "
    );

    const generatedDimensions: number[] = [];
    for (const styled of host.querySelectorAll<HTMLElement>("[style]")) {
      for (const declaration of (styled.getAttribute("style") ?? "").split(";")) {
        const value = declaration.slice(declaration.indexOf(":") + 1).trim();
        const dimension = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(?:em|%)?$/.exec(
          value
        );
        if (dimension === null) continue;
        const numericValue = Number(dimension[1]);
        expect(Number.isFinite(numericValue)).toBe(true);
        expect(Math.abs(numericValue)).toBeLessThanOrEqual(60);
        generatedDimensions.push(numericValue);
      }
    }
    expect(generatedDimensions.some((value) => Math.abs(value) >= 50)).toBe(
      true
    );
    expect(host.querySelector("mspace")?.getAttribute("width")).toBe("50em");
    expect(host.querySelector("mspace")?.getAttribute("height")).toBe("50em");

    const formulas = host.querySelectorAll(".katex");
    expect(formulas).toHaveLength(2);
    expect(formulas[1]?.querySelector("mfrac")).not.toBeNull();
    expect(formulas[1]?.querySelector("annotation")?.textContent).toBe(
      "\\frac{a}{b}"
    );
  });

  it("does not parse code, currency, unmatched delimiters, or unsupported delimiters", () => {
    const host = render(
      [
        "`$x$` and 价格是 $5 and unmatched $x and \\(y\\).",
        "",
        "```tex",
        "$z$",
        "```"
      ].join("\n")
    );
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.querySelector("p code")?.textContent).toBe("$x$");
    expect(host.querySelector("pre code")?.textContent).toContain("$z$");
    expect(host.textContent).toContain("价格是 $5");
    expect(host.textContent).toContain("unmatched $x");
    expect(host.textContent).toContain("(y)");
  });

  it("preserves GFM around formulas", () => {
    const host = render("**value** $x+1$. \n\n| formula |\n| --- |\n| $y^2$ | ");
    expect(host.querySelector("strong")?.textContent).toBe("value");
    expect(host.querySelector("p .katex")).not.toBeNull();
    expect(host.querySelector("td .katex")).not.toBeNull();
  });

  it("preserves KaTeX command and layout classes outside the original corpus", () => {
    const bold = render("$\\mathbf{x}$. ");
    expect(bold.querySelector(".katex .mathbf")?.textContent).toBe("x");

    const aligned = render("$$\n\\begin{aligned}x&=1\\\\y&=2\\end{aligned}\n$$");
    expect(aligned.querySelector(".katex .col-align-r")).not.toBeNull();

    const huge = render("$\\Huge x$. ");
    expect(huge.querySelector(".katex .size11")?.textContent).toBe("x");
  });

  it("falls invalid TeX back to selectable, copyable source without failing the message", () => {
    const source = "before $\\notARealCommand{x}$. after **safe**";
    const host = render(source);
    const error = host.querySelector<HTMLElement>(".katex-error");
    expect(error?.textContent).toBe("\\notARealCommand{x}");
    expect(host.querySelector("strong")?.textContent).toBe("safe");
    expect(error?.getAttribute("style")).toBeNull();
  });
});

describe("renderMarkdown provenance-isolated KaTeX security", () => {
  it("keeps ordinary Markdown style and SVG forbidden while preserving generated geometry", () => {
    const host = render(
      '<p class="katex katex-display evil" style="position:fixed;inset:0">fake</p>\n\nAfter $\\sqrt{x}$. <svg><path d="M0 0"/></svg>'
    );
    const raw = Array.from(host.querySelectorAll("p")).find((paragraph) =>
      paragraph.textContent?.includes("fake")
    );
    expect(raw?.getAttribute("style")).toBeNull();
    expect(raw?.classList.contains("evil")).toBe(true);
    expect(raw?.classList.contains("katex")).toBe(false);
    expect(raw?.classList.contains("katex-display")).toBe(false);
    expect(host.querySelectorAll(".katex")).toHaveLength(1);
    expect(host.querySelectorAll("svg")).toHaveLength(1);
    expect(host.querySelector(".katex svg path")).not.toBeNull();
  });

  it("does not let raw Markdown forge a formula placeholder", () => {
    const forged = "math-attacker-chosen-nonce-0";
    const host = render(
      `<code title="${forged}">${forged}</code> and $x$. `
    );
    expect(host.querySelectorAll(".katex")).toHaveLength(1);
    expect(host.querySelector("annotation")?.textContent).toBe("x");
    expect(host.textContent).toContain(forged);
    expect(host.querySelector(`code[title="${forged}"]`)).not.toBeNull();
  });

  it.each([
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\url{data:text/html,<script>alert(1)</script>}`,
    String.raw`\htmlClass{evil katex}{x}`,
    String.raw`\htmlStyle{background:url(javascript:alert(1))}{x}`,
    String.raw`\includegraphics{https://evil.example/x.svg}`,
    String.raw`\text{<svg onload=alert(1)>}`
  ])("blocks untrusted TeX capability: %s", (tex) => {
    const host = render(`$${tex}$. `);
    expectNoExecutableCarrier(host);
    expect(host.querySelector(".evil")).toBeNull();
    for (const styled of host.querySelectorAll<HTMLElement>("[style]")) {
      expect(styled.getAttribute("style")).not.toMatch(/background|url/i);
    }
  });

  it("keeps the KaTeX policy exact for tags, style properties, and URL attributes", () => {
    const host = render("$\\sqrt{\\frac{x}{y}}$. ");
    expect(host.querySelector(".katex-mathml math semantics")).not.toBeNull();
    expect(host.querySelector(".katex-html svg path")).not.toBeNull();
    expect(host.querySelector("[href], [src], [xlink\\:href]")).toBeNull();
    for (const styled of host.querySelectorAll<HTMLElement>("[style]")) {
      expect(styled.getAttribute("style")).not.toMatch(
        /url|expression|color|background|transform|--/i
      );
    }
  });
});

describe("renderMarkdown allowed formatting", () => {
  it("renders headings, emphasis, and inline code", () => {
    const host = render("# 标题\n\n**粗体** 和 `code`");
    expect(host.querySelector("h1")?.textContent).toBe("标题");
    expect(host.querySelector("strong")?.textContent).toBe("粗体");
    expect(host.querySelector("p code")?.textContent).toBe("code");
  });

  it("renders fenced code blocks with the language class", () => {
    const host = render("```ts\nconst x = 1;\n```");
    const code = host.querySelector("pre code");
    expect(code?.textContent).toContain("const x = 1;");
    expect(code?.getAttribute("class")).toContain("language-ts");
  });

  it("renders lists, blockquotes, and tables", () => {
    const host = render(
      "- a\n- b\n\n> quote\n\n| h |\n| --- |\n| c |"
    );
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("blockquote")?.textContent).toContain("quote");
    expect(host.querySelector("td")?.textContent).toBe("c");
  });

  it("keeps safe links and hardens them for a new tab", () => {
    const host = render("[site](https://example.com)");
    const anchor = host.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
    expect(anchor?.getAttribute("rel")).toContain("noreferrer");
  });

  it("keeps mailto links and relative/fragment links", () => {
    const host = render("[mail](mailto:a@b.example) [frag](#section)");
    const anchors = host.querySelectorAll("a");
    expect(anchors[0]?.getAttribute("href")).toBe("mailto:a@b.example");
    expect(anchors[1]?.getAttribute("href")).toBe("#section");
  });

  it("treats single newlines as line breaks (chat convention)", () => {
    const host = render("第一行\n第二行");
    expect(host.querySelector("br")).not.toBeNull();
  });
});
