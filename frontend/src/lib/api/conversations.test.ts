import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_MODEL_ID } from "../test-utils/test-provider";

import { ApiError } from "./client";
import {
  decodeChatMessage,
  decodeConversationDetail,
  decodeConversationPage,
  decodeConversationSummary,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  updateConversationModel
} from "./conversations";

const ID_A = "01J0000000000000000000000A";
const ID_B = "01J0000000000000000000000B";

function summaryPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ID_A,
    title: "研究笔记",
    model: TEST_MODEL_ID,
    created_at: 1786000000000,
    updated_at: 1786000001000,
    ...overrides
  };
}

function messagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ID_B,
    conversation_id: ID_A,
    client_message_id: "client-1",
    role: "assistant",
    content: "你好",
    status: "completed",
    model: TEST_MODEL_ID,
    error_code: null,
    created_at: 1786000000000,
    finished_at: 1786000000500,
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("decodeConversationSummary", () => {
  it("decodes the server DTO into the frontend shape", () => {
    expect(decodeConversationSummary(summaryPayload())).toEqual({
      id: ID_A,
      title: "研究笔记",
      model: TEST_MODEL_ID,
      createdAt: 1786000000000,
      updatedAt: 1786000001000,
      pinned: false
    });
  });

  it.each([
    ["missing id", { id: undefined }],
    ["empty title", { title: "" }],
    ["non-string title", { title: 42 }],
    ["missing model", { model: undefined }],
    ["fractional timestamp", { updated_at: 1.5 }],
    ["negative timestamp", { created_at: -1 }],
    ["string timestamp", { created_at: "1786000000000" }],
    ["oversized id", { id: "x".repeat(65) }]
  ])("rejects %s", (_label, overrides) => {
    expect(decodeConversationSummary(summaryPayload(overrides))).toBeNull();
  });
});

describe("decodeChatMessage", () => {
  it("decodes an assistant message with nullable fields", () => {
    expect(decodeChatMessage(messagePayload())).toEqual({
      id: ID_B,
      conversationId: ID_A,
      clientMessageId: "client-1",
      role: "assistant",
      content: "你好",
      reasoning: null,
      status: "completed",
      model: TEST_MODEL_ID,
      errorCode: null,
      createdAt: 1786000000000,
      finishedAt: 1786000000500
    });
  });

  it("accepts a user message without optional fields", () => {
    expect(
      decodeChatMessage(
        messagePayload({
          role: "user",
          client_message_id: null,
          model: null,
          finished_at: null
        })
      )
    ).not.toBeNull();
  });

  it("decodes persisted reasoning and tolerates a missing field", () => {
    expect(
      decodeChatMessage(messagePayload({ reasoning: "完整思维链" }))
    ).toMatchObject({ reasoning: "完整思维链" });
    // Payloads from older servers carry no reasoning key at all.
    const legacy = messagePayload();
    expect(decodeChatMessage(legacy)).toMatchObject({ reasoning: null });
  });

  it.each([
    ["unknown role", { role: "system" }],
    ["unknown status", { status: "pending" }],
    ["non-string error_code", { error_code: 7 }],
    ["non-integer finished_at", { finished_at: "soon" }],
    ["missing content", { content: undefined }],
    ["non-string reasoning", { reasoning: 42 }]
  ])("rejects %s", (_label, overrides) => {
    expect(decodeChatMessage(messagePayload(overrides))).toBeNull();
  });
});

describe("decodeConversationPage", () => {
  it("decodes a page with an opaque cursor", () => {
    const page = decodeConversationPage({
      conversations: [summaryPayload()],
      next_cursor: "1786000001000.01J0000000000000000000000A"
    });
    expect(page?.conversations).toHaveLength(1);
    expect(page?.nextCursor).toBe(
      "1786000001000.01J0000000000000000000000A"
    );
  });

  it("decodes the terminal page with a null cursor", () => {
    const page = decodeConversationPage({
      conversations: [],
      next_cursor: null
    });
    expect(page).toEqual({ conversations: [], nextCursor: null });
  });

  it("fails closed when any entry is malformed", () => {
    expect(
      decodeConversationPage({
        conversations: [summaryPayload(), summaryPayload({ title: "" })],
        next_cursor: null
      })
    ).toBeNull();
    expect(
      decodeConversationPage({ conversations: "not-an-array", next_cursor: null })
    ).toBeNull();
    expect(
      decodeConversationPage({ conversations: [], next_cursor: 42 })
    ).toBeNull();
  });
});

describe("decodeConversationDetail", () => {
  it("decodes conversation plus ordered messages", () => {
    const detail = decodeConversationDetail({
      conversation: summaryPayload(),
      messages: [messagePayload(), messagePayload({ id: ID_A, role: "user" })]
    });
    expect(detail?.conversation.id).toBe(ID_A);
    expect(detail?.messages).toHaveLength(2);
  });

  it("fails closed on malformed nested payloads", () => {
    expect(
      decodeConversationDetail({
        conversation: summaryPayload({ model: "" }),
        messages: []
      })
    ).toBeNull();
    expect(
      decodeConversationDetail({
        conversation: summaryPayload(),
        messages: [messagePayload({ status: "weird" })]
      })
    ).toBeNull();
  });
});

describe("conversation endpoints", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists conversations with limit and cursor query parameters", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { conversations: [summaryPayload()], next_cursor: null })
    );

    const page = await listConversations({ cursor: "cursor-1", limit: 50 });

    const url = String(vi.mocked(fetch).mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/conversations?");
    expect(url).toContain("limit=50");
    expect(url).toContain("cursor=cursor-1");
    expect(page.conversations[0]?.id).toBe(ID_A);
  });

  it("throws invalid-response when the list payload does not match the contract", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { conversations: [{ broken: true }] })
    );

    const error = await listConversations({}).catch((caught: unknown) => caught);
    expect((error as ApiError).kind).toBe("invalid-response");
  });

  it("opens a conversation and decodes messages", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        conversation: summaryPayload(),
        messages: [messagePayload()]
      })
    );

    const detail = await getConversation(ID_A);

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      `/api/v1/conversations/${ID_A}`
    );
    expect(detail.messages[0]?.role).toBe("assistant");
  });

  it("renames with CSRF and returns the server-updated summary", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, summaryPayload({ title: "新标题", updated_at: 1786000002000 }))
    );

    const updated = await renameConversation(ID_A, "新标题", "csrf-9");

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(request?.method).toBe("PATCH");
    expect((request?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-9"
    );
    expect(request?.body).toBe(JSON.stringify({ title: "新标题" }));
    expect(updated.title).toBe("新标题");
    expect(updated.updatedAt).toBe(1786000002000);
  });

  it("updates the current model with CSRF and decodes the result", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, summaryPayload({ model: "model-b", updated_at: 1786000003000 }))
    );

    const updated = await updateConversationModel(ID_A, "model-b", "csrf-9");

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      `/api/v1/conversations/${ID_A}/model`
    );
    expect(request?.method).toBe("PUT");
    expect((request?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-9"
    );
    expect(request?.body).toBe(JSON.stringify({ model: "model-b" }));
    expect(updated.model).toBe("model-b");
  });

  it("deletes with CSRF and resolves on 204", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteConversation(ID_A, "csrf-9")).resolves.toBeUndefined();

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(request?.method).toBe("DELETE");
    expect((request?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-9"
    );
  });
});
