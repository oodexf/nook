import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_MODEL_ID } from "../test-utils/test-provider";

import { ApiError, onSessionExpired } from "./client";
import {
  cancelGeneration,
  streamAssistantRetry,
  streamConversationMessage,
  streamNewConversationMessage
} from "./chat";
import { SseProtocolError } from "./sse";
import type { ChatStreamEvent } from "./sse";

const encoder = new TextEncoder();

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

function sseResponse(text: string): Response {
  return new Response(sseBody(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function metaBlock(): string {
  return (
    "event: meta\ndata: " +
    JSON.stringify({
      event: "meta",
      conversation_id: "01J000000000000000000000AA",
      user_message_id: "01J000000000000000000000U1",
      assistant_message_id: "01J000000000000000000000A1",
      generation_id: "01J000000000000000000000G1",
      model: TEST_MODEL_ID
    }) +
    "\n\n"
  );
}

function doneBlock(): string {
  return 'event: done\ndata: {"event":"done","finish_reason":"stop","usage":null}\n\n';
}

function deltaBlock(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ event: "delta", text })}\n\n`;
}

function errorEnvelope(
  status: number,
  code: string,
  message: string
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, request_id: "req-1" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function baseOptions(onEvent: (event: ChatStreamEvent) => void) {
  return {
    content: "你好",
    clientMessageId: "01JCLIENTMESSAGEID0000000000",
    csrfToken: "csrf-token",
    signal: new AbortController().signal,
    onEvent
  };
}

describe("chat streaming API", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a new-conversation message with CSRF, credentials, and model", async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(metaBlock() + doneBlock()));
    const events: ChatStreamEvent[] = [];

    await streamNewConversationMessage({
      ...baseOptions((event) => events.push(event)),
      content: "你好",
      model: TEST_MODEL_ID
    });

    expect(events.map((event) => event.kind)).toEqual(["meta", "done"]);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/conversations/new/messages");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("text/event-stream");
    expect(JSON.parse(init.body as string)).toEqual({
      client_message_id: "01JCLIENTMESSAGEID0000000000",
      content: "你好",
      model: TEST_MODEL_ID
    });
  });

  it("posts an existing-conversation message without a model field", async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(metaBlock() + doneBlock()));

    await streamConversationMessage("01J000000000000000000000AA", {
      ...baseOptions(() => undefined),
      content: "你好"
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/conversations/01J000000000000000000000AA/messages");
    expect(JSON.parse(init.body as string)).toEqual({
      client_message_id: "01JCLIENTMESSAGEID0000000000",
      content: "你好"
    });
  });

  it("posts a retry without a body", async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse(metaBlock() + doneBlock()));

    await streamAssistantRetry("01J000000000000000000000A1", {
      csrfToken: "csrf-token",
      signal: new AbortController().signal,
      onEvent: () => undefined
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/messages/01J000000000000000000000A1/retry");
    expect(init.body).toBeNull();
    expect(init.method).toBe("POST");
  });

  it("sends cancel as an authenticated CSRF POST", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await cancelGeneration("01J000000000000000000000G1", "csrf-token");

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/generations/01J000000000000000000000G1/cancel");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-token");
    expect(init.credentials).toBe("same-origin");
  });

  it("maps pre-stream HTTP errors to typed ApiError with the server code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      errorEnvelope(409, "model_unavailable", "The selected model is no longer available.")
    );

    const failure = await streamNewConversationMessage({
      ...baseOptions(() => undefined),
      content: "hi",
      model: "gone-model"
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.kind).toBe("http");
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("model_unavailable");
    expect(apiError.requestId).toBe("req-1");
  });

  it("routes 401 to the centralized session-expired listener", async () => {
    vi.mocked(fetch).mockResolvedValue(
      errorEnvelope(401, "session_expired", "The session expired.")
    );
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    const failure = await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions(() => undefined)
    ).catch((error: unknown) => error);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((failure as ApiError).kind).toBe("session-expired");
  });

  it("maps rate limiting and unavailable responses distinctly", async () => {
    vi.mocked(fetch).mockResolvedValue(
      errorEnvelope(429, "provider_rate_limited", "The model provider is rate limiting this request.")
    );
    const rateLimited = await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions(() => undefined)
    ).catch((error: unknown) => error);
    expect(rateLimited).toBeInstanceOf(ApiError);
    if (!(rateLimited instanceof ApiError)) throw new Error("expected ApiError");
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.code).toBe("provider_rate_limited");

    vi.mocked(fetch).mockResolvedValue(
      errorEnvelope(503, "generation_capacity", "The server is currently at its generation limit.")
    );
    const capacity = await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions(() => undefined)
    ).catch((error: unknown) => error);
    expect(capacity).toBeInstanceOf(ApiError);
    if (!(capacity instanceof ApiError)) throw new Error("expected ApiError");
    expect(capacity.status).toBe(503);
    expect(capacity.code).toBe("generation_capacity");
  });

  it("decodes unicode deltas split across transport chunks", async () => {
    const text = "你好😀世界";
    const whole = encoder.encode(metaBlock() + deltaBlock(text) + doneBlock());
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < whole.length; index += 3) {
              controller.enqueue(whole.slice(index, index + 3));
            }
            controller.close();
          }
        }),
        { status: 200 }
      )
    );
    const events: ChatStreamEvent[] = [];

    await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions((event) => events.push(event))
    );

    const deltas = events.filter((event) => event.kind === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: "delta", text });
  });

  it("propagates malformed streams as safe protocol errors", async () => {
    vi.mocked(fetch).mockResolvedValue(
      sseResponse(metaBlock() + "event: delta\ndata: {oops\n\n")
    );

    const failure = await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions(() => undefined)
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SseProtocolError);
    expect((failure as SseProtocolError).message).not.toContain("oops");
  });

  it("maps mid-stream disconnects to a network error after delivered events", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(metaBlock() + deltaBlock("部分")));
            // Error after the queued chunk has been read: stream errors
            // discard not-yet-read chunks per the WHATWG streams spec.
            setTimeout(() => {
              controller.error(new TypeError("connection reset"));
            }, 0);
          }
        }),
        { status: 200 }
      )
    );
    const events: ChatStreamEvent[] = [];

    const failure = await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions((event) => events.push(event))
    ).catch((error: unknown) => error);

    expect(events.map((event) => event.kind)).toEqual(["meta", "delta"]);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).kind).toBe("network");
    expect((failure as ApiError).code).toBe("stream_disconnected");
  });

  it("rejects a stream that ends without a terminal event", async () => {
    vi.mocked(fetch).mockResolvedValue(
      sseResponse(metaBlock() + deltaBlock("partial"))
    );

    const failure = await streamConversationMessage(
      "01J000000000000000000000AA",
      baseOptions(() => undefined)
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("stream_incomplete");
  });

  it("passes abort errors through untouched", async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })
    );

    const events: ChatStreamEvent[] = [];
    const pending = streamConversationMessage("01J000000000000000000000AA", {
      ...baseOptions((event) => events.push(event)),
      signal: controller.signal
    }).catch((error: unknown) => error);
    controller.abort();
    const failure = await pending;

    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("AbortError");
  });
});
