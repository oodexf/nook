// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGenerationStore } from "./generation-store.svelte";

const encoder = new TextEncoder();

const CONVERSATION_ID = "01J000000000000000000000AA";
const GENERATION_ID = "01J000000000000000000000G1";
const ASSISTANT_ID = "01J000000000000000000000A1";
const USER_ID = "01J000000000000000000000U1";

function metaBlock(overrides: Record<string, unknown> = {}): string {
  return (
    "event: meta\ndata: " +
    JSON.stringify({
      event: "meta",
      conversation_id: CONVERSATION_ID,
      user_message_id: USER_ID,
      assistant_message_id: ASSISTANT_ID,
      generation_id: GENERATION_ID,
      model: "test-model",
      ...overrides
    }) +
    "\n\n"
  );
}

function deltaBlock(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ event: "delta", text })}\n\n`;
}

function doneBlock(): string {
  return 'event: done\ndata: {"event":"done","finish_reason":"stop","usage":null}\n\n';
}

function stoppedBlock(): string {
  return 'event: stopped\ndata: {"event":"stopped","reason":"user_cancelled"}\n\n';
}

function errorBlock(code: string, message: string): string {
  return `event: error\ndata: ${JSON.stringify({ event: "error", code, message, request_id: "req-9" })}\n\n`;
}

function completedStream(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(metaBlock() + deltaBlock(text) + doneBlock()));
        controller.close();
      }
    }),
    { status: 200 }
  );
}

type Controlled = {
  response: Response;
  push: (text: string) => void;
  close: () => void;
  fail: (error: unknown) => void;
};

function controlledStream(): Controlled {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  return {
    response: new Response(stream, { status: 200 }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error) => controller.error(error)
  };
}

/** Waits long enough for one animation frame (or the fallback timer). */
function flushFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
}

describe("generation store", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a draft send through connecting → streaming → completed", async () => {
    vi.mocked(fetch).mockResolvedValue(completedStream("你好"));
    const created = vi.fn();
    const reconciled = vi.fn();
    const store = createGenerationStore({
      onConversationCreated: created,
      onReconcile: reconciled
    });

    const send = store.send({
      conversationId: null,
      content: "  你好  ",
      model: "test-model",
      csrfToken: "csrf"
    });
    expect(store.phase).toBe("connecting");
    await send;

    expect(store.phase).toBe("completed");
    expect(store.terminal).toEqual({ kind: "completed", finishReason: "stop" });
    expect(store.conversationId).toBe(CONVERSATION_ID);
    expect(store.generationId).toBe(GENERATION_ID);
    expect(store.assistantMessageId).toBe(ASSISTANT_ID);
    expect(store.pendingUserContent).toBe("你好");
    expect(store.streamingText).toBe("你好");
    expect(store.isBusy).toBe(false);
    expect(created).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(reconciled).toHaveBeenCalledWith(CONVERSATION_ID);

    // The request body carries the trimmed content and a ULID idempotency key.
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.content).toBe("你好");
    expect(body.model).toBe("test-model");
    expect(body.client_message_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("batches visible deltas to at most one animation frame", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    stream.push(metaBlock());
    await vi.waitFor(() => expect(store.phase).toBe("streaming"));

    stream.push(deltaBlock("a"));
    stream.push(deltaBlock("b"));
    stream.push(deltaBlock("c"));
    // Synchronously after the pushes the buffer is not yet visible: the
    // update is deferred to the next frame.
    expect(store.streamingText).toBe("");
    await flushFrame();
    expect(store.streamingText).toBe("abc");

    stream.push(doneBlock());
    stream.close();
    await send;
    // Terminal flushes synchronously without waiting for another frame.
    expect(store.streamingText).toBe("abc");
    expect(store.phase).toBe("completed");
  });

  it("rejects concurrent sends while a stream is busy", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const first = store.send({
      conversationId: CONVERSATION_ID,
      content: "first",
      model: null,
      csrfToken: "csrf"
    });
    await store.send({
      conversationId: CONVERSATION_ID,
      content: "second",
      model: null,
      csrfToken: "csrf"
    });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    stream.push(metaBlock() + deltaBlock("only-first"));
    stream.push(doneBlock());
    stream.close();
    await first;
    expect(store.streamingText).toBe("only-first");
  });

  it("ignores sends with empty content or a missing draft model", async () => {
    const store = createGenerationStore();
    await store.send({
      conversationId: null,
      content: "   ",
      model: "test-model",
      csrfToken: "csrf"
    });
    await store.send({
      conversationId: null,
      content: "hello",
      model: null,
      csrfToken: "csrf"
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(store.phase).toBe("idle");
  });

  it("surfaces pre-stream HTTP failures with the server error code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "model_unavailable",
            message: "The selected model is no longer available.",
            request_id: "req-1"
          }
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );
    const store = createGenerationStore();

    await store.send({
      conversationId: null,
      content: "hi",
      model: "gone-model",
      csrfToken: "csrf"
    });

    expect(store.phase).toBe("failed");
    expect(store.terminal).toEqual({
      kind: "failed",
      message: "The selected model is no longer available.",
      code: "model_unavailable",
      requestId: "req-1"
    });
    // No meta ever arrived: nothing is attributed to a conversation.
    expect(store.conversationId).toBeNull();
    expect(store.assistantMessageId).toBeNull();
  });

  it("fails safe when meta names a different conversation", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    stream.push(metaBlock({ conversation_id: "01J000000000000000000000ZZ" }));
    stream.push(doneBlock());
    stream.close();
    await send;

    expect(store.phase).toBe("failed");
    expect(store.terminal).toMatchObject({
      kind: "failed",
      code: "stream_conversation_mismatch"
    });
    // The foreign conversation ID was never adopted.
    expect(store.conversationId).toBe(CONVERSATION_ID);
  });

  it("never applies a stale stream's events after a new stream starts", async () => {
    const firstStream = controlledStream();
    const secondStream = controlledStream();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(secondStream.response);
    const store = createGenerationStore();

    const first = store.send({
      conversationId: CONVERSATION_ID,
      content: "first",
      model: null,
      csrfToken: "csrf"
    });
    firstStream.push(metaBlock() + deltaBlock("stale-"));
    // Let the chunk be consumed before erroring: stream errors discard
    // queued-but-unread chunks per the WHATWG streams spec.
    await vi.waitFor(() => expect(store.phase).toBe("streaming"));
    firstStream.fail(new TypeError("connection reset"));
    await first;
    expect(store.phase).toBe("failed");
    await flushFrame();
    expect(store.streamingText).toBe("stale-");

    const second = store.send({
      conversationId: CONVERSATION_ID,
      content: "second",
      model: null,
      csrfToken: "csrf"
    });
    await vi.waitFor(() => expect(store.phase).toBe("connecting"));
    // Late events from the first stream instance must not leak into the
    // second stream (its events already failed to arrive, but the guard is
    // what makes that an invariant rather than a race).
    secondStream.push(
      metaBlock({
        assistant_message_id: "01J000000000000000000000A2",
        generation_id: "01J000000000000000000000G2"
      }) + deltaBlock("fresh")
    );
    secondStream.push(doneBlock());
    secondStream.close();
    await second;

    expect(store.phase).toBe("completed");
    expect(store.streamingText).toBe("fresh");
    expect(store.assistantMessageId).toBe("01J000000000000000000000A2");
  });

  it("stop aborts the fetch and sends a cancel on a distinct signal", async () => {
    const stream = controlledStream();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes("/cancel")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(stream.response);
    });
    const reconciled = vi.fn();
    const store = createGenerationStore({ onReconcile: reconciled });

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    stream.push(metaBlock() + deltaBlock("partial"));
    await vi.waitFor(() => expect(store.phase).toBe("streaming"));
    await flushFrame();

    const stop = store.stop("csrf");
    expect(store.phase).toBe("stopping");
    await stop;
    // The handcrafted response is not wired to the fetch abort signal the
    // way a real network response is; closing it stands in for the aborted
    // body so the send promise can settle.
    stream.close();
    await send;

    expect(store.phase).toBe("stopped");
    expect(store.terminal).toEqual({ kind: "stopped" });
    // Partial output is preserved through the stop.
    expect(store.streamingText).toBe("partial");

    const cancelCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes(`/api/v1/generations/${GENERATION_ID}/cancel`)
    );
    expect(cancelCall).toBeDefined();
    const [, cancelInit] = cancelCall as [string, RequestInit];
    expect(cancelInit.method).toBe("POST");
    // The cancel request uses its own signal, not the aborted stream signal.
    expect(cancelInit.signal).not.toBeNull();
    expect(cancelInit.signal?.aborted).toBe(false);
    expect(reconciled).toHaveBeenCalledWith(CONVERSATION_ID);
  });

  it("stop before meta settles locally without a cancel request", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: null,
      content: "hi",
      model: "test-model",
      csrfToken: "csrf"
    });
    await store.stop("csrf");
    stream.close();
    await send;

    expect(store.phase).toBe("stopped");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("a server stopped terminal wins over a racing local stop", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    stream.push(metaBlock() + deltaBlock("x") + stoppedBlock());
    stream.close();
    await send;

    expect(store.phase).toBe("stopped");
    // A stop after the terminal is a no-op (no cancel request sent).
    await store.stop("csrf");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("preserves partial output on mid-stream disconnect", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    stream.push(metaBlock() + deltaBlock("前半部分"));
    await vi.waitFor(() => expect(store.phase).toBe("streaming"));
    await flushFrame();
    stream.fail(new TypeError("connection reset"));
    await send;

    expect(store.phase).toBe("failed");
    expect(store.terminal).toMatchObject({
      kind: "failed",
      code: "stream_disconnected"
    });
    expect(store.streamingText).toBe("前半部分");
  });

  it("preserves partial output on an error terminal event", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                metaBlock() +
                  deltaBlock("partial") +
                  errorBlock("provider_timeout", "The model response timed out.")
              )
            );
            controller.close();
          }
        }),
        { status: 200 }
      )
    );
    const store = createGenerationStore();

    await store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });

    expect(store.phase).toBe("failed");
    expect(store.terminal).toEqual({
      kind: "failed",
      message: "The model response timed out.",
      code: "provider_timeout",
      requestId: "req-9"
    });
    expect(store.streamingText).toBe("partial");
  });

  it("fails safe on a malformed stream without leaking payload bytes", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(metaBlock() + "event: delta\ndata: secret-broken{\n\n"));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );
    const store = createGenerationStore();

    await store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });

    expect(store.phase).toBe("failed");
    expect(store.terminal).toMatchObject({
      kind: "failed",
      code: "malformed_stream"
    });
    const terminal = store.terminal;
    if (terminal?.kind !== "failed") throw new Error("expected failure");
    expect(terminal.message).not.toContain("secret-broken");
  });

  it("retry appends a new attempt without a user message", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                metaBlock({
                  user_message_id: null,
                  assistant_message_id: "01J000000000000000000000A2",
                  generation_id: "01J000000000000000000000G2"
                }) +
                  deltaBlock("重新回答") +
                  doneBlock()
              )
            );
            controller.close();
          }
        }),
        { status: 200 }
      )
    );
    const store = createGenerationStore();

    await store.retry({
      conversationId: CONVERSATION_ID,
      assistantMessageId: ASSISTANT_ID,
      csrfToken: "csrf"
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/messages/${ASSISTANT_ID}/retry`);
    expect(init.body).toBeNull();
    expect(store.phase).toBe("completed");
    // No optimistic user bubble for retries; a new assistant ID is adopted.
    expect(store.pendingUserContent).toBeNull();
    expect(store.assistantMessageId).toBe("01J000000000000000000000A2");
    expect(store.streamingText).toBe("重新回答");
  });

  it("isActiveFor scopes the stream to its owning view", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    // Existing-conversation stream: only its conversation matches.
    expect(store.isActiveFor(CONVERSATION_ID)).toBe(true);
    expect(store.isActiveFor("01J000000000000000000000ZZ")).toBe(false);
    expect(store.isActiveFor(null)).toBe(false);

    stream.push(metaBlock() + doneBlock());
    stream.close();
    await send;

    // A draft stream matches the draft view until meta assigns the ID.
    const draft = controlledStream();
    vi.mocked(fetch).mockResolvedValue(draft.response);
    const draftSend = store.send({
      conversationId: null,
      content: "new",
      model: "test-model",
      csrfToken: "csrf"
    });
    expect(store.isActiveFor(null)).toBe(true);
    expect(store.isActiveFor(CONVERSATION_ID)).toBe(false);
    draft.push(metaBlock({ conversation_id: "01J000000000000000000000CC" }));
    await vi.waitFor(() => expect(store.phase).toBe("streaming"));
    expect(store.isActiveFor(null)).toBe(false);
    expect(store.isActiveFor("01J000000000000000000000CC")).toBe(true);
    draft.push(doneBlock());
    draft.close();
    await draftSend;
  });

  it("runs ten sequential turns without cross-turn leakage", async () => {
    const fetchMock = vi.mocked(fetch);
    for (let turn = 0; turn < 10; turn += 1) {
      fetchMock.mockResolvedValueOnce(completedStream(`回答-${turn}`));
    }
    const reconciled = vi.fn();
    const store = createGenerationStore({ onReconcile: reconciled });

    for (let turn = 0; turn < 10; turn += 1) {
      await store.send({
        conversationId: CONVERSATION_ID,
        content: `问题-${turn}`,
        model: null,
        csrfToken: "csrf"
      });
      expect(store.phase).toBe("completed");
      expect(store.streamingText).toBe(`回答-${turn}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(reconciled).toHaveBeenCalledTimes(10);
    // Every turn got its own idempotency key.
    const keys = fetchMock.mock.calls.map(
      ([, init]) =>
        (JSON.parse((init as RequestInit).body as string) as Record<string, unknown>)
          .client_message_id
    );
    expect(new Set(keys).size).toBe(10);
  });

  it("clear releases a settled stream but never an active one", async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);
    const store = createGenerationStore();

    const send = store.send({
      conversationId: CONVERSATION_ID,
      content: "hi",
      model: null,
      csrfToken: "csrf"
    });
    store.clear();
    expect(store.phase).toBe("connecting");

    stream.push(metaBlock() + doneBlock());
    stream.close();
    await send;
    store.clear();
    expect(store.phase).toBe("idle");
    expect(store.streamingText).toBe("");
    expect(store.conversationId).toBeNull();
  });
});
