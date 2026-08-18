// @vitest-environment jsdom
/**
 * Integration coverage for the Phase E chat flow: conversation store +
 * generation store wired exactly as AppShell wires them, against a fake
 * server that reproduces the Rust routes, DTOs, idempotency, and stream
 * finalization behavior of `crates/server/src/chat.rs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_MODEL_ID } from "../test-utils/test-provider";

import { createGenerationStore } from "../generation/generation-store.svelte";
import { createConversationStore } from "./conversation-store.svelte";

const encoder = new TextEncoder();

type FakeMessage = {
  id: string;
  conversation_id: string;
  client_message_id: string | null;
  role: "user" | "assistant";
  content: string;
  status: "completed" | "streaming" | "stopped" | "error" | "interrupted";
  model: string | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
};

type FakeConversation = {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
};

type PendingStream = {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  pushDelta: (text: string) => void;
  /** Finalizes the stored assistant message, then emits delta + done. */
  complete: (text: string) => void;
  /** Finalizes as stopped with the accumulated partial, then emits stopped. */
  stop: () => void;
};

function metaBlock(meta: {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  generationId: string;
  model: string;
}): string {
  return (
    "event: meta\ndata: " +
    JSON.stringify({
      event: "meta",
      conversation_id: meta.conversationId,
      user_message_id: meta.userMessageId,
      assistant_message_id: meta.assistantMessageId,
      generation_id: meta.generationId,
      model: meta.model
    }) +
    "\n\n"
  );
}

function deltaBlock(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ event: "delta", text })}\n\n`;
}

const DONE_BLOCK =
  'event: done\ndata: {"event":"done","finish_reason":"stop","usage":null}\n\n';
const STOPPED_BLOCK =
  'event: stopped\ndata: {"event":"stopped","reason":"user_cancelled"}\n\n';

function installFakeServer() {
  let counter = 0;
  const conversations = new Map<
    string,
    { summary: FakeConversation; messages: FakeMessage[] }
  >();
  const streams: PendingStream[] = [];

  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, "0")}`;
  };

  function openStream(context: {
    conversationId: string;
    userMessageId: string | null;
    assistantMessageId: string;
    generationId: string;
    model: string;
  }): Response {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let accumulated = "";
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      }
    });
    const record = conversations.get(context.conversationId);
    const pending: PendingStream = {
      conversationId: context.conversationId,
      generationId: context.generationId,
      assistantMessageId: context.assistantMessageId,
      pushDelta: (text) => {
        accumulated += text;
        controller.enqueue(encoder.encode(deltaBlock(text)));
      },
      complete: (text) => {
        accumulated += text;
        const message = record?.messages.find(
          (entry) => entry.id === context.assistantMessageId
        );
        if (message) {
          message.content = accumulated;
          message.status = "completed";
          message.finished_at = message.created_at + 1;
        }
        controller.enqueue(encoder.encode(deltaBlock(text) + DONE_BLOCK));
        controller.close();
      },
      stop: () => {
        const message = record?.messages.find(
          (entry) => entry.id === context.assistantMessageId
        );
        if (message) {
          message.content = accumulated;
          message.status = "stopped";
          message.finished_at = message.created_at + 1;
        }
        controller.enqueue(encoder.encode(STOPPED_BLOCK));
        controller.close();
      }
    };
    streams.push(pending);
    // The server always emits meta first.
    queueMicrotask(() => {
      controller.enqueue(encoder.encode(metaBlock(context)));
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  function appendTurn(
    conversationId: string,
    content: string,
    clientMessageId: string
  ): { userMessageId: string; assistantMessageId: string; generationId: string } {
    const record = conversations.get(conversationId);
    if (!record) throw new Error("unknown conversation");
    const now = record.messages.length + 1;
    const userMessageId = nextId("u");
    const assistantMessageId = nextId("a");
    record.messages.push(
      {
        id: userMessageId,
        conversation_id: conversationId,
        client_message_id: clientMessageId,
        role: "user",
        content,
        status: "completed",
        model: null,
        error_code: null,
        created_at: now,
        finished_at: now
      },
      {
        id: assistantMessageId,
        conversation_id: conversationId,
        client_message_id: null,
        role: "assistant",
        content: "",
        status: "streaming",
        model: record.summary.model,
        error_code: null,
        created_at: now + 1,
        finished_at: null
      }
    );
    record.summary.updated_at = now + 1;
    return { userMessageId, assistantMessageId, generationId: nextId("g") };
  }

  function findByClientMessageId(clientMessageId: string) {
    for (const record of conversations.values()) {
      const message = record.messages.find(
        (entry) => entry.client_message_id === clientMessageId
      );
      if (message) return record;
    }
    return null;
  }

  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "GET" && url.startsWith("/api/v1/conversations?")) {
      const items = [...conversations.values()]
        .map((record) => record.summary)
        .sort((a, b) => b.updated_at - a.updated_at);
      return Promise.resolve(
        new Response(JSON.stringify({ conversations: items, next_cursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    }

    const detailMatch = /^\/api\/v1\/conversations\/([^/?]+)$/.exec(url);
    if (method === "GET" && detailMatch) {
      const record = conversations.get(detailMatch[1]);
      if (!record) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "conversation_not_found",
                message: "Not found.",
                request_id: "req"
              }
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conversation: record.summary,
            messages: record.messages
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    if (method === "POST" && url === "/api/v1/conversations/new/messages") {
      const body = JSON.parse(init?.body as string) as {
        client_message_id: string;
        content: string;
        model: string;
      };
      // Idempotency: a retried POST with the same client_message_id replays
      // the terminal stream instead of creating a second conversation.
      const existing = findByClientMessageId(body.client_message_id);
      if (existing) {
        const assistant = [...existing.messages]
          .reverse()
          .find((entry) => entry.role === "assistant");
        if (!assistant) throw new Error("replay without assistant");
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    metaBlock({
                      conversationId: existing.summary.id,
                      userMessageId: null,
                      assistantMessageId: assistant.id,
                      generationId: nextId("g"),
                      model: existing.summary.model
                    }) + deltaBlock(assistant.content) + DONE_BLOCK
                  )
                );
                controller.close();
              }
            }),
            { status: 200 }
          )
        );
      }
      const conversationId = nextId("c");
      conversations.set(conversationId, {
        summary: {
          id: conversationId,
          title: body.content.slice(0, 80),
          model: body.model,
          created_at: 1,
          updated_at: 1
        },
        messages: []
      });
      const turn = appendTurn(conversationId, body.content, body.client_message_id);
      return Promise.resolve(
        openStream({
          conversationId,
          userMessageId: turn.userMessageId,
          assistantMessageId: turn.assistantMessageId,
          generationId: turn.generationId,
          model: body.model
        })
      );
    }

    const messageMatch = /^\/api\/v1\/conversations\/([^/]+)\/messages$/.exec(url);
    if (method === "POST" && messageMatch) {
      const conversationId = messageMatch[1];
      const body = JSON.parse(init?.body as string) as {
        client_message_id: string;
        content: string;
      };
      const turn = appendTurn(conversationId, body.content, body.client_message_id);
      const record = conversations.get(conversationId);
      if (!record) throw new Error("unknown conversation");
      return Promise.resolve(
        openStream({
          conversationId,
          userMessageId: turn.userMessageId,
          assistantMessageId: turn.assistantMessageId,
          generationId: turn.generationId,
          model: record.summary.model
        })
      );
    }

    const retryMatch = /^\/api\/v1\/messages\/([^/]+)\/retry$/.exec(url);
    if (method === "POST" && retryMatch) {
      const sourceId = retryMatch[1];
      for (const record of conversations.values()) {
        const source = record.messages.find((entry) => entry.id === sourceId);
        if (!source) continue;
        const now = record.messages.length + 1;
        const assistantMessageId = nextId("a");
        // Retry appends a new attempt; the source message is untouched.
        record.messages.push({
          id: assistantMessageId,
          conversation_id: record.summary.id,
          client_message_id: null,
          role: "assistant",
          content: "",
          status: "streaming",
          model: record.summary.model,
          error_code: null,
          created_at: now,
          finished_at: null
        });
        return Promise.resolve(
          openStream({
            conversationId: record.summary.id,
            userMessageId: null,
            assistantMessageId,
            generationId: nextId("g"),
            model: record.summary.model
          })
        );
      }
      throw new Error("retry source not found");
    }

    const cancelMatch = /^\/api\/v1\/generations\/([^/]+)\/cancel$/.exec(url);
    if (method === "POST" && cancelMatch) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    throw new Error(`unmatched request: ${method} ${url}`);
  });

  return { conversations, streams };
}

function wireStores() {
  const conversationStore = createConversationStore();
  const generation = createGenerationStore({
    onConversationCreated: (conversationId) => {
      void conversationStore.refreshList();
      if (conversationStore.selectedId === null) {
        void conversationStore.open(conversationId);
      }
    },
    onReconcile: (conversationId) => {
      void conversationStore.refreshList();
      if (conversationStore.selectedId === conversationId) {
        void conversationStore.reloadCurrent(conversationId);
      }
    }
  });
  return { conversationStore, generation };
}

describe("chat flow integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("first send creates the conversation, locks the model, and updates the sidebar once", async () => {
    const server = installFakeServer();
    const { conversationStore, generation } = wireStores();
    await conversationStore.load();
    expect(conversationStore.items).toHaveLength(0);

    const send = generation.send({
      conversationId: null,
      content: "第一个问题",
      model: "locked-model",
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    server.streams[0]?.complete("第一个回答");
    await send;

    const conversationId = generation.conversationId;
    expect(conversationId).not.toBeNull();
    // Sidebar and selection reconcile from the stream meta / reload.
    await vi.waitFor(() => {
      expect(conversationStore.selectedId).toBe(conversationId);
      expect(conversationStore.current?.messages).toHaveLength(2);
    });
    await vi.waitFor(() =>
      expect(conversationStore.items).toHaveLength(1)
    );
    expect(conversationStore.items[0]?.id).toBe(conversationId);
    expect(conversationStore.items[0]?.model).toBe("locked-model");

    const messages = conversationStore.current?.messages ?? [];
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "第一个问题",
      status: "completed"
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "第一个回答",
      status: "completed",
      model: "locked-model"
    });
    // No duplicates despite refreshList + reload racing.
    expect(conversationStore.items).toHaveLength(1);
  });

  it("a retried POST with the same client_message_id does not duplicate", async () => {
    const server = installFakeServer();
    const { conversationStore, generation } = wireStores();
    await conversationStore.load();

    const send = generation.send({
      conversationId: null,
      content: "你好",
      model: TEST_MODEL_ID,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    server.streams[0]?.complete("回答");
    await send;
    const conversationId = generation.conversationId;

    // Transport uncertainty: the client replays the same idempotency key.
    const replayKey = vi.mocked(fetch).mock.calls
      .map(([, init]) => (init as RequestInit | undefined)?.body)
      .filter((body): body is string => typeof body === "string")
      .map((body) => JSON.parse(body) as Record<string, unknown>)
      .find((body) => typeof body.client_message_id === "string")
      ?.client_message_id;
    expect(typeof replayKey).toBe("string");

    const { streamNewConversationMessage } = await import("../api/chat");
    await streamNewConversationMessage({
      content: "你好",
      model: TEST_MODEL_ID,
      clientMessageId: replayKey as string,
      csrfToken: "csrf",
      signal: new AbortController().signal,
      onEvent: () => undefined
    });

    expect(server.conversations.size).toBe(1);
    const record = server.conversations.get(conversationId as string);
    expect(record?.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("runs ten turns in one conversation with correct history growth", async () => {
    const server = installFakeServer();
    const { conversationStore, generation } = wireStores();
    await conversationStore.load();

    const first = generation.send({
      conversationId: null,
      content: "第 1 问",
      model: TEST_MODEL_ID,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    server.streams[0]?.complete("第 1 答");
    await first;
    const conversationId = generation.conversationId as string;
    await vi.waitFor(() =>
      expect(conversationStore.selectedId).toBe(conversationId)
    );

    for (let turn = 2; turn <= 10; turn += 1) {
      const send = generation.send({
        conversationId,
        content: `第 ${turn} 问`,
        model: null,
        csrfToken: "csrf"
      });
      await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
      server.streams[turn - 1]?.complete(`第 ${turn} 答`);
      await send;
      expect(generation.phase).toBe("completed");
    }

    await vi.waitFor(() =>
      expect(conversationStore.current?.messages).toHaveLength(20)
    );
    const messages = conversationStore.current?.messages ?? [];
    // Every user/assistant pair is distinct and ordered; no cross-turn bleed.
    for (let turn = 1; turn <= 10; turn += 1) {
      expect(messages[(turn - 1) * 2]?.content).toBe(`第 ${turn} 问`);
      expect(messages[(turn - 1) * 2 + 1]?.content).toBe(`第 ${turn} 答`);
    }
    expect(conversationStore.items).toHaveLength(1);
  });

  it("never applies an in-flight stream to another conversation after navigation", async () => {
    const server = installFakeServer();
    const { conversationStore, generation } = wireStores();
    await conversationStore.load();

    // Conversation A starts streaming.
    const first = generation.send({
      conversationId: null,
      content: "A 的问题",
      model: TEST_MODEL_ID,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    const conversationA = generation.conversationId as string;
    await vi.waitFor(() =>
      expect(conversationStore.selectedId).toBe(conversationA)
    );

    // A second conversation exists and the user navigates to it mid-stream.
    const secondSend = new AbortController();
    void secondSend; // navigation only; no second stream needed
    const sendB = (async () => {
      // Create conversation B directly through the fake server.
      const { streamNewConversationMessage } = await import("../api/chat");
      await streamNewConversationMessage({
        content: "B 的问题",
        model: TEST_MODEL_ID,
        clientMessageId: "01JCLIENTB00000000000000000",
        csrfToken: "csrf",
        signal: new AbortController().signal,
        onEvent: () => undefined
      });
      // B's stream is streams[1]; complete it.
    })();
    await vi.waitFor(() => expect(server.streams).toHaveLength(2));
    server.streams[1]?.complete("B 的回答");
    await sendB;
    const conversationB = [...server.conversations.keys()].find(
      (id) => id !== conversationA
    ) as string;

    await conversationStore.open(conversationB);
    expect(conversationStore.selectedId).toBe(conversationB);

    // A's stream keeps flowing but is scoped to A only.
    server.streams[0]?.pushDelta("A 的部分输出");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(generation.isActiveFor(conversationB)).toBe(false);
    expect(generation.isActiveFor(conversationA)).toBe(true);
    // B's persisted messages never receive A's streamed text.
    const bMessages = conversationStore.current?.messages ?? [];
    expect(
      bMessages.every((message) => !message.content.includes("A 的部分输出"))
    ).toBe(true);

    // Completing A reconciles A without yanking the user away from B.
    server.streams[0]?.complete("A 的结尾");
    await first;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(conversationStore.selectedId).toBe(conversationB);
    expect(
      server.conversations
        .get(conversationA)
        ?.messages.find((message) => message.role === "assistant")?.content
    ).toBe("A 的部分输出A 的结尾");
  });

  it("stop aborts the stream, cancels server-side, and reconciles partial output", async () => {
    const server = installFakeServer();
    const { conversationStore, generation } = wireStores();
    await conversationStore.load();

    const send = generation.send({
      conversationId: null,
      content: "长回答",
      model: TEST_MODEL_ID,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    const conversationId = generation.conversationId as string;
    await vi.waitFor(() =>
      expect(conversationStore.selectedId).toBe(conversationId)
    );

    server.streams[0]?.pushDelta("前半部分");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const stop = generation.stop("csrf");
    // The server observes the cancel and emits the stopped terminal.
    await vi.waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) =>
          String(url).includes("/cancel")
        )
      ).toBe(true);
    });
    server.streams[0]?.stop();
    await stop;
    await send;

    expect(generation.phase).toBe("stopped");
    expect(generation.streamingText).toBe("前半部分");

    await vi.waitFor(() => {
      const assistant = conversationStore.current?.messages.find(
        (message) => message.role === "assistant"
      );
      expect(assistant).toMatchObject({
        content: "前半部分",
        status: "stopped"
      });
    });
  });

  it("retry appends a new assistant message without overwriting the old one", async () => {
    const server = installFakeServer();
    const { conversationStore, generation } = wireStores();
    await conversationStore.load();

    const send = generation.send({
      conversationId: null,
      content: "问题",
      model: TEST_MODEL_ID,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    server.streams[0]?.complete("第一次回答");
    await send;
    const conversationId = generation.conversationId as string;
    await vi.waitFor(() =>
      expect(conversationStore.current?.messages).toHaveLength(2)
    );
    const firstAssistantId = conversationStore.current?.messages[1]?.id as string;

    const retry = generation.retry({
      conversationId,
      assistantMessageId: firstAssistantId,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(generation.phase).toBe("streaming"));
    server.streams[1]?.complete("第二次回答");
    await retry;

    await vi.waitFor(() =>
      expect(conversationStore.current?.messages).toHaveLength(3)
    );
    const messages = conversationStore.current?.messages ?? [];
    // The first attempt is preserved verbatim; the retry appended.
    expect(messages[1]).toMatchObject({
      id: firstAssistantId,
      content: "第一次回答",
      status: "completed"
    });
    expect(messages[2]).toMatchObject({
      content: "第二次回答",
      status: "completed"
    });
    expect(messages[2]?.id).not.toBe(firstAssistantId);
  });
});
