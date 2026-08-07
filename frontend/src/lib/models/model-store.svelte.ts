/**
 * Model catalog store (spec: state-management.md §Model catalog).
 *
 * Owns the normalized model catalog, its freshness/error state, and the
 * latest draft (new-conversation) model selection. It never mutates an
 * existing conversation's locked model.
 *
 * Selection rules (prd AC-01A, state-management.md §Persistence):
 * - the remembered draft model ID wins when it is still in the catalog;
 * - otherwise the configured server default is used;
 * - a removed remembered ID is dropped from storage, never substituted with
 *   another non-default model;
 * - a missing configured default or an empty/malformed catalog is a blocking
 *   configuration state — the store never invents a fallback model.
 *
 * Only the latest draft model ID is persisted (localStorage allow-list).
 * The catalog itself, credentials, and CSRF tokens are never persisted.
 */

import { ApiError, errorMessageOf, isAbortError } from "../api/client";
import {
  fetchModels,
  isModelConfigurationErrorCode,
  refreshModels
} from "../api/models";
import type { ModelCatalog, ModelRefreshError } from "../api/models";

export type ModelStoreStatus = "idle" | "loading" | "ready" | "error";

export type ModelStore = {
  readonly status: ModelStoreStatus;
  readonly models: readonly { id: string; label: string }[];
  readonly defaultModel: string | null;
  readonly refreshedAt: number | null;
  /** True when the visible catalog is a stale cache after a failed refresh. */
  readonly stale: boolean;
  readonly refreshError: ModelRefreshError | null;
  /** Blocking operator-configuration failure, distinct from transient ones. */
  readonly isConfigurationError: boolean;
  readonly errorMessage: string | null;
  readonly isRefreshing: boolean;
  /** Validated draft selection; null until a usable catalog is loaded. */
  readonly draftModelId: string | null;
  load(signal?: AbortSignal): Promise<void>;
  /** Throws `ApiError` on failure; keeps the previous catalog state. */
  refresh(csrfToken: string): Promise<void>;
  /**
   * Returns true when the ID is an exact catalog member and becomes the new
   * persisted draft selection; invalid IDs are rejected without side effects.
   */
  selectDraftModel(id: string): boolean;
  /** True when the locked model of an existing conversation is still listed. */
  isModelAvailable(id: string): boolean;
};

const DRAFT_MODEL_STORAGE_KEY = "chat.draft-model-id";
const MAX_STORED_MODEL_ID_LENGTH = 200;

function readStoredDraftModelId(): string | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_MODEL_STORAGE_KEY);
    if (
      typeof raw === "string" &&
      raw.length > 0 &&
      raw.length <= MAX_STORED_MODEL_ID_LENGTH &&
      raw.trim() === raw
    ) {
      return raw;
    }
  } catch {
    // Storage unavailable (private mode, disabled cookies): session-only UI.
  }
  return null;
}

function writeStoredDraftModelId(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(DRAFT_MODEL_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DRAFT_MODEL_STORAGE_KEY, id);
    }
  } catch {
    // Best-effort persistence only; the server catalog remains the authority.
  }
}

function hasModel(catalog: ModelCatalog, id: string): boolean {
  return catalog.models.some((model) => model.id === id);
}

export function createModelStore(): ModelStore {
  let status = $state<ModelStoreStatus>("idle");
  let catalog = $state<ModelCatalog | null>(null);
  let isConfigurationError = $state(false);
  let errorMessage = $state<string | null>(null);
  let isRefreshing = $state(false);
  let draftModelId = $state<string | null>(null);

  function rememberInvalidDraft(): void {
    // The remembered model disappeared from the catalog: persist only the
    // latest draft selection, so clear the stale record instead of
    // substituting another non-default model.
    writeStoredDraftModelId(null);
  }

  /**
   * Resolves the draft selection against a new catalog. The stored ID wins
   * when it is still listed; otherwise the server-configured default applies.
   * The resolved selection is written back so exactly the latest draft model
   * ID is persisted. Never returns a model that is not in the catalog.
   */
  function resolveDraftSelection(next: ModelCatalog): string {
    const remembered = readStoredDraftModelId();
    if (remembered !== null) {
      if (hasModel(next, remembered)) {
        writeStoredDraftModelId(remembered);
        return remembered;
      }
      rememberInvalidDraft();
    }
    writeStoredDraftModelId(next.defaultModel);
    return next.defaultModel;
  }

  function applyCatalog(
    next: ModelCatalog,
    options: { revalidateSelection: boolean }
  ): void {
    // Belt-and-suspenders: the server already enforces a non-empty catalog
    // whose default is a member, but the frontend never silently invents a
    // model when the contract is violated.
    if (
      next.models.length === 0 ||
      !hasModel(next, next.defaultModel)
    ) {
      status = "error";
      isConfigurationError = true;
      errorMessage =
        "模型目录配置无效:默认模型不可用或目录为空,请检查部署配置。";
      return;
    }
    catalog = next;
    status = "ready";
    isConfigurationError = false;
    errorMessage = null;
    if (options.revalidateSelection && draftModelId !== null) {
      if (hasModel(next, draftModelId)) return;
      // The user-selected draft model disappeared from the refreshed
      // catalog: fall back to the configured default, never invent one.
      draftModelId = next.defaultModel;
      writeStoredDraftModelId(next.defaultModel);
      return;
    }
    draftModelId = resolveDraftSelection(next);
  }

  function applyFailure(error: unknown): void {
    if (isAbortError(error)) return;
    status = "error";
    isConfigurationError =
      error instanceof ApiError && isModelConfigurationErrorCode(error.code);
    errorMessage = errorMessageOf(error);
  }

  return {
    get status() {
      return status;
    },
    get models() {
      return catalog?.models ?? [];
    },
    get defaultModel() {
      return catalog?.defaultModel ?? null;
    },
    get refreshedAt() {
      return catalog?.refreshedAt ?? null;
    },
    get stale() {
      return catalog?.stale ?? false;
    },
    get refreshError() {
      return catalog?.refreshError ?? null;
    },
    get isConfigurationError() {
      return isConfigurationError;
    },
    get errorMessage() {
      return errorMessage;
    },
    get isRefreshing() {
      return isRefreshing;
    },
    get draftModelId() {
      return draftModelId;
    },

    async load(signal?: AbortSignal): Promise<void> {
      if (status === "loading") return;
      status = "loading";
      errorMessage = null;
      try {
        applyCatalog(await fetchModels(signal), {
          revalidateSelection: false
        });
      } catch (error) {
        applyFailure(error);
      }
    },

    async refresh(csrfToken: string): Promise<void> {
      if (isRefreshing) return;
      isRefreshing = true;
      try {
        applyCatalog(await refreshModels(csrfToken), {
          revalidateSelection: true
        });
      } catch (error) {
        if (!isAbortError(error)) {
          // A failed explicit refresh keeps the previous catalog state; the
          // previous stale/error markers stay visible until a retry resolves.
          errorMessage = errorMessageOf(error);
          if (status === "idle" || status === "loading") {
            status = "error";
          }
          if (error instanceof ApiError && isModelConfigurationErrorCode(error.code)) {
            isConfigurationError = true;
          }
        }
        throw error;
      } finally {
        isRefreshing = false;
      }
    },

    selectDraftModel(id: string): boolean {
      if (catalog === null || !hasModel(catalog, id)) return false;
      draftModelId = id;
      writeStoredDraftModelId(id);
      return true;
    },

    isModelAvailable(id: string): boolean {
      return catalog !== null && hasModel(catalog, id);
    }
  };
}
