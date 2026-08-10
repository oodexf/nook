// @vitest-environment jsdom
/**
 * StreamingTurn unit coverage (Phase I-01/I-05): role lanes for the
 * in-flight turn, throttled live Markdown during streaming, immediate
 * terminal render, and unchanged sanitization for hostile content.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reactiveBox } from "../test-utils/reactive-box.svelte";
import type {
  GenerationPhase,
  GenerationTerminal
} from "./generation-store.svelte";
import StreamingTurn from "./StreamingTurn.svelte";

type TurnState = {
  userContent: string | null;
  assistantText: string;
  reasoningText: string;
  phase: GenerationPhase;
  terminal: GenerationTerminal | null;
  model: string | null;
};

function mountTurn(initial: TurnState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  // `$state`-backed boxes keep the mounted component reactive to the
  // `update()` calls below (plain object getters would not notify Svelte).
  const state = reactiveBox(initial);
  const instance = mount(StreamingTurn, {
    target: container,
    props: {
      get userContent() {
        return state.value.userContent;
      },
      get assistantText() {
        return state.value.assistantText;
      },
      get reasoningText() {
        return state.value.reasoningText;
      },
      get phase() {
        return state.value.phase;
      },
      get terminal() {
        return state.value.terminal;
      },
      get model() {
        return state.value.model;
      }
    }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    update(patch: Partial<TurnState>) {
      state.set({ ...state.value, ...patch });
      flushSync();
    },
    destroy: () => {
      void unmount(instance);
      container.remove();
    }
  };
}

function streamingState(patch: Partial<TurnState> = {}): TurnState {
  return {
    userContent: "问题",
    assistantText: "",
    reasoningText: "",
    phase: "streaming",
    terminal: null,
    model: "test-model",
    ...patch
  };
}

/**
 * Every element with live-region semantics: explicit `aria-live` plus the
 * implicit politeness of `role=status`/`role=alert`. Counting only
 * `[aria-live]` would miss implicit regions. Each copy control owns a
 * private polite status slot (`.copy-slot`), which is excluded here so
 * the count reflects only phase/terminal announcements.
 */
function liveRegionsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "[aria-live], [role='status'], [role='alert']"
    )
  ).filter((element) => element.closest(".copy-slot") === null);
}

describe("StreamingTurn", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // @ts-expect-error test cleanup of the stubbed clipboard
    delete navigator.clipboard;
  });

  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    return writeText;
  }

  it("uses the shared role lanes for the optimistic user message and the stream", () => {
    const view = mountTurn(streamingState({ assistantText: "回答" }));

    const userLane = view.container.querySelector("article.lane[data-role='user']");
    expect(userLane?.getAttribute("aria-label")).toBe("你");
    expect(userLane?.textContent).toContain("问题");
    const assistantLane = view.container.querySelector(
      "article.lane[data-role='assistant']"
    );
    expect(assistantLane?.getAttribute("aria-label")).toBe("助手");
    expect(assistantLane?.textContent).toContain("回答");
    view.destroy();
  });

  it("renders Markdown before the terminal event", () => {
    const view = mountTurn(
      streamingState({ assistantText: "**加粗** 和 `代码`" })
    );

    const markdown = view.container.querySelector(
      "[data-role='assistant'] .markdown"
    );
    expect(markdown?.querySelector("strong")?.textContent).toBe("加粗");
    expect(markdown?.querySelector("code")?.textContent).toBe("代码");
    view.destroy();
  });

  it("strips hostile markup from the live stream", () => {
    const view = mountTurn(
      streamingState({
        assistantText:
          '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1))'
      })
    );

    const markdown = view.container.querySelector(
      "[data-role='assistant'] .markdown"
    );
    expect(markdown).not.toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
    expect(markdown?.querySelector("img")).toBeNull();
    const href = markdown?.querySelector("a")?.getAttribute("href") ?? "";
    expect(href).not.toContain("javascript:");
    view.destroy();
  });

  it("keeps an incomplete formula readable, then renders the closed formula on the throttled snapshot", () => {
    vi.useFakeTimers();
    try {
      const view = mountTurn(
        streamingState({ assistantText: "结果是 $x^2" })
      );
      const markdown = () =>
        view.container.querySelector("[data-role='assistant'] .markdown");

      expect(markdown()?.querySelector(".katex")).toBeNull();
      expect(markdown()?.textContent).toContain("$x^2");

      view.update({ assistantText: "结果是 $x^2$. " });
      expect(markdown()?.querySelector(".katex")).toBeNull();
      vi.advanceTimersByTime(200);
      flushSync();
      expect(markdown()?.querySelector(".katex")).not.toBeNull();
      expect(markdown()?.querySelector("msup")).not.toBeNull();
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the final formula immediately on the terminal transition", () => {
    vi.useFakeTimers();
    try {
      const view = mountTurn(
        streamingState({ assistantText: "结果是 $x^2" })
      );
      view.update({
        assistantText: "结果是 $x^2$. ",
        phase: "completed",
        terminal: { kind: "completed", finishReason: "stop" }
      });
      const markdown = view.container.querySelector(
        "[data-role='assistant'] .markdown"
      );
      expect(markdown?.querySelector(".katex")).not.toBeNull();
      expect(markdown?.querySelector("msup")).not.toBeNull();
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps formula snapshots out of token-level live announcements", () => {
    const view = mountTurn(
      streamingState({ assistantText: "结果是 $x^2$. " })
    );

    expect(
      view.container.querySelector(".markdown .katex-mathml math")
    ).not.toBeNull();
    const liveRegions = liveRegionsOf(view.container);
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent).toContain("正在生成");
    expect(liveRegions[0]?.contains(view.container.querySelector("math"))).toBe(
      false
    );
    view.destroy();
  });

  it("renders an incomplete code fence as usable code", () => {
    const view = mountTurn(
      streamingState({ assistantText: "```js\nconst a = 1" })
    );

    expect(
      view.container.querySelector(".markdown pre code")?.textContent
    ).toContain("const a = 1");
    view.destroy();
  });

  it("does not re-render Markdown for every buffered update", () => {
    vi.useFakeTimers();
    try {
      const view = mountTurn(streamingState({ assistantText: "一" }));
      const markdown = () =>
        view.container.querySelector("[data-role='assistant'] .markdown");

      // First paint is immediate.
      expect(markdown()?.textContent).toContain("一");

      // Rapid buffered updates inside the throttle window leave the last
      // rendered snapshot untouched.
      view.update({ assistantText: "一二" });
      expect(markdown()?.textContent).not.toContain("一二");
      view.update({ assistantText: "一二三" });
      expect(markdown()?.textContent).not.toContain("一二三");

      // The trailing throttled render picks up the latest buffer once.
      vi.advanceTimersByTime(200);
      flushSync();
      expect(markdown()?.textContent).toContain("一二三");
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the final buffer immediately on the terminal transition", () => {
    vi.useFakeTimers();
    try {
      const view = mountTurn(streamingState({ assistantText: "一" }));
      // Enter the terminal state inside the throttle window: the final
      // render must not wait for the trailing timer.
      view.update({
        assistantText: "一二 final",
        phase: "completed",
        terminal: { kind: "completed", finishReason: "stop" }
      });
      expect(
        view.container.querySelector("[data-role='assistant'] .markdown")
          ?.textContent
      ).toContain("一二 final");
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the streaming status as the only live announcement", () => {
    const view = mountTurn(streamingState({ assistantText: "部分输出" }));

    const liveRegions = liveRegionsOf(view.container);
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent).toContain("正在生成");
    view.destroy();
  });

  it("announces a failed transition exactly once, owned by the alert", () => {
    const view = mountTurn(
      streamingState({
        assistantText: "部分输出",
        phase: "failed",
        terminal: {
          kind: "failed",
          message: "上游服务不可用",
          code: "provider_unavailable",
          requestId: null
        }
      })
    );

    const liveRegions = liveRegionsOf(view.container);
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.getAttribute("role")).toBe("alert");
    expect(liveRegions[0]?.textContent).toContain("上游服务不可用");
    // The visible phase label stays but is not a second announcement.
    const label = view.container.querySelector(".status[data-phase='failed']");
    expect(label?.textContent).toContain("生成失败");
    expect(label?.getAttribute("role")).toBeNull();
    expect(label?.getAttribute("aria-live")).toBeNull();
    view.destroy();
  });

  it("announces a stopped transition exactly once, owned by the status note", () => {
    const view = mountTurn(
      streamingState({
        assistantText: "部分输出",
        phase: "stopped",
        terminal: { kind: "stopped" }
      })
    );

    const liveRegions = liveRegionsOf(view.container);
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.getAttribute("role")).toBe("status");
    expect(liveRegions[0]?.textContent).toContain("已停止，以上内容已保留");
    const label = view.container.querySelector(".status[data-phase='stopped']");
    expect(label?.textContent).toContain("已停止");
    expect(label?.getAttribute("role")).toBeNull();
    expect(label?.getAttribute("aria-live")).toBeNull();
    view.destroy();
  });

  it("keeps the completed transition announced by the phase label alone", () => {
    const view = mountTurn(
      streamingState({
        assistantText: "完整输出",
        phase: "completed",
        terminal: { kind: "completed", finishReason: "stop" }
      })
    );

    const liveRegions = liveRegionsOf(view.container);
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent).toContain("已完成");
    view.destroy();
  });

  it("suppresses code copy controls while streaming and reveals them at the terminal transition", () => {
    const view = mountTurn(
      streamingState({ assistantText: "```js\nconst a = 1\n```" })
    );

    // Non-terminal snapshot renders the sanitized code block without any
    // interactive copy control on transient content.
    expect(
      view.container.querySelector("[data-role='assistant'] .markdown pre")
    ).not.toBeNull();
    expect(view.container.querySelector(".markdown .copy-button")).toBeNull();

    view.update({
      phase: "completed",
      terminal: { kind: "completed", finishReason: "stop" }
    });
    const button = view.container.querySelector<HTMLButtonElement>(
      ".markdown pre .copy-button"
    );
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("复制代码");
    view.destroy();
  });

  it("offers message-level copy for the optimistic user message below its bubble", async () => {
    const writeText = stubClipboard();
    const view = mountTurn(
      streamingState({ userContent: "复制这段问题", assistantText: "回答" })
    );

    const userLane = view.container.querySelector<HTMLElement>(
      "article.lane[data-role='user']"
    );
    expect(userLane).not.toBeNull();
    const button = userLane?.querySelector<HTMLButtonElement>(
      ".actions .copy-button"
    );
    expect(button?.getAttribute("aria-label")).toBe("复制你消息内容");
    // The action row belongs to the user lane and sits below the bubble
    // content (right-aligned on the trailing edge via the lane contract);
    // it is a message-level action, never part of the Markdown content.
    const bubble = userLane?.querySelector<HTMLElement>(".content");
    expect(bubble).not.toBeNull();
    expect(
      (bubble?.compareDocumentPosition(button as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(button?.closest(".markdown")).toBeNull();

    button?.click();
    await vi.waitFor(() => {
      expect(button?.dataset.state).toBe("copied");
    });
    expect(writeText).toHaveBeenCalledWith("复制这段问题");
    expect(
      userLane?.querySelector(".copy-slot [role='status']")?.textContent
    ).toContain("已复制");
    view.destroy();
  });

  it("offers message-level copy for the assistant buffer at the lower left of its lane", async () => {
    const writeText = stubClipboard();
    const view = mountTurn(streamingState({ assistantText: "流式回答" }));

    const assistantLane = view.container.querySelector<HTMLElement>(
      "article.lane[data-role='assistant']"
    );
    const button = assistantLane?.querySelector<HTMLButtonElement>(
      ".actions .copy-button"
    );
    expect(button?.getAttribute("aria-label")).toBe("复制助手消息内容");
    // Distinct from the per-code-block copy control inside the Markdown.
    expect(button?.closest(".markdown")).toBeNull();

    button?.click();
    await vi.waitFor(() => {
      expect(button?.dataset.state).toBe("copied");
    });
    expect(writeText).toHaveBeenCalledWith("流式回答");
    view.destroy();
  });

  it("copies the latest buffer mid-stream, not the first rendered snapshot", async () => {
    const writeText = stubClipboard();
    const view = mountTurn(streamingState({ assistantText: "一" }));
    view.update({ assistantText: "一二三" });

    const button = view.container.querySelector<HTMLButtonElement>(
      "article.lane[data-role='assistant'] .actions .copy-button"
    );
    button?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("一二三");
    });
    view.destroy();
  });

  it("keeps failed and stopped partial replies copyable", async () => {
    const writeText = stubClipboard();
    const failed = mountTurn(
      streamingState({
        assistantText: "失败前的部分输出",
        phase: "failed",
        terminal: {
          kind: "failed",
          message: "上游服务不可用",
          code: null,
          requestId: null
        }
      })
    );
    const failedButton = failed.container.querySelector<HTMLButtonElement>(
      "article.lane[data-role='assistant'] .actions .copy-button"
    );
    expect(failedButton).not.toBeNull();
    failedButton?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("失败前的部分输出");
    });
    failed.destroy();

    const stopped = mountTurn(
      streamingState({
        assistantText: "停止时的部分输出",
        phase: "stopped",
        terminal: { kind: "stopped" }
      })
    );
    const stoppedButton = stopped.container.querySelector<HTMLButtonElement>(
      "article.lane[data-role='assistant'] .actions .copy-button"
    );
    expect(stoppedButton).not.toBeNull();
    stoppedButton?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("停止时的部分输出");
    });
    stopped.destroy();
  });

  it("hides each message copy control while its own content is empty", () => {
    const view = mountTurn(streamingState({ assistantText: "" }));

    // No assistant copy while the buffer is empty; the user copy is
    // already available.
    expect(
      view.container.querySelector(
        "article.lane[data-role='assistant'] .actions .copy-button"
      )
    ).toBeNull();
    expect(
      view.container.querySelector(
        "article.lane[data-role='user'] .actions .copy-button"
      )
    ).not.toBeNull();

    view.update({ assistantText: "来了" });
    expect(
      view.container.querySelector(
        "article.lane[data-role='assistant'] .actions .copy-button"
      )
    ).not.toBeNull();
    view.destroy();

    // No user copy once the optimistic message is replaced by the server
    // copy (the whole user lane is gone).
    const settled = mountTurn(streamingState({ userContent: null }));
    expect(
      settled.container.querySelector("article.lane[data-role='user']")
    ).toBeNull();
    settled.destroy();
  });

  it("shows the thinking chain above the answer and auto-collapses it when content starts", () => {
    const view = mountTurn(streamingState({ reasoningText: "先分析需求" }));
    const toggle = view.container.querySelector<HTMLButtonElement>(
      "article.lane[data-role='assistant'] button.toggle"
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.textContent).toContain("正在思考…");

    view.update({ assistantText: "回答" });
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("思考过程");
    view.destroy();
  });

  it("renders no thinking block when the stream has no reasoning", () => {
    const view = mountTurn(streamingState({ assistantText: "回答" }));
    expect(view.container.querySelector("button.toggle")).toBeNull();
    view.destroy();
  });
});
