/**
 * Chat streaming API boundary.
 *
 * Decodes the public SSE protocol owned by `crates/server/src/chat.rs`:
 *
 *   POST /api/v1/conversations/new/messages      (creates the conversation)
 *   POST /api/v1/conversations/{id}/messages     (existing conversation)
 *   POST /api/v1/messages/{assistant_id}/retry   (new attempt, never overwrites)
 *   POST /api/v1/generations/{generation_id}/cancel
 *
 * All stream decoding is delegated to the central decoder in `./sse.ts`;
 * this module owns only transport framing, terminal-event accounting, and
 * the mapping of transport failures into safe public errors.
 */

import {
  ApiError,
  apiRequest,
  apiStreamRequest,
  isAbortError
} from "./client";
import {
  SseProtocolError,
  createChatEventDecoder,
  isTerminalEvent
} from "./sse";
import type { ChatStreamEvent } from "./sse";

export const STREAM_DISCONNECTED_MESSAGE =
  "连接中断;已生成的部分内容会保留,可重新加载或重试。";
export const STREAM_INCOMPLETE_MESSAGE =
  "响应流未正常结束;已生成的部分内容会保留,可重试。";

export type ChatStreamHandler = (event: ChatStreamEvent) => void;

/**
 * Reads one SSE response body to completion, emitting typed events. Resolves
 * only after exactly one terminal event was observed; rejects with:
 * - the original abort error (callers distinguish user cancellation);
 * - `SseProtocolError` for malformed or protocol-violating streams;
 * - `ApiError` (kind `network`) for mid-stream transport disconnects;
 * - `ApiError` (kind `invalid-response`, code `stream_incomplete`) when the
 *   body ends without a terminal event.
 */
async function consumeChatStream(
  response: Response,
  onEvent: ChatStreamHandler
): Promise<void> {
  const body = response.body;
  if (body === null) {
    throw new ApiError("invalid-response", STREAM_INCOMPLETE_MESSAGE, {
      code: "stream_incomplete"
    });
  }
  const reader = body.getReader();
  const decoder = createChatEventDecoder();
  let sawTerminal = false;
  const emit = (events: ChatStreamEvent[]): void => {
    for (const event of events) {
      if (isTerminalEvent(event)) {
        sawTerminal = true;
      }
      onEvent(event);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.length > 0) {
        emit(decoder.push(value));
      }
    }
    emit(decoder.end());
  } catch (error) {
    if (isAbortError(error) || error instanceof SseProtocolError) {
      throw error;
    }
    // Mid-stream transport failure: partial events already delivered stay
    // visible; the caller decides on reconciliation.
    throw new ApiError("network", STREAM_DISCONNECTED_MESSAGE, {
      code: "stream_disconnected",
      cause: error
    });
  }
  if (!sawTerminal) {
    throw new ApiError("invalid-response", STREAM_INCOMPLETE_MESSAGE, {
      code: "stream_incomplete"
    });
  }
}

export type SendMessageStreamOptions = {
  content: string;
  /** ULID-shaped idempotency key; reused only across transport retries of
   * the same logical message. */
  clientMessageId: string;
  csrfToken: string;
  signal: AbortSignal;
  onEvent: ChatStreamHandler;
};

/** First message of a draft conversation: creates and locks the model. */
export async function streamNewConversationMessage(
  options: SendMessageStreamOptions & { model: string }
): Promise<void> {
  const response = await apiStreamRequest(
    "/api/v1/conversations/new/messages",
    {
      csrfToken: options.csrfToken,
      body: {
        client_message_id: options.clientMessageId,
        content: options.content,
        model: options.model
      },
      signal: options.signal
    }
  );
  await consumeChatStream(response, options.onEvent);
}

/** Message in an existing conversation; the locked model is server-side. */
export async function streamConversationMessage(
  conversationId: string,
  options: SendMessageStreamOptions
): Promise<void> {
  const response = await apiStreamRequest(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      csrfToken: options.csrfToken,
      body: {
        client_message_id: options.clientMessageId,
        content: options.content
      },
      signal: options.signal
    }
  );
  await consumeChatStream(response, options.onEvent);
}

/**
 * Retries the latest assistant response. The server appends a new assistant
 * message and generation; the previous response is never overwritten.
 */
export async function streamAssistantRetry(
  assistantMessageId: string,
  options: {
    csrfToken: string;
    signal: AbortSignal;
    onEvent: ChatStreamHandler;
  }
): Promise<void> {
  const response = await apiStreamRequest(
    `/api/v1/messages/${encodeURIComponent(assistantMessageId)}/retry`,
    {
      csrfToken: options.csrfToken,
      signal: options.signal
    }
  );
  await consumeChatStream(response, options.onEvent);
}

/**
 * Explicit generation cancel. Idempotent server-side (204 in all resolved
 * cases) and sent on its own signal, independent from the aborted stream
 * fetch (spec: streaming-data-access.md §Generation Ownership).
 */
export async function cancelGeneration(
  generationId: string,
  csrfToken: string,
  signal?: AbortSignal
): Promise<void> {
  await apiRequest(
    `/api/v1/generations/${encodeURIComponent(generationId)}/cancel`,
    { method: "POST", csrfToken, signal }
  );
}
