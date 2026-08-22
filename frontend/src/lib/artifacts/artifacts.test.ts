// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CSP,
  buildArtifactPreviewDocument,
  captureArtifactTheme,
  extractArtifacts,
  resolveArtifactKind
} from "./artifacts";

const lightTheme = {
  colorScheme: "light" as const,
  variables: [["--surface", "#fff"]] as const
};

describe("artifact detection", () => {
  it.each([
    ["html", "text", "html"],
    ["xhtml", "text", "html"],
    ["scss", "text", "css"],
    ["mjs", "text", "javascript"],
    ["", "<section>hello</section>", "html"],
    ["markdown", "<!doctype html><html></html>", "html"]
  ] as const)("maps %s to %s", (language, code, expected) => {
    expect(resolveArtifactKind(language, code)).toBe(expected);
  });

  it("does not classify ordinary source code", () => {
    expect(resolveArtifactKind("ts", "const x = 1")).toBeNull();
    expect(resolveArtifactKind("", "plain prose")).toBeNull();
  });

  it("extracts previewable fenced blocks and preserves code-block positions", () => {
    const source = [
      "```ts",
      "const ignored = true;",
      "```",
      "~~~html title=demo",
      "<main>preview</main>",
      "~~~~",
      "```css",
      ".card { color: red; }",
      "```"
    ].join("\n");

    expect(extractArtifacts(source, "message-1", true)).toEqual([
      expect.objectContaining({
        id: "message-1:artifact:0",
        blockIndex: 0,
        codeBlockIndex: 1,
        kind: "html",
        language: "html",
        code: "<main>preview</main>",
        complete: true
      }),
      expect.objectContaining({
        id: "message-1:artifact:1",
        blockIndex: 1,
        codeBlockIndex: 2,
        kind: "css",
        complete: true
      })
    ]);
  });

  it("does not expose an incomplete streaming fence", () => {
    const source = "```html\n<script>document.body.textContent = 'live'</script>";
    expect(extractArtifacts(source, "stream", false)).toEqual([]);
    expect(extractArtifacts(source, "settled", true)).toEqual([]);
  });

  it("falls back to one whole-message HTML artifact", () => {
    const [artifact] = extractArtifacts(
      "<!doctype html><html><body>hello</body></html>",
      "message-2",
      true
    );
    expect(artifact).toEqual(
      expect.objectContaining({
        id: "message-2:artifact:0",
        codeBlockIndex: null,
        kind: "html",
        complete: true
      })
    );
  });
});

describe("artifact preview documents", () => {
  it("puts the platform CSP before user head content", () => {
    const documentHtml = buildArtifactPreviewDocument(
      "html",
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>User</title></head><body><h1>Hello</h1></body></html>',
      lightTheme
    );

    expect(documentHtml).toContain(ARTIFACT_CSP);
    expect(documentHtml.indexOf(ARTIFACT_CSP)).toBeLessThan(
      documentHtml.indexOf("default-src *")
    );
    expect(documentHtml).toContain("<h1>Hello</h1>");
  });

  it("wraps CSS in an isolated sample document", () => {
    const documentHtml = buildArtifactPreviewDocument(
      "css",
      ".preview-panel { color: tomato; }",
      lightTheme
    );
    expect(documentHtml).toContain(".preview-panel { color: tomato; }");
    expect(documentHtml).toContain("Preview Surface");
  });

  it("escapes closing script sequences in JavaScript artifacts", () => {
    const documentHtml = buildArtifactPreviewDocument(
      "javascript",
      "document.body.dataset.value = '</script><script>parent.alert(1)</script>'",
      lightTheme
    );
    expect(documentHtml).not.toContain("'</script><script>parent.alert");
    expect(documentHtml).toContain("<\\/script");
    expect(documentHtml).toContain('id="artifact-console"');
  });

  it("captures only approved, structurally safe theme variables", () => {
    document.documentElement.style.setProperty("--surface", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--text", "red;}</style>");
    document.documentElement.style.setProperty("--attacker", "hotpink");
    const theme = captureArtifactTheme("dark");
    expect(theme.colorScheme).toBe("dark");
    expect(theme.variables).toContainEqual(["--surface", "rgb(1, 2, 3)"]);
    expect(theme.variables.some(([name]) => name === "--attacker")).toBe(false);
    expect(theme.variables.some(([name]) => name === "--text")).toBe(false);
  });
});
