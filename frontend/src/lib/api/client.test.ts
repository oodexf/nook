import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  decodeErrorBody,
  GENERIC_ERROR_MESSAGE,
  INVALID_RESPONSE_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  apiRequest,
  onSessionExpired
} from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("apiRequest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends same-origin credentials and decodes JSON from unknown", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));

    const payload = await apiRequest("/api/v1/example");

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/v1/example");
    expect(request?.credentials).toBe("same-origin");
    expect(request?.method).toBe("GET");
    expect(payload).toEqual({ ok: true });
  });

  it("sends the CSRF header and JSON body on mutations", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));

    await apiRequest("/api/v1/example", {
      method: "PATCH",
      csrfToken: "csrf-1",
      body: { title: "Renamed" }
    });

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    const headers = request?.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(request?.body).toBe(JSON.stringify({ title: "Renamed" }));
  });

  it("returns null for 204 responses", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiRequest("/api/v1/example", { method: "DELETE" }))
      .resolves.toBeNull();
  });

  it("notifies session-expired listeners once on 401 and throws a typed error", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);

    const error = await apiRequest("/api/v1/example").catch(
      (caught: unknown) => caught
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("session-expired");
    expect((error as ApiError).message).toBe(SESSION_EXPIRED_MESSAGE);
    unsubscribe();
  });

  it("stops notifying after the listener unsubscribes", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    unsubscribe();

    await apiRequest("/api/v1/example").catch(() => undefined);

    expect(listener).not.toHaveBeenCalled();
  });

  it("maps the server error envelope to a typed safe error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(404, {
        error: {
          code: "conversation_not_found",
          message: "The conversation was not found.",
          request_id: "01J00000000000000000000000"
        }
      })
    );

    const error = await apiRequest("/api/v1/example").catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe("http");
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe("conversation_not_found");
    expect(apiError.requestId).toBe("01J00000000000000000000000");
    expect(apiError.message).toBe("The conversation was not found.");
  });

  it("falls back to a generic message when the error envelope is malformed", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(500, { error: { code: 42 } })
    );

    const error = await apiRequest("/api/v1/example").catch(
      (caught: unknown) => caught
    );

    expect((error as ApiError).kind).toBe("http");
    expect((error as ApiError).message).toBe(GENERIC_ERROR_MESSAGE);
    expect((error as ApiError).code).toBeNull();
  });

  it("treats an undecodable success body as an invalid response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("not json", { status: 200 })
    );

    const error = await apiRequest("/api/v1/example").catch(
      (caught: unknown) => caught
    );

    expect((error as ApiError).kind).toBe("invalid-response");
    expect((error as ApiError).message).toBe(INVALID_RESPONSE_MESSAGE);
  });

  it("maps transport failures to a network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("network down"));

    const error = await apiRequest("/api/v1/example").catch(
      (caught: unknown) => caught
    );

    expect((error as ApiError).kind).toBe("network");
    expect((error as ApiError).message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("passes abort errors through untouched", async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException("aborted", "AbortError")
    );

    const error = await apiRequest("/api/v1/example").catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(DOMException);
  });
});

describe("decodeErrorBody", () => {
  it("decodes the public error envelope", () => {
    expect(
      decodeErrorBody({
        error: { code: "conflict", message: "Conflict.", request_id: "r1" }
      })
    ).toEqual({ code: "conflict", message: "Conflict.", requestId: "r1" });
  });

  it("rejects missing, oversized, or non-string fields", () => {
    expect(decodeErrorBody(null)).toBeNull();
    expect(decodeErrorBody({})).toBeNull();
    expect(decodeErrorBody({ error: null })).toBeNull();
    expect(
      decodeErrorBody({ error: { code: "x", message: "y", request_id: "" } })
    ).toBeNull();
    expect(
      decodeErrorBody({
        error: {
          code: "x",
          message: "m".repeat(301),
          request_id: "r1"
        }
      })
    ).toBeNull();
  });
});
