import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeSession,
  decodeSessionError,
  fetchSession,
  login,
  logout
} from "./session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("decodeSession", () => {
  it("accepts the authenticated contract", () => {
    expect(
      decodeSession({ authenticated: true, csrf_token: "csrf-value" })
    ).toEqual({ kind: "authenticated", csrfToken: "csrf-value" });
  });

  it.each([
    null,
    {},
    { authenticated: false, csrf_token: "csrf-value" },
    { authenticated: true },
    { authenticated: true, csrf_token: "" },
    { authenticated: true, csrf_token: 42 }
  ])("rejects malformed payload %#", (payload) => {
    expect(decodeSession(payload)).toBeNull();
  });
});

describe("decodeSessionError", () => {
  it.each([
    ["invalid_credentials", "访问令牌无效，请检查后重试。"],
    ["rate_limited", "尝试次数过多，请稍后再试。"],
    ["csrf_rejected", "请求来源验证失败，请刷新页面后重试。"],
    ["unknown_code", "登录失败，请稍后重试。"]
  ])("maps %s to generic actionable copy", (code, message) => {
    expect(
      decodeSessionError({
        error: { code, message: "server detail must not be shown" }
      })
    ).toBe(message);
  });

  it("does not trust malformed error payloads", () => {
    expect(
      decodeSessionError({ error: { message: "raw upstream body" } })
    ).toBeNull();
  });
});

describe("session HTTP boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a 401 session check as unauthenticated", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));

    await expect(fetchSession()).resolves.toEqual({
      kind: "unauthenticated"
    });
  });

  it("converts transport failures into an actionable error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchSession()).rejects.toThrow(
      "暂时无法连接服务，请检查网络后重试。"
    );
  });

  it("rethrows abort signals so callers can ignore cancelled checks", async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(fetchSession()).rejects.toMatchObject({
      name: "AbortError"
    });
  });

  it("never sends the raw token after a successful exchange", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await login("raw-token", true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "raw-token",
      remember_me: true
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { authenticated: true, csrf_token: "csrf" })
    );
    await fetchSession();
    const bootstrapRequest = fetchMock.mock.calls[1]?.[1];
    expect(JSON.stringify(bootstrapRequest)).not.toContain("raw-token");
  });

  it("maps login error codes through the public decoder", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(429, { error: { code: "rate_limited" } })
    );

    await expect(login("token", false)).rejects.toThrow(
      "尝试次数过多，请稍后再试。"
    );
  });

  it("treats an already-expired session as a successful logout", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));

    await expect(logout("csrf")).resolves.toBeUndefined();
  });

  it("sends the CSRF header only on logout", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await logout("csrf-value");

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe("DELETE");
    expect(new Headers(request?.headers).get("x-csrf-token")).toBe(
      "csrf-value"
    );
  });
});
