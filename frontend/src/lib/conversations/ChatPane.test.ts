// @vitest-environment jsdom
/**
 * ChatPane component coverage for the Phase E streaming UI: composer
 * wiring, the generation overlay, stop, retry, cross-navigation isolation,
 * and failure recovery.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_MODEL_ID } from "../test-utils/test-provider";

import { createGenerationStore } from "../generation/generation-store.svelte";
import { createModelStore } from "../models/model-store.svelte";
import ChatPane from "./ChatPane.svelte";
import { createConversationStore } from "./conversation-store.svelte";

const encoder = new TextEncoder();

const MODEL_ID = TEST_MODEL_ID;

function catalogResponse(): Response {
  return new Response(
    JSON.stringify({
      models: [
        { id: MODEL_ID, label: "Test Model" },
        { id: "model-b", label: "Model B" }
      ],
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
  updateModel?: (id: string) => Promise<Response> | Response;
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
    if (/^\/api\/v1\/conversations\/[^/?]+\/model$/.test(url) && method === "PUT") {
      const id = url.split("/").at(-2) as string;
      return Promise.resolve(
        options.updateModel?.(id) ??
          new Response(JSON.stringify(summary(id, `对话 ${id}`)), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
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

  it("disables send and every open selector option while a model update is pending", async () => {
    let resolveUpdate: (response: Response) => void = () => undefined;
    installRouter({
      streamText: () => "",
      conversations: [summary("c-1", "对话 c-1")],
      detailMessages: [messageRecord("a-old", "c-1")],
      updateModel: () =>
        new Promise<Response>((resolve) => {
          resolveUpdate = resolve;
        })
    });
    const pane = mountPane();
    await pane.modelStore.load();
    await pane.store.load();
    await pane.store.open("c-1");
    flushSync();

    const trigger = pane.container.querySelector<HTMLButtonElement>(".model-trigger");
    trigger?.click();
    flushSync();
    const modelB = Array.from(
      pane.container.querySelectorAll<HTMLButtonElement>(".model-option")
    ).find((option) => option.textContent?.includes("Model B"));
    modelB?.click();
    await vi.waitFor(() => expect(pane.store.isUpdatingModel("c-1")).toBe(true));
    flushSync();

    expect(trigger?.disabled).toBe(true);
    expect(
      Array.from(
        pane.container.querySelectorAll<HTMLButtonElement>(".model-option")
      ).every((option) => option.disabled)
    ).toBe(true);
    typeComposer(pane.container, "must wait");
    expect(
      pane.container.querySelector<HTMLButtonElement>("button.send")?.disabled
    ).toBe(true);

    resolveUpdate(
      new Response(
        JSON.stringify({
          ...summary("c-1", "对话 c-1"),
          model: "model-b",
          updated_at: 1786000004000
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await vi.waitFor(() => expect(pane.store.isUpdatingModel("c-1")).toBe(false));
    pane.destroy();
  });

  it("keeps another conversation usable while the first conversation model update is pending", async () => {
    let resolveA: (response: Response) => void = () => undefined;
    installRouter({
      streamText: () => "",
      conversations: [summary("c-1", "对话 c-1"), summary("c-2", "对话 c-2")],
      detailMessages: [messageRecord("a-old", "c-1")],
      updateModel: (id) =>
        id === "c-1"
          ? new Promise<Response>((resolve) => {
              resolveA = resolve;
            })
          : new Response(
              JSON.stringify({
                ...summary("c-2", "对话 c-2"),
                model: "model-b",
                updated_at: 1786000005000
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
    });
    const pane = mountPane();
    await pane.modelStore.load();
    await pane.store.load();
    await pane.store.open("c-1");
    flushSync();

    pane.container.querySelector<HTMLButtonElement>(".model-trigger")?.click();
    flushSync();
    Array.from(
      pane.container.querySelectorAll<HTMLButtonElement>(".model-option")
    )
      .find((option) => option.textContent?.includes("Model B"))
      ?.click();
    await vi.waitFor(() => expect(pane.store.isUpdatingModel("c-1")).toBe(true));

    await pane.store.open("c-2");
    flushSync();
    const trigger = pane.container.querySelector<HTMLButtonElement>(".model-trigger");
    expect(trigger?.disabled).toBe(false);
    typeComposer(pane.container, "B remains usable");
    expect(
      pane.container.querySelector<HTMLButtonElement>("button.send")?.disabled
    ).toBe(false);

    trigger?.click();
    flushSync();
    Array.from(
      pane.container.querySelectorAll<HTMLButtonElement>(".model-option")
    )
      .find((option) => option.textContent?.includes("Model B"))
      ?.click();
    await vi.waitFor(() => {
      expect(pane.store.current?.conversation.id).toBe("c-2");
      expect(pane.store.current?.conversation.model).toBe("model-b");
    });

    resolveA(
      new Response(
        JSON.stringify({
          ...summary("c-1", "对话 c-1"),
          model: "model-b",
          updated_at: 1786000004000
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await vi.waitFor(() => expect(pane.store.isUpdatingModel("c-1")).toBe(false));
    expect(pane.store.current?.conversation.id).toBe("c-2");
    pane.destroy();
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
    // Live Markdown (Phase I-05): the stream renders through the
    // sanitized Markdown lane before the terminal event.
    await vi.waitFor(() => {
      expect(
        pane.container.querySelector(".turn [data-role='assistant'] .markdown")
          ?.textContent
      ).toContain("流式回答");
    });

    stream.push(DONE_BLOCK);
    stream.close();
    await vi.waitFor(() => {
      expect(pane.generation.phase).toBe("completed");
    });
    pane.destroy();
  });

  it("releases the settled overlay once persisted, exposing regenerate", async () => {
    // The reload returns the server-authoritative copies of the turn (the
    // router is static, so `a-1` is present from the first open).
    const stream = installRouter({
      streamText: () => "",
      detailMessages: [
        messageRecord("u-1", "c-new", { role: "user", content: "第一个问题" }),
        messageRecord("a-1", "c-new", { content: "流式回答" })
      ]
    });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "第一个问题");
    pressEnter(pane.container);
    await vi.waitFor(() => expect(pane.generation.phase).toBe("connecting"));

    stream.push(metaBlock("c-new") + deltaBlock("流式回答"));
    // While streaming, the overlay owns the turn and the persisted copy is
    // excluded, so no regenerate control is visible yet.
    await vi.waitFor(() => {
      expect(pane.container.querySelector(".turn")).not.toBeNull();
    });
    expect(pane.container.querySelector("button.retry")).toBeNull();

    stream.push(DONE_BLOCK);
    stream.close();

    // After the terminal event and reconciliation, the overlay yields to
    // the persisted list, which offers regenerate on the latest assistant
    // message (08-08 fix: previously the overlay stayed mounted and the
    // button never appeared).
    await vi.waitFor(() => {
      expect(pane.container.querySelector(".turn")).toBeNull();
    });
    const retry =
      pane.container.querySelector<HTMLButtonElement>("button.retry");
    expect(retry?.getAttribute("aria-label")).toBe("重新生成助手消息");
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

    const retryButton =
      pane.container.querySelector<HTMLButtonElement>("button.retry");
    expect(retryButton?.getAttribute("aria-label")).toBe("重试助手消息");
    expect(retryButton?.title).toBe("重试");
    expect(retryButton?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
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

  it("renders streamed Markdown in role lanes, throttled between deltas", async () => {
    const stream = installRouter({ streamText: () => "" });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "问题");
    pressEnter(pane.container);
    stream.push(metaBlock("c-new") + deltaBlock("**第一段**"));

    // The optimistic user message sits in the right lane hook.
    await vi.waitFor(() => {
      expect(
        pane.container.querySelector(".turn [data-role='user']")?.textContent
      ).toContain("问题");
    });
    // The first streamed Markdown render is immediate (Phase I-05).
    await vi.waitFor(() => {
      expect(
        pane.container.querySelector(
          ".turn [data-role='assistant'] .markdown strong"
        )?.textContent
      ).toBe("第一段");
    });

    // A delta inside the throttle window updates the buffer but is not
    // parsed into Markdown per transport delta.
    stream.push(deltaBlock(" 第二段"));
    await vi.waitFor(() => {
      expect(pane.generation.streamingText).toContain("第二段");
    });
    expect(
      pane.container.querySelector(".turn [data-role='assistant'] .markdown")
        ?.textContent
    ).not.toContain("第二段");

    // The trailing throttled render picks up the latest buffer.
    await vi.waitFor(
      () => {
        expect(
          pane.container.querySelector(
            ".turn [data-role='assistant'] .markdown"
          )?.textContent
        ).toContain("第二段");
      },
      { timeout: 2000 }
    );

    // The terminal event forces an immediate final render.
    stream.push(deltaBlock(" 第三段") + DONE_BLOCK);
    stream.close();
    await vi.waitFor(() => expect(pane.generation.phase).toBe("completed"));
    flushSync();
    expect(
      pane.container.querySelector(".turn [data-role='assistant'] .markdown")
        ?.textContent
    ).toContain("第三段");
    pane.destroy();
  });

  it("keeps streamed Markdown sanitized before the terminal event", async () => {
    const stream = installRouter({ streamText: () => "" });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "问题");
    pressEnter(pane.container);
    stream.push(
      metaBlock("c-new") +
        deltaBlock(
          '<script>alert(1)</script><img src=x onerror="alert(1)">[点击](javascript:alert(1))'
        )
    );

    const markdown = await vi.waitFor(() => {
      const found = pane.container.querySelector<HTMLElement>(
        ".turn [data-role='assistant'] .markdown"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(markdown.querySelector("script")).toBeNull();
    expect(markdown.querySelector("img")).toBeNull();
    const href = markdown.querySelector("a")?.getAttribute("href") ?? "";
    expect(href).not.toContain("javascript:");
    expect(pane.container.querySelector("script")).toBeNull();
    stream.close();
    pane.destroy();
  });

  it("renders an incomplete streamed code fence defensively", async () => {
    const stream = installRouter({ streamText: () => "" });
    const pane = mountPane();
    await pane.modelStore.load();
    flushSync();

    typeComposer(pane.container, "问题");
    pressEnter(pane.container);
    // The fence is never closed before the stream pauses.
    stream.push(metaBlock("c-new") + deltaBlock("```js\nconst a = 1"));

    await vi.waitFor(() => {
      expect(
        pane.container.querySelector(
          ".turn [data-role='assistant'] .markdown pre code"
        )?.textContent
      ).toContain("const a = 1");
    });
    // Non-terminal snapshots render the sanitized code block without
    // exposing an interactive copy control on transient content.
    expect(
      pane.container.querySelector(".turn .markdown .copy-button")
    ).toBeNull();

    // The terminal render restores the copy control with its accessible
    // name on the final code block.
    stream.push(DONE_BLOCK);
    await vi.waitFor(() => {
      expect(
        pane.container
          .querySelector(".turn .markdown .copy-button")
          ?.getAttribute("aria-label")
      ).toBe("复制代码");
    });
    stream.close();
    pane.destroy();
  });
});
