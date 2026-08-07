// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionStore } from "./session-store.svelte";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("session store", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bootstraps to authenticated when the session is valid", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { authenticated: true, csrf_token: "csrf-1" })
    );
    const store = createSessionStore();

    await store.bootstrap();

    expect(store.status).toEqual({
      kind: "authenticated",
      csrfToken: "csrf-1"
    });
  });

  it("bootstraps to unauthenticated on 401", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, null));
    const store = createSessionStore();

    await store.bootstrap();

    expect(store.status).toEqual({ kind: "unauthenticated" });
  });

  it("surfaces transport failures as a recoverable unavailable state", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("network down"));
    const store = createSessionStore();

    await store.bootstrap();

    expect(store.status.kind).toBe("unavailable");
    if (store.status.kind === "unavailable") {
      expect(store.status.message).toContain("重试");
    }
  });

  it("logs in with remember_me=false by default and clears the raw token path", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { authenticated: true, csrf_token: "csrf-2" })
      );
    const store = createSessionStore();

    await expect(store.login("raw-token", false)).resolves.toBe(true);

    const loginRequest = fetchMock.mock.calls[0]?.[1];
    expect(loginRequest?.method).toBe("POST");
    expect(JSON.parse(String(loginRequest?.body))).toEqual({
      token: "raw-token",
      remember_me: false
    });
    expect(store.status).toEqual({
      kind: "authenticated",
      csrfToken: "csrf-2"
    });
    expect(store.errorMessage).toBeNull();
  });

  it("keeps the unauthenticated state with an actionable error on bad credentials", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, null));
    const store = createSessionStore();
    await store.bootstrap();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "invalid_credentials" } })
    );
    await expect(store.login("wrong-token", false)).resolves.toBe(false);

    expect(store.status).toEqual({ kind: "unauthenticated" });
    expect(store.errorMessage).toBe("访问令牌无效，请检查后重试。");
    expect(store.isBusy).toBe(false);
  });

  it("fails closed when the exchange succeeds but no session materializes", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(401, null));
    const store = createSessionStore();

    await expect(store.login("raw-token", false)).resolves.toBe(false);

    expect(store.status.kind).not.toBe("authenticated");
    expect(store.errorMessage).toBe("操作失败，请稍后重试。");
  });

  it("logs out using the in-memory CSRF token and returns to unauthenticated", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { authenticated: true, csrf_token: "csrf-3" })
    );
    const store = createSessionStore();
    await store.bootstrap();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store.logout();

    const logoutRequest = fetchMock.mock.calls[1]?.[1];
    expect(logoutRequest?.method).toBe("DELETE");
    expect(
      new Headers(logoutRequest?.headers).get("x-csrf-token")
    ).toBe("csrf-3");
    expect(store.status).toEqual({ kind: "unauthenticated" });
  });

  it("keeps the session and reports the error when logout fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { authenticated: true, csrf_token: "csrf-4" })
    );
    const store = createSessionStore();
    await store.bootstrap();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await store.logout();

    expect(store.status.kind).toBe("authenticated");
    expect(store.errorMessage).toBe("退出失败，请稍后重试。");
  });

  it("recovers from unavailable through an explicit retry", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const store = createSessionStore();
    await store.bootstrap();
    expect(store.status.kind).toBe("unavailable");

    fetchMock.mockResolvedValueOnce(jsonResponse(401, null));
    await store.retryBootstrap();

    expect(store.status).toEqual({ kind: "unauthenticated" });
  });

  it("collapses concurrent retries into a single bootstrap request", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const store = createSessionStore();
    await store.bootstrap();
    expect(store.status.kind).toBe("unavailable");

    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(401, null));
        })
    );

    const first = store.retryBootstrap();
    expect(store.isBusy).toBe(true);
    const second = store.retryBootstrap();
    await Promise.resolve();

    release();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2); // failed bootstrap + one retry
    expect(store.status).toEqual({ kind: "unauthenticated" });
    expect(store.isBusy).toBe(false);
  });

  it("expire drops the authenticated session with a re-login notice", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { authenticated: true, csrf_token: "csrf-4" })
    );
    const store = createSessionStore();
    await store.bootstrap();
    expect(store.status.kind).toBe("authenticated");

    store.expire();

    expect(store.status).toEqual({ kind: "unauthenticated" });
    expect(store.errorMessage).toBe("登录已过期，请重新登录。");

    // Expiring when already unauthenticated is a no-op.
    store.clearError();
    store.expire();
    expect(store.errorMessage).toBeNull();
  });
});
