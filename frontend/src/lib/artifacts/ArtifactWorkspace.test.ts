// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatArtifact } from "./artifacts";
import ArtifactWorkspace from "./ArtifactWorkspace.svelte";

function artifact(overrides: Partial<ChatArtifact> = {}): ChatArtifact {
  return {
    id: "m-1:artifact:0",
    messageId: "m-1",
    blockIndex: 0,
    codeBlockIndex: 0,
    kind: "html",
    language: "html",
    code: "<button onclick=\"document.body.dataset.clicked='yes'\">Click</button>",
    complete: true,
    ...overrides
  };
}

function mountWorkspace(items = [artifact()]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const instance = mount(ArtifactWorkspace, {
    target: container,
    props: { artifact: items[0], artifacts: items, onSelect, onClose }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    onSelect,
    onClose,
    destroy() {
      void unmount(instance);
      container.remove();
    }
  };
}

describe("ArtifactWorkspace", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the exact opaque-origin iframe security contract", () => {
    const view = mountWorkspace();
    const frame = view.container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("allow")).toContain("camera 'none'");
    expect(frame?.getAttribute("allow")).toContain("clipboard-write 'none'");
    expect(frame?.getAttribute("srcdoc")).toContain("default-src 'none'");
    view.destroy();
  });

  it("switches to a read-only source view and closes accessibly", () => {
    const view = mountWorkspace();
    const sourceTab = Array.from(view.container.querySelectorAll("[role='tab']")).find(
      (tab) => tab.textContent === "源码"
    ) as HTMLButtonElement;
    sourceTab.click();
    flushSync();
    expect(view.container.querySelector("pre.source")?.textContent).toContain(
      "document.body.dataset.clicked"
    );
    view.container
      .querySelector<HTMLButtonElement>("button[aria-label='关闭 Artifact 预览']")
      ?.click();
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("offers selection when a conversation has multiple artifacts", () => {
    const second = artifact({
      id: "m-2:artifact:0",
      messageId: "m-2",
      kind: "css",
      language: "css",
      code: "body { color: red; }"
    });
    const view = mountWorkspace([artifact(), second]);
    const select = view.container.querySelector("select") as HTMLSelectElement;
    select.value = second.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.onSelect).toHaveBeenCalledWith(second.id);
    view.destroy();
  });
});
