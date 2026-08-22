// @vitest-environment jsdom
/**
 * AC-07 payload matrix for the Markdown pipeline (quality-guidelines.md
 * §Security Gate). Every case renders through the production
 * `renderMarkdown` entry point and inspects the resulting DOM: scripts,
 * event attributes, dangerous URL schemes, iframes, unsafe SVG, remote
 * embeds, and malformed HTML must never produce executable carriers.
 */
import { describe, expect, it } from "vitest";

import DOMPurify from "dompurify";

import { filterKatexStyle, renderMarkdown } from "./render";

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
    expect(host.querySelector("div")).not.toBeNull();
    expect(host.textContent).not.toContain("alert(document.cookie)");
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
    expect(host.querySelector("div")).not.toBeNull();
  });

  it("strips form and input carriers", () => {
    const host = render(
      '<form action="https://evil.example"><input name="t"></form>'
    );
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector("input")).toBeNull();
  });

  it("strips style tags and dangerous style declarations", () => {
    const host = render(
      '<style>body{display:none}</style><p style="color:red;background:url(javascript:alert(1));animation:spin 1s">x</p>'
    );
    expect(host.querySelector("style")).toBeNull();
    expect(host.querySelector("p")?.getAttribute("style")).toBe("color: red;");
  });

  it("allows the approved static HTML containers and sanitized layout styles", () => {
    const host = render(
      '<main style="display:grid;grid-template-columns:1fr 2fr;gap:12px"><section style="padding:8px;border-radius:10px;background:var(--surface-muted)"><details open><summary>More</summary><span style="font-weight:700">Safe</span></details></section></main>'
    );
    expect(host.querySelector("main > section > details[open] summary")?.textContent).toBe(
      "More"
    );
    expect(host.querySelector("main")?.getAttribute("style")).toContain(
      "grid-template-columns: 1fr 2fr"
    );
    expect(host.querySelector("section")?.getAttribute("style")).toContain(
      "background: var(--surface-muted)"
    );
  });

  it("rejects executable HTML and unsafe or unknown style values", () => {
    const host = render(
      '<div style="position:fixed;z-index:999999;transform:translateX(-100vw);color:var(--attacker);width:calc(100% + 2px);opacity:.5" onclick="alert(1)"><form><input></form><iframe src="https://evil.example"></iframe><img src="x"><svg><path/></svg>safe</div>'
    );
    const div = host.querySelector("div");
    expect(div?.getAttribute("onclick")).toBeNull();
    expect(div?.getAttribute("style")).toContain("position: fixed");
    expect(div?.getAttribute("style")).toContain("z-index: 999999");
    expect(div?.getAttribute("style")).toContain("transform: translateX(-100vw)");
    expect(div?.getAttribute("style")).toContain("opacity: .5");
    expect(div?.getAttribute("style")).not.toContain("--attacker");
    expect(div?.getAttribute("style")).toContain("calc(100% + 2px)");
    expect(host.querySelector("form, input, iframe, img, svg")).toBeNull();
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

  it("renders line-isolated and same-line double dollars as display math", () => {
    const isolated = render("Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter");
    const isolatedDisplay = isolated.querySelector(".katex-display");
    expect(isolatedDisplay).not.toBeNull();
    expect(isolatedDisplay?.querySelector("math")?.getAttribute("display")).toBe(
      "block"
    );
    expect(isolatedDisplay?.querySelector("mfrac")).not.toBeNull();

    const sameLine = render("拉普拉斯变换：$$F(s)=\\int_0^\\infty e^{-st}f(t),dt$$");
    const sameLineDisplay = sameLine.querySelector(".katex-display");
    expect(sameLineDisplay).not.toBeNull();
    expect(sameLineDisplay?.querySelector("math")?.getAttribute("display")).toBe(
      "block"
    );
    expect(sameLineDisplay?.querySelector("msubsup")).not.toBeNull();
    expect(sameLine.textContent).toContain("拉普拉斯变换：");
  });

  it("renders representative persisted model output using LaTeX delimiters", () => {
    const source = String.raw`以下是一些数学公式：

1. **二次方程求根公式**
   \( x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \)

2. **定积分**
   \[ \int_{a}^{b} x^2 \, dx = \left[ \frac{x^3}{3} \right]_{a}^{b} = \frac{b^3 - a^3}{3} \]

3. **矩阵**
\[
A = \begin{pmatrix} a & b \\ c & d \end{pmatrix}
\]`;
    const host = render(source);

    expect(host.querySelectorAll(".katex")).toHaveLength(3);
    expect(host.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(host.querySelectorAll("math[display='block']")).toHaveLength(2);
    expect(host.querySelector("p > .katex mfrac")).not.toBeNull();
    expect(host.querySelector(".katex-display mtable")).not.toBeNull();
    expect(
      Array.from(host.querySelectorAll("annotation"), (node) => node.textContent)
    ).toEqual([
      "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "\\int_{a}^{b} x^2 \\, dx = \\left[ \\frac{x^3}{3} \\right]_{a}^{b} = \\frac{b^3 - a^3}{3}",
      "A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"
    ]);
  });

  it("leaves code, unmatched, empty, escaped, and nested LaTeX delimiters literal", () => {
    const host = render(
      [
        "inline code `\\(code\\)` and unmatched \\(open",
        String.raw`empty \(   \) and escaped \\(literal\\)`,
        String.raw`outer \(unmatched then \(x\)`,
        "",
        "```tex",
        String.raw`\[fenced\]`,
        "```"
      ].join("\n")
    );

    expect(host.querySelectorAll(".katex")).toHaveLength(1);
    expect(host.querySelector("annotation")?.textContent).toBe("x");
    expect(host.querySelector("p code")?.textContent).toBe("\\(code\\)");
    expect(host.querySelector("pre code")?.textContent).toContain(
      "\\[fenced\\]"
    );
    expect(host.textContent).toContain("unmatched (open");
    expect(host.textContent).toContain("empty (   )");
    expect(host.textContent).toContain("escaped \\(literal\\)");
  });

  it.each([
    String.raw`outer \(unmatched then \(x\)`,
    String.raw`outer \(unmatched then \[x\]`,
    String.raw`outer \[unmatched then \(x\)`,
    String.raw`outer \[unmatched then \[x\]`
  ])("recovers from nested LaTeX delimiters: %s", (source) => {
    const host = render(source);

    expect(host.querySelectorAll(".katex")).toHaveLength(1);
    expect(host.querySelector("annotation")?.textContent).toBe("x");
    expect(host.textContent).toContain(
      source.startsWith(String.raw`outer \[`) ? "outer [unmatched then" : "outer (unmatched then"
    );
  });

  it.each([
    String.raw`\(\href{javascript:alert(1)}{click}\)`,
    String.raw`\[\htmlStyle{background:url(javascript:alert(1))}{x}\]`
  ])("keeps new LaTeX delimiters on the isolated security path: %s", (source) => {
    const host = render(source);

    expectNoExecutableCarrier(host);
    expect(host.querySelector("[href], [src]")).toBeNull();
    for (const styled of host.querySelectorAll<HTMLElement>("[style]")) {
      expect(styled.getAttribute("style")).not.toMatch(
        /(?:url\s*\(|javascript:|background)/i
      );
    }
  });

  it("renders adjacent Chinese text and consecutive same-line display formulas in order", () => {
    const host = render(
      "高斯积分：$$\\int_{-\\infty}^{\\infty}e^{-x^2},dx=\\sqrt{\\pi}$$" +
        "施瓦茨不等式：$$|\\langle u,v\\rangle|\\leq|u||v|$$" +
        "泰勒级数：$$f(x)=\\sum_{n=0}^{\\infty}\\frac{f^{(n)}(a)}{n!}(x-a)^n$$"
    );

    expect(host.querySelectorAll(".katex-display")).toHaveLength(3);
    const text = host.textContent ?? "";
    expect(text.indexOf("高斯积分：")).toBeLessThan(text.indexOf("施瓦茨不等式："));
    expect(text.indexOf("施瓦茨不等式：")).toBeLessThan(
      text.indexOf("泰勒级数：")
    );
  });

  it("renders the supplied mixed Chinese display and inline formula corpus", () => {
    const source = String.raw`拉普拉斯变换：$$F(s) = \int_0^\infty e^{-st} f(t) , dt$$

傅里叶变换：$$\hat{f}(\xi) = \int_{-\infty}^{\infty} f(x) e^{-2\pi i x \xi} , dx$$泰勒级数：$$f(x) = \sum_{n=0}^{\infty} \frac{f^{(n)}(a)}{n!}(x-a)^n$$

傅里叶级数：$$f(t) = a_0 + \sum_{n=1}^{\infty} \left(a_n \cos \frac{2\pi nt}{T} + b_n \sin \frac{2\pi nt}{T}\right)$$

高斯积分：$$\int_{-\infty}^{\infty} e^{-x^2} , dx = \sqrt{\pi}$$

施瓦茨不等式：$$|\langle u, v \rangle| \leq |u| |v|$$

伽马函数：$$\Gamma(z) = \int_0^\infty t^{z-1} e^{-t} , dt$$一、基础符号与排版
上下标：$x_i^2 + y_i^2 = z_i^2$
分式：$\frac{a}{b} + \frac{c}{d} = \frac{ad + bc}{bd}$
根式：$\sqrt{x^2 + y^2}$，$\sqrt[3]{a^3 + b^3}$
希腊字母：$\alpha, \beta, \gamma, \delta, \epsilon, \theta, \lambda, \mu, \pi, \sigma, \omega$
运算符：$\pm, \times, \div, \cdot, \leq, \geq, \neq, \approx, \propto$
二、常用数学表达式
求和公式：$\sum_{i=1}^{n} i^2 = \frac{n(n+1)(2n+1)}{6}$
积分公式：$\int_0^\infty e^{-x^2} , dx = \frac{\sqrt{\pi}}{2}$
极限：$\lim_{x \to 0} \frac{\sin x}{x} = 1$
连乘：$\prod_{k=1}^n k = n!$
组合数：$\binom{n}{k} = \frac{n!}{k!(n-k)!}$
绝对值与范数：$| \mathbf{v} | = \sqrt{\sum_i v_i^2}$`;
    const host = render(source);

    expect(host.querySelectorAll(".katex-display")).toHaveLength(7);
    expect(host.querySelectorAll(".katex")).toHaveLength(19);
    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    expect(host.textContent).not.toContain("$$");
    expect(host.textContent).toContain("一、基础符号与排版");
    expect(host.textContent).toContain("二、常用数学表达式");
  });

  it("keeps escaped dollar forms and unmatched openers from hiding later formulas", () => {
    const host = render(
      String.raw`before \$$literal$$ then $$x$$; ：\$escaped$。 then ：$y$。; unmatched $word then $$q$$; before $$ $$ after $z$.`
    );

    expect(host.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(host.querySelectorAll(".katex")).toHaveLength(4);
    expect(
      Array.from(host.querySelectorAll("annotation"), (node) => node.textContent)
    ).toEqual(["x", "y", "q", "z"]);
    // The opening escape is consumed while both delimiters remain literal;
    // importantly, neither escaped pair steals a later formula's closing
    // delimiter.
    expect(host.textContent).toContain("before $$literal$$ then");
    expect(host.textContent).toContain("：$escaped$。 then");
    expect(host.textContent).toContain("unmatched $word then");
    expect(host.textContent).toContain("before $$ $$ after");
  });

  it.each([
    {
      source: String.raw`before \$literal then $x$.`,
      literal: "before $literal then",
      formula: "x"
    },
    {
      source: String.raw`before \$$literal then $$x$$ after`,
      literal: "before $$literal then",
      formula: "x"
    }
  ])(
    "does not let an unmatched escaped opener consume later math: $source",
    ({ source, literal, formula }) => {
      const host = render(source);

      expect(host.querySelectorAll(".katex")).toHaveLength(1);
      expect(host.querySelector("annotation")?.textContent).toBe(formula);
      expect(host.textContent).toContain(literal);
    }
  );

  it("preserves whitespace-only line-isolated display delimiters as literal text", () => {
    const source = "Before\n\n$$\n \t\n$$\n\nAfter";
    const host = render(source);

    expect(host.querySelector(".katex")).toBeNull();
    expect(host.textContent).toContain("$$");
    expect(host.textContent).toContain("Before");
    expect(host.textContent).toContain("After");
  });

  it("supports the full approved CJK punctuation set at both inline boundaries", () => {
    const punctuation = ["：", "，", "。", "！", "？", "；", "、"];
    const source = punctuation
      .map((mark, index) => `${mark}$x_${index}$${mark}`)
      .join(" ");
    const host = render(source);

    expect(host.querySelectorAll(".katex")).toHaveLength(punctuation.length);
    expect(
      Array.from(host.querySelectorAll("annotation"), (node) => node.textContent)
    ).toEqual(punctuation.map((_, index) => `x_${index}`));
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

  it("does not parse code, currency, unmatched dollar delimiters, or escaped delimiters", () => {
    const host = render(
      [
        "`$x$` and `$$y$$` and 价格是 $5 and unmatched $x.",
        "",
        "unmatched display $$x+1",
        "",
        "```tex",
        "$z$ and $$w$$",
        "```"
      ].join("\n")
    );
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.querySelector("p code")?.textContent).toBe("$x$");
    expect(host.querySelectorAll("p code")[1]?.textContent).toBe("$$y$$");
    expect(host.querySelector("pre code")?.textContent).toContain("$$w$$");
    expect(host.textContent).toContain("价格是 $5");
    expect(host.textContent).toContain("unmatched $x");
    expect(host.textContent).toContain("unmatched display $$x+1");
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

  it("renders Chinese reaction conditions written as stray backslash commands", () => {
    const source = `化学方程式：

1. 氢气燃烧

   $$2H_2+O_2\\xrightarrow{\\点燃}2H_2O$$

2. 碳酸钙分解

   $$CaCO_3\\xrightarrow{\\高温}CaO+CO_2\\uparrow$$

3. 盐酸与氢氧化钠反应

   $$HCl + NaOH \\to NaCl + H_2O$$

4. 光合作用

   $$6CO_2+6H_2O\\xrightarrow{\\光照,\\ 叶绿素}C_6H_{12}O_6+6O_2$$`;
    const host = render(source);

    expect(host.querySelectorAll(".katex-display")).toHaveLength(4);
    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    // The stray opener is dropped only for KaTeX; every other token survives.
    expect(
      Array.from(host.querySelectorAll("annotation"), (node) => node.textContent)
    ).toEqual([
      "2H_2+O_2\\xrightarrow{点燃}2H_2O",
      "CaCO_3\\xrightarrow{高温}CaO+CO_2\\uparrow",
      "HCl + NaOH \\to NaCl + H_2O",
      "6CO_2+6H_2O\\xrightarrow{光照,\\ 叶绿素}C_6H_{12}O_6+6O_2"
    ]);
    expect(host.textContent).toContain("点燃");
    expect(host.textContent).toContain("叶绿素");
  });

  it("repairs stray backslash commands in the LaTeX delimiter lane too", () => {
    const host = render(String.raw`条件：\(x \xrightarrow{\高温} y\)。`);

    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    expect(host.querySelector("annotation")?.textContent).toBe(
      "x \\xrightarrow{高温} y"
    );
  });

  it("keeps a line break intact when a non-ASCII character follows it", () => {
    const host = render("$$\n\\begin{aligned}a&=1\\\\温&=2\\end{aligned}\n$$");

    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    expect(host.querySelector(".katex .vlist")).not.toBeNull();
    expect(host.textContent).toContain("温");
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
    expect(raw?.getAttribute("style")).toBe("position: fixed;");
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
    const host = render([`$${tex}$`, `$$${tex}$$`].join(" "));
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

/**
 * AC-1: KaTeX layout declarations survive per-declaration filtering. Before
 * this task a single unrecognized declaration dropped the whole `style`
 * attribute, so `\phantom` became visible, `\boxed` collapsed, `array`
 * separators vanished and `\rule` disappeared.
 */
describe("renderMarkdown formula fidelity (AC-1)", () => {
  function styleOf(host: HTMLElement, selector: string): string {
    const element = host.querySelector<HTMLElement>(selector);
    expect(element, `missing ${selector}`).not.toBeNull();
    return element?.getAttribute("style") ?? "";
  }

  it("keeps \\phantom content hidden via color:transparent", () => {
    const host = render("$a\\phantom{XYZ}c$. ");
    const hidden = Array.from(
      host.querySelectorAll<HTMLElement>(".katex-html [style]")
    ).filter((element) =>
      (element.getAttribute("style") ?? "").includes("color:transparent")
    );
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.map((element) => element.textContent).join("")).toContain(
      "XYZ"
    );
  });

  it.each(["\\hphantom{X}", "\\vphantom{X}"])(
    "keeps %s hidden as well",
    (tex) => {
      const host = render(`$a${tex}c$. `);
      expect(host.innerHTML).toContain("color:transparent");
    }
  );

  it("keeps the \\boxed frame geometry", () => {
    const host = render("$$\\boxed{x=1}$$");
    const style = styleOf(host, ".fbox");
    expect(style).toMatch(/height:\s*[\d.]+em/);
    expect(style).toContain("border-style:solid");
    expect(style).toMatch(/border-width:\s*[\d.]+em/);
  });

  it("keeps array column separators", () => {
    const host = render(
      "$$\n\\begin{array}{c|c} a & b \\\\ c & d \\end{array}\n$$"
    );
    const style = styleOf(host, ".vertical-separator");
    expect(style).toMatch(/border-right-width:\s*[\d.]+em/);
    expect(style).toContain("border-right-style:solid");
    expect(style).toMatch(/height:\s*[\d.]+em/);
    expect(style).toContain("margin:0 -0.02em");
  });

  it("keeps \\rule geometry", () => {
    const host = render("$a\\rule{2em}{1pt}b$. ");
    const style = styleOf(host, ".rule");
    expect(style).toContain("border-right-width:2em");
    expect(style).toContain("border-top-width:0.1em");
    expect(style).toContain("bottom:0em");
  });

  it("keeps \\textcolor, \\colorbox, and \\fcolorbox colors", () => {
    expect(styleOf(render("$\\textcolor{red}{x}$. "), ".mord[style]")).toContain(
      "color:red"
    );
    expect(styleOf(render("$\\colorbox{yellow}{y}$. "), ".colorbox")).toContain(
      "background-color:yellow"
    );

    const framed = styleOf(
      render("$\\fcolorbox{blue}{yellow}{z}$. "),
      ".fcolorbox"
    );
    expect(framed).toContain("background-color:yellow");
    expect(framed).toContain("border-color:blue");
    expect(framed).toContain("border-style:solid");
  });

  it("keeps mpadded/mphantom MathML nodes and their layout attributes", () => {
    const host = render("$\\fcolorbox{blue}{yellow}{z}$. ");
    const padded = host.querySelector("mpadded");
    expect(padded).not.toBeNull();
    expect(padded?.getAttribute("lspace")).toBe("3pt");
    expect(padded?.getAttribute("voffset")).toBe("3pt");
    expect(padded?.getAttribute("mathbackground")).toBe("yellow");
    expect(padded?.getAttribute("style")).toContain("border:0.04em solid blue");

    expect(render("$a\\phantom{x}b$. ").querySelector("mphantom")).not.toBeNull();
  });

  it("keeps array column line and row spacing MathML attributes", () => {
    const host = render(
      "$$\n\\begin{array}{c|c} a & b \\\\ c & d \\end{array}\n$$"
    );
    expect(host.querySelector("mtable")?.getAttribute("columnlines")).toContain(
      "solid"
    );
  });
});

/**
 * AC-2: every newly allow-listed style property gets an attack payload.
 * `filterKatexStyle` is exported for exactly this reason: `trust: false`
 * KaTeX cannot be coerced into emitting these values, so the pipeline alone
 * could not reach the branch under test.
 */
describe("renderMarkdown KaTeX style filtering (AC-2)", () => {
  it("keeps a legal declaration and drops the illegal one beside it", () => {
    expect(filterKatexStyle("color:red;background:url(https://evil/x)")).toBe(
      "color:red"
    );
    expect(
      filterKatexStyle("height:1.2em;behavior:url(#x);border-style:solid")
    ).toBe("height:1.2em;border-style:solid");
  });

  it.each([
    "width:expression(alert(1))",
    "width:var(--x)",
    "background-color:image-set(\"x\")",
    "color:attr(data-x)",
    "border-color:element(#a)",
    "background-color:rgb(1,2,3)",
    "text-shadow:0 0 url(x)",
    "border:1px solid url(#x)"
  ])("rejects functional notation: %s", (declaration) => {
    expect(filterKatexStyle(declaration)).toBe("");
  });

  // Each case asserts the exact surviving text, so a weakened veto that let
  // part of a payload through would fail instead of passing silently.
  it.each([
    ["color:\\72 ed", ""],
    ["color:red!important", ""],
    ["color: red ! important", ""],
    ["color:/*x*/red", ""],
    ["color:red;;behavior:url(#x)", "color:red"],
    ["background-color:\\75rl(x)", ""],
    ["color:'red'", ""],
    ['color:"red"', ""],
    ["color:&#114;ed", ""],
    ["position:absolute", ""],
    ["position:fixed", ""],
    ["top:0em;position:sticky", "top:0em"],
    ["height:100vh", ""],
    ["width:calc(1em + 1px)", ""],
    ["-moz-binding:url(x)", ""],
    ["behavior:url(#default#time2)", ""],
    ["background:red", ""],
    ["background-image:none", ""],
    ["transform:scale(2)", ""],
    ["left:javascript:alert(1)", ""],
    ["content:x", ""],
    // A NUL terminator, a Cyrillic homoglyph, full-width latin, and a
    // zero-width space: the character allow-list is ASCII-only and excludes
    // control characters, so none of them reaches a value grammar.
    ["color:\u0072ed\u0000", ""],
    ["color:rеd", ""],
    ["color:ｒed", ""],
    ["color:red​", ""],
    // Custom properties and vendor prefixes are not allow-listed properties.
    ["--x:red", ""],
    ["-moz-color:red", ""],
    // A second colon cannot smuggle a second property/value pair into a value.
    ["color:red:blue", ""],
    ["position:relative:absolute", ""],
    ["color::red", ""],
    // A newline is outside the allow-list, so a declaration cannot be split.
    ["height:1em\n", ""],
    // Properties outside the KaTeX set stay rejected even with legal values.
    ["unicode-bidi:bidi-override", ""],
    ["direction:rtl", ""],
    ["font-size:100em", ""]
  ])("rejects payload %s", (declaration, expected) => {
    expect(filterKatexStyle(declaration)).toBe(expected);
  });

  it("accepts only the KaTeX layout grammar per category", () => {
    expect(filterKatexStyle("position:relative")).toBe("position:relative");
    expect(filterKatexStyle("margin:0 -0.02em")).toBe("margin:0 -0.02em");
    expect(filterKatexStyle("border:0.04em solid blue")).toBe(
      "border:0.04em solid blue"
    );
    expect(filterKatexStyle("text-shadow:0.02em 0.01em 0.04px")).toBe(
      "text-shadow:0.02em 0.01em 0.04px"
    );
    expect(filterKatexStyle("color:#a1b2c3")).toBe("color:#a1b2c3");
    expect(filterKatexStyle("color:#a1b2c3d4")).toBe("color:#a1b2c3d4");
    expect(filterKatexStyle("color:#12g")).toBe("");
    expect(filterKatexStyle("border-style:solid dashed")).toBe(
      "border-style:solid dashed"
    );
    expect(filterKatexStyle("border-style:solid;color:transparent")).toBe(
      "border-style:solid;color:transparent"
    );
    expect(filterKatexStyle("height:1em 2em 3em 4em 5em")).toBe("");
    expect(filterKatexStyle("")).toBe("");
    expect(filterKatexStyle(";;;")).toBe("");
    expect(filterKatexStyle("height")).toBe("");
    expect(filterKatexStyle(":1em")).toBe("");
  });

  it("filters ordinary Markdown style and keeps MathML, SVG, input, and img out", () => {
    const host = render(
      [
        '<span style="color:red">a</span>',
        '<p style="height:1em">b</p>',
        "<math><mo>c</mo></math>",
        '<mo href="javascript:alert(1)">d</mo>',
        '<svg><path d="M0 0"/></svg>',
        '<input type="checkbox" checked>',
        '<img src="https://evil.example/x.png" alt="e">',
        '<mpadded voffset="3pt">f</mpadded>',
        '<div style="animation:spin 1s;background:url(x)">g</div>'
      ].join("\n\n")
    );

    // Inline style is no longer banned outright: the HTML artifact lane needs
    // it, so declarations survive only through the property allow-list.
    const styleOf = (selector: string, text: string): string | null =>
      Array.from(host.querySelectorAll<HTMLElement>(selector))
        .find((node) => node.textContent?.trim() === text)
        ?.getAttribute("style") ?? null;

    expect(styleOf("span", "a")).toBe("color: red;");
    expect(styleOf("p", "b")).toBe("height: 1em;");
    // An unlisted property and a url() value leave nothing to keep.
    expect(styleOf("div", "g")).toBeNull();
    expect(host.querySelector("math, mo, mpadded, mphantom")).toBeNull();
    expect(host.querySelector("svg, path")).toBeNull();
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("[href], [src]")).toBeNull();
    expect(host.innerHTML).not.toContain("javascript:");
  });

  it("does not leak the KaTeX lane to a following strict render", () => {
    // A failing formula exercises the KaTeX sanitizer's error path first.
    const failed = render("$\\notARealCommand{x}$. ");
    expect(failed.querySelector(".katex-error")).not.toBeNull();

    // `border-top-width` sits inside the KaTeX value grammar but outside the
    // HTML property allow-list, so it survives only if the lane leaked.
    const strict = render('<span style="border-top-width:2px">x</span>');
    expect(strict.querySelector("span")?.getAttribute("style")).toBeNull();
    expect(strict.querySelector("span")?.textContent).toBe("x");
  });

  it("never allow-lists a URL-bearing MathML attribute", () => {
    const host = render(
      [
        String.raw`$\href{https://example.com}{x}$`,
        String.raw`$\includegraphics{https://evil.example/x.svg}$`
      ].join(" ")
    );
    expect(host.querySelector("[href], [src], [alt], [xlink\\:href]")).toBeNull();
  });

  it("drops URL carriers forced into the KaTeX lane's attribute filter", () => {
    // `trust: false` KaTeX cannot emit these attributes, so the exclusion
    // would otherwise be untestable and an accidental addition to
    // `KATEX_ALLOWED_ATTR` would go unnoticed. `afterSanitizeElements` runs
    // per node immediately before DOMPurify filters that node's attributes,
    // so injecting there exercises the real KaTeX allow-list.
    const inject = (node: Node): void => {
      const element = node as Element;
      if (element.nodeType !== 1 || element.tagName.toLowerCase() !== "mo") {
        return;
      }
      element.setAttribute("href", "https://evil.example/x");
      element.setAttribute("src", "https://evil.example/x");
      element.setAttribute("alt", "leak");
      element.setAttribute("xlink:href", "https://evil.example/x");
      // Control attribute: proves the injection reached the attribute filter
      // rather than the assertions below passing vacuously.
      element.setAttribute("mathcolor", "red");
    };

    DOMPurify.addHook("afterSanitizeElements", inject);
    let host: HTMLElement;
    try {
      host = render("$a+b$. ");
    } finally {
      DOMPurify.removeHook("afterSanitizeElements");
    }

    const operator = host.querySelector("mo");
    expect(operator).not.toBeNull();
    expect(operator?.getAttribute("mathcolor")).toBe("red");
    expect(host.querySelector("[href], [src], [alt]")).toBeNull();
    expect(operator?.hasAttribute("xlink:href")).toBe(false);
  });
});

/**
 * AC-3: constructs that used to be silently stripped now render as visible,
 * inert markup — without adding `input`, `img`, or a footnote `href` to the
 * strict lane.
 */
describe("renderMarkdown Markdown fidelity (AC-3)", () => {
  it("renders task list checkboxes without an input element", () => {
    const host = render("- [ ] a\n- [x] b");

    expect(host.querySelector("input")).toBeNull();
    const items = host.querySelectorAll("li.task-item");
    expect(items).toHaveLength(2);
    expect(items[0]?.classList.contains("task-item-checked")).toBe(false);
    expect(items[1]?.classList.contains("task-item-checked")).toBe(true);

    const markers = host.querySelectorAll(".task-marker");
    expect(markers).toHaveLength(2);
    expect(markers[0]?.classList.contains("task-marker-checked")).toBe(false);
    expect(markers[1]?.classList.contains("task-marker-checked")).toBe(true);
    expect(host.textContent).toContain("a");
    expect(host.textContent).toContain("b");
  });

  it("leaves ordinary list items untouched", () => {
    const host = render("- a\n- b");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("li.task-item")).toBeNull();
    expect(host.querySelector(".task-marker")).toBeNull();
  });

  it("keeps sub and sup", () => {
    const host = render("H<sub>2</sub>O and x<sup>2</sup>");
    expect(host.querySelector("sub")?.textContent).toBe("2");
    expect(host.querySelector("sup")?.textContent).toBe("2");
    expect(host.textContent).toContain("H2O");
  });

  it("degrades images to a safe link instead of blank output", () => {
    const host = render("![图](https://example.com/a.png)");
    expect(host.querySelector("img")).toBeNull();
    const anchor = host.querySelector("a");
    expect(anchor?.textContent).toBe("图");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/a.png");
    expect(anchor?.getAttribute("rel")).toContain("nofollow");
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("falls back to the URL when the image alt text is empty", () => {
    const host = render("![](https://example.com/a.png)");
    expect(host.querySelector("a")?.textContent).toBe(
      "https://example.com/a.png"
    );
  });

  it.each([
    "![x](javascript:alert(1))",
    "![x](data:text/html;base64,PHNjcmlwdD4=)",
    "![x](vbscript:msgbox(1))"
  ])("never produces a dangerous image link: %s", (source) => {
    const host = render(source);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(host.innerHTML).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
  });

  it("renders footnotes as visible text without producing a link", () => {
    const host = render("正文[^1]\n\n[^1]: 注释内容");

    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("[href]")).toBeNull();
    const text = host.textContent ?? "";
    expect(text).toContain("正文");
    expect(text).toContain("1");
    expect(text).toContain("注释内容");
    expect(host.querySelector("sup.footnote-ref")?.textContent).toBe("[1]");
    expect(host.querySelector(".footnote-def")?.textContent).toContain(
      "注释内容"
    );
  });

  it("keeps ordinary link reference definitions working", () => {
    const host = render("[文字][ref] and [bare][ref]\n\n[ref]: https://example.com");
    const anchors = host.querySelectorAll("a");
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.getAttribute("href")).toBe("https://example.com");
    expect(anchors[0]?.textContent).toBe("文字");
    expect(host.textContent).not.toContain("https://example.com");
  });

  it("leaves an unpaired reference as literal text", () => {
    // R8 pairs references with definitions. `[^…]` is ordinary prose far more
    // often than it is a footnote, and an unpaired match would both superscript
    // the text and silently drop its caret.
    const host = render(
      "use [^a-z] to match, and array[^2] index\n\ntext[^missing] end"
    );
    expect(host.querySelector("sup")).toBeNull();
    expect(host.querySelector(".footnote-ref")).toBeNull();
    const text = host.textContent ?? "";
    expect(text).toContain("[^a-z]");
    expect(text).toContain("array[^2]");
    expect(text).toContain("[^missing]");
  });

  it("keeps an indented footnote definition visible", () => {
    // Up to three leading spaces is what a link reference definition accepts,
    // so the footnote tokenizer has to claim the same shape or the note body
    // is swallowed as a definition and disappears.
    const host = render("正文[^1]\n\n  [^1]: 缩进注释");
    expect(host.querySelector("[href]")).toBeNull();
    expect(host.querySelector(".footnote-def")?.textContent).toContain(
      "缩进注释"
    );
  });

  it("keeps a definition without a reference visible", () => {
    const host = render("[^1]: 孤立注释");
    expect(host.querySelector("[href]")).toBeNull();
    expect(host.querySelector(".footnote-def")?.textContent).toContain(
      "孤立注释"
    );
  });

  it("does not swallow bracket text that is not a footnote", () => {
    const host = render("literal [x] and [not^a] stay");
    expect(host.querySelector(".footnote-ref")).toBeNull();
    expect(host.textContent).toContain("literal [x] and [not^a] stay");
  });

  it("keeps details and summary structure instead of unwrapping them", () => {
    const host = render("<details><summary>展开</summary>内容</details>");
    const details = host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toBe("展开");
    expect(details?.textContent).toContain("内容");
  });

  it("keeps details inert: no scripts, handlers, or URL carriers survive", () => {
    const host = render(
      '<details open ontoggle="alert(1)"><summary onclick="alert(2)">s</summary><script>alert(3)</script><a href="javascript:alert(4)">l</a></details>'
    );
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(host.querySelector("details")?.getAttribute("ontoggle")).toBeNull();
    expect(host.querySelector("summary")?.getAttribute("onclick")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBeNull();
  });

  it("keeps a long footnote label paired instead of losing the note body", () => {
    // A definition this extension declines falls through to Marked's `def`
    // tokenizer, which discards the body silently — the very failure R8 exists
    // to prevent. The label bound must be generous enough that ordinary text
    // never crosses it.
    const label = "a".repeat(200);
    const host = render(`正文[^${label}]\n\n[^${label}]: 长标签注释`);

    expect(host.querySelector("[href]")).toBeNull();
    expect(host.querySelector("sup.footnote-ref")?.textContent).toBe(
      `[${label}]`
    );
    expect(host.querySelector(".footnote-def")?.textContent).toContain(
      "长标签注释"
    );
  });

  it("shows a literal ampersand in image alt text exactly once", () => {
    // `&amp;` in Markdown source already means a literal `&`; re-encoding it
    // would surface `&amp;` to the reader.
    const host = render(
      "![a &amp; b](https://example.com/a.png) ![c & d](https://example.com/b.png)"
    );
    const anchors = host.querySelectorAll("a");
    expect(anchors[0]?.textContent).toBe("a & b");
    expect(anchors[1]?.textContent).toBe("c & d");
    expect(host.innerHTML).not.toContain("&amp;amp;");
  });

  it("still escapes markup characters in image alt text", () => {
    const host = render(
      '![<script>alert(1)</script> "x" \'y\'](https://example.com/a.png)'
    );
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("a")?.textContent).toContain("<script>");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a.png"
    );
  });

  it("keeps a query-string ampersand intact in a degraded image link", () => {
    const host = render("![x](https://example.com/a?b=1&c=2)");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a?b=1&c=2"
    );
  });
});
