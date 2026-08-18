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
  import { buildSidebarSections } from "./conversation-store.svelte";
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

  // --- Sections (08-15 sidebar UI refresh) ----------------------------
  // Pinned first, then the remainder bucketed by `updatedAt` into local
  // calendar-day ranges. Empty sections are already dropped by the store
  // helper, so the markup renders whatever comes back.
  //
  // Pinning is a local placeholder (store.togglePinPlaceholder): it only
  // re-groups the current page and is reset by any server-sourced list
  // replacement, until a backend pin contract lands.
  const sections = $derived(buildSidebarSections(store.items, Date.now()));

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

  // --- Menu placement -------------------------------------------------
  // The menu is viewport-positioned (`position: fixed`) instead of being an
  // absolute child of the row: the scrolling `.list-region` clips overflow,
  // so an absolute popover on a row near the bottom was cut off. Fixed
  // positioning escapes that clip (no ancestor establishes a containing
  // block for it), and the coordinates are derived from the row's rect —
  // below the row when there is room, flipped above it otherwise.
  const MENU_VIEWPORT_MARGIN = 8;
  const MENU_ANCHOR_GAP = 4; // var(--space-1)
  const MENU_ROW_INSET = 8; // var(--space-2): the old `right` offset
  const MENU_FALLBACK_WIDTH = 184; // matches the CSS min-width

  type MenuPlacement = { top: number; left: number; maxHeight: number };

  let menuEl = $state<HTMLElement | null>(null);
  let menuPlacement = $state<MenuPlacement | null>(null);

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function updateMenuPlacement(): void {
    const id = openMenuId;
    const menu = menuEl;
    if (id === null || menu === null) return;
    const row =
      root
        ?.querySelector<HTMLElement>(`[data-row-menu-trigger="${id}"]`)
        ?.closest<HTMLElement>(".item-row") ?? null;
    if (row === null) return;

    const rowRect = row.getBoundingClientRect();
    const region = root?.querySelector<HTMLElement>(".list-region") ?? null;
    if (region !== null) {
      // The menu no longer travels with the clipped list, so a row scrolled
      // out of the list viewport would leave it floating over unrelated
      // chrome. Closing keeps the popover tied to a visible anchor.
      const regionRect = region.getBoundingClientRect();
      const scrolledOut =
        rowRect.bottom <= regionRect.top || rowRect.top >= regionRect.bottom;
      if (scrolledOut && regionRect.height > 0) {
        closeMenu();
        return;
      }
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menuRect = menu.getBoundingClientRect();
    const width = menuRect.width || MENU_FALLBACK_WIDTH;
    const height = menuRect.height;
    const maxHeight = Math.max(0, viewportHeight - MENU_VIEWPORT_MARGIN * 2);

    const spaceBelow =
      viewportHeight - MENU_VIEWPORT_MARGIN - (rowRect.bottom + MENU_ANCHOR_GAP);
    const spaceAbove = rowRect.top - MENU_ANCHOR_GAP - MENU_VIEWPORT_MARGIN;
    const flipUp = height > spaceBelow && spaceAbove > spaceBelow;
    const top = flipUp
      ? rowRect.top - MENU_ANCHOR_GAP - height
      : rowRect.bottom + MENU_ANCHOR_GAP;

    menuPlacement = {
      top: clamp(
        top,
        MENU_VIEWPORT_MARGIN,
        viewportHeight - MENU_VIEWPORT_MARGIN - Math.min(height, maxHeight)
      ),
      left: clamp(
        rowRect.right - MENU_ROW_INSET - width,
        MENU_VIEWPORT_MARGIN,
        viewportWidth - MENU_VIEWPORT_MARGIN - width
      ),
      maxHeight
    };
  }

  $effect(() => {
    if (openMenuId === null || menuEl === null) {
      menuPlacement = null;
      return;
    }
    updateMenuPlacement();
    const reposition = (): void => updateMenuPlacement();
    // Capture phase: scrolling inside `.list-region` does not bubble to the
    // window, and that is exactly the scroll that moves the anchor row.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  });

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
      <NookLogo size={22} />
      <span class="brand-name">栖语 <span class="brand-name-en">NooK</span></span>
    </span>
    <div class="top-actions">
      {#if onClose}
        <button
          type="button"
          class="icon-button"
          aria-label="关闭导航"
          onclick={onClose}
        >
          <CloseIcon size={18} />
        </button>
      {:else if onCollapse}
        <button
          type="button"
          class="icon-button"
          aria-label="收起侧边栏"
          onclick={onCollapse}
        >
          <SidebarToggleIcon size={18} direction="collapse" />
        </button>
      {/if}
    </div>
  </div>

  <!-- Nav entries: icon + label rows. 搜索 moved down from the top bar
       (08-15) so the header carries nothing but identity and the collapse
       control. 搜索 and 项目 stay placeholders until those features land;
       their labels keep the "(即将上线)" note so a dead click reads as
       "not yet" rather than "broken". -->
  <nav class="nav-entries" aria-label="主导航">
    <button type="button" class="nav-entry" onclick={onNew}>
      <EditSquareIcon size={18} />
      <span>新建对话</span>
    </button>
    <button
      type="button"
      class="nav-entry"
      aria-label="搜索(即将上线)"
      title="搜索(即将上线)"
      disabled
    >
      <SearchIcon size={18} />
      <span>搜索</span>
    </button>
    <button
      type="button"
      class="nav-entry"
      aria-label="项目(即将上线)"
      title="项目(即将上线)"
      disabled
    >
      <FolderIcon size={18} />
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
      {#each sections as section (section.key)}
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
                <!-- The row is the unified card: it owns the background,
                     radius, hover, and active wash, so the title button
                     and the action buttons read as one surface while
                     remaining independent keyboard controls (no nested
                     interactive elements). The actions are lifted out of
                     the flex flow (08-15) so the title always spans the
                     full row and the reveal costs no layout. -->
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
                  </button>
                  <div class="row-actions">
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
                  </div>
                  {#if openMenuId === item.id}
                    <!-- Measured, then placed: the first render has no
                         rect to flip against, so it stays invisible for
                         that frame instead of flashing at the wrong end
                         of the row. -->
                    <div
                      class="menu"
                      role="menu"
                      aria-label="对话操作"
                      bind:this={menuEl}
                      style={menuPlacement === null
                        ? "visibility: hidden;"
                        : `top: ${menuPlacement.top}px; left: ${menuPlacement.left}px; max-height: ${menuPlacement.maxHeight}px;`}
                    >
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
                        <PinIcon size={16} filled={item.pinned} />
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

  <!-- Account-level actions sit together at the bottom (08-15): settings
       came down from the top bar, so the header holds identity only. Token
       auth exposes no user profile, so this is an action row, not an
       account row. -->
  <div class="sidebar-footer">
    <button
      type="button"
      class="icon-button"
      aria-label="设置"
      title="设置"
      onclick={onOpenSettings}
    >
      <SettingsIcon size={18} />
    </button>
    <button
      type="button"
      class="icon-button sign-out"
      aria-label={isSigningOut ? "正在退出" : "退出登录"}
      title={isSigningOut ? "正在退出..." : "退出登录"}
      disabled={isSigningOut}
      onclick={onSignOut}
    >
      <LogOutIcon size={18} />
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
    /* Rows and chrome buttons run on the shared navigation scale
       (`--nav-row-height` / `--nav-icon-button` in global.css), which the
       chat header uses too and which returns to the 44px touch minimum on
       coarse pointers. */

    /* The title's tail fade, shared by the hover/focus reveal and the
       always-on coarse-pointer case. It is fully transparent by the time it
       reaches the action buttons (the cluster is 62px wide from the row's
       right edge and the title box ends 8px inside it, so they start 54px
       in from the title's right edge), so a long title never reads through
       the glyphs. `currentColor` keeps the gradient free of a literal
       color — only the alpha ramp matters to a mask. */
    --title-fade-mask: linear-gradient(
      to right,
      currentColor calc(100% - 98px),
      transparent calc(100% - 54px)
    );

    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    background: var(--surface);
  }

  /* Identity and the open/close control only (08-15); search and settings
     moved down into the nav list and the footer. */
  /* 16px is the column's left rail: the brand, the nav-entry icons
     (8px list padding + 8px row padding) and the footer glyphs all start
     there, so the whole sidebar reads on one vertical edge. */
  .sidebar-top {
    display: flex;
    min-height: 48px;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 0 var(--space-1) 0 var(--space-4);
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
    font-size: 0.9rem;
    font-weight: 750;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .brand-name-en {
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 650;
  }

  .top-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-1);
  }

  .icon-button {
    display: inline-flex;
    flex-shrink: 0;
    width: var(--nav-icon-button);
    height: var(--nav-icon-button);
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 8px;
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

  /* Nav entries (新建对话 / 搜索 / 项目): icon+label rows sharing the list
     grid and the muted-hover row treatment, so the whole left column reads
     on one rhythm. */
  .nav-entries {
    display: grid;
    gap: 1px;
    margin: 0 0 var(--space-1);
    padding: 0 var(--space-2);
  }

  .nav-entry {
    display: flex;
    min-height: var(--nav-row-height);
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: 8px;
    color: var(--text);
    background: transparent;
    font-size: 0.8125rem;
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
    padding: 0 var(--space-2) var(--space-2);
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  /* Time buckets (08-15): 置顶 / 今天 / 昨天 / 过去 7 天 / 过去 30 天 /
     更早. The generous top margin is what separates the groups; the labels
     themselves stay quiet. */
  .section-label {
    margin: var(--space-3) var(--space-2) var(--space-1);
    color: var(--muted);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .section-label:first-child {
    margin-top: var(--space-1);
  }

  .list {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Grid items default to `min-width: auto`, so a long unbreakable title
     would size the row to its own content and push it past the column.
     Cutting the automatic minimum here is what lets the ellipsis (and the
     fade mask) inside the row actually engage. */
  .list > li {
    min-width: 0;
  }

  /* The row is the card: hover/active chrome lives here, the inner
     title button and action buttons stay transparent. */
  .item-row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 8px;
    transition: background-color var(--motion-fast);
  }

  .item-row:hover,
  .item-row:focus-within,
  .item-row[data-menu] {
    background: var(--surface-muted);
  }

  /* The selected row is a wash of the accent rather than the former
     `inset 2px` rule: a square-ended bar drawn down the left side of a
     10px-radius card cuts across the corner, while a filled shape stays
     true to the row's own outline. */
  .item-row-active,
  .item-row-active:hover,
  .item-row-active:focus-within,
  .item-row-active[data-menu] {
    background: var(--accent-soft);
  }

  .item {
    display: flex;
    min-width: 0;
    flex: 1;
    min-height: var(--nav-row-height);
    align-items: center;
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: 8px;
    color: var(--text);
    background: transparent;
    text-align: left;
  }

  .item-title {
    overflow: hidden;
    min-width: 0;
    flex: 1;
    font-size: 0.8125rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-row-active .item-title {
    color: var(--text-strong);
    font-weight: 600;
  }

  /* Row actions are lifted out of the flex flow so an idle row gives its
     whole width to the title. Revealing them therefore costs no layout:
     only `opacity` (and the title's mask below) changes, so the row height
     and the title's starting edge never move.
     `opacity: 0` rather than `visibility: hidden` / `display: none`,
     because the buttons must stay in the tab order — reaching them by
     keyboard is exactly what raises `:focus-within` and reveals them. */
  .row-actions {
    position: absolute;
    right: var(--space-1);
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--motion-fast);
  }

  .item-row:hover .row-actions,
  .item-row:focus-within .row-actions,
  .item-row-active .row-actions,
  .item-row[data-menu] .row-actions {
    opacity: 1;
    pointer-events: auto;
  }

  /* Whenever the actions are up, the title fades out before it reaches
     them instead of running underneath. A mask is not a layout property,
     so this too is free of reflow. */
  .item-row:hover .item-title,
  .item-row:focus-within .item-title,
  .item-row-active .item-title,
  .item-row[data-menu] .item-title {
    -webkit-mask-image: var(--title-fade-mask);
    mask-image: var(--title-fade-mask);
  }

  .row-action {
    position: relative;
    width: var(--compact-action-size);
    height: var(--compact-action-size);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--muted);
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

  /* Coarse pointers have no hover to reveal with, so the actions (and the
     title's fade) are unconditional there, and each action gets the full
     44px hit area behind its compact glyph. (The row/button scale itself is
     restored globally by the same query in global.css.) */
  @media (any-pointer: coarse) {
    .row-actions {
      opacity: 1;
      pointer-events: auto;
    }

    .item-title {
      -webkit-mask-image: var(--title-fade-mask);
      mask-image: var(--title-fade-mask);
    }

    .row-action::after {
      position: absolute;
      width: var(--touch-target);
      height: var(--touch-target);
      content: "";
    }
  }

  /* Row action menu: viewport-positioned popover anchored to the row's
     trailing edge. `fixed` (with `top`/`left` written by
     `updateMenuPlacement`) is what keeps it out of the `.list-region`
     overflow clip — as an absolute child it was cut off on rows near the
     bottom of the scroll area. */
  .menu {
    position: fixed;
    z-index: var(--z-drawer);
    display: grid;
    min-width: 184px;
    max-width: calc(100vw - 16px);
    gap: 1px;
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .menu-item {
    display: flex;
    min-height: var(--nav-row-height);
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: 8px;
    color: var(--text);
    background: transparent;
    font-size: 0.8125rem;
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

  /* No padding of its own: the editor stands in for a row, so its input
     spans exactly the row's box and the title does not shift sideways when
     renaming starts. */
  .edit-form {
    display: grid;
    gap: var(--space-1);
    padding: 0;
  }

  .edit-form input {
    min-width: 0;
    min-height: var(--nav-row-height);
    padding: 0 var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    color: var(--text);
    background: var(--surface);
    font-size: 0.8125rem;
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
    margin: var(--space-2);
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .list-error .retry,
  .load-more {
    display: block;
    width: 100%;
    min-height: var(--nav-row-height);
    margin: var(--space-2) 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    background: var(--surface);
    font-size: 0.8125rem;
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

  /* Settings and sign-out share one action row at the bottom (08-15);
     both reuse the shared icon-button chrome above. */
  .sidebar-footer {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: var(--space-1);
    /* 8px + the icon button's own 7px inset lands the glyphs on the same
       16px rail as the brand and the nav-entry icons. */
    padding: var(--space-1) var(--space-2);
    border-top: 1px solid var(--border);
  }

  .icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
