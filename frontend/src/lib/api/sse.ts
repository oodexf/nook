/**
 * Central SSE decoder for the public chat stream (spec:
 * streaming-data-access.md §SSE Decoder; producer:
 * `crates/server/src/chat.rs::PublicStreamEvent`).
 *
 * This module is the single owner of:
 * - incremental UTF-8 decoding across transport chunks;
 * - line buffering and SSE field parsing (`event:` / `data:` / comments);
 * - JSON decoding from `unknown` into the typed event union;
 * - unknown-event tolerance;
 * - protocol enforcement: `meta` first, exactly one terminal event.
 *
 * Components never see raw bytes, raw event names, or undecoded payloads.
 * All failures raise `SseProtocolError`, whose message is a safe,
 * payload-free public string.
 */

export type ChatStreamUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type ChatStreamMeta = {
  kind: "meta";
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  generationId: string;
  model: string;
};

export type ChatStreamDelta = {
  kind: "delta";
  text: string;
};

export type ChatStreamReasoningDelta = {
  kind: "reasoning-delta";
  text: string;
};

export type ChatStreamDone = {
  kind: "done";
  finishReason: string;
  usage: ChatStreamUsage | null;
};

export type ChatStreamStopped = {
  kind: "stopped";
  reason: string;
};

export type ChatStreamError = {
  kind: "error";
  code: string;
  message: string;
  requestId: string;
};

export type ChatStreamEvent =
  | ChatStreamMeta
  | ChatStreamDelta
  | ChatStreamReasoningDelta
  | ChatStreamDone
  | ChatStreamStopped
  | ChatStreamError;

export type ChatStreamTerminal = ChatStreamDone | ChatStreamStopped | ChatStreamError;

export function isTerminalEvent(
  event: ChatStreamEvent
): event is ChatStreamTerminal {
  return (
    event.kind === "done" || event.kind === "stopped" || event.kind === "error"
  );
}

/** Stable, safe protocol-failure categories (no payload content leaks). */
export type SseProtocolFailure =
  | "invalid-utf8"
  | "malformed-data"
  | "invalid-event"
  | "missing-meta"
  | "duplicate-meta"
  | "event-after-terminal";

export const STREAM_PROTOCOL_ERROR_MESSAGE =
  "服务返回了无法识别的数据流，请重试。";

export class SseProtocolError extends Error {
  readonly failure: SseProtocolFailure;

  constructor(failure: SseProtocolFailure) {
    super(STREAM_PROTOCOL_ERROR_MESSAGE);
    this.name = "SseProtocolError";
    this.failure = failure;
  }
}

export type SseDecoder = {
  /**
   * Feeds one transport chunk. Returns every complete, decoded business
   * event produced by this chunk (possibly none). Throws `SseProtocolError`
   * on invalid UTF-8, malformed payloads, or protocol violations.
   */
  push(chunk: Uint8Array): ChatStreamEvent[];
  /**
   * Flushes the decoder at end-of-body: completes any pending UTF-8
   * sequence and dispatches a final buffered event. Throws
   * `SseProtocolError` on truncated UTF-8.
   */
  end(): ChatStreamEvent[];
};

// Bounds mirror the server contract: ULIDs are 26 chars, provider model IDs
// are capped at 200 chars, and safe error fields stay short single-line
// strings. A single delta is bounded well above any provider chunk.
const MAX_ID_LENGTH = 64;
const MAX_MODEL_LENGTH = 200;
const MAX_DELTA_LENGTH = 200_000;
const MAX_REASON_LENGTH = 64;
const MAX_ERROR_FIELD_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeMeta(value: unknown): ChatStreamMeta | null {
  if (!isRecord(value)) return null;
  const userMessageId = value.user_message_id;
  if (
    isBoundedString(value.conversation_id, MAX_ID_LENGTH) &&
    (userMessageId === null ||
      isBoundedString(userMessageId, MAX_ID_LENGTH)) &&
    isBoundedString(value.assistant_message_id, MAX_ID_LENGTH) &&
    isBoundedString(value.generation_id, MAX_ID_LENGTH) &&
    isBoundedString(value.model, MAX_MODEL_LENGTH)
  ) {
    return {
      kind: "meta",
      conversationId: value.conversation_id,
      userMessageId,
      assistantMessageId: value.assistant_message_id,
      generationId: value.generation_id,
      model: value.model
    };
  }
  return null;
}

function decodeDelta(value: unknown): ChatStreamDelta | null {
  if (!isRecord(value)) return null;
  if (typeof value.text === "string" && value.text.length <= MAX_DELTA_LENGTH) {
    return { kind: "delta", text: value.text };
  }
  return null;
}

function decodeReasoningDelta(value: unknown): ChatStreamReasoningDelta | null {
  if (!isRecord(value)) return null;
  if (typeof value.text === "string" && value.text.length <= MAX_DELTA_LENGTH) {
    return { kind: "reasoning-delta", text: value.text };
  }
  return null;
}

function decodeDone(value: unknown): ChatStreamDone | null {
  if (!isRecord(value)) return null;
  if (!isBoundedString(value.finish_reason, MAX_REASON_LENGTH)) return null;
  const usageRaw = value.usage;
  let usage: ChatStreamUsage | null = null;
  if (usageRaw !== null) {
    if (!isRecord(usageRaw)) return null;
    const input = usageRaw.input_tokens;
    const output = usageRaw.output_tokens;
    if (
      !(input === null || isTokenCount(input)) ||
      !(output === null || isTokenCount(output))
    ) {
      return null;
    }
    usage = { inputTokens: input, outputTokens: output };
  }
  return { kind: "done", finishReason: value.finish_reason, usage };
}

function decodeStopped(value: unknown): ChatStreamStopped | null {
  if (!isRecord(value)) return null;
  if (isBoundedString(value.reason, MAX_REASON_LENGTH)) {
    return { kind: "stopped", reason: value.reason };
  }
  return null;
}

function decodeError(value: unknown): ChatStreamError | null {
  if (!isRecord(value)) return null;
  // request_id may be an empty string in fallback encodings; accept any
  // bounded string, including empty, for this diagnostic field only.
  if (
    isBoundedString(value.code, MAX_ID_LENGTH) &&
    isBoundedString(value.message, MAX_ERROR_FIELD_LENGTH) &&
    typeof value.request_id === "string" &&
    value.request_id.length <= MAX_ID_LENGTH
  ) {
    return {
      kind: "error",
      code: value.code,
      message: value.message,
      requestId: value.request_id
    };
  }
  return null;
}

type EventName =
  | "meta"
  | "delta"
  | "reasoning_delta"
  | "done"
  | "stopped"
  | "error";

const KNOWN_EVENTS: readonly EventName[] = [
  "meta",
  "delta",
  "reasoning_delta",
  "done",
  "stopped",
  "error"
];

function isKnownEvent(name: string): name is EventName {
  return KNOWN_EVENTS.includes(name as EventName);
}

function decodePayload(name: EventName, value: unknown): ChatStreamEvent | null {
  switch (name) {
    case "meta":
      return decodeMeta(value);
    case "delta":
      return decodeDelta(value);
    case "reasoning_delta":
      return decodeReasoningDelta(value);
    case "done":
      return decodeDone(value);
    case "stopped":
      return decodeStopped(value);
    case "error":
      return decodeError(value);
  }
}

type ProtocolState = "awaiting-meta" | "streaming" | "terminated";

/**
 * Creates the one incremental decoder instance for a single chat stream.
 * Each HTTP response body gets exactly one decoder; instances are not
 * reusable across requests.
 */
export function createChatEventDecoder(): SseDecoder {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let lineBuffer = "";
  let state: ProtocolState = "awaiting-meta";
  let pendingEventName: string | null = null;
  let pendingData: string[] = [];

  function resetPending(): void {
    pendingEventName = null;
    pendingData = [];
  }

  function dispatchPending(events: ChatStreamEvent[]): void {
    const name = pendingEventName;
    const data = pendingData;
    resetPending();
    // Comment-only blocks (keep-alive) and unknown event kinds are ignored
    // by contract; they never affect the meta/terminal state machine.
    if (data.length === 0) return;
    if (name === null || !isKnownEvent(name)) return;

    if (state === "awaiting-meta" && name !== "meta") {
      throw new SseProtocolError("missing-meta");
    }
    if (state === "terminated") {
      throw new SseProtocolError("event-after-terminal");
    }
    if (state === "streaming" && name === "meta") {
      throw new SseProtocolError("duplicate-meta");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      throw new SseProtocolError("malformed-data");
    }
    const event = decodePayload(name, payload);
    if (event === null) {
      throw new SseProtocolError("invalid-event");
    }
    if (event.kind === "meta") {
      state = "streaming";
    } else if (isTerminalEvent(event)) {
      state = "terminated";
    }
    events.push(event);
  }

  function processLine(rawLine: string, events: ChatStreamEvent[]): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatchPending(events);
      return;
    }
    if (line.startsWith(":")) {
      // Comment / keep-alive line.
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        pendingEventName = value;
        break;
      case "data":
        pendingData.push(value);
        break;
      default:
        // Unknown fields (id:, retry:, ...) carry no business meaning.
        break;
    }
  }

  function processText(text: string, events: ChatStreamEvent[]): void {
    lineBuffer += text;
    for (;;) {
      const newline = lineBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      processLine(line, events);
    }
  }

  return {
    push(chunk: Uint8Array): ChatStreamEvent[] {
      let text: string;
      try {
        text = utf8.decode(chunk, { stream: true });
      } catch {
        throw new SseProtocolError("invalid-utf8");
      }
      const events: ChatStreamEvent[] = [];
      processText(text, events);
      return events;
    },

    end(): ChatStreamEvent[] {
      let text: string;
      try {
        text = utf8.decode();
      } catch {
        throw new SseProtocolError("invalid-utf8");
      }
      const events: ChatStreamEvent[] = [];
      processText(text, events);
      // A final block not terminated by a blank line is still dispatched;
      // the producer always terminates blocks, so this only helps truncated
      // but otherwise complete tails.
      if (lineBuffer.length > 0) {
        const rest = lineBuffer;
        lineBuffer = "";
        processLine(rest, events);
      }
      dispatchPending(events);
      return events;
    }
  };
}
