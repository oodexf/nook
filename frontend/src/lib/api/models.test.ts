import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, onSessionExpired } from "./client";
import {
  decodeModelCatalog,
  fetchModels,
  isModelConfigurationErrorCode,
  refreshModels
} from "./models";

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

describe("fetchModels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the catalog with same-origin credentials and decodes it", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));

    const catalog = await fetchModels();

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/v1/models");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.credentials).toBe("same-origin");
    expect(catalog).toEqual({
      models: [
        { id: "model-a", label: "model-a" },
        { id: "model-b", label: "model-b" }
      ],
      defaultModel: "model-a",
      refreshedAt: 1786000000000,
      stale: false,
      refreshError: null
    });
  });

  it("decodes a stale catalog with its refresh-error metadata", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        200,
        catalogPayload({
          stale: true,
          refresh_error: {
            code: "model_provider_rate_limited",
            message: "The model provider is rate limiting model discovery.",
            request_id: "r-stale-1"
          }
        })
      )
    );

    const catalog = await fetchModels();

    expect(catalog.stale).toBe(true);
    expect(catalog.refreshError).toEqual({
      code: "model_provider_rate_limited",
      message: "The model provider is rate limiting model discovery.",
      requestId: "r-stale-1"
    });
    expect(catalog.models).toHaveLength(2);
  });

  it("propagates a blocking configuration error with its stable code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "model_default_missing",
          message: "The configured default model is not available.",
          request_id: "r-1"
        }
      })
    );

    const error = await fetchModels().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("model_default_missing");
    expect(isModelConfigurationErrorCode((error as ApiError).code)).toBe(true);
  });

  it("routes 401 through the centralized session-expired notification", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    const error = await fetchModels().catch((caught: unknown) => caught);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((error as ApiError).kind).toBe("session-expired");
    unsubscribe();
  });
});

describe("refreshModels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts with the session-bound CSRF token", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, catalogPayload()));

    await refreshModels("csrf-9");

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/v1/models/refresh");
    expect(request?.method).toBe("POST");
    expect((request?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-9"
    );
  });
});

describe("decodeModelCatalog", () => {
  it("rejects malformed success payloads instead of repairing them", () => {
    expect(decodeModelCatalog(null)).toBeNull();
    expect(decodeModelCatalog({})).toBeNull();
    expect(decodeModelCatalog(catalogPayload({ models: "model-a" }))).toBeNull();
    expect(
      decodeModelCatalog(catalogPayload({ models: [{ id: "model-a" }] }))
    ).toBeNull();
    expect(
      decodeModelCatalog(catalogPayload({ models: [{ id: 42, label: "x" }] }))
    ).toBeNull();
    expect(decodeModelCatalog(catalogPayload({ default_model: "" }))).toBeNull();
    expect(
      decodeModelCatalog(catalogPayload({ default_model: "x".repeat(201) }))
    ).toBeNull();
    expect(
      decodeModelCatalog(catalogPayload({ refreshed_at: "yesterday" }))
    ).toBeNull();
    expect(decodeModelCatalog(catalogPayload({ refreshed_at: -1 }))).toBeNull();
    expect(decodeModelCatalog(catalogPayload({ stale: "yes" }))).toBeNull();
    expect(
      decodeModelCatalog(catalogPayload({ refresh_error: { code: "unknown" } }))
    ).toBeNull();
    expect(
      decodeModelCatalog(
        catalogPayload({
          refresh_error: {
            code: "model_provider_timeout",
            message: "Model discovery timed out.",
            request_id: ""
          }
        })
      )
    ).toBeNull();
  });

  it("accepts an empty model list shape; emptiness is enforced by the store", () => {
    // The server already rejects empty catalogs; the decoder validates shape
    // only, so the store remains the single owner of the empty-catalog guard.
    const decoded = decodeModelCatalog(catalogPayload({ models: [] }));
    expect(decoded?.models).toEqual([]);
  });
});

describe("isModelConfigurationErrorCode", () => {
  it("classifies only the blocking configuration codes", () => {
    expect(isModelConfigurationErrorCode("model_default_missing")).toBe(true);
    expect(isModelConfigurationErrorCode("model_catalog_empty")).toBe(true);
    expect(isModelConfigurationErrorCode("model_provider_invalid_response")).toBe(
      true
    );
    expect(isModelConfigurationErrorCode("model_provider_unavailable")).toBe(
      false
    );
    expect(isModelConfigurationErrorCode("model_provider_timeout")).toBe(false);
    expect(isModelConfigurationErrorCode(null)).toBe(false);
  });
});
