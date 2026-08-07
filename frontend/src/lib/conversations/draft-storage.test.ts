// @vitest-environment jsdom
/**
 * Draft persistence bounds (F-08; state-management.md §Persistence):
 * safe keying, validation of stored payloads, size/entry bounds, eviction,
 * and post-send cleanup. Storage holds only unsent drafts — never tokens,
 * never persisted message bodies.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_DRAFT_ENTRIES,
  MAX_DRAFT_LENGTH,
  clearDraft,
  draftKeyFor,
  readDraft,
  writeDraft
} from "./draft-storage";

const STORAGE_KEY = "chat.composer-drafts";

describe("draft-storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a draft keyed by conversation identity", () => {
    writeDraft("conv-1", "未发送的内容");
    expect(readDraft("conv-1")).toBe("未发送的内容");
    // Other views are unaffected.
    expect(readDraft("new")).toBeNull();
    expect(readDraft("conv-2")).toBeNull();
  });

  it("uses the literal `new` key for the empty-draft view", () => {
    expect(draftKeyFor(null)).toBe("new");
    expect(draftKeyFor("abc-DEF_123")).toBe("abc-DEF_123");
  });

  it("rejects unusable identities instead of building unsafe keys", () => {
    expect(draftKeyFor("has space")).toBeNull();
    expect(draftKeyFor("../etc")).toBeNull();
    expect(draftKeyFor("x".repeat(65))).toBeNull();
    expect(draftKeyFor("")).toBeNull();
  });

  it("removes the entry when the value becomes empty (post-send cleanup)", () => {
    writeDraft("conv-1", "草稿");
    writeDraft("conv-1", "");
    expect(readDraft("conv-1")).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clearDraft removes only the targeted entry", () => {
    writeDraft("conv-1", "一");
    writeDraft("conv-2", "二");
    clearDraft("conv-1");
    expect(readDraft("conv-1")).toBeNull();
    expect(readDraft("conv-2")).toBe("二");
  });

  it("does not persist overlong drafts (session-only instead of truncating)", () => {
    writeDraft("conv-1", "短草稿");
    writeDraft("conv-1", "x".repeat(MAX_DRAFT_LENGTH + 1));
    // The overlong value replaces nothing: the entry is dropped, never
    // silently truncated, and the UI keeps the text in memory.
    expect(readDraft("conv-1")).toBeNull();
  });

  it("accepts a draft exactly at the length bound", () => {
    const value = "x".repeat(MAX_DRAFT_LENGTH);
    writeDraft("conv-1", value);
    expect(readDraft("conv-1")).toBe(value);
  });

  it("evicts the stalest draft beyond the entry cap", () => {
    for (let index = 0; index < MAX_DRAFT_ENTRIES; index += 1) {
      writeDraft(`conv-${index}`, `draft-${index}`);
    }
    writeDraft("conv-new", "newest");
    expect(readDraft("conv-0")).toBeNull();
    expect(readDraft("conv-1")).toBe("draft-1");
    expect(readDraft("conv-new")).toBe("newest");
  });

  it("refreshes recency when an existing draft is edited", () => {
    for (let index = 0; index < MAX_DRAFT_ENTRIES; index += 1) {
      writeDraft(`conv-${index}`, `draft-${index}`);
    }
    writeDraft("conv-0", "edited");
    writeDraft("conv-new", "newest");
    // conv-0 was touched last among the originals, so conv-1 evicts first.
    expect(readDraft("conv-0")).toBe("edited");
    expect(readDraft("conv-1")).toBeNull();
  });

  it("discards corrupted JSON without throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readDraft("conv-1")).toBeNull();
  });

  it("discards records with invalid value shapes", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "conv-1": 42 })
    );
    expect(readDraft("conv-1")).toBeNull();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["array"]));
    expect(readDraft("conv-1")).toBeNull();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "bad key": "x" })
    );
    expect(readDraft("bad key")).toBeNull();
  });

  it("discards oversized stored payloads wholesale", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "conv-1": "x".repeat(MAX_DRAFT_LENGTH + 1) })
    );
    expect(readDraft("conv-1")).toBeNull();
  });
});
