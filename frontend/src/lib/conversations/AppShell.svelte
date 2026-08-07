<script lang="ts">
  import { onMount, tick } from "svelte";

  import { createGenerationStore } from "../generation/generation-store.svelte";
  import { createModelStore } from "../models/model-store.svelte";
  import ChatPane from "./ChatPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { createConversationStore } from "./conversation-store.svelte";

  type Props = {
    csrfToken: string;
    isSigningOut: boolean;
    onSignOut: () => void;
  };

  const { csrfToken, isSigningOut, onSignOut }: Props = $props();

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

  onMount(() => {
    // Model catalog loads independently from the conversation list: a
    // catalog failure must surface as a model error, not a chat error.
    void store.load();
    void modelStore.load();
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

<div class="shell">
  <aside class="sidebar-static" aria-label="对话导航">
    <Sidebar
      {store}
      onSelect={handleSelect}
      onNew={handleNew}
      {onSignOut}
      {isSigningOut}
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
          onSelect={handleSelect}
          onNew={handleNew}
          {onSignOut}
          {isSigningOut}
          onClose={() => void closeDrawer(true)}
        />
      </div>
    </div>
  {/if}

  <main class="content">
    <ChatPane {store} {modelStore} {generation} {csrfToken} onOpenDrawer={() => (isDrawerOpen = true)} bind:menuButton />
  </main>
</div>

<style>
  .shell {
    display: grid;
    height: 100vh;
    height: 100dvh;
    grid-template-columns: 300px minmax(0, 1fr);
  }

  .sidebar-static {
    min-height: 0;
    border-right: 1px solid var(--border);
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
    .shell {
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
