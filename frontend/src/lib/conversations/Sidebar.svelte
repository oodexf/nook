<script lang="ts">
  import { tick } from "svelte";

  import { errorMessageOf } from "../api/client";
  import type { ConversationSummary } from "../api/conversations";
  import ArchiveIcon from "../components/ArchiveIcon.svelte";
  import ChevronRightIcon from "../components/ChevronRightIcon.svelte";
  import CloseIcon from "../components/CloseIcon.svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import EditSquareIcon from "../components/EditSquareIcon.svelte";
  import FolderIcon from "../components/FolderIcon.svelte";
  import LogOutIcon from "../components/LogOutIcon.svelte";
  import MoreHorizontalIcon from "../components/MoreHorizontalIcon.svelte";
  import NookLogo from "../components/NookLogo.svelte";
  import PencilIcon from "../components/PencilIcon.svelte";
  import PinIcon from "../components/PinIcon.svelte";
  import SearchIcon from "../components/SearchIcon.svelte";
  import SettingsIcon from "../components/SettingsIcon.svelte";
  import ShareIcon from "../components/ShareIcon.svelte";
  import SidebarToggleIcon from "../components/SidebarToggleIcon.svelte";
  import TrashIcon from "../components/TrashIcon.svelte";
  import { groupConversations } from "./conversation-store.svelte";
  import type { ConversationStore } from "./conversation-store.svelte";

  type Props = {
    store: ConversationStore;
    /** In-memory session CSRF token for rename/delete mutations. */
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

  let root = $state<HTMLElement | null>(null);

  // --- Pinned/recents sections (08-08 sidebar redesign) ---------------
  // Pinning is a local placeholder (store.togglePinPlaceholder): it only
  // re-groups the current page and is reset by any server-sourced list
  // replacement, until a backend pin contract lands.
  const groups = $derived(groupConversations(store.items));
  const sections = $derived([
    { label: "置顶", items: groups.pinned },
    { label: "最近", items: groups.recents }
  ]);

  // --- Inline title editing (Phase I-04) ------------------------------
  // The sidebar owns only the editor/focus/error state; the mutation goes
  // through `ConversationStore.rename`, so the server response stays
  // authoritative for both the list and the open header. A failed save
  // never replaces the old title.
  const MAX_TITLE_LENGTH = 200;

  let editingId = $state<string | null>(null);
  let editDraft = $state("");
  let editError = $state<string | null>(null);
  let isEditBusy = $state(false);
  let editInput = $state<HTMLInputElement | null>(null);
  // The editor is only autofocused when it was opened by an explicit user
  // action (menu rename). `bind:this` rebinds to the freshly mounted input
  // whenever the editor renders, and an unconditional focus effect would
  // steal focus back after a blur-commit or after the user deliberately
  // moved focus elsewhere.
  let pendingEditFocus = false;

  $effect(() => {
    if (pendingEditFocus && editingId !== null && editInput !== null) {
      pendingEditFocus = false;
      editInput.focus();
      editInput.select();
    } else if (editingId === null) {
      pendingEditFocus = false;
    }
  });

  /**
   * Focus lands on the row's "···" menu trigger (the menu owns rename
   * since the dedicated pencil button was absorbed into it, 08-08).
   */
  async function focusRenameTrigger(id: string): Promise<void> {
    await tick();
    root
      ?.querySelector<HTMLElement>(`[data-row-menu-trigger="${id}"]`)
      ?.focus();
  }

  function startEditing(item: ConversationSummary): void {
    if (isEditBusy) return;
    closeMenu();
    pendingEditFocus = true;
    editingId = item.id;
    editDraft = item.title;
    editError = null;
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
    // Stop the sidebar-level menu handler: Escape in the editor cancels
    // the edit, never the (already closed) menu.
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

  // --- Row action menu (08-08 sidebar redesign) -----------------------
  // One menu open at a time; anchored under the row's "···" trigger.
  // Share/Archive/Move-to-project are placeholders (they only close the
  // menu); Rename/Pin/Delete run the real paths.
  let openMenuId = $state<string | null>(null);

  function closeMenu(): void {
    openMenuId = null;
  }

  function toggleMenu(id: string, event: MouseEvent): void {
    // Keep this click from reaching the window-level outside-click
    // listener synchronously; otherwise the just-opened menu would count
    // as its own outside click and close in the same gesture.
    event.stopPropagation();
    openMenuId = openMenuId === id ? null : id;
  }

  function handleRootClick(event: MouseEvent): void {
    if (openMenuId === null) return;
    // Coarse pointers (touch) synthesize a compatibility mouse click after
    // the real tap; that synthetic event carries coordinates (0, 0) while
    // the trigger's own click was already stopPropagation'd, so this
    // listener only ever sees the synthetic twin — treating it as an
    // outside click would instantly close a freshly opened menu.
    if (event.clientX === 0 && event.clientY === 0 && event.detail === 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("[data-menu]") !== null) {
      return;
    }
    closeMenu();
  }

  function handleRootKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || openMenuId === null) return;
    event.preventDefault();
    event.stopPropagation();
    const id = openMenuId;
    closeMenu();
    const trigger = root?.querySelector<HTMLElement>(`[data-row-menu-trigger="${id}"]`);
    trigger?.focus();
  }

  function handleMenuSelect(item: ConversationSummary, action: string): void {
    closeMenu();
    switch (action) {
      case "rename":
        startEditing(item);
        break;
      case "pin":
        store.togglePinPlaceholder(item.id);
        break;
      case "delete":
        requestDelete(item);
        break;
      default:
        // Placeholder actions (share / archive / move-to-project):
        // closing the menu is the whole behavior until those features land.
        break;
    }
  }

  // --- Delete flow ----------------------------------------------------
  // Same server-authoritative path as the chat header (store.remove), with
  // the shared ConfirmDialog for the destructive confirmation.
  let deleteTarget = $state<ConversationSummary | null>(null);
  let deleteError = $state<string | null>(null);
  let isDeleteBusy = $state(false);

  function requestDelete(item: ConversationSummary): void {
    deleteError = null;
    deleteTarget = item;
  }

  function cancelDelete(): void {
    if (isDeleteBusy) return;
    deleteTarget = null;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (target === null || isDeleteBusy) return;
    isDeleteBusy = true;
    deleteError = null;
    try {
      await store.remove(target.id, csrfToken);
      deleteTarget = null;
    } catch (error) {
      deleteError = errorMessageOf(error);
    } finally {
      isDeleteBusy = false;
    }
  }
</script>

<svelte:window onclick={handleRootClick} onkeydown={handleRootKeydown} />

<div class="sidebar" bind:this={root}>
  <div class="sidebar-top">
    <span class="brand">
      <NookLogo size={26} />
      <span class="brand-name">栖语 <span class="brand-name-en">NooK</span></span>
    </span>
    <div class="top-actions">
      <button
        type="button"
        class="icon-button"
        aria-label="搜索(即将上线)"
        title="搜索(即将上线)"
        disabled
      >
        <SearchIcon size={20} />
      </button>
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

  <!-- Nav entries styled like the reference screenshot: icon + label row
       items. 项目 is a placeholder until project grouping lands. -->
  <nav class="nav-entries" aria-label="主导航">
    <button type="button" class="nav-entry" onclick={onNew}>
      <EditSquareIcon size={20} />
      <span>新建对话</span>
    </button>
    <button
      type="button"
      class="nav-entry"
      aria-label="项目(即将上线)"
      title="项目(即将上线)"
      disabled
    >
      <FolderIcon size={20} />
      <span>项目</span>
    </button>
  </nav>

  <nav class="list-region" aria-label="对话列表">
    {#if store.listStatus === "idle" || store.listStatus === "loading"}
      <p class="list-note" role="status">正在加载对话...</p>
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
      {#each sections as section (section.label)}
        {#if section.items.length > 0}
          <p class="section-label">{section.label}</p>
          <ul class="list">
            {#each section.items as item (item.id)}
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
                       title button and the action buttons read as one
                       surface while remaining independent keyboard
                       controls (no nested interactive elements). -->
                  <div
                    class="item-row"
                    class:item-row-active={store.selectedId === item.id}
                    data-menu={openMenuId === item.id ? "" : undefined}
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
                      class="icon-button row-action"
                      class:row-action-active={item.pinned}
                      aria-label={item.pinned
                        ? `取消置顶 ${item.title}`
                        : `置顶 ${item.title}`}
                      aria-pressed={item.pinned}
                      title={item.pinned ? "取消置顶" : "置顶"}
                      onclick={() => store.togglePinPlaceholder(item.id)}
                    >
                      <PinIcon size={16} filled={item.pinned} />
                    </button>
                    <button
                      type="button"
                      class="icon-button row-action"
                      data-row-menu-trigger={item.id}
                      aria-label={`${item.title} 的更多操作`}
                      title="更多操作"
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === item.id}
                      onclick={(event) => toggleMenu(item.id, event)}
                    >
                      <MoreHorizontalIcon size={16} />
                    </button>
                    {#if openMenuId === item.id}
                      <div class="menu" role="menu" aria-label="对话操作">
                        <button
                          type="button"
                          class="menu-item"
                          role="menuitem"
                          onclick={() => handleMenuSelect(item, "share")}
                        >
                          <ShareIcon size={18} />
                          <span>分享</span>
                        </button>
                        <button
                          type="button"
                          class="menu-item"
                          role="menuitem"
                          onclick={() => handleMenuSelect(item, "rename")}
                        >
                          <PencilIcon size={18} />
                          <span>重命名</span>
                        </button>
                        <button
                          type="button"
                          class="menu-item"
                          role="menuitem"
                          onclick={() => handleMenuSelect(item, "pin")}
                        >
                          <PinIcon size={18} filled={item.pinned} />
                          <span>{item.pinned ? "取消置顶" : "置顶对话"}</span>
                        </button>
                        <button
                          type="button"
                          class="menu-item"
                          role="menuitem"
                          onclick={() => handleMenuSelect(item, "archive")}
                        >
                          <ArchiveIcon size={18} />
                          <span>归档</span>
                        </button>
                        <button
                          type="button"
                          class="menu-item menu-item-danger"
                          role="menuitem"
                          onclick={() => handleMenuSelect(item, "delete")}
                        >
                          <TrashIcon size={18} />
                          <span>删除</span>
                        </button>
                        <div class="menu-separator" role="separator"></div>
                        <button
                          type="button"
                          class="menu-item"
                          role="menuitem"
                          onclick={() => handleMenuSelect(item, "move")}
                        >
                          <FolderIcon size={18} />
                          <span>移动到项目</span>
                          <span class="menu-item-trailing">
                            <ChevronRightIcon size={16} />
                          </span>
                        </button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/each}
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
          {store.isLoadingMore ? "正在加载..." : "加载更多"}
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

{#if deleteTarget !== null}
  <ConfirmDialog
    title="删除对话"
    description={`确定删除「${deleteTarget.title}」吗?此操作不可撤销。`}
    confirmLabel="删除"
    busy={isDeleteBusy}
    errorMessage={deleteError}
    onConfirm={() => void confirmDelete()}
    onCancel={cancelDelete}
  />
{/if}

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
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-2);
    overflow: hidden;
  }

  .brand :global(svg) {
    flex-shrink: 0;
  }

  .brand-name {
    overflow: hidden;
    font-size: 0.95rem;
    font-weight: 750;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .brand-name-en {
    color: var(--muted);
    font-size: 0.85rem;
    font-weight: 650;
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

  .icon-button:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-muted);
  }

  /* Nav entries (新建对话 / 项目) mirror the reference: plain icon+label
     rows on the list grid, with the muted-hover row treatment. */
  .nav-entries {
    display: grid;
    gap: 2px;
    margin: 0 0 var(--space-3);
    padding: 0 var(--space-2);
  }

  .nav-entry {
    display: flex;
    min-height: var(--touch-target);
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text);
    background: transparent;
    font-size: 0.9rem;
    font-weight: 600;
    text-align: left;
    transition: background-color var(--motion-fast);
  }

  .nav-entry:hover:not(:disabled) {
    background: var(--surface-muted);
  }

  .nav-entry:disabled {
    cursor: default;
    color: var(--muted);
  }

  .list-region {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-2);
  }

  .section-label {
    margin: var(--space-2) var(--space-3) var(--space-1);
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The row is the card: hover/active chrome lives here, the inner
     title button and action buttons stay transparent. */
  .item-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--radius-sm);
    transition: background-color var(--motion-fast);
  }

  .item-row:hover,
  .item-row:focus-within,
  .item-row[data-menu] {
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

  .row-action {
    position: relative;
    width: var(--compact-action-size);
    height: var(--compact-action-size);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--muted);
  }

  .row-action:last-of-type {
    margin-right: var(--space-1);
  }

  .row-action:hover,
  .row-action:focus-visible,
  .row-action[aria-expanded="true"] {
    border-color: var(--border-strong);
    background: var(--surface);
  }

  .row-action-active {
    color: var(--text);
  }

  @media (any-pointer: coarse) {
    .row-action::after {
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

  /* Row action menu: absolute popover anchored under the row's trailing
     edge, above scrolling list content. */
  .menu {
    position: absolute;
    z-index: var(--z-drawer);
    top: calc(100% + var(--space-1));
    right: var(--space-2);
    display: grid;
    min-width: 200px;
    gap: 2px;
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .menu-item {
    display: flex;
    min-height: 40px;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text);
    background: transparent;
    font-size: 0.875rem;
    text-align: left;
    transition: background-color var(--motion-fast);
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--surface-muted);
  }

  .menu-item-danger,
  .menu-item-danger:hover {
    color: var(--danger);
  }

  .menu-item-trailing {
    display: inline-flex;
    margin-left: auto;
    color: var(--muted);
  }

  .menu-separator {
    height: 1px;
    margin: var(--space-1) var(--space-2);
    background: var(--border);
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
