<script lang="ts">
  import RefreshIcon from "../components/RefreshIcon.svelte";
  import type { ModelStore } from "./model-store.svelte";

  /**
   * Accessible model selector for the empty draft conversation.
   *
   * Rendered only before the first message exists; existing conversations
   * show a locked label instead (component-guidelines.md). A stale cached
   * catalog is labelled with a visible retry; a missing configured default
   * or an unusable catalog is a blocking configuration state that never
   * offers an invented model.
   */
  type Props = {
    store: ModelStore;
    csrfToken: string;
  };

  const { store, csrfToken }: Props = $props();

  let refreshNotice = $state<string | null>(null);

  function handleChange(event: Event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;
    if (!store.selectDraftModel(target.value)) {
      // A value outside the catalog is rejected by the store; snap the
      // control back to the authoritative selection.
      target.value = store.draftModelId ?? "";
    }
  }

  async function handleRefresh() {
    if (store.isRefreshing) return;
    refreshNotice = null;
    try {
      await store.refresh(csrfToken);
      refreshNotice = "模型列表已更新。";
    } catch {
      // The store keeps the previous catalog and the latest failure message.
      refreshNotice = null;
    }
  }

  function formatRefreshedAt(milliseconds: number): string {
    return new Date(milliseconds).toLocaleString();
  }
</script>

<section class="model-panel" aria-labelledby="draft-model-title">
  <div class="panel-heading">
    <h3 id="draft-model-title">选择模型</h3>
    {#if store.status === "ready"}
      <button
        type="button"
        class="refresh-button"
        disabled={store.isRefreshing}
        onclick={() => void handleRefresh()}
      >
        <RefreshIcon size={16} />
        <span>{store.isRefreshing ? "正在刷新..." : "刷新模型列表"}</span>
      </button>
    {/if}
  </div>

  {#if store.status === "idle" || store.status === "loading"}
    <p class="panel-note" role="status">正在加载模型列表...</p>
  {:else if store.status === "error"}
    <div class="panel-error">
      <p class="error-text" role="alert">
        {#if store.isConfigurationError}
          模型配置不可用:{store.errorMessage} 请检查部署配置后重试。
        {:else}
          模型列表加载失败:{store.errorMessage}
        {/if}
      </p>
      <button
        type="button"
        class="retry"
        disabled={store.isRefreshing}
        onclick={() => void handleRefresh()}
      >
        {store.isRefreshing ? "正在重试..." : "重试"}
      </button>
    </div>
  {:else}
    {#if store.stale}
      <p class="stale-banner" role="status">
        模型列表可能不是最新({store.refreshError?.message ?? "刷新失败"}),仍可继续使用当前列表。
      </p>
    {/if}
    {#if store.refreshError === null && store.errorMessage}
      <p class="stale-banner" role="alert">上次刷新失败:{store.errorMessage}</p>
    {/if}

    <label class="field-label" for="draft-model-select">对话模型</label>
    <select
      id="draft-model-select"
      class="model-select"
      disabled={store.isRefreshing}
      onchange={handleChange}
    >
      {#each store.models as model (model.id)}
        <option value={model.id} selected={model.id === store.draftModelId}>
          {model.label}
        </option>
      {/each}
    </select>

    <p class="panel-hint">
      默认模型:{store.defaultModel}。发送第一条消息后模型将锁定,无法更改。
    </p>
    {#if store.refreshedAt !== null}
      <p class="panel-meta">
        更新于 {formatRefreshedAt(store.refreshedAt)}{store.stale ? "(缓存)" : ""}
      </p>
    {/if}
  {/if}

  {#if refreshNotice}
    <p class="panel-note" role="status">{refreshNotice}</p>
  {/if}
</section>

<style>
  .model-panel {
    display: grid;
    gap: var(--space-3);
    width: min(100%, 480px);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    text-align: left;
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .refresh-button {
    display: inline-flex;
    min-height: var(--touch-target);
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.82rem;
    font-weight: 650;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .refresh-button:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .refresh-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .field-label {
    font-size: 0.85rem;
    font-weight: 650;
  }

  .model-select {
    width: 100%;
    min-height: var(--control-height);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 1rem;
    transition: border-color var(--motion-fast);
  }

  .model-select:focus {
    border-color: var(--accent);
  }

  .model-select:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .panel-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }

  .panel-error {
    display: grid;
    gap: var(--space-3);
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.875rem;
    line-height: 1.6;
  }

  .retry {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-weight: 650;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .retry:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .stale-banner {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, #b45309 35%, var(--surface));
    border-radius: var(--radius-sm);
    color: #92400e;
    background: color-mix(in srgb, #f59e0b 10%, var(--surface));
    font-size: 0.82rem;
    line-height: 1.5;
  }

  .panel-hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .panel-meta {
    margin: 0;
    color: var(--muted);
    font-size: 0.75rem;
  }
</style>
