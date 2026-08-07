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
  renameConversation
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
  /** Throws `ApiError` on failure; reconciles list + current on success. */
  remove(id: string, csrfToken: string): Promise<void>;
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

    async remove(id: string, csrfToken: string): Promise<void> {
      await deleteConversation(id, csrfToken);
      items = items.filter((item) => item.id !== id);
      if (selectedId === id) {
        clearSelection();
      }
    }
  };
}
