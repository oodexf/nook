// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onSessionExpired } from "../api/client";
import AppShell from "./AppShell.svelte";
import { GREETING_POOLS } from "./greetings";

const ALL_GREETINGS: readonly string[] = Object.values(GREETING_POOLS).flat();

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

// The empty-draft hero is a random time-of-day greeting (08-10), so tests
// assert membership in the pool rather than one fixed string.
function greetingIn(container: HTMLElement): HTMLElement | undefined {
  const element = container.querySelector<HTMLElement>(".greeting");
  if (element && ALL_GREETINGS.includes(element.textContent ?? "")) {
    return element;
  }
  return undefined;
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
  /** POST /api/v1/conversations/new/messages (draft first send). */
  draftSend?: RouteHandler;
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
    if (url === "/api/v1/conversations/new/messages" && method === "POST") {
      return Promise.resolve(
        routes.draftSend?.() ?? jsonResponse(404, notFound())
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

  /**
   * The rename editor opens through the row action menu (08-08 sidebar
   * redesign): click the row's "···" trigger, then pick 重命名.
   */
  async function openSidebarRenameEditor(id: string = ID_A) {
    container
      .querySelector<HTMLButtonElement>(
        `.sidebar-static [data-row-menu-trigger="${id}"]`
      )
      ?.click();
    const menu = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        ".sidebar-static [role='menu']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    byText(menu, ".menu-item", "重命名")?.click();
  }

  it("shows a loading state, then renders the conversation list", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();

    expect(byText(container, "[role='status']", "正在加载对话")).toBeDefined();

    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    expect(greetingIn(container)).toBeDefined();
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
      expect(greetingIn(container)).toBeDefined();
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

  it("locks the document to the dynamic viewport while mounted and releases it on unmount", async () => {
    installRouter({ list: () => page([], null) });
    expect(document.body.classList.contains("app-shell-lock")).toBe(false);

    mountShell();
    await vi.waitFor(() => {
      expect(document.body.classList.contains("app-shell-lock")).toBe(true);
    });

    const mounted = instance;
    expect(mounted).toBeDefined();
    await unmount(mounted as Mounted);
    instance = undefined;
    expect(document.body.classList.contains("app-shell-lock")).toBe(false);
  });

  it("keeps the viewport lock while the drawer scroll lock comes and goes", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    container.querySelector<HTMLButtonElement>("button[aria-label='打开导航']")?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".drawer [role='dialog']")).not.toBeNull();
    });
    // The drawer's temporary inline lock layers on top of the shell's
    // persistent class lock without disturbing it.
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.classList.contains("app-shell-lock")).toBe(true);

    container
      .querySelector<HTMLElement>(".drawer [role='dialog']")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    await vi.waitFor(() => {
      expect(container.querySelector(".drawer")).toBeNull();
    });
    expect(document.body.style.overflow).toBe("");
    expect(document.body.classList.contains("app-shell-lock")).toBe(true);
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

  it("collapses and restores the desktop sidebar with focus management", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    expect(container.querySelector(".shell.sidebar-collapsed")).toBeNull();
    const collapse = container.querySelector<HTMLButtonElement>(
      ".sidebar-static button[aria-label='收起侧边栏']"
    );
    expect(collapse).not.toBeNull();
    collapse?.click();

    await vi.waitFor(() => {
      expect(container.querySelector(".shell.sidebar-collapsed")).not.toBeNull();
    });
    // Focus moves to the always-reachable restore control in the header.
    const restore = container.querySelector<HTMLButtonElement>(
      "button[aria-label='展开侧边栏']"
    );
    expect(restore).not.toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(restore);
    });

    restore?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".shell.sidebar-collapsed")).toBeNull();
    });
    expect(
      container.querySelector("button[aria-label='展开侧边栏']")
    ).toBeNull();
    // Focus returns to the collapse trigger inside the restored sidebar.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector(
          ".sidebar-static button[aria-label='收起侧边栏']"
        )
      );
    });
  });

  it("keeps the mobile drawer independent from the desktop collapsed state", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    container
      .querySelector<HTMLButtonElement>(
        ".sidebar-static button[aria-label='收起侧边栏']"
      )
      ?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".shell.sidebar-collapsed")).not.toBeNull();
    });

    // The modal drawer still opens with its dialog semantics, close
    // control, and body-scroll lock.
    container
      .querySelector<HTMLButtonElement>("button[aria-label='打开导航']")
      ?.click();
    const drawer = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        ".drawer [role='dialog']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    // The drawer sidebar has no collapse control; mobile owns close.
    expect(
      drawer.querySelector("button[aria-label='收起侧边栏']")
    ).toBeNull();
    expect(
      drawer.querySelector("button[aria-label='关闭导航']")
    ).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    drawer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => {
      expect(container.querySelector(".drawer")).toBeNull();
    });
    expect(document.body.style.overflow).toBe("");
    // The desktop collapsed state survives the drawer cycle untouched.
    expect(container.querySelector(".shell.sidebar-collapsed")).not.toBeNull();
  });

  it("treats the sidebar item row as one card with two independent controls", async () => {
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

    // The active card chrome lives on the row container; the title
    // button and the row actions are transparent siblings inside it,
    // never nested interactive elements.
    const row = container.querySelector<HTMLElement>(
      ".sidebar-static .item-row.item-row-active"
    );
    expect(row).not.toBeNull();
    const item = row?.querySelector<HTMLButtonElement>(":scope > button.item");
    expect(item?.getAttribute("aria-current")).toBe("true");
    expect(item?.classList.contains("item-active")).toBe(false);
    // Pin placeholder toggle and the menu trigger (which owns rename via
    // its menu) are the row's independent action controls.
    const pinTrigger = row?.querySelector<HTMLButtonElement>(
      `:scope > button[aria-label='置顶 对话 ${ID_A}']`
    );
    expect(pinTrigger?.getAttribute("aria-pressed")).toBe("false");
    expect(pinTrigger?.querySelector("svg")).not.toBeNull();
    const menuTrigger = row?.querySelector<HTMLButtonElement>(
      `:scope > button[data-row-menu-trigger='${ID_A}']`
    );
    expect(menuTrigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(menuTrigger?.getAttribute("aria-expanded")).toBe("false");
  });

  it("renames from the sidebar and reconciles list and open header", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id)),
      patch: (id) =>
        jsonResponse(
          200,
          summary(id, { title: "侧栏新标题", updated_at: 1786000002000 })
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

    const trigger = container.querySelector<HTMLButtonElement>(
      `.sidebar-static [data-row-menu-trigger="${ID_A}"]`
    );
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    trigger?.click();
    await vi.waitFor(() => {
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    });
    byText(container, ".menu-item", "重命名")?.click();

    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>(
        ".sidebar-static #sidebar-rename-input"
      );
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    expect(input.value).toBe(`对话 ${ID_A}`);

    input.value = "侧栏新标题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".sidebar-static .edit-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // The server response reconciles both the sidebar list and the open
    // header (server-authoritative rename).
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", "侧栏新标题")).toBeDefined();
    });
    expect(byText(container, "h1.title", "侧栏新标题")).toBeDefined();
    const request = requests.find((entry) => entry.init?.method === "PATCH");
    expect(
      (request?.init?.headers as Record<string, string>)["X-CSRF-Token"]
    ).toBe("csrf-shell");
    expect(request?.init?.body).toBe(JSON.stringify({ title: "侧栏新标题" }));
    // Editor closed and focus restored to the item's rename trigger.
    expect(
      container.querySelector(".sidebar-static #sidebar-rename-input")
    ).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector(`.sidebar-static [data-row-menu-trigger="${ID_A}"]`)
      );
    });
  });

  it("keeps the old title and shows inline feedback when the sidebar rename fails", async () => {
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

    await openSidebarRenameEditor();
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>(
        ".sidebar-static #sidebar-rename-input"
      );
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.value = "另一个标题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".sidebar-static .edit-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(
        byText(container, ".edit-error", "存储暂时不可用")
      ).toBeDefined();
    });
    expect(
      container.querySelector(".edit-error")?.getAttribute("role")
    ).toBe("alert");
    // The failed save is never silently discarded: the editor stays open
    // with the draft, and the list never shows the unsaved title.
    expect(
      container.querySelector(".sidebar-static #sidebar-rename-input")
    ).not.toBeNull();
    expect(input.value).toBe("另一个标题");
    expect(byText(container, ".item-title", "另一个标题")).toBeUndefined();
    // The busy state clears before focus returns: the re-enabled editor
    // regains focus instead of the focus call landing on a disabled input.
    expect(input.disabled).toBe(false);
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    // Escape still cancels afterwards and restores the old title.
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static #sidebar-rename-input")
      ).toBeNull();
    });
    expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
  });

  it("cancels the sidebar rename with Escape without sending a request", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id))
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    await openSidebarRenameEditor();
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>(
        ".sidebar-static #sidebar-rename-input"
      );
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.value = "未提交的标题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static #sidebar-rename-input")
      ).toBeNull();
    });
    expect(requests.some((entry) => entry.init?.method === "PATCH")).toBe(false);
    expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    // Focus returns to the item's rename trigger.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector(`.sidebar-static [data-row-menu-trigger="${ID_A}"]`)
      );
    });
  });

  it("commits a changed sidebar title on safe blur and closes silently when unchanged", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id)),
      patch: (id) =>
        jsonResponse(
          200,
          summary(id, { title: "模糊提交", updated_at: 1786000002000 })
        )
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    // Unchanged blur: closes without a request.
    await openSidebarRenameEditor();
    let input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>(
        ".sidebar-static #sidebar-rename-input"
      );
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static #sidebar-rename-input")
      ).toBeNull();
    });
    expect(requests.some((entry) => entry.init?.method === "PATCH")).toBe(false);

    // Changed blur: commits through the same server-authoritative path.
    await openSidebarRenameEditor();
    input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>(
        ".sidebar-static #sidebar-rename-input"
      );
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.value = "模糊提交";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // The user moved focus elsewhere (tab/click away) before the blur.
    const elsewhere = container.querySelector<HTMLButtonElement>(
      ".sidebar-static .nav-entry"
    );
    expect(elsewhere).not.toBeNull();
    elsewhere?.focus();
    expect(document.activeElement).toBe(elsewhere);
    input.dispatchEvent(new FocusEvent("blur"));

    await vi.waitFor(() => {
      expect(byText(container, ".item-title", "模糊提交")).toBeDefined();
    });
    const request = requests.find((entry) => entry.init?.method === "PATCH");
    expect(request?.init?.body).toBe(JSON.stringify({ title: "模糊提交" }));
    // Blur-save never pulls focus backward to the rename trigger; it stays
    // where the user put it.
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(
      container.querySelector(`.sidebar-static [data-row-menu-trigger="${ID_A}"]`)
    );
  });

  it("rejects an empty sidebar title inline without a request", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id))
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    await openSidebarRenameEditor();
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>(
        ".sidebar-static #sidebar-rename-input"
      );
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });
    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".sidebar-static .edit-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(byText(container, ".edit-error", "标题不能为空")).toBeDefined();
    });
    expect(requests.some((entry) => entry.init?.method === "PATCH")).toBe(false);
    // The editor stays open and no title was replaced.
    expect(
      container.querySelector(".sidebar-static #sidebar-rename-input")
    ).not.toBeNull();
  });

  it("closes the open mobile drawer when crossing into the desktop breakpoint", async () => {
    let desktopMatches = false;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      get matches() {
        return desktopMatches;
      },
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void
      ) => listeners.add(listener),
      removeEventListener: (
        _type: string,
        listener: (event: { matches: boolean }) => void
      ) => listeners.delete(listener),
      dispatchEvent: () => false
    }));
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    // Collapse the desktop sidebar first: the breakpoint hand-off must
    // leave the independent collapse state untouched.
    container
      .querySelector<HTMLButtonElement>(
        ".sidebar-static button[aria-label='收起侧边栏']"
      )
      ?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".shell.sidebar-collapsed")).not.toBeNull();
    });

    container
      .querySelector<HTMLButtonElement>("button[aria-label='打开导航']")
      ?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".drawer [role='dialog']")).not.toBeNull();
    });
    expect(document.body.style.overflow).toBe("hidden");

    // The viewport crosses into the desktop breakpoint.
    desktopMatches = true;
    for (const listener of listeners) listener({ matches: true });

    await vi.waitFor(() => {
      expect(container.querySelector(".drawer")).toBeNull();
    });
    // The scroll lock is released and focus does not land on the menu
    // button, which is hidden at the desktop breakpoint.
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).not.toBe(
      container.querySelector("button[aria-label='打开导航']")
    );
    expect(container.querySelector(".shell.sidebar-collapsed")).not.toBeNull();

    // Crossing back to mobile does not resurrect the drawer.
    desktopMatches = false;
    for (const listener of listeners) listener({ matches: false });
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

    // The sign-out control is a compact icon button (08-08 UI polish):
    // identified by its accessible name rather than visible text.
    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>(
          "button.sign-out[aria-label='退出登录']"
        )
      ).not.toBeNull();
    });
    container
      .querySelector<HTMLButtonElement>("button.sign-out[aria-label='退出登录']")
      ?.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("opens settings left of the collapse control and applies the theme", async () => {
    installRouter({ list: () => page([], null) });
    mountShell();

    await vi.waitFor(() => {
      expect(
        container.querySelector("button[aria-label='收起侧边栏']")
      ).not.toBeNull();
    });
    const settings = container.querySelector<HTMLButtonElement>(
      "button[aria-label='设置']"
    );
    const collapse = container.querySelector<HTMLButtonElement>(
      "button[aria-label='收起侧边栏']"
    );
    expect(settings).not.toBeNull();
    // Settings sits to the left of the collapse control.
    expect(
      settings!.compareDocumentPosition(collapse!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);

    settings!.click();
    await vi.waitFor(() => {
      expect(container.querySelector("[role='dialog']")).not.toBeNull();
    });

    const dark = container.querySelector<HTMLInputElement>(
      "input[value='dark']"
    );
    expect(dark).not.toBeNull();
    dark!.click();

    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
    });
    expect(window.localStorage.getItem("chat.theme-preference")).toBe("dark");

    // Tidy up the applied attribute for later tests in this file.
    delete document.documentElement.dataset.theme;
  });

  it("renders the sidebar nav entries with search and projects as placeholders", async () => {
    installRouter({ list: () => page([], null) });
    mountShell();

    const search = container.querySelector<HTMLButtonElement>(
      ".sidebar-static button[aria-label='搜索(即将上线)']"
    );
    expect(search).not.toBeNull();
    expect(search?.disabled).toBe(true);

    const newChat = byText(container, ".nav-entry", "新建对话");
    expect(newChat).not.toBeNull();
    expect(newChat?.querySelector("svg")).not.toBeNull();

    const projects = byText(container, ".nav-entry", "项目") as
      | HTMLButtonElement
      | undefined;
    expect(projects).not.toBeNull();
    expect(projects?.disabled).toBe(true);

    // The enabled entry keeps the new-conversation behavior.
    newChat?.click();
    await vi.waitFor(() => {
      expect(greetingIn(container)).toBeDefined();
    });
  });

  it("starts a fresh conversation after the first draft send fails", async () => {
    installRouter({
      list: () => page([], null),
      draftSend: () =>
        jsonResponse(409, {
          error: {
            code: "model_unavailable",
            message: "The selected model is no longer available.",
            request_id: "r-409"
          }
        })
    });
    mountShell();

    // The empty-draft screen with a usable composer. The h2 renders as
    // soon as the shell mounts, but the send button only enables after the
    // model catalog finishes loading AND the input is non-empty; type
    // first, then gate the click on the enabled button.
    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLTextAreaElement>("#composer-input")
      ).not.toBeNull();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#composer-input"
    );
    textarea!.value = "第一条消息";
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    // Svelte flushes DOM updates asynchronously; flush so the send button
    // is enabled before the click.
    flushSync();
    await vi.waitFor(() => {
      const sendButton = container.querySelector<HTMLButtonElement>(
        "button[aria-label='发送消息']"
      );
      expect(sendButton?.disabled).toBe(false);
    });
    container
      .querySelector<HTMLButtonElement>("button[aria-label='发送消息']")
      ?.click();

    // Pre-meta failure: the failed turn overlay owns the draft view.
    await vi.waitFor(() => {
      expect(
        container.querySelector(".turn[data-phase='failed']")
      ).not.toBeNull();
    });
    expect(greetingIn(container)).toBeUndefined();

    // Clicking 新建对话 must release the stale stream and render the
    // draft screen again (regression: the failed draft stream kept
    // `isActiveFor(null)` true and blocked the new-conversation action).
    // The failed text is intentionally restored so the user can retry it.
    byText(container, ".nav-entry", "新建对话")?.click();

    await vi.waitFor(() => {
      expect(greetingIn(container)).toBeDefined();
    });
    expect(container.querySelector(".turn[data-phase='failed']")).toBeNull();
    const freshTextarea = container.querySelector<HTMLTextAreaElement>(
      "#composer-input"
    );
    expect(freshTextarea?.value).toBe("第一条消息");
    const sendButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='发送消息']"
    );
    expect(sendButton?.disabled).toBe(false);
  });

  it("pins a conversation into the pinned section as a local placeholder", async () => {
    installRouter({
      list: () => page([summary(ID_A), summary(ID_B)], null)
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });
    // Everything starts under Recents; the pinned section stays hidden.
    expect(byText(container, ".section-label", "最近")).toBeDefined();
    expect(byText(container, ".section-label", "置顶")).toBeUndefined();

    container
      .querySelector<HTMLButtonElement>(
        `.sidebar-static button[aria-label='置顶 对话 ${ID_B}']`
      )
      ?.click();

    // The pinned row moves into the pinned section with the pressed state.
    const pinnedToggle = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        `.sidebar-static button[aria-label='取消置顶 对话 ${ID_B}']`
      );
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    expect(pinnedToggle.getAttribute("aria-pressed")).toBe("true");
    expect(byText(container, ".section-label", "置顶")).toBeDefined();
    const pinnedRow = byText(
      container,
      ".item-title",
      `对话 ${ID_B}`
    )?.closest(".item-row");
    const pinnedLabel = byText(container, ".section-label", "置顶");
    expect(pinnedRow).not.toBeNull();
    expect(pinnedLabel).not.toBeNull();
    expect(
      (pinnedRow as HTMLElement).compareDocumentPosition(
        pinnedLabel as HTMLElement
      ) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();

    // Unpinning returns the row to Recents and hides the section again.
    pinnedToggle.click();
    await vi.waitFor(() => {
      expect(byText(container, ".section-label", "置顶")).toBeUndefined();
    });
    expect(
      container.querySelector(
        `.sidebar-static button[aria-label='置顶 对话 ${ID_B}']`
      )
    ).not.toBeNull();
  });

  it("opens the row menu with placeholder actions and closes it on Escape", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      `.sidebar-static [data-row-menu-trigger="${ID_A}"]`
    );
    trigger?.click();
    const menu = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        ".sidebar-static [role='menu']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    // Full placeholder set, mirroring the reference menu.
    for (const label of [
      "分享",
      "重命名",
      "置顶对话",
      "归档",
      "删除",
      "移动到项目"
    ]) {
      expect(byText(menu, ".menu-item", label)).toBeDefined();
    }

    menu.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      })
    );
    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static [role='menu']")
      ).toBeNull();
    });
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });

  it("pins from the row menu and closes it on outside click", async () => {
    installRouter({ list: () => page([summary(ID_A)], null) });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    container
      .querySelector<HTMLButtonElement>(
        `.sidebar-static [data-row-menu-trigger="${ID_A}"]`
      )
      ?.click();
    const menu = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        ".sidebar-static [role='menu']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    byText(menu, ".menu-item", "置顶对话")?.click();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static [role='menu']")
      ).toBeNull();
    });
    expect(byText(container, ".section-label", "置顶")).toBeDefined();

    // Reopen, then an outside click closes the menu without changes.
    container
      .querySelector<HTMLButtonElement>(
        `.sidebar-static [data-row-menu-trigger="${ID_A}"]`
      )
      ?.click();
    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static [role='menu']")
      ).not.toBeNull();
    });
    // Outside click (a real pointer press carries coordinates; the
    // touch-synthetic (0,0) twin is ignored by the sidebar).
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 })
    );
    await vi.waitFor(() => {
      expect(
        container.querySelector(".sidebar-static [role='menu']")
      ).toBeNull();
    });
    expect(byText(container, ".section-label", "置顶")).toBeDefined();
  });

  it("deletes a conversation from the row menu through the confirm dialog", async () => {
    const { requests } = installRouter({
      list: () => page([summary(ID_A)], null),
      detail: (id) => jsonResponse(200, detail(id))
    });
    mountShell();
    await vi.waitFor(() => {
      expect(byText(container, ".item-title", `对话 ${ID_A}`)).toBeDefined();
    });

    container
      .querySelector<HTMLButtonElement>(
        `.sidebar-static [data-row-menu-trigger="${ID_A}"]`
      )
      ?.click();
    const menu = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        ".sidebar-static [role='menu']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    byText(menu, ".menu-item", "删除")?.click();

    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[role='dialog'], [role='alertdialog']"
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(dialog.textContent).toContain("删除对话");
    byText(dialog, "button", "删除")?.click();

    await vi.waitFor(() => {
      expect(
        byText(container, ".item-title", `对话 ${ID_A}`)
      ).toBeUndefined();
    });
    const request = requests.find((entry) => entry.init?.method === "DELETE");
    expect(
      (request?.init?.headers as Record<string, string>)["X-CSRF-Token"]
    ).toBe("csrf-shell");
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

    // The composer trigger shows the configured default once the catalog
    // finishes loading.
    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found?.textContent).toContain("test-model");
      return found as HTMLButtonElement;
    });

    expect(requests.some((request) => request.url === "/api/v1/models")).toBe(
      true
    );
    // The trigger is accessibly named with the current selection.
    expect(trigger.getAttribute("aria-label")).toContain("选择模型");
    expect(trigger.getAttribute("aria-label")).toContain("test-model");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Opening the popover lists every catalog model with the default marked.
    trigger.click();
    const popover = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(".model-popover");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const options = Array.from(
      popover.querySelectorAll<HTMLButtonElement>(".model-option")
    );
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "test-model",
      "model-b"
    ]);
    expect(
      options[0].classList.contains("selected")
    ).toBe(true);
  });

  it("closes the model popover with Escape and restores trigger focus", async () => {
    installRouter({ list: () => page([], null) });
    mountShell();

    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found?.textContent).toContain("test-model");
      return found as HTMLButtonElement;
    });
    trigger.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".model-popover")).not.toBeNull();
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    await vi.waitFor(() => {
      expect(container.querySelector(".model-popover")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the model popover on an outside pointer press", async () => {
    installRouter({ list: () => page([], null) });
    mountShell();

    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found?.textContent).toContain("test-model");
      return found as HTMLButtonElement;
    });
    trigger.click();
    await vi.waitFor(() => {
      expect(container.querySelector(".model-popover")).not.toBeNull();
    });

    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true })
    );

    await vi.waitFor(() => {
      expect(container.querySelector(".model-popover")).toBeNull();
    });
  });

  it("preselects the remembered draft model and persists a new choice", async () => {
    window.localStorage.setItem("chat.draft-model-id", "model-b");
    installRouter({ list: () => page([], null) });
    mountShell();

    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found?.textContent).toContain("model-b");
      return found as HTMLButtonElement;
    });

    trigger.click();
    const option = await vi.waitFor(() => {
      const found = byText(container, ".model-option", "test-model");
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    option.click();

    await vi.waitFor(() => {
      expect(window.localStorage.getItem("chat.draft-model-id")).toBe(
        "test-model"
      );
    });
    // A successful pick applies to the trigger and closes the popover.
    expect(trigger.textContent).toContain("test-model");
    expect(container.querySelector(".model-popover")).toBeNull();
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

    // The composer trigger is still offered so its popover can surface the
    // blocking state and the retry entry.
    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    trigger.click();

    await vi.waitFor(() => {
      expect(
        byText(container, ".error-text", "模型配置不可用")
      ).toBeDefined();
    });
    // Blocking state: no model option is offered and none is invented.
    expect(container.querySelector(".model-option")).toBeNull();
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

    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    trigger.click();

    await vi.waitFor(() => {
      expect(
        byText(container, ".error-text", "模型列表加载失败")
      ).toBeDefined();
    });
    expect(container.querySelector(".model-option")).toBeNull();

    byText(container, ".retry", "重试")?.click();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".model-option")
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
    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    trigger.click();
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

    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    trigger.click();

    await vi.waitFor(() => {
      expect(byText(container, ".stale-banner", "可能不是最新")).toBeDefined();
    });
    // The stale catalog still offers its models; nothing is blocked.
    expect(container.querySelector(".model-option")).not.toBeNull();

    byText(container, ".refresh-button", "刷新模型列表")?.click();

    await vi.waitFor(() => {
      expect(byText(container, ".popover-note", "模型列表已更新")).toBeDefined();
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

    const trigger = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(".model-trigger");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    trigger.click();

    await vi.waitFor(() => {
      expect(container.querySelector(".model-option")).not.toBeNull();
    });

    byText(container, ".refresh-button", "刷新模型列表")?.click();

    await vi.waitFor(() => {
      expect(byText(container, ".stale-banner", "上次刷新失败")).toBeDefined();
    });
    // The previously loaded catalog remains usable.
    expect(container.querySelector(".model-option")).not.toBeNull();
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
    // Locked label only; the composer selector and refresh action are absent.
    expect(byText(container, ".locked-model", "test-model")).toBeDefined();
    expect(container.querySelector(".model-trigger")).toBeNull();
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
    expect(container.querySelector(".model-trigger")).toBeNull();
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
    expect(container.querySelector(".model-trigger")).toBeNull();

    resolveModels(jsonResponse(200, catalog()));
    await vi.waitFor(() => {
      expect(container.querySelector(".model-unavailable")).toBeNull();
    });
    expect(byText(container, ".locked-model", "test-model")).toBeDefined();
  });
});
