<script lang="ts">
  import CheckIcon from "../components/CheckIcon.svelte";
  import ChevronsUpDownIcon from "../components/ChevronsUpDownIcon.svelte";
  import RefreshIcon from "../components/RefreshIcon.svelte";
  import type { ModelStore } from "./model-store.svelte";

  /**
   * Composer-embedded model selector for the empty draft conversation
   * (08-10 new chat UI upgrade). It replaces the old centered model panel:
   * the trigger sits left of the send button and shows the current draft
   * model; clicking opens a popover card above the composer that owns every
   * catalog state the panel used to render (loading, error, configuration
   * error, stale cache, refresh). Selecting a model applies it through
   * `store.selectDraftModel` (validated + persisted) and closes the card.
   *
   * Rendered only in the draft view by ChatPane; existing conversations
   * keep the locked-model label in the header instead. All glyphs are
   * Lucide inline icons; no emoji anywhere (project iconography rule).
   */
  type Props = {
    store: ModelStore;
    csrfToken: string;
  };

  const { store, csrfToken }: Props = $props();

  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let open = $state(false);
  let refreshNotice = $state<string | null>(null);

  const currentLabel = $derived(
    store.models.find((model) => model.id === store.draftModelId)?.label ??
      store.draftModelId ??
      "选择模型"
  );

  function closePopover(restoreFocus: boolean) {
    if (!open) return;
    open = false;
    if (restoreFocus) trigger?.focus();
  }

  function togglePopover() {
    if (open) {
      closePopover(false);
    } else {
      refreshNotice = null;
      open = true;
    }
  }

  function selectModel(id: string) {
    // The store validates catalog membership and persists the pick; only a
    // successful application closes the card.
    if (store.selectDraftModel(id)) closePopover(true);
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

  // Dismissal contract: Escape or a pointer press outside the popover
  // closes it and returns focus to the trigger.
  $effect(() => {
    if (!open) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover(true);
      }
    }
    function handlePointerDown(event: PointerEvent) {
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        closePopover(false);
      }
    }
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  });
</script>

<div class="model-switcher" bind:this={root}>
  <button
    type="button"
    class="model-trigger"
    bind:this={trigger}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={`选择模型,当前为 ${currentLabel}`}
    title="选择模型"
    onclick={togglePopover}
  >
    <span class="trigger-label">{currentLabel}</span>
    <ChevronsUpDownIcon size={14} />
  </button>

  {#if open}
    <div
      class="model-popover"
      role="dialog"
      aria-label="选择模型"
    >
      <div class="popover-heading">
        <h3 class="popover-title">选择模型</h3>
        {#if store.status === "ready"}
          <button
            type="button"
            class="refresh-button"
            disabled={store.isRefreshing}
            onclick={() => void handleRefresh()}
          >
            <RefreshIcon size={14} />
            <span>{store.isRefreshing ? "正在刷新..." : "刷新模型列表"}</span>
          </button>
        {/if}
      </div>

      {#if store.status === "idle" || store.status === "loading"}
        <p class="popover-note" role="status">正在加载模型列表...</p>
      {:else if store.status === "error"}
        <div class="popover-error">
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

        <ul class="model-list" aria-label="可用模型">
          {#each store.models as model (model.id)}
            <li>
              <button
                type="button"
                class="model-option"
                class:selected={model.id === store.draftModelId}
                aria-pressed={model.id === store.draftModelId}
                onclick={() => selectModel(model.id)}
              >
                <span class="option-label">{model.label}</span>
                {#if model.id === store.draftModelId}
                  <CheckIcon size={16} />
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if refreshNotice}
        <p class="popover-note" role="status">{refreshNotice}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-switcher {
    position: relative;
    flex-shrink: 0;
  }

  /* Trigger: a quiet pill that reads as part of the composer chrome until
     hovered, then gains a surface and border. */
  .model-trigger {
    display: inline-flex;
    max-width: 180px;
    min-height: 36px;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: 999px;
    color: var(--muted);
    background: transparent;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    transition:
      border-color var(--motion-fast),
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .model-trigger:hover,
  .model-trigger[aria-expanded="true"] {
    border-color: var(--border);
    color: var(--text);
    background: var(--surface-muted);
  }

  .trigger-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Popover card: elevated surface floating above the composer with a soft
     entrance motion (CSS-only; the global reduced-motion rule collapses
     it, and it never depends on the Web Animations API). */
  @keyframes popover-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .model-popover {
    position: absolute;
    right: 0;
    bottom: calc(100% + var(--space-2));
    z-index: var(--z-dialog);
    display: grid;
    gap: var(--space-3);
    width: max-content;
    min-width: 260px;
    max-width: min(320px, calc(100vw - 2 * var(--space-4)));
    max-height: min(60vh, 380px);
    padding: var(--space-3);
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow);
    text-align: left;
    animation: popover-in 180ms ease;
  }

  .popover-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .popover-title {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .refresh-button {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.75rem;
    font-weight: 650;
    transition:
      border-color var(--motion-fast),
      background-color var(--motion-fast),
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

  .popover-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .popover-error {
    display: grid;
    gap: var(--space-2);
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.82rem;
    line-height: 1.6;
  }

  .retry {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.85rem;
    font-weight: 650;
    transition:
      border-color var(--motion-fast),
      background-color var(--motion-fast);
  }

  .retry:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .stale-banner {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--warning-text) 35%, var(--surface));
    border-radius: var(--radius-sm);
    color: var(--warning-text);
    background: color-mix(in srgb, var(--warning-text) 8%, var(--surface));
    font-size: 0.78rem;
    line-height: 1.5;
  }

  .model-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .model-option {
    display: flex;
    width: 100%;
    min-height: var(--touch-target);
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text);
    background: transparent;
    font-size: 0.875rem;
    text-align: left;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .model-option:hover {
    background: var(--surface-muted);
  }

  .model-option.selected {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    font-weight: 650;
  }

  .option-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
