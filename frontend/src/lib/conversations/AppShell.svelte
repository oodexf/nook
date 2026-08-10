<script lang="ts">
  import { onMount, tick } from "svelte";

  import SettingsDialog from "../components/SettingsDialog.svelte";
  import { createGenerationStore } from "../generation/generation-store.svelte";
  import { createModelStore } from "../models/model-store.svelte";
  import {
    createThemeStore,
    type ThemeStore
  } from "../theme/theme-store.svelte";
  import ChatPane from "./ChatPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { createConversationStore } from "./conversation-store.svelte";

  type Props = {
    csrfToken: string;
    isSigningOut: boolean;
    onSignOut: () => void;
    /**
     * Provided by `App` so the theme also applies on the auth page. When
     * absent (unit tests mounting the shell directly), the shell creates
     * its own instance — the applied `data-theme` state is identical.
     */
    theme?: ThemeStore;
  };

  const {
    csrfToken,
    isSigningOut,
    onSignOut,
    theme: providedTheme
  }: Props = $props();

  // Fallback for hosts that mount the shell without a theme store (unit
  // tests): the applied `data-theme` state is identical either way.
  const fallbackTheme = createThemeStore();
  const theme = $derived(providedTheme ?? fallbackTheme);

  // The settings dialog is shell-owned: both the static sidebar and the
  // mobile drawer open the same instance (08-08 UI polish).
  let isSettingsOpen = $state(false);

  const store = createConversationStore();
  const modelStore = createModelStore();

  // The generation store owns stream state only; every server-visible
  // change (new conversation, settled message) reconciles through the
  // conversation store, which remains the single owner of persisted data.
  // Navigation is respected: a refresh/open is applied only when the user
  // is still on the view that owns the stream.
  const generation = createGenerationStore({
    onConversationCreated: (conversationId) => {
      void store.refreshList();
      if (store.selectedId === null) {
        void store.open(conversationId);
      }
    },
    onReconcile: (conversationId) => {
      void store.refreshList();
      if (store.selectedId === conversationId) {
        void store.reloadCurrent(conversationId);
      }
    }
  });

  let isDrawerOpen = $state(false);
  let drawerPanel = $state<HTMLElement | null>(null);
  let menuButton = $state<HTMLButtonElement | null>(null);

  // Desktop sidebar collapse (Phase I-03): component-local shell state,
  // fully independent from the mobile modal drawer above. Collapsing hides
  // only the static column; the drawer, its focus trap, Escape handling,
  // and body-scroll lock are untouched. A restore control stays reachable
  // in the chat header while collapsed.
  let isSidebarCollapsed = $state(false);
  let staticSidebar = $state<HTMLElement | null>(null);
  let restoreButton = $state<HTMLButtonElement | null>(null);

  async function collapseSidebar() {
    isSidebarCollapsed = true;
    // The collapse trigger is hidden by the collapse; move focus to the
    // always-reachable restore control instead of dropping it to body.
    await tick();
    restoreButton?.focus();
  }

  async function restoreSidebar() {
    isSidebarCollapsed = false;
    await tick();
    staticSidebar
      ?.querySelector<HTMLElement>("button[aria-label='收起侧边栏']")
      ?.focus();
  }

  onMount(() => {
    // While the authenticated shell is mounted, the document is locked to
    // the dynamic viewport (see `body.app-shell-lock` in global.css): the
    // shell already sizes itself with 100dvh, and this keeps the body's
    // global `min-height: 100vh` from stretching past the dynamic
    // viewport on mobile (toolbar/keyboard changes), which would produce
    // a bottom gap and a scrollable document. Only the internal
    // panes/lists scroll. The class is removed on unmount so other pages
    // (e.g. auth) keep normal document flow, and it composes with the
    // drawer's temporary inline scroll lock below.
    document.body.classList.add("app-shell-lock");

    // Model catalog loads independently from the conversation list: a
    // catalog failure must surface as a model error, not a chat error.
    void store.load();
    void modelStore.load();

    // Responsive hand-off: crossing into the desktop breakpoint while the
    // modal drawer is open must close it for real. The media query only
    // hides the drawer via CSS; without this the scroll lock would leak
    // and focus would stay inside hidden content. The desktop collapse
    // state is independent and untouched. No focus restore here: the
    // menu button is hidden at this breakpoint, so focus consistently
    // falls back to the document instead of a hidden control.
    let removeMediaListener: (() => void) | undefined;
    if (typeof window.matchMedia === "function") {
      const desktop = window.matchMedia("(min-width: 761px)");
      const handleDesktopEnter = (event: MediaQueryListEvent) => {
        if (event.matches && isDrawerOpen) {
          void closeDrawer();
        }
      };
      desktop.addEventListener("change", handleDesktopEnter);
      removeMediaListener = () => {
        desktop.removeEventListener("change", handleDesktopEnter);
      };
    }
    return () => {
      removeMediaListener?.();
      document.body.classList.remove("app-shell-lock");
    };
  });

  const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function drawerFocusableElements(): HTMLElement[] {
    if (!drawerPanel) return [];
    return Array.from(
      drawerPanel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    );
  }

  async function closeDrawer(restoreFocus = false) {
    isDrawerOpen = false;
    if (restoreFocus) {
      await tick();
      menuButton?.focus();
    }
  }

  function handleDrawerKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void closeDrawer(true);
      return;
    }
    // The drawer is a modal dialog: keep Tab/Shift+Tab cycling inside the
    // panel so focus never escapes to the inert content behind it.
    if (event.key !== "Tab") return;
    const focusable = drawerFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !drawerPanel?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !drawerPanel?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleSelect(id: string) {
    void closeDrawer();
    void store.open(id);
  }

  function handleNew() {
    void closeDrawer(true);
    store.openNew();
    // A settled stream that never released (notably a pre-meta failed draft:
    // `assistantMessageId === null`, so the pane's release effect cannot
    // fire) would keep `isActiveFor(null)` true and leave the stale failure
    // overlay on the brand-new conversation screen. Starting a new
    // conversation is an explicit user action: release any non-busy stream
    // so the empty-draft view renders clean. `clear()` is a no-op while a
    // stream is busy, so mid-stream navigation behavior is untouched.
    generation.clear();
  }

  $effect(() => {
    if (isDrawerOpen) {
      drawerPanel
        ?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?.focus();
    }
  });

  // While the modal drawer is open, lock body scroll so the page behind
  // cannot be scrolled (e.g. iOS rubber-banding through the backdrop).
  // The previous value is restored on close; no global state is involved.
  $effect(() => {
    if (!isDrawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  });
</script>

<div class="shell" class:sidebar-collapsed={isSidebarCollapsed}>
  <aside
    class="sidebar-static"
    aria-label="对话导航"
    bind:this={staticSidebar}
  >
    <Sidebar
      {store}
      {csrfToken}
      onSelect={handleSelect}
      onNew={handleNew}
      {onSignOut}
      {isSigningOut}
      onOpenSettings={() => (isSettingsOpen = true)}
      onCollapse={() => void collapseSidebar()}
    />
  </aside>

  {#if isDrawerOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="drawer" onkeydown={handleDrawerKeydown}>
      <button
        type="button"
        class="drawer-backdrop"
        aria-label="关闭导航"
        tabindex="-1"
        onclick={() => void closeDrawer(true)}
      ></button>
      <div
        class="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="对话导航"
        bind:this={drawerPanel}
      >
        <Sidebar
          {store}
          {csrfToken}
          onSelect={handleSelect}
          onNew={handleNew}
          {onSignOut}
          {isSigningOut}
          onOpenSettings={() => (isSettingsOpen = true)}
          onClose={() => void closeDrawer(true)}
        />
      </div>
    </div>
  {/if}

  <main class="content">
    <ChatPane
      {store}
      {modelStore}
      {generation}
      {csrfToken}
      onOpenDrawer={() => (isDrawerOpen = true)}
      bind:menuButton
      showSidebarRestore={isSidebarCollapsed}
      onRestoreSidebar={() => void restoreSidebar()}
      bind:restoreButton
    />
  </main>

  {#if isSettingsOpen}
    <SettingsDialog {theme} onClose={() => (isSettingsOpen = false)} />
  {/if}
</div>

<style>
  .shell {
    display: grid;
    height: 100vh;
    height: 100dvh;
    grid-template-columns: 300px minmax(0, 1fr);
    transition: grid-template-columns var(--motion-fast);
  }

  .shell.sidebar-collapsed {
    grid-template-columns: 0 minmax(0, 1fr);
  }

  .sidebar-static {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-right: 1px solid var(--border);
  }

  /* `visibility` removes the hidden column from the tab order and the
     accessibility tree; the delay lets the width transition play before
     the content disappears. */
  .shell.sidebar-collapsed .sidebar-static {
    visibility: hidden;
    border-right: none;
    transition: visibility 0s linear 160ms;
  }

  .content {
    min-width: 0;
    min-height: 0;
  }

  .content :global(.pane) {
    height: 100%;
  }

  .drawer {
    position: fixed;
    inset: 0;
    z-index: var(--z-drawer);
  }

  .drawer-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    border: none;
    background: rgb(24 24 27 / 0.45);
    cursor: default;
  }

  .drawer-panel {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(84vw, 320px);
    border-right: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  @media (max-width: 760px) {
    /* Mobile keeps its single column and modal drawer regardless of the
       desktop collapse state. */
    .shell,
    .shell.sidebar-collapsed {
      grid-template-columns: minmax(0, 1fr);
    }

    .sidebar-static {
      display: none;
    }
  }

  @media (min-width: 761px) {
    .drawer {
      display: none;
    }
  }
</style>
