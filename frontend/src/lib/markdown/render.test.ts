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
