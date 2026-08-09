// @vitest-environment jsdom
import { resolve } from "node:path";
import { compile } from "svelte/compiler";
import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

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

function mountMarkdown(content: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = mount(MarkdownContent, {
    target: container,
    props: { content }
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
