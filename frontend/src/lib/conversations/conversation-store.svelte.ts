/**
 * Conversation feature store (spec: state-management.md).
 *
 * Owns the sidebar pages, the currently open conversation with its persisted
 * messages, and rename/delete reconciliation. The server is the authority:
 * list items and the open conversation are only ever replaced by decoded
 * server responses, never patched with local guesses.
 *
 * Only the selected conversation ID is persisted (localStorage allow-list);
 * no conversation bodies, tokens, or CSRF values are stored.
 */

import {
  errorMessageOf,
  isAbortError,
  ApiError
} from "../api/client";
import {
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  updateConversationModel
} from "../api/conversations";
import type {
  ConversationDetail,
  ConversationSummary
} from "../api/conversations";

export type ConversationListStatus = "idle" | "loading" | "ready" | "error";
export type ConversationDetailStatus = "idle" | "loading" | "ready" | "error";

export type ConversationStore = {
  readonly items: ConversationSummary[];
  readonly listStatus: ConversationListStatus;
  readonly listError: string | null;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMoreError: string | null;
  readonly selectedId: string | null;
  readonly detailStatus: ConversationDetailStatus;
  readonly detailError: string | null;
  readonly current: ConversationDetail | null;
  /** True while this conversation has a server-authoritative model mutation pending. */
  isUpdatingModel(id: string | null): boolean;
  /** Loads the first page; reopens the remembered selection when possible. */
  load(): Promise<void>;
  /** Deterministic next-page fetch; the cursor only advances on success. */
  loadMore(): Promise<void>;
  /**
   * Best-effort first-page refetch used after generation events create or
   * reorder conversations. Keeps the current status (no loading flicker);
   * failures are silent because the list on screen stays usable and the
   * next explicit load retries. The server page replaces local items
   * wholesale (server authority; pagination restarts from page one).
   */
  refreshList(): Promise<void>;
  open(id: string): Promise<void>;
  /**
   * Silent detail refetch after server-side changes (e.g. a generation
   * settled). Unlike `open`, it never switches the visible status, so the
   * on-screen messages do not flicker; failures keep the current detail.
   */
  reloadCurrent(id: string): Promise<void>;
  /** Returns to the empty/new-conversation screen. */
  openNew(): void;
  /** Throws `ApiError` on failure; reconciles list + current on success. */
  rename(
    id: string,
    title: string,
    csrfToken: string
  ): Promise<ConversationSummary>;
  /** Throws `ApiError` on failure; persists and reconciles current model. */
  updateModel(
    id: string,
    model: string,
    csrfToken: string
  ): Promise<ConversationSummary>;
  /** Throws `ApiError` on failure; reconciles list + current on success. */
  remove(id: string, csrfToken: string): Promise<void>;
  /**
   * Pin placeholder (08-08 sidebar redesign): flips `pinned` locally so
   * the sidebar can preview the pinned section. Not persisted — any
   * server-sourced list replacement (load, loadMore, refreshList) resets
   * it, until a backend pin contract lands.
   */
  togglePinPlaceholder(id: string): void;
};

const SELECTED_ID_STORAGE_KEY = "chat.selected-conversation-id";
const MAX_STORED_ID_LENGTH = 64;

function readStoredSelectedId(): string | null {
  try {
    const raw = window.localStorage.getItem(SELECTED_ID_STORAGE_KEY);
    if (typeof raw === "string" && raw.length > 0 && raw.length <= MAX_STORED_ID_LENGTH) {
      return raw;
    }
  } catch {
    // Storage unavailable (private mode, disabled cookies): session-only UI.
  }
  return null;
}

function writeStoredSelectedId(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(SELECTED_ID_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SELECTED_ID_STORAGE_KEY, id);
    }
  } catch {
    // Best-effort persistence only; the server remains the authority.
  }
}

/** Matches the server ordering: `updated_at DESC, id DESC`. */
export function sortConversations(
  conversations: ConversationSummary[]
): ConversationSummary[] {
  return [...conversations].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export type ConversationSectionKey =
  | "pinned"
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "older";

export type ConversationSection = {
  /** Stable keyed-each key, decoupled from the display label. */
  key: ConversationSectionKey;
  label: string;
  items: ConversationSummary[];
};

const SECTION_LABELS: Record<ConversationSectionKey, string> = {
  pinned: "置顶",
  today: "今天",
  yesterday: "昨天",
  week: "过去 7 天",
  month: "过去 30 天",
  older: "更早"
};

/**
 * Local midnight `daysAgo` days before the local day containing `now`.
 *
 * Built by calendar arithmetic (`new Date(y, m, d - n)`) rather than by
 * subtracting `n * 86_400_000` milliseconds: a DST transition makes a local
 * day 23 or 25 hours long, and millisecond math would slide the boundary
 * into the neighbouring day.
 */
function localDayStart(now: number, daysAgo: number): number {
  const reference = new Date(now);
  return new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() - daysAgo
  ).getTime();
}

/**
 * Splits a server-ordered page into the sidebar's sections (08-15 sidebar UI
 * refresh): pinned first, then the remainder bucketed by `updatedAt` into
 * local-calendar-day ranges.
 *
 * `now` is injected rather than read from the clock inside, so the bucket
 * boundaries are deterministic under test. Order inside every section keeps
 * the incoming server ordering (`updated_at DESC`), so this never re-sorts;
 * pinning is a placeholder without persistence. Empty sections are omitted,
 * so the rendering layer never has to test for them.
 */
export function buildSidebarSections(
  conversations: ConversationSummary[],
  now: number
): ConversationSection[] {
  const todayStart = localDayStart(now, 0);
  const yesterdayStart = localDayStart(now, 1);
  const weekStart = localDayStart(now, 6);
  const monthStart = localDayStart(now, 29);

  const buckets: Record<ConversationSectionKey, ConversationSummary[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    month: [],
    older: []
  };

  for (const item of conversations) {
    if (item.pinned) {
      buckets.pinned.push(item);
      // A clock skew that puts `updatedAt` ahead of `now` lands in "today":
      // the newest bucket is open-ended upward, so no "future" section exists.
    } else if (item.updatedAt >= todayStart) {
      buckets.today.push(item);
    } else if (item.updatedAt >= yesterdayStart) {
      buckets.yesterday.push(item);
    } else if (item.updatedAt >= weekStart) {
      buckets.week.push(item);
    } else if (item.updatedAt >= monthStart) {
      buckets.month.push(item);
    } else {
      buckets.older.push(item);
    }
  }

  return (Object.keys(buckets) as ConversationSectionKey[])
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: SECTION_LABELS[key], items: buckets[key] }));
}

export function createConversationStore(): ConversationStore {
  let items = $state<ConversationSummary[]>([]);
  let nextCursor = $state<string | null>(null);
  let listStatus = $state<ConversationListStatus>("idle");
  let listError = $state<string | null>(null);
  let isLoadingMore = $state(false);
  let loadMoreError = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  let detailStatus = $state<ConversationDetailStatus>("idle");
  let detailError = $state<string | null>(null);
  let current = $state<ConversationDetail | null>(null);
  let updatingModelConversationIds = $state<string[]>([]);

  function clearSelection(): void {
    selectedId = null;
    current = null;
    detailStatus = "idle";
    detailError = null;
    writeStoredSelectedId(null);
  }

  async function open(id: string): Promise<void> {
    if (detailStatus === "loading" && selectedId === id) return;
    selectedId = id;
    writeStoredSelectedId(id);
    detailStatus = "loading";
    detailError = null;
    try {
      const detail = await getConversation(id);
      // Navigation during the request keeps ownership of the newer selection.
      if (selectedId !== id) return;
      current = detail;
      detailStatus = "ready";
    } catch (error) {
      if (selectedId !== id || isAbortError(error)) return;
      if (error instanceof ApiError && error.code === "conversation_not_found") {
        // Server authority: the conversation is gone; drop it everywhere.
        items = items.filter((item) => item.id !== id);
        clearSelection();
        return;
      }
      current = null;
      detailStatus = "error";
      detailError = errorMessageOf(error);
    }
  }

  return {
    get items() {
      return items;
    },
    get listStatus() {
      return listStatus;
    },
    get listError() {
      return listError;
    },
    get hasMore() {
      return nextCursor !== null;
    },
    get isLoadingMore() {
      return isLoadingMore;
    },
    get loadMoreError() {
      return loadMoreError;
    },
    get selectedId() {
      return selectedId;
    },
    get detailStatus() {
      return detailStatus;
    },
    get detailError() {
      return detailError;
    },
    get current() {
      return current;
    },
    isUpdatingModel(id: string | null): boolean {
      return id !== null && updatingModelConversationIds.includes(id);
    },

    async load(): Promise<void> {
      if (listStatus === "loading") return;
      listStatus = "loading";
      listError = null;
      try {
        const page = await listConversations({});
        items = page.conversations;
        nextCursor = page.nextCursor;
        listStatus = "ready";
      } catch (error) {
        if (isAbortError(error)) {
          listStatus = "idle";
          return;
        }
        listStatus = "error";
        listError = errorMessageOf(error);
        return;
      }
      const remembered = readStoredSelectedId();
      if (remembered !== null && remembered !== selectedId) {
        await open(remembered);
      }
    },

    async loadMore(): Promise<void> {
      if (isLoadingMore || nextCursor === null || listStatus !== "ready") {
        return;
      }
      isLoadingMore = true;
      loadMoreError = null;
      try {
        const page = await listConversations({ cursor: nextCursor });
        items = [
          ...items,
          ...page.conversations.filter(
            (entry) => !items.some((item) => item.id === entry.id)
          )
        ];
        nextCursor = page.nextCursor;
      } catch (error) {
        if (!isAbortError(error)) {
          // The cursor is preserved so retrying fetches the same page.
          loadMoreError = errorMessageOf(error);
        }
      } finally {
        isLoadingMore = false;
      }
    },

    async refreshList(): Promise<void> {
      if (listStatus === "loading") return;
      try {
        const page = await listConversations({});
        items = page.conversations;
        nextCursor = page.nextCursor;
        if (listStatus !== "ready") {
          listStatus = "ready";
          listError = null;
        }
      } catch {
        // Best-effort background refresh: keep the current list on screen.
      }
    },

    open,

    async reloadCurrent(id: string): Promise<void> {
      try {
        const detail = await getConversation(id);
        // Navigation during the request keeps ownership of the newer view.
        if (selectedId !== id) return;
        current = detail;
        detailStatus = "ready";
      } catch {
        // Keep the last known detail; explicit reload remains available.
      }
    },

    openNew(): void {
      clearSelection();
    },

    async rename(
      id: string,
      title: string,
      csrfToken: string
    ): Promise<ConversationSummary> {
      const updated = await renameConversation(id, title, csrfToken);
      items = sortConversations(
        items.map((item) => (item.id === id ? updated : item))
      );
      if (current !== null && current.conversation.id === id) {
        current = { ...current, conversation: updated };
      }
      return updated;
    },

    async updateModel(
      id: string,
      model: string,
      csrfToken: string
    ): Promise<ConversationSummary> {
      if (updatingModelConversationIds.includes(id)) {
        throw new ApiError("http", "模型切换正在保存，请稍候。", {
          status: 409,
          code: "model_update_in_progress"
        });
      }
      updatingModelConversationIds = [...updatingModelConversationIds, id];
      try {
        const updated = await updateConversationModel(id, model, csrfToken);
        items = sortConversations(
          items.map((item) => (item.id === id ? updated : item))
        );
        // Navigation while the mutation is in flight must not replace the
        // newly opened conversation with the old response.
        if (
          selectedId === id &&
          current !== null &&
          current.conversation.id === id
        ) {
          current = { ...current, conversation: updated };
        }
        return updated;
      } finally {
        updatingModelConversationIds = updatingModelConversationIds.filter(
          (conversationId) => conversationId !== id
        );
      }
    },

    async remove(id: string, csrfToken: string): Promise<void> {
      await deleteConversation(id, csrfToken);
      items = items.filter((item) => item.id !== id);
      if (selectedId === id) {
        clearSelection();
      }
    },

    togglePinPlaceholder(id: string): void {
      items = items.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item
      );
    }
  };
}
