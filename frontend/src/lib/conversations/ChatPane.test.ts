// @vitest-environment jsdom
/**
 * ChatPane component coverage for the Phase E streaming UI: composer
 * wiring, the generation overlay, stop, retry, cross-navigation isolation,
 * and failure recovery.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGenerationStore } from "../generation/generation-store.svelte";
import { createModelStore } from "../models/model-store.svelte";
import ChatPane from "./ChatPane.svelte";
import { createConversationStore } from "./conversation-store.svelte";

const encoder = new TextEncoder();

const MODEL_ID = "test-model";

function catalogResponse(): Response {
  return new Response(
    JSON.stringify({
      models: [{ id: MODEL_ID, label: "Test Model" }],
      default_model: MODEL_ID,
      refreshed_at: 1786000000000,
      stale: false,
      refresh_error: null
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function metaBlock(conversationId: string): string {
  return (
    "event: meta\ndata: " +
    JSON.stringify({
      event: "meta",
      conversation_id: conversationId,
      user_message_id: "u-1",
      assistant_message_id: "a-1",
      generation_id: "g-1",
      model: MODEL_ID
    }) +
    "\n\n"
  );
}

function deltaBlock(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ event: "delta", text })}\n\n`;
}

const DONE_BLOCK =
  'event: done\ndata: {"event":"done","finish_reason":"stop","usage":null}\n\n';

function summary(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    model: MODEL_ID,
    created_at: 1786000000000,
    updated_at: 1786000001000
  };
}

function messageRecord(
  id: string,
  conversationId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    conversation_id: conversationId,
    client_message_id: null,
    role: "assistant",
    content: "旧回答",
    status: "completed",
    model: MODEL_ID,
    error_code: null,
    created_at: 1786000000000,
    finished_at: null,
    ...overrides
  };
}

type Controlled = {
  push: (text: string) => void;
  close: () => void;
};

/** Minimal routed fake: catalog + one controlled chat stream. */
function installRouter(options: {
  streamText: () => string;
  conversations?: Record<string, unknown>[];
  detailMessages?: Record<string, unknown>[];
}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  const controlled: Controlled = {
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close()
  };

  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v1/models" && method === "GET") {
      return Promise.resolve(catalogResponse());
    }
    if (url.startsWith("/api/v1/conversations?")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conversations: options.conversations ?? [],
            next_cursor: null
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (/^\/api\/v1\/conversations\/[^/?]+$/.test(url) && method === "GET") {
      const id = url.split("/").pop() as string;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conversation: summary(id, `对话 ${id}`),
            messages: options.detailMessages ?? []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (url.includes("/cancel")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      );
    }
    throw new Error(`unmatched ${method} ${url}`);
  });
  return controlled;
}

function mountPane() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const store = createConversationStore();
  const modelStore = createModelStore();
  const generation = createGenerationStore({
    onConversationCreated: (conversationId) => {
      void store.refreshList();
      if (store.selectedId === null) void store.open(conversationId);
    },
    onReconcile: (conversationId) => {
      void store.refreshList();
      if (store.selectedId === conversationId) {
        void store.reloadCurrent(conversationId);
      }
    }
  });
  const instance = mount(ChatPane, {
    target: container,
    props: {
      store,
      modelStore,
      generation,
      csrfToken: "csrf",
      onOpenDrawer: () => undefined
    }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    store,
    modelStore,
    generation,
    destroy: () => {
      void unmount(instance);
      container.remove();
    }
  };
}

function typeComposer(container: HTMLElement, value: string) {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer not rendered");
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function pressEnter(container: HTMLElement) {
  container.querySelector("textarea")?.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    })
  );
  flushSync();
}

describe("ChatPane streaming", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  it("sends a first message, streams into the overlay, and reconciles", async () => {
    const stream = installRouter({ streamText: () => "" });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "第一个问题");
    pressEnter(pane.container);

    await vi.waitFor(() => {
      expect(pane.container.querySelector(".turn")).not.toBeNull();
    });
    // Composer cleared on accepted send; stop is offered while streaming.
    expect(pane.container.querySelector("textarea")?.value).toBe("");
    expect(pane.container.querySelector("button.stop")).not.toBeNull();

    stream.push(metaBlock("c-new") + deltaBlock("流式回答"));
    await vi.waitFor(() => {
      expect(
        pane.container.querySelector(".turn .assistant .content")?.textContent
      ).toContain("流式回答");
    });

    stream.push(DONE_BLOCK);
    stream.close();
    await vi.waitFor(() => {
      expect(pane.generation.phase).toBe("completed");
    });
    pane.destroy();
  });

  it("hides the stream overlay after navigating to another conversation", async () => {
    const stream = installRouter({
      streamText: () => "",
      conversations: [summary("c-other", "其他对话")],
      detailMessages: [messageRecord("m-1", "c-other")]
    });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "A 的问题");
    pressEnter(pane.container);
    await vi.waitFor(() => expect(pane.generation.phase).toBe("connecting"));
    stream.push(metaBlock("c-new") + deltaBlock("A 的输出"));
    await vi.waitFor(() => {
      expect(pane.container.querySelector(".turn")).not.toBeNull();
    });

    // Navigate away: the overlay belongs to its own conversation.
    await pane.store.open("c-other");
    flushSync();
    expect(pane.container.querySelector(".turn")).toBeNull();
    expect(pane.container.textContent).toContain("旧回答");
    expect(pane.container.textContent).not.toContain("A 的输出");

    // The stream state itself is untouched by navigation.
    expect(pane.generation.conversationId).toBe("c-new");

    stream.push(DONE_BLOCK);
    stream.close();
    await vi.waitFor(() => expect(pane.generation.phase).toBe("completed"));
    // The user is not yanked back to the streaming conversation.
    expect(pane.store.selectedId).toBe("c-other");
    pane.destroy();
  });

  it("stop aborts and requests cancellation, preserving partial output", async () => {
    const stream = installRouter({ streamText: () => "" });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "问题");
    pressEnter(pane.container);
    stream.push(metaBlock("c-new") + deltaBlock("部分"));
    // Wait until meta was applied so the generation ID exists server-side
    // and the stop button reflects the streaming phase.
    await vi.waitFor(() => expect(pane.generation.phase).toBe("streaming"));
    await vi.waitFor(() => {
      expect(pane.container.querySelector("button.stop")).not.toBeNull();
    });

    pane.container.querySelector<HTMLButtonElement>("button.stop")?.click();
    await vi.waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) =>
          String(url).includes("/api/v1/generations/g-1/cancel")
        )
      ).toBe(true);
    });
    stream.close();
    await vi.waitFor(() => expect(pane.generation.phase).toBe("stopped"));
    expect(pane.generation.streamingText).toBe("部分");
    pane.destroy();
  });

  it("restores composer content after a pre-stream failure", async () => {
    installRouter({ streamText: () => "" });
    // First chat POST fails with a locked-model style error.
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/messages")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "model_unavailable",
                message: "The selected model is no longer available.",
                request_id: "req-7"
              }
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      if (url === "/api/v1/models") return Promise.resolve(catalogResponse());
      if (url.startsWith("/api/v1/conversations?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ conversations: [], next_cursor: null }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      throw new Error(`unmatched ${url}`);
    });

    typeComposer(pane.container, "保留这段文字");
    pressEnter(pane.container);

    await vi.waitFor(() => {
      expect(pane.container.querySelector(".failure")).not.toBeNull();
    });
    // Draft restored for correction; error is message-local, not toast-only.
    expect(pane.container.querySelector("textarea")?.value).toBe("保留这段文字");
    expect(pane.container.textContent).toContain("model_unavailable");
    pane.destroy();
  });

  it("offers retry on the latest assistant message and streams the new attempt", async () => {
    const stream = installRouter({
      streamText: () => "",
      conversations: [summary("c-1", "对话")],
      detailMessages: [
        messageRecord("u-1", "c-1", { role: "user", content: "问题" }),
        messageRecord("a-old", "c-1", { status: "error", error_code: "provider_timeout" })
      ]
    });
    const pane = mountPane();
    await pane.modelStore.load();
    await pane.store.load();
    await pane.store.open("c-1");
    flushSync();

    const retryButton = pane.container.querySelector<HTMLButtonElement>("button.retry");
    expect(retryButton?.textContent?.trim()).toBe("重试");
    retryButton?.click();

    await vi.waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) =>
          String(url).includes("/api/v1/messages/a-old/retry")
        )
      ).toBe(true);
    });
    stream.push(metaBlock("c-1") + deltaBlock("新的回答") + DONE_BLOCK);
    stream.close();
    await vi.waitFor(() => expect(pane.generation.phase).toBe("completed"));
    pane.destroy();
  });
});
