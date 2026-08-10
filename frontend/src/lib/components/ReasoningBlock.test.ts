// @vitest-environment jsdom
/**
 * ReasoningBlock unit coverage (task 08-10): streaming starts expanded,
 * the answer start auto-collapses exactly once unless the user already
 * toggled, and history starts collapsed.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import { reactiveBox } from "../test-utils/reactive-box.svelte";
import ReasoningBlock from "./ReasoningBlock.svelte";

type BlockState = {
  reasoning: string;
  streaming: boolean;
  contentStarted: boolean;
  initiallyExpanded: boolean;
};

function mountBlock(initial: BlockState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const state = reactiveBox(initial);
  const instance = mount(ReasoningBlock, {
    target: container,
    props: {
      get reasoning() {
        return state.value.reasoning;
      },
      get streaming() {
        return state.value.streaming;
      },
      get contentStarted() {
        return state.value.contentStarted;
      },
      get initiallyExpanded() {
        return state.value.initiallyExpanded;
      }
    }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    update(patch: Partial<BlockState>) {
      state.set({ ...state.value, ...patch });
      flushSync();
    },
    destroy: () => {
      void unmount(instance);
      container.remove();
    }
  };
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.toggle");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function panelOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".panel");
}

describe("ReasoningBlock", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts expanded while streaming and shows the live label", () => {
    const view = mountBlock({
      reasoning: "分析中",
      streaming: true,
      contentStarted: false,
      initiallyExpanded: true
    });
    const toggle = toggleOf(view.container);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("正在思考…");
    expect(panelOf(view.container)?.textContent).toBe("分析中");
    view.destroy();
  });

  it("auto-collapses exactly once when answer content starts", () => {
    const view = mountBlock({
      reasoning: "思维链",
      streaming: true,
      contentStarted: false,
      initiallyExpanded: true
    });
    view.update({ contentStarted: true, streaming: false });
    const toggle = toggleOf(view.container);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("思考过程");
    expect(panelOf(view.container)).toBeNull();

    // Manual re-expand sticks; no further automatic collapse.
    toggle.click();
    flushSync();
    expect(panelOf(view.container)?.textContent).toBe("思维链");
    view.update({ contentStarted: false });
    view.update({ contentStarted: true });
    expect(panelOf(view.container)).not.toBeNull();
    view.destroy();
  });

  it("skips auto-collapse when the user already toggled during streaming", () => {
    const view = mountBlock({
      reasoning: "思维链",
      streaming: true,
      contentStarted: false,
      initiallyExpanded: true
    });
    const toggle = toggleOf(view.container);
    // User collapses manually before the answer starts.
    toggle.click();
    flushSync();
    expect(panelOf(view.container)).toBeNull();

    view.update({ contentStarted: true, streaming: false });
    // Still collapsed, and a later manual expand is respected.
    expect(panelOf(view.container)).toBeNull();
    toggle.click();
    flushSync();
    expect(panelOf(view.container)).not.toBeNull();
    view.destroy();
  });

  it("starts collapsed for persisted history and expands on demand", () => {
    const view = mountBlock({
      reasoning: "历史思维链",
      streaming: false,
      contentStarted: true,
      initiallyExpanded: false
    });
    const toggle = toggleOf(view.container);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("思考过程");
    expect(panelOf(view.container)).toBeNull();

    toggle.click();
    flushSync();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panelOf(view.container)?.textContent).toBe("历史思维链");
    view.destroy();
  });
});
