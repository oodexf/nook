// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onSessionExpired } from "../api/client";
import { createModelStore } from "./model-store.svelte";

const DRAFT_KEY = "chat.draft-model-id";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function catalogPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    models: [
      { id: "model-a", label: "model-a" },
      { id: "model-b", label: "model-b" }
    ],
    default_model: "model-a",
    refreshed_at: 1786000000000,
    stale: false,
    refresh_error: null,
    ...overrides
  };
}

function catalogError(code: string, status = 503): Response {
  return jsonResponse(status, {
    error: { code, message: "模型服务暂时不可用。", request_id: "r-1" }
  });
}

describe("model store", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("loads the catalog and preselects the configured default model", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("ready");
    expect(store.models.map((model) => model.id)).toEqual([
      "model-a",
      "model-b"
    ]);
    expect(store.defaultModel).toBe("model-a");
    expect(store.draftModelId).toBe("model-a");
    expect(store.stale).toBe(false);
    expect(store.errorMessage).toBeNull();
    // Only the latest draft model ID is persisted — never the catalog.
    expect(Object.keys(window.localStorage)).toEqual([DRAFT_KEY]);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-a");
  });

  it("preselects the remembered draft model when it is still available", async () => {
    window.localStorage.setItem(DRAFT_KEY, "model-b");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));
    const store = createModelStore();

    await store.load();

    expect(store.draftModelId).toBe("model-b");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-b");
  });

  it("falls back to the configured default when the remembered model is gone", async () => {
    window.localStorage.setItem(DRAFT_KEY, "removed-model");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));
    const store = createModelStore();

    await store.load();

    expect(store.draftModelId).toBe("model-a");
    // The stale record is replaced with exactly the resolved selection.
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-a");
  });

  it("ignores invalid remembered values and never substitutes a model", async () => {
    window.localStorage.setItem(DRAFT_KEY, "x".repeat(400));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));
    const store = createModelStore();

    await store.load();

    expect(store.draftModelId).toBe("model-a");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-a");
  });

  it("treats a malformed success payload as a recoverable error state", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { models: "model-a" })
    );
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("error");
    expect(store.isConfigurationError).toBe(false);
    expect(store.errorMessage).toContain("重试");
    expect(store.draftModelId).toBeNull();
  });

  it("blocks on an empty catalog instead of inventing a model", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, catalogPayload({ models: [], default_model: "" }))
    );
    // default_model "" fails decoding first; use a default absent from the list.
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, catalogPayload({ models: [], default_model: "ghost" }))
    );
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("error");
    expect(store.isConfigurationError).toBe(true);
    expect(store.models).toEqual([]);
    expect(store.draftModelId).toBeNull();
  });

  it("blocks on a default model missing from the decoded catalog", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, catalogPayload({ default_model: "not-in-catalog" }))
    );
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("error");
    expect(store.isConfigurationError).toBe(true);
    expect(store.draftModelId).toBeNull();
  });

  it("maps the server model_default_missing failure to a blocking state", async () => {
    vi.mocked(fetch).mockResolvedValue(
      catalogError("model_default_missing", 422)
    );
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("error");
    expect(store.isConfigurationError).toBe(true);
    expect(store.errorMessage).toBe("模型服务暂时不可用。");
  });

  it("keeps transient catalog failures recoverable and distinct", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      catalogError("model_provider_unavailable")
    );
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("error");
    expect(store.isConfigurationError).toBe(false);
    expect(store.errorMessage).toBe("模型服务暂时不可用。");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogPayload()));
    await store.load();

    expect(store.status).toBe("ready");
    expect(store.draftModelId).toBe("model-a");
    expect(store.errorMessage).toBeNull();
  });

  it("exposes a stale catalog with refresh metadata and stays usable", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        200,
        catalogPayload({
          stale: true,
          refresh_error: {
            code: "model_provider_timeout",
            message: "Model discovery timed out.",
            request_id: "r-stale"
          }
        })
      )
    );
    const store = createModelStore();

    await store.load();

    expect(store.status).toBe("ready");
    expect(store.stale).toBe(true);
    expect(store.refreshError?.code).toBe("model_provider_timeout");
    // The stale catalog is still authoritative for the draft selection.
    expect(store.draftModelId).toBe("model-a");
  });

  it("refresh bypasses the cache, sends CSRF, and clears stale markers", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, catalogPayload({ stale: true }))
    );
    const store = createModelStore();
    await store.load();
    expect(store.stale).toBe(true);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        catalogPayload({
          models: [
            { id: "model-a", label: "model-a" },
            { id: "model-c", label: "model-c" }
          ],
          refreshed_at: 1786000005000
        })
      )
    );
    await store.refresh("csrf-7");

    const request = fetchMock.mock.calls[1]?.[1];
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/models/refresh");
    expect(request?.method).toBe("POST");
    expect((request?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-7"
    );
    expect(store.stale).toBe(false);
    expect(store.refreshError).toBeNull();
    expect(store.refreshedAt).toBe(1786000005000);
    expect(store.models.map((model) => model.id)).toEqual([
      "model-a",
      "model-c"
    ]);
  });

  it("keeps the previous state visible when an explicit refresh fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogPayload()));
    const store = createModelStore();
    await store.load();

    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    await expect(store.refresh("csrf-7")).rejects.toThrow();
    expect(store.status).toBe("ready");
    expect(store.models).toHaveLength(2);
    expect(store.errorMessage).toContain("重试");
    expect(store.isRefreshing).toBe(false);
  });

  it("revalidates the draft selection after a refresh removes the model", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogPayload()));
    const store = createModelStore();
    await store.load();
    expect(store.selectDraftModel("model-b")).toBe(true);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        catalogPayload({ models: [{ id: "model-a", label: "model-a" }] })
      )
    );
    await store.refresh("csrf-7");

    // The removed draft model falls back to the configured default only.
    expect(store.draftModelId).toBe("model-a");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-a");
  });

  it("rejects selections outside the catalog without side effects", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));
    const store = createModelStore();
    await store.load();

    expect(store.selectDraftModel("not-a-model")).toBe(false);
    expect(store.draftModelId).toBe("model-a");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-a");

    expect(store.selectDraftModel(" model-b ")).toBe(false);
    expect(store.selectDraftModel("model-b")).toBe(true);
    expect(store.draftModelId).toBe("model-b");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("model-b");
  });

  it("reports locked-model availability only from the loaded catalog", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));
    const store = createModelStore();

    expect(store.isModelAvailable("model-a")).toBe(false);

    await store.load();

    expect(store.isModelAvailable("model-a")).toBe(true);
    expect(store.isModelAvailable("removed-model")).toBe(false);
  });

  it("does not persist anything but the draft model ID across failures", async () => {
    vi.mocked(fetch).mockResolvedValue(catalogError("model_provider_timeout"));
    const store = createModelStore();

    await store.load();

    expect(Object.keys(window.localStorage)).toEqual([]);
  });

  it("routes a 401 to the centralized session-expired listener", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    const store = createModelStore();

    await store.load();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.status).toBe("error");
    unsubscribe();
  });
});
