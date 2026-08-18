// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onSessionExpired } from "../api/client";
import type { ConversationSummary } from "../api/conversations";
import {
  buildSidebarSections,
  createConversationStore,
  sortConversations
} from "./conversation-store.svelte";

const ID_A = "01J0000000000000000000000A";
const ID_B = "01J0000000000000000000000B";
const ID_C = "01J0000000000000000000000C";

function summary(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    title: `对话 ${id}`,
    model: "test-model",
    created_at: 1786000000000,
    updated_at: 1786000001000,
    ...overrides
  };
}

function detail(id: string): Record<string, unknown> {
  return {
    conversation: summary(id),
    messages: [
      {
        id: `${id.slice(0, 24)}M1`,
        conversation_id: id,
        client_message_id: "client-1",
        role: "user",
        content: "你好",
        status: "completed",
        model: null,
        error_code: null,
        created_at: 1786000000000,
        finished_at: null
      }
    ]
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function pageResponse(
  conversations: Record<string, unknown>[],
  nextCursor: string | null
): Response {
  return jsonResponse(200, { conversations, next_cursor: nextCursor });
}

describe("conversation store", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("loads the first page and exposes deterministic ready state", async () => {
    vi.mocked(fetch).mockResolvedValue(
      pageResponse([summary(ID_A), summary(ID_B)], null)
    );
    const store = createConversationStore();

    await store.load();

    expect(store.listStatus).toBe("ready");
    expect(store.items.map((item) => item.id)).toEqual([ID_A, ID_B]);
    expect(store.hasMore).toBe(false);
    expect(store.listError).toBeNull();
  });

  it("surfaces a recoverable error state when the first page fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const store = createConversationStore();

    await store.load();

    expect(store.listStatus).toBe("error");
    expect(store.listError).toContain("重试");

    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    await store.load();

    expect(store.listStatus).toBe("ready");
    expect(store.items).toHaveLength(1);
  });

  it("keeps the empty list distinct from loading and error", async () => {
    vi.mocked(fetch).mockResolvedValue(pageResponse([], null));
    const store = createConversationStore();

    await store.load();

    expect(store.listStatus).toBe("ready");
    expect(store.items).toEqual([]);
  });

  it("appends the next page deterministically and advances the cursor once", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        pageResponse([summary(ID_A), summary(ID_B)], "cursor-2")
      )
      .mockResolvedValueOnce(
        pageResponse([summary(ID_B), summary(ID_C)], null)
      );
    const store = createConversationStore();
    await store.load();

    await store.loadMore();

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=cursor-2");
    // The overlap row (ID_B) is deduplicated; ordering is unchanged.
    expect(store.items.map((item) => item.id)).toEqual([ID_A, ID_B, ID_C]);
    expect(store.hasMore).toBe(false);
    expect(store.loadMoreError).toBeNull();
  });

  it("preserves the cursor on load-more failure so retry is stable", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(pageResponse([summary(ID_A)], "cursor-2"))
      .mockRejectedValueOnce(new TypeError("network down"));
    const store = createConversationStore();
    await store.load();

    await store.loadMore();

    expect(store.hasMore).toBe(true);
    expect(store.loadMoreError).toContain("重试");
    expect(store.items.map((item) => item.id)).toEqual([ID_A]);

    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_B)], null));
    await store.loadMore();

    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("cursor=cursor-2");
    expect(store.items.map((item) => item.id)).toEqual([ID_A, ID_B]);
    expect(store.loadMoreError).toBeNull();
  });

  it("collapses concurrent load-more calls into one request", async () => {
    const fetchMock = vi.mocked(fetch);
    let resolveSecond: (response: Response) => void = () => undefined;
    fetchMock
      .mockResolvedValueOnce(pageResponse([summary(ID_A)], "cursor-2"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          })
      );
    const store = createConversationStore();
    await store.load();

    const first = store.loadMore();
    const second = store.loadMore();
    resolveSecond(pageResponse([summary(ID_B)], null));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.items).toHaveLength(2);
  });

  it("opens a conversation and decodes its persisted messages", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();
    await store.load();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, detail(ID_A)));
    await store.open(ID_A);

    expect(store.selectedId).toBe(ID_A);
    expect(store.detailStatus).toBe("ready");
    expect(store.current?.conversation.id).toBe(ID_A);
    expect(store.current?.messages).toHaveLength(1);
    expect(store.current?.messages[0]?.content).toBe("你好");
  });

  it("clears the selection when the server reports the conversation is gone", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();
    await store.load();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: {
          code: "conversation_not_found",
          message: "The conversation was not found.",
          request_id: "r1"
        }
      })
    );
    await store.open(ID_A);

    expect(store.detailStatus).toBe("idle");
    expect(store.selectedId).toBeNull();
    expect(store.items).toEqual([]);
    expect(window.localStorage.getItem("chat.selected-conversation-id")).toBeNull();
  });

  it("keeps a recoverable error state when opening fails transiently", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();
    await store.load();

    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    await store.open(ID_A);

    expect(store.detailStatus).toBe("error");
    expect(store.detailError).toContain("重试");
    expect(store.selectedId).toBe(ID_A);
  });

  it("reopens the remembered selection after a reload", async () => {
    window.localStorage.setItem("chat.selected-conversation-id", ID_B);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(pageResponse([summary(ID_A), summary(ID_B)], null))
      .mockResolvedValueOnce(jsonResponse(200, detail(ID_B)));
    const store = createConversationStore();

    await store.load();

    expect(store.selectedId).toBe(ID_B);
    expect(store.current?.conversation.id).toBe(ID_B);
  });

  it("ignores an invalid remembered selection value", async () => {
    window.localStorage.setItem(
      "chat.selected-conversation-id",
      "x".repeat(200)
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();

    await store.load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.selectedId).toBeNull();
  });

  it("persists only the selected conversation id", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();
    await store.load();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, detail(ID_A)));

    await store.open(ID_A);

    const keys = Object.keys(window.localStorage);
    expect(keys).toEqual(["chat.selected-conversation-id"]);
    expect(window.localStorage.getItem(keys[0] ?? "")).toBe(ID_A);
  });

  it("reconciles rename from the server response in list and current state", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      pageResponse(
        [summary(ID_A, { updated_at: 100 }), summary(ID_B, { updated_at: 200 })],
        null
      )
    );
    const store = createConversationStore();
    await store.load();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, detail(ID_B)));
    await store.open(ID_B);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, summary(ID_B, { title: "改名后", updated_at: 300 }))
    );
    const updated = await store.rename(ID_B, "改名后", "csrf-1");

    expect(updated.title).toBe("改名后");
    const item = store.items.find((entry) => entry.id === ID_B);
    expect(item?.title).toBe("改名后");
    expect(item?.updatedAt).toBe(300);
    expect(store.current?.conversation.title).toBe("改名后");
    // The renamed conversation is now the most recently updated.
    expect(store.items[0]?.id).toBe(ID_B);
  });

  it("does not touch local state when rename fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();
    await store.load();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "conflict", message: "冲突。", request_id: "r1" }
      })
    );

    await expect(store.rename(ID_A, "x", "csrf-1")).rejects.toMatchObject({
      code: "conflict"
    });
    expect(store.items[0]?.title).toBe(`对话 ${ID_A}`);
  });

  it("removes a deleted conversation and resets the open view to empty", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      pageResponse([summary(ID_A), summary(ID_B)], null)
    );
    const store = createConversationStore();
    await store.load();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, detail(ID_A)));
    await store.open(ID_A);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store.remove(ID_A, "csrf-1");

    expect(store.items.map((item) => item.id)).toEqual([ID_B]);
    expect(store.selectedId).toBeNull();
    expect(store.current).toBeNull();
    expect(store.detailStatus).toBe("idle");
    expect(window.localStorage.getItem("chat.selected-conversation-id")).toBeNull();
  });

  it("keeps the open conversation when a different one is deleted", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      pageResponse([summary(ID_A), summary(ID_B)], null)
    );
    const store = createConversationStore();
    await store.load();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, detail(ID_A)));
    await store.open(ID_A);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store.remove(ID_B, "csrf-1");

    expect(store.selectedId).toBe(ID_A);
    expect(store.current?.conversation.id).toBe(ID_A);
  });

  it("returns to the empty screen with openNew", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(pageResponse([summary(ID_A)], null));
    const store = createConversationStore();
    await store.load();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, detail(ID_A)));
    await store.open(ID_A);

    store.openNew();

    expect(store.selectedId).toBeNull();
    expect(store.detailStatus).toBe("idle");
  });

  it("notifies session-expired listeners on a 401 during load", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    const store = createConversationStore();

    await store.load();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.listStatus).toBe("error");
    unsubscribe();
  });
});

describe("sortConversations", () => {
  it("orders by updated_at desc with id desc as the tie-breaker", () => {
    const sorted = sortConversations([
      { id: ID_A, title: "a", model: "m", createdAt: 0, updatedAt: 10, pinned: false },
      { id: ID_B, title: "b", model: "m", createdAt: 0, updatedAt: 20, pinned: false },
      { id: ID_C, title: "c", model: "m", createdAt: 0, updatedAt: 20, pinned: false }
    ]);
    expect(sorted.map((item) => item.id)).toEqual([ID_C, ID_B, ID_A]);
  });
});

describe("buildSidebarSections", () => {
  // A fixed local wall-clock instant, so every boundary below is expressed
  // against a known local midnight regardless of the runner's timezone.
  const NOW = new Date(2026, 7, 15, 13, 30, 0).getTime();

  function dayStart(daysAgo: number): number {
    return new Date(2026, 7, 15 - daysAgo).getTime();
  }

  function entry(
    id: string,
    updatedAt: number,
    pinned = false
  ): ConversationSummary {
    return { id, title: id, model: "m", createdAt: 0, updatedAt, pinned };
  }

  it("puts pinned items first and keeps them out of the time buckets", () => {
    const sections = buildSidebarSections(
      [
        entry(ID_A, NOW),
        entry(ID_B, dayStart(40), true),
        entry(ID_C, NOW, true)
      ],
      NOW
    );
    expect(sections.map((section) => section.key)).toEqual(["pinned", "today"]);
    // Pinned keeps the incoming order even though B is far older than C.
    expect(sections[0].items.map((item) => item.id)).toEqual([ID_B, ID_C]);
    expect(sections[0].label).toBe("置顶");
    expect(sections[1].items.map((item) => item.id)).toEqual([ID_A]);
  });

  it("buckets by local calendar day and labels each section", () => {
    const sections = buildSidebarSections(
      [
        entry("today", dayStart(0)),
        entry("yesterday", dayStart(1)),
        entry("week", dayStart(6)),
        entry("month", dayStart(29)),
        entry("older", dayStart(30))
      ],
      NOW
    );
    expect(sections.map((section) => section.key)).toEqual([
      "today",
      "yesterday",
      "week",
      "month",
      "older"
    ]);
    expect(sections.map((section) => section.label)).toEqual([
      "今天",
      "昨天",
      "过去 7 天",
      "过去 30 天",
      "更早"
    ]);
    expect(
      sections.map((section) => section.items.map((item) => item.id))
    ).toEqual([["today"], ["yesterday"], ["week"], ["month"], ["older"]]);
  });

  it("places a timestamp exactly on a boundary in the newer bucket", () => {
    // Each boundary is the inclusive lower edge of its own bucket, so one
    // millisecond earlier belongs to the next-older one.
    const sections = buildSidebarSections(
      [
        entry("edge-today", dayStart(0)),
        entry("edge-yesterday", dayStart(0) - 1),
        entry("edge-week", dayStart(1) - 1),
        entry("edge-month", dayStart(6) - 1),
        entry("edge-older", dayStart(29) - 1)
      ],
      NOW
    );
    expect(
      sections.map((section) => [section.key, section.items[0].id])
    ).toEqual([
      ["today", "edge-today"],
      ["yesterday", "edge-yesterday"],
      ["week", "edge-week"],
      ["month", "edge-month"],
      ["older", "edge-older"]
    ]);
  });

  it("omits empty sections", () => {
    const sections = buildSidebarSections([entry(ID_A, dayStart(3))], NOW);
    expect(sections.map((section) => section.key)).toEqual(["week"]);
  });

  it("returns nothing for an empty page", () => {
    expect(buildSidebarSections([], NOW)).toEqual([]);
  });

  it("keeps the incoming server order inside a bucket", () => {
    const sections = buildSidebarSections(
      [
        entry(ID_A, dayStart(0) + 1_000),
        entry(ID_B, dayStart(0) + 3_000),
        entry(ID_C, dayStart(0) + 2_000)
      ],
      NOW
    );
    expect(sections[0].items.map((item) => item.id)).toEqual([ID_A, ID_B, ID_C]);
  });

  it("treats a clock-skewed future timestamp as today", () => {
    const sections = buildSidebarSections(
      [entry(ID_A, NOW + 60 * 60 * 1000)],
      NOW
    );
    expect(sections.map((section) => section.key)).toEqual(["today"]);
  });
});
