/**
 * Conversation API boundary.
 *
 * Decodes the public DTOs owned by `crates/server/src/conversations.rs` from
 * `unknown`. Field names on the wire are snake_case; decoded frontend types
 * use camelCase. Components never see raw payloads.
 */

import { ApiError, INVALID_RESPONSE_MESSAGE, apiRequest } from "./client";

export type MessageRole = "user" | "assistant";

export type MessageStatus =
  | "completed"
  | "streaming"
  | "stopped"
  | "error"
  | "interrupted";

export type ConversationSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model: string | null;
  errorCode: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type ConversationPage = {
  conversations: ConversationSummary[];
  nextCursor: string | null;
};

export type ConversationDetail = {
  conversation: ConversationSummary;
  messages: ChatMessage[];
};

// Bounds mirror the server contract: ULID path IDs are 26 chars, titles are
// capped at 200 chars, and message bodies are bounded by server limits.
const MAX_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 400;
const MAX_MODEL_LENGTH = 200;
const MAX_CONTENT_LENGTH = 200_000;

const MESSAGE_ROLES: readonly MessageRole[] = ["user", "assistant"];
const MESSAGE_STATUSES: readonly MessageStatus[] = [
  "completed",
  "streaming",
  "stopped",
  "error",
  "interrupted"
];

function isMessageRole(value: unknown): value is MessageRole {
  return typeof value === "string" && MESSAGE_ROLES.includes(value as MessageRole);
}

function isMessageStatus(value: unknown): value is MessageStatus {
  return (
    typeof value === "string" && MESSAGE_STATUSES.includes(value as MessageStatus)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isNullableBoundedString(
  value: unknown,
  max: number
): value is string | null {
  return value === null || isBoundedString(value, max);
}

export function decodeConversationSummary(
  value: unknown
): ConversationSummary | null {
  if (!isRecord(value)) return null;
  if (
    isBoundedString(value.id, MAX_ID_LENGTH) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= MAX_TITLE_LENGTH &&
    isBoundedString(value.model, MAX_MODEL_LENGTH) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  ) {
    return {
      id: value.id,
      title: value.title,
      model: value.model,
      createdAt: value.created_at,
      updatedAt: value.updated_at
    };
  }
  return null;
}

export function decodeChatMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  if (
    isBoundedString(value.id, MAX_ID_LENGTH) &&
    isBoundedString(value.conversation_id, MAX_ID_LENGTH) &&
    isNullableBoundedString(value.client_message_id, MAX_ID_LENGTH) &&
    isMessageRole(value.role) &&
    typeof value.content === "string" &&
    value.content.length <= MAX_CONTENT_LENGTH &&
    isMessageStatus(value.status) &&
    isNullableBoundedString(value.model, MAX_MODEL_LENGTH) &&
    isNullableBoundedString(value.error_code, MAX_ID_LENGTH) &&
    isTimestamp(value.created_at) &&
    isNullableTimestamp(value.finished_at)
  ) {
    return {
      id: value.id,
      conversationId: value.conversation_id,
      clientMessageId: value.client_message_id,
      role: value.role,
      content: value.content,
      status: value.status,
      model: value.model,
      errorCode: value.error_code,
      createdAt: value.created_at,
      finishedAt: value.finished_at
    };
  }
  return null;
}

export function decodeConversationPage(value: unknown): ConversationPage | null {
  if (!isRecord(value) || !Array.isArray(value.conversations)) return null;
  const conversations: ConversationSummary[] = [];
  for (const entry of value.conversations) {
    const decoded = decodeConversationSummary(entry);
    if (!decoded) return null;
    conversations.push(decoded);
  }
  const nextCursor = value.next_cursor;
  if (nextCursor !== null && !isBoundedString(nextCursor, 128)) {
    return null;
  }
  return { conversations, nextCursor };
}

export function decodeConversationDetail(
  value: unknown
): ConversationDetail | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const conversation = decodeConversationSummary(value.conversation);
  if (!conversation) return null;
  const messages: ChatMessage[] = [];
  for (const entry of value.messages) {
    const decoded = decodeChatMessage(entry);
    if (!decoded) return null;
    messages.push(decoded);
  }
  return { conversation, messages };
}

function invalidResponse(): ApiError {
  return new ApiError("invalid-response", INVALID_RESPONSE_MESSAGE);
}

const DEFAULT_LIST_LIMIT = 30;

export async function listConversations(options: {
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ConversationPage> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? DEFAULT_LIST_LIMIT));
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  const payload = await apiRequest(`/api/v1/conversations?${params}`, {
    signal: options.signal
  });
  const page = decodeConversationPage(payload);
  if (!page) throw invalidResponse();
  return page;
}

export async function getConversation(
  id: string,
  signal?: AbortSignal
): Promise<ConversationDetail> {
  const payload = await apiRequest(
    `/api/v1/conversations/${encodeURIComponent(id)}`,
    { signal }
  );
  const detail = decodeConversationDetail(payload);
  if (!detail) throw invalidResponse();
  return detail;
}

export async function renameConversation(
  id: string,
  title: string,
  csrfToken: string,
  signal?: AbortSignal
): Promise<ConversationSummary> {
  const payload = await apiRequest(
    `/api/v1/conversations/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      csrfToken,
      body: { title },
      signal
    }
  );
  const conversation = decodeConversationSummary(payload);
  if (!conversation) throw invalidResponse();
  return conversation;
}

export async function deleteConversation(
  id: string,
  csrfToken: string,
  signal?: AbortSignal
): Promise<void> {
  // The server makes permanent delete idempotent: 204 whether or not the
  // conversation still exists.
  await apiRequest(`/api/v1/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    csrfToken,
    signal
  });
}
