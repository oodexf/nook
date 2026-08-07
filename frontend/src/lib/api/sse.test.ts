import { describe, expect, it } from "vitest";

import {
  SseProtocolError,
  createChatEventDecoder,
  isTerminalEvent
} from "./sse";
import type { ChatStreamEvent } from "./sse";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function metaBlock(overrides: Record<string, unknown> = {}): string {
  const payload = {
    event: "meta",
    conversation_id: "01J000000000000000000000AA",
    user_message_id: "01J000000000000000000000U1",
    assistant_message_id: "01J000000000000000000000A1",
    generation_id: "01J000000000000000000000G1",
    model: "test-model",
    ...overrides
  };
  return `event: meta\ndata: ${JSON.stringify(payload)}\n\n`;
}

function block(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function decodeAll(chunks: string[]): ChatStreamEvent[] {
  const decoder = createChatEventDecoder();
  const events: ChatStreamEvent[] = [];
  for (const chunk of chunks) {
    events.push(...decoder.push(bytes(chunk)));
  }
  events.push(...decoder.end());
  return events;
}

describe("chat SSE decoder", () => {
  it("decodes a complete meta/delta/done stream", () => {
    const events = decodeAll([
      metaBlock(),
      block("delta", { event: "delta", text: "你好" }),
      block("delta", { event: "delta", text: "，世界" }),
      block("done", { event: "done", finish_reason: "stop", usage: null })
    ]);

    expect(events.map((event) => event.kind)).toEqual([
      "meta",
      "delta",
      "delta",
      "done"
    ]);
    const meta = events[0];
    if (meta.kind !== "meta") throw new Error("expected meta");
    expect(meta.conversationId).toBe("01J000000000000000000000AA");
    expect(meta.userMessageId).toBe("01J000000000000000000000U1");
    expect(meta.assistantMessageId).toBe("01J000000000000000000000A1");
    expect(meta.generationId).toBe("01J000000000000000000000G1");
    expect(meta.model).toBe("test-model");
    const done = events[3];
    if (done.kind !== "done") throw new Error("expected done");
    expect(done.finishReason).toBe("stop");
    expect(done.usage).toBeNull();
    expect(isTerminalEvent(done)).toBe(true);
  });

  it("accepts a null user_message_id on retry streams", () => {
    const events = decodeAll([
      metaBlock({ user_message_id: null }),
      block("stopped", { event: "stopped", reason: "user_cancelled" })
    ]);
    expect(events[0]).toMatchObject({ kind: "meta", userMessageId: null });
    expect(events[1]).toMatchObject({
      kind: "stopped",
      reason: "user_cancelled"
    });
  });

  it("decodes usage when present and rejects malformed usage", () => {
    const events = decodeAll([
      metaBlock(),
      block("done", {
        event: "done",
        finish_reason: "stop",
        usage: { input_tokens: 12, output_tokens: 34 }
      })
    ]);
    expect(events[1]).toMatchObject({
      kind: "done",
      usage: { inputTokens: 12, outputTokens: 34 }
    });

    expect(() =>
      decodeAll([
        metaBlock(),
        block("done", {
          event: "done",
          finish_reason: "stop",
          usage: { input_tokens: -1, output_tokens: null }
        })
      ])
    ).toThrowError(SseProtocolError);
  });

  it("decodes the error terminal with code, message, and request ID", () => {
    const events = decodeAll([
      metaBlock(),
      block("delta", { event: "delta", text: "partial" }),
      block("error", {
        event: "error",
        code: "provider_timeout",
        message: "The model response timed out.",
        request_id: "01JREQUESTID"
      })
    ]);
    const terminal = events[2];
    if (terminal.kind !== "error") throw new Error("expected error");
    expect(terminal.code).toBe("provider_timeout");
    expect(terminal.requestId).toBe("01JREQUESTID");
    expect(isTerminalEvent(terminal)).toBe(true);
  });

  it("decodes multi-byte UTF-8 split across transport chunks", () => {
    const text = "你好，世界！😀 café — 你好";
    const stream =
      metaBlock() +
      block("delta", { event: "delta", text }) +
      block("done", { event: "done", finish_reason: "stop", usage: null });
    const whole = bytes(stream);
    const decoder = createChatEventDecoder();
    const events: ChatStreamEvent[] = [];
    // Feed one byte at a time: every multi-byte sequence is split.
    for (let index = 0; index < whole.length; index += 1) {
      events.push(...decoder.push(whole.slice(index, index + 1)));
    }
    events.push(...decoder.end());

    const deltas = events.filter((event) => event.kind === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: "delta", text });
  });

  it("reassembles lines split across chunks at arbitrary byte offsets", () => {
    const stream =
      metaBlock() +
      block("delta", { event: "delta", text: "abc" }) +
      block("done", { event: "done", finish_reason: "stop", usage: null });
    const whole = bytes(stream);
    const decoder = createChatEventDecoder();
    const events: ChatStreamEvent[] = [];
    // 7-byte strides split event lines, JSON payloads, and blank lines.
    for (let index = 0; index < whole.length; index += 7) {
      events.push(...decoder.push(whole.slice(index, index + 7)));
    }
    events.push(...decoder.end());
    expect(events.map((event) => event.kind)).toEqual([
      "meta",
      "delta",
      "done"
    ]);
  });

  it("handles CRLF line endings", () => {
    const payload = JSON.stringify({ event: "delta", text: "x" });
    const meta = metaBlock().replaceAll("\n", "\r\n");
    const events = decodeAll([
      meta,
      `event: delta\r\ndata: ${payload}\r\n\r\n`,
      "event: done\r\ndata: {\"event\":\"done\",\"finish_reason\":\"stop\",\"usage\":null}\r\n\r\n"
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "meta",
      "delta",
      "done"
    ]);
  });

  it("ignores keep-alive comments and unknown fields", () => {
    const events = decodeAll([
      ": keepalive\n\n",
      metaBlock(),
      ": keepalive\n",
      "id: 42\nretry: 1000\n\n",
      block("delta", { event: "delta", text: "a" }),
      block("done", { event: "done", finish_reason: "stop", usage: null })
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "meta",
      "delta",
      "done"
    ]);
  });

  it("ignores unknown event kinds without disturbing the protocol", () => {
    const events = decodeAll([
      block("telemetry", { hello: "world" }),
      metaBlock(),
      block("typing", {}),
      block("delta", { event: "delta", text: "a" }),
      block("done", { event: "done", finish_reason: "stop", usage: null }),
      block("trailing-unknown", { x: 1 })
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "meta",
      "delta",
      "done"
    ]);
  });

  it("joins multi-line data fields with newlines", () => {
    const decoder = createChatEventDecoder();
    const events: ChatStreamEvent[] = [];
    events.push(...decoder.push(bytes(metaBlock())));
    events.push(
      ...decoder.push(
        bytes('event: delta\ndata: {"event":"delta",\ndata: "text":"ab"}\n\n')
      )
    );
    events.push(
      ...decoder.push(
        bytes(
          'event: done\ndata: {"event":"done","finish_reason":"stop","usage":null}\n\n'
        )
      )
    );
    expect(events[1]).toMatchObject({ kind: "delta", text: "ab" });
  });

  it("enforces meta as the first business event", () => {
    expect(() =>
      decodeAll([block("delta", { event: "delta", text: "x" })])
    ).toThrowError(
      expect.objectContaining({
        name: "SseProtocolError",
        failure: "missing-meta"
      })
    );
    expect(() =>
      decodeAll([
        block("done", { event: "done", finish_reason: "stop", usage: null })
      ])
    ).toThrowError(
      expect.objectContaining({ failure: "missing-meta" })
    );
  });

  it("rejects a second meta event", () => {
    expect(() => decodeAll([metaBlock(), metaBlock()])).toThrowError(
      expect.objectContaining({ failure: "duplicate-meta" })
    );
  });

  it("enforces exactly one terminal event", () => {
    const done = block("done", {
      event: "done",
      finish_reason: "stop",
      usage: null
    });
    expect(() => decodeAll([metaBlock(), done, done])).toThrowError(
      expect.objectContaining({ failure: "event-after-terminal" })
    );
    expect(() =>
      decodeAll([
        metaBlock(),
        done,
        block("delta", { event: "delta", text: "late" })
      ])
    ).toThrowError(
      expect.objectContaining({ failure: "event-after-terminal" })
    );
  });

  it("rejects malformed JSON payloads with a safe public error", () => {
    let caught: unknown;
    try {
      decodeAll([metaBlock(), "event: delta\ndata: {not json\n\n"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SseProtocolError);
    expect((caught as SseProtocolError).failure).toBe("malformed-data");
    // The public message never echoes payload bytes.
    expect((caught as SseProtocolError).message).not.toContain("not json");
  });

  it("rejects well-formed JSON with the wrong shape", () => {
    expect(() =>
      decodeAll([metaBlock(), block("delta", { event: "delta", text: 42 })])
    ).toThrowError(expect.objectContaining({ failure: "invalid-event" }));
    expect(() =>
      decodeAll([metaBlock({ generation_id: 7 })])
    ).toThrowError(expect.objectContaining({ failure: "invalid-event" }));
  });

  it("rejects invalid UTF-8 with a protocol error", () => {
    const decoder = createChatEventDecoder();
    decoder.push(bytes(metaBlock()));
    expect(() => decoder.push(new Uint8Array([0xff, 0xfe]))).toThrowError(
      expect.objectContaining({ failure: "invalid-utf8" })
    );
  });

  it("rejects a truncated multi-byte sequence at end of body", () => {
    const decoder = createChatEventDecoder();
    decoder.push(bytes(metaBlock()));
    decoder.push(bytes('event: delta\ndata: {"event":"delta","text":"'));
    // Start of a 3-byte sequence, never completed.
    decoder.push(new Uint8Array([0xe4, 0xbd]));
    expect(() => decoder.end()).toThrowError(
      expect.objectContaining({ failure: "invalid-utf8" })
    );
  });

  it("dispatches a final block not terminated by a blank line at end()", () => {
    const decoder = createChatEventDecoder();
    const events = decoder.push(bytes(metaBlock()));
    events.push(
      ...decoder.push(
        bytes(
          'event: done\ndata: {"event":"done","finish_reason":"stop","usage":null}\n'
        )
      )
    );
    events.push(...decoder.end());
    expect(events.map((event) => event.kind)).toEqual(["meta", "done"]);
  });

  it("produces no events for an empty stream", () => {
    const decoder = createChatEventDecoder();
    expect(decoder.end()).toEqual([]);
  });
});
