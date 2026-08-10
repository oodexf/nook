// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../api/conversations";
import MessageList from "./MessageList.svelte";

let idCounter = 0;

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  idCounter += 1;
  return {
    id: `m-${idCounter}`,
    conversationId: "c-1",
    clientMessageId: null,
    role: "user",
    content: "内容",
    reasoning: null,
    status: "completed",
    model: null,
    errorCode: null,
    createdAt: 1786000000000 + idCounter,
    finishedAt: null,
    ...overrides
  };
}

function mountList(props: {
  messages: ChatMessage[];
  excludedMessageIds?: string[];
  onRetry?: ((id: string) => void) | null;
  retryDisabled?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = mount(MessageList, {
    target: container,
    props: {
      messages: props.messages,
      excludedMessageIds: props.excludedMessageIds ?? [],
      onRetry: props.onRetry ?? null,
      retryDisabled: props.retryDisabled ?? false
    }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    destroy: () => {
      void unmount(instance);
      container.remove();
    }
  };
}

describe("MessageList", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // @ts-expect-error test cleanup of the stubbed clipboard
    delete navigator.clipboard;
  });

  it("places persisted messages in shared role lanes", () => {
    const { container, destroy } = mountList({
      messages: [
        message({ role: "user", content: "问题" }),
        message({ role: "assistant", content: "回答", model: "test-model" })
      ]
    });

    const lanes = container.querySelectorAll("article.lane");
    expect(lanes).toHaveLength(2);
    // Phase I-01 contract: user right lane, assistant left lane.
    expect(lanes[0]?.getAttribute("data-role")).toBe("user");
    expect(lanes[0]?.getAttribute("aria-label")).toBe("你");
    expect(lanes[1]?.getAttribute("data-role")).toBe("assistant");
    expect(lanes[1]?.getAttribute("aria-label")).toBe("助手");
    // Copy/status treatment stays attached to the owning lane.
    expect(lanes[0]?.querySelector(".actions .copy-button")).not.toBeNull();
    expect(lanes[1]?.querySelector(".actions .copy-button")).not.toBeNull();
    destroy();
  });

  it("renders formulas only for persisted assistant messages", () => {
    const formula = "formula $x^2$. ";
    const { container, destroy } = mountList({
      messages: [
        message({ role: "user", content: formula }),
        message({ role: "assistant", content: formula })
      ]
    });

    const userLane = container.querySelector(".lane[data-role='user']");
    expect(userLane?.querySelector(".katex")).toBeNull();
    expect(userLane?.textContent).toContain("$x^2$");
    const assistantLane = container.querySelector(
      ".lane[data-role='assistant']"
    );
    expect(assistantLane?.querySelector(".katex msup")).not.toBeNull();
    destroy();
  });

  it("uses the shared compact copy control with announced feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    const { container, destroy } = mountList({
      messages: [message({ role: "user", content: "复制我" })]
    });

    const button = container.querySelector<HTMLButtonElement>(
      ".lane[data-role='user'] button.copy-button"
    );
    expect(button?.getAttribute("aria-label")).toBe("复制你消息内容");
    expect(button?.title).toBe("复制你消息内容");
    expect(button?.dataset.state).toBe("idle");
    expect(button?.querySelector("svg[aria-hidden='true']")).not.toBeNull();

    button?.click();
    await vi.waitFor(() => {
      expect(button?.dataset.state).toBe("copied");
    });
    expect(writeText).toHaveBeenCalledWith("复制我");
    expect(
      container.querySelector("[role='status']")?.textContent
    ).toContain("已复制");
    destroy();
  });

  it("renders content as escaped plain text, never as HTML", () => {
    const { container, destroy } = mountList({
      messages: [
        message({ content: "<script>alert(1)</script><b>粗</b>" })
      ]
    });

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector(".content")?.textContent).toBe(
      "<script>alert(1)</script><b>粗</b>"
    );
    destroy();
  });

  it("renders explicit localized statuses", () => {
    const { container, destroy } = mountList({
      messages: [
        message({ role: "assistant", status: "completed", content: "a" }),
        message({ role: "assistant", status: "stopped", content: "b" }),
        message({ role: "assistant", status: "error", content: "c" }),
        message({ role: "assistant", status: "interrupted", content: "d" })
      ]
    });

    const statuses = Array.from(
      container.querySelectorAll(".status")
    ).map((element) => element.textContent?.trim());
    expect(statuses).toEqual(["已完成", "已停止", "出错", "已中断"]);
    destroy();
  });

  it("offers retry only on the latest retry-eligible assistant message", () => {
    const onRetry = vi.fn();
    const older = message({
      role: "assistant",
      status: "error",
      content: "旧失败"
    });
    const user = message({ role: "user", content: "再问" });
    const latest = message({
      role: "assistant",
      status: "stopped",
      content: "部分"
    });
    const { container, destroy } = mountList({
      messages: [older, user, latest],
      onRetry
    });

    const retries = container.querySelectorAll<HTMLButtonElement>("button.retry");
    expect(retries).toHaveLength(1);
    retries[0]?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(latest.id);
    destroy();
  });

  it("renders regenerate as a compact accessible icon action", () => {
    const { container, destroy } = mountList({
      messages: [
        message({ role: "assistant", status: "completed", content: "回答" })
      ],
      onRetry: () => undefined
    });

    const retry = container.querySelector<HTMLButtonElement>("button.retry");
    expect(retry?.getAttribute("aria-label")).toBe("重新生成助手消息");
    expect(retry?.title).toBe("重新生成");
    expect(retry?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(retry?.textContent?.trim()).toBe("");
    destroy();
  });

  it("never offers retry while a stream is active (streaming status)", () => {
    const { container, destroy } = mountList({
      messages: [
        message({ role: "assistant", status: "streaming", content: "" })
      ],
      onRetry: () => undefined
    });

    expect(container.querySelector("button.retry")).toBeNull();
    destroy();
  });

  it("hides messages rendered by the generation overlay", () => {
    const visible = message({ role: "user", content: "问题" });
    const overlay = message({
      role: "assistant",
      status: "streaming",
      content: ""
    });
    const { container, destroy } = mountList({
      messages: [visible, overlay],
      excludedMessageIds: [overlay.id]
    });

    expect(container.querySelectorAll("li.message")).toHaveLength(1);
    expect(container.textContent).toContain("问题");
    destroy();
  });

  it("shows inline failure notes with the error code", () => {
    const { container, destroy } = mountList({
      messages: [
        message({
          role: "assistant",
          status: "error",
          content: "前半部分",
          errorCode: "provider_timeout"
        })
      ]
    });

    const note = container.querySelector(".failure-note");
    expect(note?.getAttribute("role")).toBe("alert");
    expect(note?.textContent).toContain("provider_timeout");
    destroy();
  });
});
