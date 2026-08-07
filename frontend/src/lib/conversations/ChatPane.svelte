<script lang="ts">
  import { tick, untrack } from "svelte";

  import { errorMessageOf } from "../api/client";
  import ArrowDownIcon from "../components/ArrowDownIcon.svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import MenuIcon from "../components/MenuIcon.svelte";
  import PencilIcon from "../components/PencilIcon.svelte";
  import TrashIcon from "../components/TrashIcon.svelte";
  import StreamingTurn from "../generation/StreamingTurn.svelte";
  import type { GenerationStore } from "../generation/generation-store.svelte";
  import Composer from "./Composer.svelte";
  import {
    clearDraft,
    draftKeyFor,
    readDraft,
    writeDraft
  } from "./draft-storage";
  import EmptyConversation from "./EmptyConversation.svelte";
  import MessageList from "./MessageList.svelte";
  import type { ModelStore } from "../models/model-store.svelte";
  import type { ConversationStore } from "./conversation-store.svelte";

  type Props = {
    store: ConversationStore;
    modelStore: ModelStore;
    generation: GenerationStore;
    csrfToken: string;
    onOpenDrawer: () => void;
    /** Exposed so the shell can restore focus after the drawer closes. */
    menuButton?: HTMLButtonElement | null;
  };

  let {
    store,
    modelStore,
    generation,
    csrfToken,
    onOpenDrawer,
    menuButton = $bindable(null)
  }: Props = $props();

  const MAX_TITLE_LENGTH = 200;

  let contentRegion = $state<HTMLElement | null>(null);
  let renameButton = $state<HTMLButtonElement | null>(null);
  let renameInput = $state<HTMLInputElement | null>(null);

  let isRenaming = $state(false);
  let renameDraft = $state("");
  let renameError = $state<string | null>(null);
  let isRenameBusy = $state(false);

  let isDeleteOpen = $state(false);
  let deleteError = $state<string | null>(null);
  let isDeleteBusy = $state(false);

  let composerValue = $state("");

  // --- Unsent draft persistence (F-08) -------------------------------
  // Keyed by the visible view: the server conversation ID, or "new" for
  // the empty-draft view. Sending empties the composer, which removes the
  // stored entry; a pre-stream failure restores the text and the draft.
  let draftKey = $state<string | null>(null);

  $effect(() => {
    const key = draftKeyFor(store.selectedId);
    if (key === draftKey) return;
    draftKey = key;
    composerValue = key === null ? "" : (readDraft(key) ?? "");
  });

  $effect(() => {
    const key = draftKey;
    const value = composerValue;
    if (key === null) return;
    writeDraft(key, value);
  });

  // --- Auto-follow / return-to-bottom (F-03) --------------------------
  // The output follows growth only while the user is near the bottom; any
  // scroll away from the bottom (a deliberate upward scroll) disables
  // following until the user returns or uses the jump control. While
  // unfollowed, new streamed output raises a polite "new content"
  // indicator instead of yanking the viewport.
  const NEAR_BOTTOM_THRESHOLD_PX = 80;

  let followOutput = $state(true);
  let newOutputBelow = $state(false);

  function isNearBottom(element: HTMLElement): boolean {
    return (
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      NEAR_BOTTOM_THRESHOLD_PX
    );
  }

  function scrollToBottom(behavior: "auto" | "smooth"): void {
    const element = contentRegion;
    if (!element || typeof element.scrollTo !== "function") return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }

  function handleBodyScroll() {
    const element = contentRegion;
    if (!element) return;
    const near = isNearBottom(element);
    followOutput = near;
    if (near) newOutputBelow = false;
  }

  function jumpToBottom() {
    followOutput = true;
    newOutputBelow = false;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollToBottom(reduceMotion ? "auto" : "smooth");
    // The button unmounts once following resumes; keep focus in the pane.
    contentRegion?.focus({ preventScroll: true });
  }

  // Reset follow state when the visible conversation changes.
  $effect(() => {
    void store.selectedId;
    followOutput = true;
    newOutputBelow = false;
  });

  // React to content growth: follow when pinned to the bottom, otherwise
  // raise the new-output indicator for incoming stream content.
  $effect(() => {
    void store.detailStatus;
    void store.current?.messages;
    void generation.streamingText;
    void generation.pendingUserContent;
    void streamVisible;
    if (untrack(() => followOutput)) {
      void tick().then(() => scrollToBottom("auto"));
    } else if (
      generation.phase === "connecting" ||
      generation.phase === "streaming"
    ) {
      newOutputBelow = true;
    }
  });

  // The generation overlay is shown only in the view that owns the stream:
  // the draft view before `meta`, or the conversation whose ID matches.
  // Navigating elsewhere never receives another conversation's stream.
  const streamVisible = $derived(generation.isActiveFor(store.selectedId));

  const showJumpToBottom = $derived(
    !followOutput && (store.current !== null || streamVisible)
  );

  // Dedup against server state: once the persisted user message (matched by
  // idempotency key) or assistant placeholder arrives via open/reload, the
  // overlay yields to the authoritative rows — never rendering both.
  const serverHasUserMessage = $derived(
    streamVisible &&
      generation.clientMessageId !== null &&
      (store.current?.messages.some(
        (message) => message.clientMessageId === generation.clientMessageId
      ) ??
        false)
  );
  const pendingUserContent = $derived(
    streamVisible && !serverHasUserMessage
      ? generation.pendingUserContent
      : null
  );
  const excludedMessageIds = $derived(
    streamVisible && generation.assistantMessageId !== null
      ? [generation.assistantMessageId]
      : []
  );

  const lockedModelRemoved = $derived(
    store.detailStatus === "ready" &&
      store.current !== null &&
      modelStore.status === "ready" &&
      !modelStore.isModelAvailable(store.current.conversation.model)
  );

  // canSend gating (derived, not stored): the pane must be in a sendable
  // view, a draft must have a selected catalog model, and a locked
  // conversation whose model left the catalog cannot send.
  const composerDisabled = $derived(
    (store.detailStatus !== "ready" && store.detailStatus !== "idle") ||
      (store.detailStatus === "idle" &&
        (modelStore.status !== "ready" || modelStore.draftModelId === null)) ||
      lockedModelRemoved
  );

  async function handleSend(content: string) {
    if (composerDisabled || generation.isBusy) return;
    const conversationId =
      store.detailStatus === "ready" ? store.selectedId : null;
    if (conversationId === null && modelStore.draftModelId === null) return;
    composerValue = "";
    await generation.send({
      conversationId,
      content,
      model: modelStore.draftModelId,
      csrfToken
    });
    // Pre-stream failure (HTTP error before `meta`): no server-side message
    // exists, so restore the composer content for correction and resend.
    if (
      generation.phase === "failed" &&
      generation.assistantMessageId === null &&
      generation.isActiveFor(conversationId)
    ) {
      composerValue = content;
    }
  }

  function handleStop() {
    void generation.stop(csrfToken);
  }

  function handleRetry(assistantMessageId: string) {
    const conversationId = store.selectedId;
    if (conversationId === null || generation.isBusy) return;
    void generation.retry({ conversationId, assistantMessageId, csrfToken });
  }

  async function startRename() {
    const current = store.current;
    if (!current || isRenameBusy) return;
    renameDraft = current.conversation.title;
    renameError = null;
    isRenaming = true;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  async function finishRename(restoreFocus: boolean) {
    isRenaming = false;
    renameError = null;
    if (restoreFocus) {
      await tick();
      renameButton?.focus();
    }
  }

  async function handleRenameSubmit(event: SubmitEvent) {
    event.preventDefault();
    const current = store.current;
    if (!current || isRenameBusy) return;
    const title = renameDraft.trim();
    if (title.length === 0) {
      renameError = "标题不能为空。";
      return;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      renameError = `标题不能超过 ${MAX_TITLE_LENGTH} 个字符。`;
      return;
    }
    if (title === current.conversation.title) {
      await finishRename(true);
      return;
    }
    isRenameBusy = true;
    renameError = null;
    try {
      await store.rename(current.conversation.id, title, csrfToken);
      isRenaming = false;
      await tick();
      renameButton?.focus();
    } catch (error) {
      renameError = errorMessageOf(error);
    } finally {
      isRenameBusy = false;
    }
  }

  function openDelete() {
    if (store.current) {
      deleteError = null;
      isDeleteOpen = true;
    }
  }

  async function handleDeleteConfirm() {
    const current = store.current;
    if (!current || isDeleteBusy) return;
    isDeleteBusy = true;
    deleteError = null;
    try {
      await store.remove(current.conversation.id, csrfToken);
      // A deleted conversation's unsent draft is unreachable; drop it.
      const key = draftKeyFor(current.conversation.id);
      if (key !== null) clearDraft(key);
      isDeleteOpen = false;
    } catch (error) {
      deleteError = errorMessageOf(error);
    } finally {
      isDeleteBusy = false;
    }
  }
</script>

<section class="pane" aria-label="对话内容">
  <header class="pane-header">
    <button
      type="button"
      class="icon-button menu-button"
      aria-label="打开导航"
      bind:this={menuButton}
      onclick={onOpenDrawer}
    >
      <MenuIcon size={22} />
    </button>

    {#if store.detailStatus === "ready" && store.current}
      {#if isRenaming}
        <form class="rename-form" onsubmit={handleRenameSubmit}>
          <label class="visually-hidden" for="rename-title">对话标题</label>
          <input
            id="rename-title"
            bind:this={renameInput}
            bind:value={renameDraft}
            maxlength={MAX_TITLE_LENGTH}
            disabled={isRenameBusy}
          />
          <button type="submit" class="text-action" disabled={isRenameBusy}>
            {isRenameBusy ? "正在保存…" : "保存"}
          </button>
          <button
            type="button"
            class="text-action"
            disabled={isRenameBusy}
            onclick={() => void finishRename(true)}
          >
            取消
          </button>
        </form>
      {:else}
        <div class="title-group">
          <h1 class="title">{store.current.conversation.title}</h1>
          <span class="locked-model">{store.current.conversation.model}</span>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="icon-button"
            aria-label="重命名对话"
            bind:this={renameButton}
            onclick={() => void startRename()}
          >
            <PencilIcon size={18} />
          </button>
          <button
            type="button"
            class="icon-button danger"
            aria-label="删除对话"
            onclick={openDelete}
          >
            <TrashIcon size={18} />
          </button>
        </div>
      {/if}
    {:else}
      <span class="header-placeholder">Minimal AI Chat</span>
    {/if}
  </header>

  {#if store.detailStatus === "ready" && store.current && !modelStore.isModelAvailable(store.current.conversation.model) && modelStore.status === "ready"}
    <!-- The locked model is gone from the catalog: history stays readable -->
    <!-- but new messages are blocked server-side (409 model_unavailable). -->
    <p class="model-unavailable" role="status">
      此对话锁定的模型 <code>{store.current.conversation.model}</code> 已从提供商目录中移除;历史消息仍可查看,但无法发送新消息。
    </p>
  {/if}

  {#if renameError && isRenaming}
    <p class="rename-error" role="alert">{renameError}</p>
  {/if}

  <div class="scroll-area">
  <div
    class="pane-body"
    bind:this={contentRegion}
    tabindex="-1"
    onscroll={handleBodyScroll}
  >
    {#if store.detailStatus === "idle" && !streamVisible}
      <EmptyConversation {modelStore} {csrfToken} />
    {:else if store.detailStatus === "loading" && !streamVisible}
      <p class="pane-note" role="status">正在加载对话…</p>
    {:else if store.detailStatus === "error"}
      <div class="pane-error">
        <p class="pane-note" role="alert">{store.detailError}</p>
        {#if store.selectedId}
          <button
            type="button"
            class="retry"
            onclick={() => {
              const id = store.selectedId;
              if (id) void store.open(id);
            }}
          >
            重试
          </button>
        {/if}
      </div>
    {:else if store.current || streamVisible}
      <div class="messages-scroll">
        {#if store.current}
          {#if store.current.messages.length === 0 && !streamVisible}
            <p class="pane-note">对话还没有消息。</p>
          {:else}
            <MessageList
              messages={store.current.messages}
              {excludedMessageIds}
              onRetry={handleRetry}
              retryDisabled={generation.isBusy}
            />
          {/if}
        {/if}
        {#if streamVisible}
          <StreamingTurn
            userContent={pendingUserContent}
            assistantText={generation.streamingText}
            phase={generation.phase}
            terminal={generation.terminal}
            model={generation.model}
          />
        {/if}
      </div>
    {/if}
  </div>

  {#if showJumpToBottom}
    <button
      type="button"
      class="to-bottom"
      class:has-new={newOutputBelow}
      onclick={jumpToBottom}
    >
      <ArrowDownIcon size={18} />
      <span>{newOutputBelow ? "新内容" : "回到底部"}</span>
    </button>
  {/if}
  <!-- Polite, transition-only announcement for new output arriving while -->
  <!-- the user reads history above the bottom. -->
  <span class="visually-hidden" role="status" aria-live="polite"
    >{newOutputBelow ? "下方有新内容" : ""}</span
  >
  </div>

  {#if store.detailStatus !== "error"}
    <Composer
      bind:value={composerValue}
      disabled={composerDisabled}
      streaming={generation.phase === "connecting" || generation.phase === "streaming"}
      stopping={generation.phase === "stopping"}
      onSend={(content) => void handleSend(content)}
      onStop={handleStop}
    />
  {/if}
</section>

{#if isDeleteOpen && store.current}
  <ConfirmDialog
    title="删除对话"
    description={`将永久删除“${store.current.conversation.title}”及其所有消息，此操作无法撤销。`}
    confirmLabel="永久删除"
    busy={isDeleteBusy}
    errorMessage={deleteError}
    onConfirm={() => void handleDeleteConfirm()}
    onCancel={() => {
      if (!isDeleteBusy) isDeleteOpen = false;
    }}
    onRestoreFocus={() => contentRegion?.focus()}
  />
{/if}

<style>
  .pane {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    background: var(--bg);
  }

  .pane-header {
    display: flex;
    min-height: 60px;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
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

  .icon-button.danger:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
  }

  .menu-button {
    display: none;
  }

  .title-group {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: baseline;
    gap: var(--space-3);
  }

  .title {
    overflow: hidden;
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .locked-model {
    overflow: hidden;
    flex-shrink: 1;
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-actions {
    display: flex;
    flex-shrink: 0;
    gap: var(--space-1);
  }

  .model-unavailable {
    margin: 0;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    color: #92400e;
    background: color-mix(in srgb, #f59e0b 10%, var(--surface));
    font-size: 0.82rem;
    line-height: 1.5;
  }

  .model-unavailable code {
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }

  .header-placeholder {
    color: var(--muted);
    font-size: 0.9rem;
    font-weight: 650;
  }

  .rename-form {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: var(--space-2);
  }

  .rename-form input {
    min-width: 0;
    flex: 1;
    min-height: var(--touch-target);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.95rem;
  }

  .rename-form input:focus {
    border-color: var(--accent);
  }

  .text-action {
    flex-shrink: 0;
    min-height: var(--touch-target);
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.85rem;
    font-weight: 650;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .text-action:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .text-action:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .rename-error {
    margin: 0;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    color: var(--danger);
    background: var(--surface);
    font-size: 0.85rem;
  }

  .scroll-area {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    outline: none;
  }

  .to-bottom {
    position: absolute;
    bottom: var(--space-4);
    left: 50%;
    display: inline-flex;
    min-height: var(--touch-target);
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: 0.85rem;
    font-weight: 650;
    transform: translateX(-50%);
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .to-bottom:hover {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .to-bottom.has-new {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    color: var(--accent);
  }

  .messages-scroll {
    width: min(100%, 760px);
    margin: 0 auto;
    padding: var(--space-5);
  }

  .pane-note {
    margin: var(--space-6) 0 0;
    color: var(--muted);
    font-size: 0.9rem;
    text-align: center;
  }

  .pane-error {
    display: grid;
    justify-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-5);
  }

  .pane-error .retry {
    min-height: var(--touch-target);
    padding: 0 var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-weight: 650;
  }

  .pane-error .retry:hover {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  @media (max-width: 760px) {
    .menu-button {
      display: inline-flex;
    }

    .messages-scroll {
      padding: var(--space-4) var(--space-3);
    }
  }
</style>
