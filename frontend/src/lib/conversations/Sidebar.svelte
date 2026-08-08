<script lang="ts">
  import { tick } from "svelte";

  import { errorMessageOf } from "../api/client";
  import type { ConversationSummary } from "../api/conversations";
  import CloseIcon from "../components/CloseIcon.svelte";
  import LogOutIcon from "../components/LogOutIcon.svelte";
  import PencilIcon from "../components/PencilIcon.svelte";
  import PlusIcon from "../components/PlusIcon.svelte";
  import SettingsIcon from "../components/SettingsIcon.svelte";
  import SidebarToggleIcon from "../components/SidebarToggleIcon.svelte";
  import type { ConversationStore } from "./conversation-store.svelte";

  type Props = {
    store: ConversationStore;
    /** In-memory session CSRF token for the rename mutation. */
    csrfToken: string;
    /** Rendered inside the mobile drawer: shows a close control. */
    onClose?: (() => void) | null;
    /**
     * Desktop static sidebar only: collapses the shell column. The mobile
     * drawer never receives it, keeping the two navigation states
     * independent (Phase I-03).
     */
    onCollapse?: (() => void) | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onSignOut: () => void;
    isSigningOut: boolean;
    /** Opens the settings dialog (owned by the shell). */
    onOpenSettings: () => void;
  };

  const {
    store,
    csrfToken,
    onClose = null,
    onCollapse = null,
    onSelect,
    onNew,
    onSignOut,
    isSigningOut,
    onOpenSettings
  }: Props = $props();

  // --- Inline title editing (Phase I-04) ------------------------------
  // The sidebar owns only the editor/focus/error state; the mutation goes
  // through `ConversationStore.rename`, so the server response stays
  // authoritative for both the list and the open header. A failed save
  // never replaces the old title.
  const MAX_TITLE_LENGTH = 200;

  let root = $state<HTMLElement | null>(null);
  let editingId = $state<string | null>(null);
  let editDraft = $state("");
  let editError = $state<string | null>(null);
  let isEditBusy = $state(false);
  let editInput = $state<HTMLInputElement | null>(null);

  async function focusRenameTrigger(id: string): Promise<void> {
    await tick();
    root
      ?.querySelector<HTMLElement>(`[data-rename-trigger="${id}"]`)
      ?.focus();
  }

  async function startEditing(item: ConversationSummary): Promise<void> {
    if (isEditBusy) return;
    editingId = item.id;
    editDraft = item.title;
    editError = null;
    await tick();
    editInput?.focus();
    editInput?.select();
  }

  /** Closes the editor without saving; optionally restores trigger focus. */
  async function cancelEditing(restoreFocusId: string | null): Promise<void> {
    editingId = null;
    editError = null;
    if (restoreFocusId !== null) {
      await focusRenameTrigger(restoreFocusId);
    }
  }

  /**
   * Commits the draft through the server-authoritative rename. Focus is
   * restored to the rename trigger only for explicit submits; a blur
   * commit leaves focus where the user moved it (tabbing/clicking away
   * must never pull focus backward into the sidebar).
   */
  async function commitEditing(restoreFocusOnSuccess: boolean): Promise<void> {
    const id = editingId;
    if (id === null || isEditBusy) return;
    const original = store.items.find((entry) => entry.id === id);
    if (original === undefined) {
      await cancelEditing(null);
      return;
    }
    const title = editDraft.trim();
    if (title.length === 0) {
      editError = "标题不能为空。";
      return;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      editError = `标题不能超过 ${MAX_TITLE_LENGTH} 个字符。`;
      return;
    }
    if (title === original.title) {
      await cancelEditing(restoreFocusOnSuccess ? id : null);
      return;
    }
    isEditBusy = true;
    editError = null;
    try {
      await store.rename(id, title, csrfToken);
      const restoreId = restoreFocusOnSuccess ? id : null;
      editingId = null;
      isEditBusy = false;
      if (restoreId !== null) {
        await focusRenameTrigger(restoreId);
      }
    } catch (error) {
      // Keep the editor open with inline feedback and focus so the user
      // can retry, correct, or cancel with Escape; the list and header
      // keep the old title because the store only reconciles on success.
      // The busy state is cleared before the tick/focus: the input is
      // disabled while busy, and focusing a disabled control is a no-op,
      // so the enabled editor must exist first to regain focus.
      editError = errorMessageOf(error);
      isEditBusy = false;
      await tick();
      editInput?.focus();
    }
  }

  function handleEditSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void commitEditing(true);
  }

  function handleEditKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const id = editingId;
    editingId = null;
    editError = null;
    if (id !== null) {
      void focusRenameTrigger(id);
    }
  }

  function handleEditBlur(): void {
    // Safe blur: unchanged or emptied drafts close silently (an empty
    // title can never be saved); a changed valid draft commits. A failed
    // blur-commit keeps the editor open with the error, so a failed save
    // is never silently discarded. The blur fired by Escape-cancel is a
    // no-op because `editingId` is already null.
    if (editingId === null || isEditBusy) return;
    const original = store.items.find((entry) => entry.id === editingId);
    const title = editDraft.trim();
    if (
      original === undefined ||
      title.length === 0 ||
      title === original.title
    ) {
      void cancelEditing(null);
      return;
    }
    void commitEditing(false);
  }
</script>

<div class="sidebar" bind:this={root}>
  <div class="sidebar-top">
    <span class="brand">Minimal AI Chat</span>
    <div class="top-actions">
      <button
        type="button"
        class="icon-button"
        aria-label="设置"
        title="设置"
        onclick={onOpenSettings}
      >
        <SettingsIcon size={20} />
      </button>
      {#if onClose}
        <button
          type="button"
          class="icon-button"
          aria-label="关闭导航"
          onclick={onClose}
        >
          <CloseIcon size={20} />
        </button>
      {:else if onCollapse}
        <button
          type="button"
          class="icon-button"
          aria-label="收起侧边栏"
          onclick={onCollapse}
        >
          <SidebarToggleIcon size={20} direction="collapse" />
        </button>
      {/if}
    </div>
  </div>

  <button type="button" class="new-button" onclick={onNew}>
    <PlusIcon size={18} />
    <span>新对话</span>
  </button>

  <nav class="list-region" aria-label="对话列表">
    {#if store.listStatus === "idle" || store.listStatus === "loading"}
      <p class="list-note" role="status">正在加载对话…</p>
    {:else if store.listStatus === "error"}
      <div class="list-error">
        <p class="list-note" role="alert">{store.listError}</p>
        <button type="button" class="retry" onclick={() => void store.load()}>
          重试
        </button>
      </div>
    {:else if store.items.length === 0}
      <p class="list-note">还没有对话。</p>
    {:else}
      <ul class="list">
        {#each store.items as item (item.id)}
          <li>
            {#if editingId === item.id}
              <!-- Inline editor replaces the item button, so selection is
                   suppressed while editing. -->
              <form class="edit-form" onsubmit={handleEditSubmit}>
                <label class="visually-hidden" for="sidebar-rename-input">
                  对话标题
                </label>
                <input
                  id="sidebar-rename-input"
                  bind:this={editInput}
                  bind:value={editDraft}
                  maxlength={MAX_TITLE_LENGTH}
                  disabled={isEditBusy}
                  aria-invalid={editError !== null}
                  onkeydown={handleEditKeydown}
                  onblur={handleEditBlur}
                />
                {#if editError}
                  <p class="edit-error" role="alert">{editError}</p>
                {/if}
              </form>
            {:else}
              <!-- The row is the unified card: it owns the border,
                   background, radius, hover, and active accent, so the
                   title button and the rename trigger read as one
                   surface while remaining two independent keyboard
                   controls (no nested interactive elements). -->
              <div
                class="item-row"
                class:item-row-active={store.selectedId === item.id}
              >
                <button
                  type="button"
                  class="item"
                  aria-current={store.selectedId === item.id
                    ? "true"
                    : undefined}
                  onclick={() => onSelect(item.id)}
                >
                  <span class="item-title">{item.title}</span>
                  <span class="item-model">{item.model}</span>
                </button>
                <button
                  type="button"
                  class="icon-button rename-trigger"
                  data-rename-trigger={item.id}
                  aria-label={`重命名 ${item.title}`}
                  onclick={() => void startEditing(item)}
                >
                  <PencilIcon size={16} />
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if store.loadMoreError}
        <p class="list-note" role="alert">{store.loadMoreError}</p>
      {/if}
      {#if store.hasMore}
        <button
          type="button"
          class="load-more"
          disabled={store.isLoadingMore}
          onclick={() => void store.loadMore()}
        >
          {store.isLoadingMore ? "正在加载…" : "加载更多"}
        </button>
      {/if}
    {/if}
  </nav>

  <div class="sidebar-footer">
    <button
      type="button"
      class="icon-button sign-out"
      aria-label={isSigningOut ? "正在退出" : "退出登录"}
      title={isSigningOut ? "正在退出..." : "退出登录"}
      disabled={isSigningOut}
      onclick={onSignOut}
    >
      <LogOutIcon size={20} />
    </button>
  </div>
</div>

<style>
  .sidebar {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    background: var(--surface);
  }

  .sidebar-top {
    display: flex;
    min-height: 60px;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 0 var(--space-4);
  }

  .brand {
    overflow: hidden;
    font-size: 0.95rem;
    font-weight: 750;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Settings sits to the left of the collapse/close control (08-08). */
  .top-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-1);
  }

  .icon-button {
    display: inline-flex;
    flex-shrink: 0;
    width: var(--touch-target);
    height: var(--touch-target);
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .icon-button:hover {
    color: var(--text);
    background: var(--surface-muted);
  }

  .new-button {
    display: flex;
    min-height: var(--control-height);
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    margin: 0 var(--space-4) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--accent-contrast);
    background: var(--text);
    font-weight: 700;
    transition:
      background-color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .new-button:hover {
    background: var(--text-strong);
  }

  .list-region {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-2);
  }

  .list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The row is the card: hover/active chrome lives here, the inner
     title button and rename trigger stay transparent. */
  .item-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--radius-sm);
    transition: background-color var(--motion-fast);
  }

  .item-row:hover {
    background: var(--surface-muted);
  }

  .item-row-active,
  .item-row-active:hover {
    background: var(--surface-muted);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .item {
    display: grid;
    min-width: 0;
    flex: 1;
    min-height: var(--touch-target);
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text);
    background: transparent;
    text-align: left;
  }

  .rename-trigger {
    position: relative;
    width: var(--compact-action-size);
    height: var(--compact-action-size);
    margin-right: var(--space-1);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--muted);
  }

  .rename-trigger:hover,
  .rename-trigger:focus-visible {
    border-color: var(--border-strong);
    background: var(--surface);
  }

  @media (any-pointer: coarse) {
    .rename-trigger::after {
      position: absolute;
      width: var(--touch-target);
      height: var(--touch-target);
      content: "";
    }
  }

  .item-title {
    overflow: hidden;
    font-size: 0.9rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-model {
    overflow: hidden;
    color: var(--muted);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .edit-form {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
  }

  .edit-form input {
    min-width: 0;
    min-height: var(--touch-target);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.9rem;
  }

  .edit-form input:focus {
    border-color: var(--accent);
  }

  .edit-form input[aria-invalid="true"] {
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
  }

  .edit-error {
    margin: 0;
    color: var(--danger);
    font-size: 0.78rem;
    line-height: 1.5;
  }

  .list-note {
    margin: var(--space-3) var(--space-2);
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .list-error .retry,
  .load-more {
    display: block;
    width: calc(100% - var(--space-4));
    min-height: var(--touch-target);
    margin: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.875rem;
    font-weight: 600;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .list-error .retry:hover,
  .load-more:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .load-more:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /* Sign-out is a compact icon action anchored to the bottom-left corner
     (08-08 UI polish); it reuses the shared icon-button chrome above. */
  .sidebar-footer {
    display: flex;
    justify-content: flex-start;
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
  }

  .icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
