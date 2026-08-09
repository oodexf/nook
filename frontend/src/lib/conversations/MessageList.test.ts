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
  });

  it("renders formulas only for persisted assistant messages", () => {
    const formula = "formula $x^2$. ";
    const { container, destroy } = mountList({
      messages: [
        message({ role: "user", content: formula }),
        message({ role: "assistant", content: formula })
      ]
    });

    const userMessage = container.querySelector("article[aria-label='你']");
    expect(userMessage?.querySelector(".katex")).toBeNull();
    expect(userMessage?.textContent).toContain("$x^2$");
    const assistantMessage = container.querySelector(
      "article[aria-label='助手']"
    );
    expect(assistantMessage?.querySelector(".katex msup")).not.toBeNull();
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

  it("labels a completed retry as regenerate", () => {
    const { container, destroy } = mountList({
      messages: [
        message({ role: "assistant", status: "completed", content: "回答" })
      ],
      onRetry: () => undefined
    });

    expect(
      container.querySelector("button.retry")?.textContent?.trim()
    ).toBe("重新生成");
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
