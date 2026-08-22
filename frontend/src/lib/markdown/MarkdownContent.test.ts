// @vitest-environment jsdom
import { resolve } from "node:path";
import { compile } from "svelte/compiler";
import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import MarkdownContent from "./MarkdownContent.svelte";

const componentPath = resolve(
  process.cwd(),
  "src/lib/markdown/MarkdownContent.svelte"
);
const componentCss = (() => {
  const compiledCss = compile(readFileSync(componentPath, "utf8"), {
    filename: componentPath,
    generate: "client",
    css: "external"
  }).css?.code;

  if (compiledCss === undefined) {
    throw new Error("MarkdownContent component CSS was not compiled");
  }
  return compiledCss;
})();

function installComponentStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = componentCss;
  document.head.appendChild(style);
  return style;
}

function mountMarkdown(
  content: string,
  extraProps: Record<string, unknown> = {}
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = mount(MarkdownContent, {
    target: container,
    props: { content, ...extraProps }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    destroy() {
      void unmount(instance);
      container.remove();
    }
  };
}

describe("MarkdownContent formulas", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps one Markdown boundary with accessible formula output", () => {
    const view = mountMarkdown("Answer: $x^2$. ");
    expect(view.container.querySelectorAll(".markdown")).toHaveLength(1);
    expect(view.container.querySelector(".katex-mathml math msup")).not.toBeNull();
    expect(
      view.container.querySelector(".katex-html")?.getAttribute("aria-hidden")
    ).toBe("true");
    view.destroy();
  });

  it("gives a long display formula a locally scrollable outer container", () => {
    const styles = installComponentStyles();
    const terms = Array.from({ length: 80 }, (_, index) => `x_{${index}}`).join(
      "+"
    );
    const view = mountMarkdown(`$$\n${terms}\n$$`);
    const display = view.container.querySelector<HTMLElement>(".katex-display");
    expect(display).not.toBeNull();
    expect(display?.closest(".markdown")).not.toBeNull();
    expect(display?.querySelector(":scope > .katex")).not.toBeNull();
    expect(display?.textContent?.length).toBeGreaterThan(100);
    expect(getComputedStyle(display!).overflowX).toBe("auto");
    expect(getComputedStyle(display!).overflowY).toBe("hidden");
    expect(getComputedStyle(display!).maxWidth).toBe("100%");
    expect(
      getComputedStyle(display!.querySelector<HTMLElement>(":scope > .katex")!)
        .minWidth
    ).toBe("max-content");
    view.destroy();
    styles.remove();
  });

  it("adds a real preview action only for settled previewable code", () => {
    const onOpenArtifact = vi.fn();
    const view = mountMarkdown("```html\n<h1>Preview</h1>\n```", {
      artifactMessageId: "message-1",
      artifactsSettled: true,
      onOpenArtifact
    });
    const button = view.container.querySelector<HTMLButtonElement>(
      ".artifact-preview-button"
    );
    expect(button?.textContent).toBe("预览");
    button?.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "html", code: "<h1>Preview</h1>" }),
      button
    );
    view.destroy();
  });

  it("offers preview for a whole HTML-like assistant message", () => {
    const onOpenArtifact = vi.fn();
    const view = mountMarkdown("<!doctype html><html><body><h1>Page</h1></body></html>", {
      artifactMessageId: "message-2",
      onOpenArtifact
    });
    const button = view.container.querySelector<HTMLButtonElement>(
      ".artifact-inline-action"
    );
    expect(button?.textContent).toBe("打开 HTML 预览");
    button?.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "html", codeBlockIndex: null }),
      button
    );
    view.destroy();
  });

  it("suppresses all code actions for transient stream snapshots", () => {
    const view = mountMarkdown("```html\n<h1>Preview</h1>\n```", {
      artifactMessageId: "stream",
      artifactsSettled: false,
      suppressCodeCopy: true,
      onOpenArtifact: vi.fn()
    });
    expect(view.container.querySelector(".artifact-preview-button")).toBeNull();
    expect(view.container.querySelector(".copy-button")).toBeNull();
    view.destroy();
  });

  it("contains adversarial inline HTML inside the Markdown region", () => {
    const styles = installComponentStyles();
    const view = mountMarkdown(
      '<div style="position:fixed;z-index:999999;transform:translateX(-100vw);width:100vw;height:100vh;overflow:visible">contained</div>'
    );
    const root = view.container.querySelector<HTMLElement>(".markdown");
    expect(root).not.toBeNull();
    expect(getComputedStyle(root!).position).toBe("relative");
    expect(getComputedStyle(root!).isolation).toBe("isolate");
    expect(getComputedStyle(root!).overflow).toBe("hidden");
    expect(getComputedStyle(root!).maxWidth).toBe("100%");
    view.destroy();
    styles.remove();
  });

  it("keeps invalid display TeX readable in the same local overflow region", () => {
    const source = String.raw`\notARealCommand{xxxxxxxxxxxxxxxx}`;
    const view = mountMarkdown(`$$\n${source}\n$$`);
    const error = view.container.querySelector<HTMLElement>(
      ".katex-error-display"
    );
    expect(error?.textContent).toBe(source);
    expect(error?.closest(".markdown")).not.toBeNull();
    expect(error?.classList.contains("katex-error")).toBe(true);
    view.destroy();
  });
});
