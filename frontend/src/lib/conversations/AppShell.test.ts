// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onSessionExpired } from "../api/client";
import AppShell from "./AppShell.svelte";

type Mounted = Record<string, never>;

const ID_A = "01J0000000000000000000000A";
const ID_B = "01J0000000000000000000000B";

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

function detail(
  id: string,
  content = "普通消息",
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    conversation: summary(id, overrides),
    messages: [
      {
        id: `${id.slice(0, 24)}M1`,
        conversation_id: id,
        client_message_id: "client-1",
        role: "user",
        content,
        status: "completed",
        model: null,
        error_code: null,
        created_at: 1786000000000,
        finished_at: null
      },
      {
        id: `${id.slice(0, 24)}M2`,
        conversation_id: id,
        client_message_id: null,
        role: "assistant",
        content: "助手回复",
        status: "stopped",
        model: "test-model",
        error_code: null,
        created_at: 1786000000100,
        finished_at: 1786000000200
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

function page(
  conversations: Record<string, unknown>[],
  nextCursor: string | null
): Response {
  return jsonResponse(200, { conversations, next_cursor: nextCursor });
}

function catalog(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    models: [
      { id: "test-model", label: "test-model" },
      { id: "model-b", label: "model-b" }
    ],
    default_model: "test-model",
    refreshed_at: 1786000000000,
    stale: false,
    refresh_error: null,
    ...overrides
  };
}

function notFound(): Record<string, unknown> {
  return {
    error: {
      code: "conversation_not_found",
      message: "The conversation was not found.",
      request_id: "r-404"
    }
  };
}

function byText(
  root: HTMLElement,
  selector: string,
  text: string
): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.textContent?.includes(text)
  );
}

type FetchResult = Response | Promise<Response>;
type RouteHandler = (init?: RequestInit) => FetchResult;

type Routes = {
  list?: RouteHandler;
  detail?: (id: string) => FetchResult;
  models?: RouteHandler;
  refresh?: RouteHandler;
  patch?: (id: string) => FetchResult;
  remove?: (id: string) => FetchResult;
};

type CapturedRequest = { url: string; init?: RequestInit };

/**
 * URL-routing fetch stub: the authenticated shell fetches the conversation
 * list and the model catalog independently, so positional mock queues would
 * silently cross the two boundaries. Unmatched routes return 404.
 */
function installRouter(routes: Routes): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const method = init?.method ?? "GET";
    if (url === "/api/v1/models" && method === "GET") {
      return Promise.resolve(
        routes.models?.() ?? jsonResponse(200, catalog())
      );
    }
    if (url === "/api/v1/models/refresh" && method === "POST") {
      return Promise.resolve(
        routes.refresh?.() ?? jsonResponse(200, catalog())
      );
    }
    if (url.startsWith("/api/v1/conversations?") && method === "GET") {
      return Promise.resolve(
        routes.list?.() ?? jsonResponse(404, notFound())
      );
    }
    const conversationMatch = /^\/api\/v1\/conversations\/([^/?]+)$/.exec(url);
    if (conversationMatch) {
      const id = decodeURIComponent(conversationMatch[1] ?? "");
      if (method === "GET") {
        return Promise.resolve(
          routes.detail?.(id) ?? jsonResponse(404, notFound())
        );
      }
      if (method === "PATCH") {
        return Promise.resolve(
          routes.patch?.(id) ?? jsonResponse(404, notFound())
        );
      }
      if (method === "DELETE") {
        return Promise.resolve(routes.remove?.(id) ?? new Response(null, { status: 204 }));
      }
    }
    return Promise.resolve(jsonResponse(404, notFound()));
  });
  return { requests };
}

/** Sequential responses; the last one repeats when the queue is exhausted. */
function queue(...responses: FetchResult[]): RouteHandler {
  let index = 0;
  return () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
  };
}

describe("AppShell", () => {
  let container: HTMLElement;
  let instance: Mounted | undefined;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = undefined;
    }
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function mountShell() {
    instance = mount(AppShell, {
      target: container,
      props: {
        csrfToken: "csrf-shell",
        isSigningOut: false,
        onSignOut: vi.fn()
      }
    }) as Mounted;
  }

  it("shows a loading state, then renders the conversation list", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();

    expect(byText(container, "[role='status']", "正在加载对话")).toBeDefined();

    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    expect(byText(container, "h2", "开始一个新对话")).toBeDefined();
  });

  it("renders the empty state when there are no conversations", async () => {
    installRouter({ list: () => page([], null) });
    mountShell();

    await vi.waitFor(() => {
      expect(byText(container, ".list-note", "还没有对话")).toBeDefined();
    });
  });

  it("shows a recoverable error with retry when the list fails", async () => {
    installRouter({
      list: queue(
        Promise.reject(new TypeError("network down")),
        page([summary(ID_A)], null)
      )
    });
    mountShell();

    await vi.waitFor(() => {
      expect(container.querySelector("[role='alert']")).not.toBeNull();
    });

    byText(container, ".retry", "重试")?.click();

    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
  });

  it("opens a conversation and renders persisted messages as escaped text", async () => {
    installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id, "<script>alert(1)</script>"))
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    byText(container, ".item", `对话 ${ID_A}`)?.click();

    await vi.waitFor(() => {
      expect(container.querySelector(".messages")).not.toBeNull();
    });
    // No script element anywhere; the user payload stays escaped plain
    // text and the assistant message renders via the sanitized Markdown
    // path (no markup carriers survive).
    expect(container.querySelector("script")).toBeNull();
    const contents = Array.from(
      container.querySelectorAll<HTMLElement>(".content")
    ).map((element) => element.textContent);
    expect(contents).toContain("<script>alert(1)</script>");
    const markdown = container.querySelector(".markdown");
    expect(markdown?.textContent).toContain("助手回复");
    // Model and status exactly as the contract exposes them (localized label).
    expect(byText(container, ".status", "已停止")).toBeDefined();
    expect(byText(container, "code.model", "test-model")).toBeDefined();
    // Locked model label in the header.
    expect(byText(container, ".locked-model", "test-model")).toBeDefined();
  });

  it("loads the next page through the load-more button", async () => {
    const { requests } = installRouter({
      list: queue(
        page([summary(ID_A)], "cursor-2"),
        page([summary(ID_B)], null)
      )
    });
    mountShell();

    await vi.waitFor(() => {
      expect(byText(container, ".load-more", "加载更多")).toBeDefined();
    });

    byText(container, ".load-more", "加载更多")?.click();

    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_B}`)).toBeDefined();
    });
    expect(
      requests.some((request) => request.url.includes("cursor=cursor-2"))
    ).toBe(true);
    expect(byText(container, ".load-more", "加载更多")).toBeUndefined();
  });

  it("renames the open conversation and reconciles header and list", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id)),
      patch: (id) =>
        jsonResponse(
          200,
          summary(id, { title: "改名后的标题", updated_at: 1786000002000 })
        )
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    byText(container, ".item", `对话 ${ID_A}`)?.click();
    await vi.waitFor(() => {
      expect(byText(container, "h1.title", `对话 ${ID_A}`)).toBeDefined();
    });

    container.querySelector<HTMLButtonElement>("button[aria-label='重命名对话']")?.click();
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>("#rename-title");
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.value = "改名后的标题";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    container
      .querySelector<HTMLFormElement>(".rename-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(byText(container, "h1.title", "改名后的标题")).toBeDefined();
    });
    const request = requests.find(
      (entry) => entry.init?.method === "PATCH"
    );
    expect((request?.init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-shell"
    );
    expect(request?.init?.body).toBe(
      JSON.stringify({ title: "改名后的标题" })
    );
    expect(byText(container, ".item-title", "改名后的标题")).toBeDefined();
  });

  it("keeps the old title and shows an inline error when rename fails", async () => {
    installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id)),
      patch: () =>
        jsonResponse(503, {
          error: {
            code: "storage_unavailable",
            message: "存储暂时不可用，请稍后重试。",
            request_id: "r1"
          }
        })
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    byText(container, ".item", `对话 ${ID_A}`)?.click();
    await vi.waitFor(() => {
      expect(byText(container, "h1.title", `对话 ${ID_A}`)).toBeDefined();
    });

    container.querySelector<HTMLButtonElement>("button[aria-label='重命名对话']")?.click();
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>("#rename-title");
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.value = "另一个标题";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    container
      .querySelector<HTMLFormElement>(".rename-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(
        byText(container, ".rename-error", "存储暂时不可用")
      ).toBeDefined();
    });
    expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
  });

  it("deletes after accessible confirmation and reconciles list and view", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id)),
      remove: () => new Response(null, { status: 204 })
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    byText(container, ".item", `对话 ${ID_A}`)?.click();
    await vi.waitFor(() => {
      expect(byText(container, "h1.title", `对话 ${ID_A}`)).toBeDefined();
    });

    container.querySelector<HTMLButtonElement>("button[aria-label='删除对话']")?.click();

    const dialog = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>("[role='dialog']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("此操作无法撤销");

    byText(dialog, "button", "永久删除")?.click();

    await vi.waitFor(() => {
      expect(container.querySelector("[role='dialog']")).toBeNull();
      expect(byText(container, "h2", "开始一个新对话")).toBeDefined();
    });
    const request = requests.find(
      (entry) => entry.init?.method === "DELETE"
    );
    expect((request?.init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-shell"
    );
    expect(container.querySelector(".item")).toBeNull();
  });

  it("keeps the conversation when the confirmation is cancelled with Escape", async () => {
    installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id))
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    byText(container, ".item", `对话 ${ID_A}`)?.click();
    await vi.waitFor(() => {
      expect(byText(container, "h1.title", `对话 ${ID_A}`)).toBeDefined();
    });

    container.querySelector<HTMLButtonElement>("button[aria-label='删除对话']")?.click();
    const dialog = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>("[role='dialog']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    await vi.waitFor(() => {
      expect(container.querySelector("[role='dialog']")).toBeNull();
    });
    expect(byText(container, "h1.title", `对话 ${ID_A}`)).toBeDefined();
  });

  it("routes a 401 to the centralized session-expired listener", async () => {
    installRouter({
      list: () => jsonResponse(401, null),
      models: () => jsonResponse(401, null)
    });
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    mountShell();

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalled();
    });
    // The shell itself never silently keeps showing private data states.
    expect(container.querySelector(".item")).toBeNull();
    unsubscribe();
  });

  it("opens and closes the mobile drawer with focus management", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    const menuButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='打开导航']"
    );
    expect(menuButton).not.toBeNull();
    menuButton?.click();

    const drawer = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        ".drawer [role='dialog']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(drawer.getAttribute("aria-modal")).toBe("true");

    drawer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    await vi.waitFor(() => {
      expect(container.querySelector(".drawer")).toBeNull();
    });
    expect(document.activeElement).toBe(menuButton);
  });

  it("traps Tab and Shift+Tab inside the open mobile drawer", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    container.querySelector<HTMLButtonElement>("button[aria-label='打开导航']")?.click();
    const drawer = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(".drawer [role='dialog']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    const focusable = Array.from(
      drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Initial focus lands inside the dialog.
    expect(drawer.contains(document.activeElement)).toBe(true);

    // Tab on the last element wraps forward to the first.
    last.focus();
    drawer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(first);

    // Shift+Tab on the first element wraps backward to the last.
    drawer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(last);

    // Focus outside the panel (e.g. the backdrop) is pulled back inside.
    const backdrop = container.querySelector<HTMLElement>(".drawer-backdrop");
    expect(backdrop).not.toBeNull();
    backdrop?.focus();
    drawer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(first);
    backdrop?.focus();
    drawer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(last);
  });

  it("locks body scroll while the drawer is open and restores it on close", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    expect(document.body.style.overflow).toBe("");

    container.querySelector<HTMLButtonElement>("button[aria-label='打开导航']")?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".drawer [role='dialog']")).not.toBeNull();
    });
    expect(document.body.style.overflow).toBe("hidden");

    container
      .querySelector<HTMLElement>(".drawer [role='dialog']")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    await vi.waitFor(() => {
      expect(container.querySelector(".drawer")).toBeNull();
    });
    expect(document.body.style.overflow).toBe("");
  });

  it("sign-out remains available in the sidebar", async () => {
    const onSignOut = vi.fn();
    installRouter({ list: () => page([], null) });
    instance = mount(AppShell, {
      target: container,
      props: { csrfToken: "csrf-shell", isSigningOut: false, onSignOut }
    }) as Mounted;

    await vi.waitFor(() => {
      expect(byText(container, ".sign-out", "退出登录")).toBeDefined();
    });
    byText(container, ".sign-out", "退出登录")?.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("AppShell model flows", () => {
  let container: HTMLElement;
  let instance: Mounted | undefined;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = undefined;
    }
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function mountShell() {
    instance = mount(AppShell, {
      target: container,
      props: {
        csrfToken: "csrf-shell",
        isSigningOut: false,
        onSignOut: vi.fn()
      }
    }) as Mounted;
  }

  it("fetches the model catalog independently and offers an accessible selector on the draft screen", async () => {
    const { requests } = installRouter({ list: () => page([], null) });
    mountShell();

    const select = await vi.waitFor(() => {
      const found = container.querySelector<HTMLSelectElement>("#draft-model-select");
      expect(found).not.toBeNull();
      return found as HTMLSelectElement;
    });

    expect(requests.some((request) => request.url === "/api/v1/models")).toBe(
      true
    );
    // The label is programmatically associated with the control.
    const label = container.querySelector("label[for='draft-model-select']");
    expect(label?.textContent).toContain("对话模型");
    // The configured default is preselected.
    expect(select.value).toBe("test-model");
    expect(
      Array.from(select.options).map((option) => option.value)
    ).toEqual(["test-model", "model-b"]);
  });

  it("preselects the remembered draft model and persists a new choice", async () => {
    window.localStorage.setItem("chat.draft-model-id", "model-b");
    installRouter({ list: () => page([], null) });
    mountShell();

    const select = await vi.waitFor(() => {
      const found = container.querySelector<HTMLSelectElement>("#draft-model-select");
      expect(found).not.toBeNull();
      return found as HTMLSelectElement;
    });
    expect(select.value).toBe("model-b");

    select.value = "test-model";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(window.localStorage.getItem("chat.draft-model-id")).toBe(
        "test-model"
      );
    });
  });

  it("shows a blocking configuration state when the configured default is missing", async () => {
    installRouter({
      list: () => page([], null),
      models: () =>
        jsonResponse(422, {
          error: {
            code: "model_default_missing",
            message: "The configured default model is not available from the provider.",
            request_id: "r-cfg"
          }
        })
    });
    mountShell();

    await vi.waitFor(() => {
      expect(container.querySelector("[role='alert']")).not.toBeNull();
    });
    expect(
      byText(container, ".error-text", "模型配置不可用")
    ).toBeDefined();
    // Blocking state: no selector is offered and no model is invented.
    expect(container.querySelector("#draft-model-select")).toBeNull();
  });

  it("labels a malformed catalog as a recoverable error with retry", async () => {
    installRouter({
      list: () => page([], null),
      models: queue(
        jsonResponse(200, { models: "not-an-array" }),
        jsonResponse(200, catalog())
      )
    });
    mountShell();

    await vi.waitFor(() => {
      expect(
        byText(container, ".error-text", "模型列表加载失败")
      ).toBeDefined();
    });
    expect(container.querySelector("#draft-model-select")).toBeNull();

    byText(container, ".retry", "重试")?.click();

    await vi.waitFor(() => {
      expect(
        container.querySelector("#draft-model-select")
      ).not.toBeNull();
    });
  });

  it("keeps model-catalog failures distinct from conversation failures", async () => {
    installRouter({
      list: () => page([summary(ID_A)], null),
      models: () =>
        jsonResponse(503, {
          error: {
            code: "model_provider_unavailable",
            message: "The model provider is temporarily unavailable.",
            request_id: "r-m1"
          }
        })
    });
    mountShell();

    // The conversation list is unaffected by the catalog failure.
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    await vi.waitFor(() => {
      expect(
        byText(container, ".error-text", "模型列表加载失败")
      ).toBeDefined();
    });
    expect(
      byText(container, ".error-text", "temporarily unavailable")
    ).toBeDefined();
    // No conversation-level error is shown.
    expect(container.querySelector(".list-error")).toBeNull();
  });

  it("labels a stale catalog and recovers through the explicit refresh action", async () => {
    const { requests } = installRouter({
      list: () => page([], null),
      models: () =>
        jsonResponse(
          200,
          catalog({
            stale: true,
            refresh_error: {
              code: "model_provider_timeout",
              message: "Model discovery timed out.",
              request_id: "r-stale"
            }
          })
        ),
      refresh: () => jsonResponse(200, catalog({ refreshed_at: 1786000009000 }))
    });
    mountShell();

    await vi.waitFor(() => {
      expect(byText(container, ".stale-banner", "可能不是最新")).toBeDefined();
    });
    // The stale catalog still offers its models; nothing is blocked.
    expect(container.querySelector("#draft-model-select")).not.toBeNull();

    byText(container, ".refresh-button", "刷新模型列表")?.click();

    await vi.waitFor(() => {
      expect(byText(container, ".panel-note", "模型列表已更新")).toBeDefined();
    });
    const refresh = requests.find(
      (request) => request.url === "/api/v1/models/refresh"
    );
    expect(refresh?.init?.method).toBe("POST");
    expect(
      (refresh?.init?.headers as Record<string, string>)["X-CSRF-Token"]
    ).toBe("csrf-shell");
    expect(byText(container, ".stale-banner", "可能不是最新")).toBeUndefined();
  });

  it("keeps the stale catalog labelled when the explicit refresh fails", async () => {
    installRouter({
      list: () => page([], null),
      models: () => jsonResponse(200, catalog()),
      refresh: () => Promise.reject(new TypeError("network down"))
    });
    mountShell();

    await vi.waitFor(() => {
      expect(container.querySelector("#draft-model-select")).not.toBeNull();
    });

    byText(container, ".refresh-button", "刷新模型列表")?.click();

    await vi.waitFor(() => {
      expect(byText(container, ".stale-banner", "上次刷新失败")).toBeDefined();
    });
    // The previously loaded catalog remains usable.
    expect(container.querySelector("#draft-model-select")).not.toBeNull();
  });

  it("never shows the editable selector on an existing conversation", async () => {
    installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id))
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    byText(container, ".item", `对话 ${ID_A}`)?.click();

    await vi.waitFor(() => {
      expect(container.querySelector(".messages")).not.toBeNull();
    });
    // Locked label only; the draft selector and refresh action are absent.
    expect(byText(container, ".locked-model", "test-model")).toBeDefined();
    expect(container.querySelector("#draft-model-select")).toBeNull();
    expect(container.querySelector(".refresh-button")).toBeNull();
  });

  it("explains a removed locked model without hiding history", async () => {
    installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id, "普通消息", { model: "removed-model" })),
      models: () => jsonResponse(200, catalog())
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    byText(container, ".item", `对话 ${ID_A}`)?.click();

    await vi.waitFor(() => {
      expect(
        byText(container, ".model-unavailable", "已从提供商目录中移除")
      ).toBeDefined();
    });
    // The locked label is retained and history stays readable.
    expect(byText(container, ".locked-model", "removed-model")).toBeDefined();
    expect(container.querySelector(".messages")).not.toBeNull();
    expect(container.querySelector("#draft-model-select")).toBeNull();
  });

  it("does not claim a locked model is unavailable while the catalog is still loading", async () => {
    let resolveModels: (response: Response) => void = () => undefined;
    installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id)),
      models: () =>
        new Promise<Response>((resolve) => {
          resolveModels = resolve;
        })
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    byText(container, ".item", `对话 ${ID_A}`)?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".messages")).not.toBeNull();
    });

    // Catalog unresolved: no unavailable claim, no selector either.
    expect(container.querySelector(".model-unavailable")).toBeNull();
    expect(container.querySelector("#draft-model-select")).toBeNull();

    resolveModels(jsonResponse(200, catalog()));
    await vi.waitFor(() => {
      expect(container.querySelector(".model-unavailable")).toBeNull();
    });
    expect(byText(container, ".locked-model", "test-model")).toBeDefined();
  });
});
