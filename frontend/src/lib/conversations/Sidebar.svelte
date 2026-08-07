<script lang="ts">
  import CloseIcon from "../components/CloseIcon.svelte";
  import PlusIcon from "../components/PlusIcon.svelte";
  import type { ConversationStore } from "./conversation-store.svelte";

  type Props = {
    store: ConversationStore;
    /** Rendered inside the mobile drawer: shows a close control. */
    onClose?: (() => void) | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onSignOut: () => void;
    isSigningOut: boolean;
  };

  const {
    store,
    onClose = null,
    onSelect,
    onNew,
    onSignOut,
    isSigningOut
  }: Props = $props();
</script>

<div class="sidebar">
  <div class="sidebar-top">
    <span class="brand">Minimal AI Chat</span>
    {#if onClose}
      <button
        type="button"
        class="icon-button"
        aria-label="关闭导航"
        onclick={onClose}
      >
        <CloseIcon size={20} />
      </button>
    {/if}
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
            <button
              type="button"
              class="item"
              class:item-active={store.selectedId === item.id}
              aria-current={store.selectedId === item.id ? "true" : undefined}
              onclick={() => onSelect(item.id)}
            >
              <span class="item-title">{item.title}</span>
              <span class="item-model">{item.model}</span>
            </button>
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
      class="sign-out"
      disabled={isSigningOut}
      onclick={onSignOut}
    >
      {isSigningOut ? "正在退出…" : "退出登录"}
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
    font-size: 0.95rem;
    font-weight: 750;
    letter-spacing: -0.01em;
  }

  .icon-button {
    display: inline-flex;
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

  .item {
    display: grid;
    width: 100%;
    min-height: var(--touch-target);
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text);
    background: transparent;
    text-align: left;
    transition: background-color var(--motion-fast);
  }

  .item:hover {
    background: var(--surface-muted);
  }

  .item-active,
  .item-active:hover {
    background: var(--surface-muted);
    box-shadow: inset 2px 0 0 var(--accent);
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

  .sidebar-footer {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
  }

  .sign-out {
    min-height: var(--touch-target);
    width: 100%;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
    font-size: 0.875rem;
    font-weight: 600;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .sign-out:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-muted);
  }

  .sign-out:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
