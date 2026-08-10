<script lang="ts">
  import { tick } from "svelte";
  import type { Snippet } from "svelte";

  import ArrowUpIcon from "../components/ArrowUpIcon.svelte";
  import CloseIcon from "../components/CloseIcon.svelte";
  import PlusIcon from "../components/PlusIcon.svelte";
  import StopIcon from "../components/StopIcon.svelte";

  /**
   * Message composer (spec: component-guidelines.md).
   *
   * - Enter sends, Shift+Enter inserts a newline;
   * - IME composition (compositionstart/end + isComposing) suppresses
   *   send-on-Enter;
   * - the textarea auto-resizes up to a cap, then scrolls;
   * - 16px input font and dvh-safe layout keep iOS from zooming and keep the
   *   composer visible above the software keyboard;
   * - send is disabled for empty input, while busy, or when the surrounding
   *   pane marks the composer unavailable; stop is offered while streaming.
   *
   * Visual design (08-08 UI polish): a single rounded "pill" container
   * holds the textarea and the round send/stop button, ChatGPT-style. The
   * leading "+" button opens a local file picker; selected files are shown
   * as removable chips above the input but are NOT sent with the message
   * (the backend has no attachment support yet — display only, per PRD).
   */
  type Props = {
    /** Two-way bound so the parent can restore content after a failed send. */
    value?: string;
    /** External gate: no model, locked-model removed, pane not ready, ... */
    disabled: boolean;
    /** A generation is in flight: show Stop instead of Send. */
    streaming: boolean;
    /** Stop has been requested and is reconciling. */
    stopping?: boolean;
    onSend: (content: string) => void;
    onStop: () => void;
    /**
     * Optional control rendered immediately left of the send/stop button
     * (08-10: the draft model selector). Composer stays domain-agnostic;
     * ChatPane decides what, if anything, is injected here.
     */
    beforeSend?: Snippet;
  };

  let {
    value = $bindable(""),
    disabled,
    streaming,
    stopping = false,
    onSend,
    onStop,
    beforeSend
  }: Props = $props();

  const MAX_TEXTAREA_HEIGHT = 220;
  /** Display-only guardrail against pathological picker selections. */
  const MAX_ATTACHMENTS = 8;

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let isComposing = $state(false);
  let attachments = $state<string[]>([]);

  const canSend = $derived(
    !disabled && !streaming && !stopping && value.trim().length > 0
  );

  function resize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  function submit() {
    if (!canSend) return;
    // Attachments are display-only for now, so a send simply drops them.
    attachments = [];
    onSend(value.trim());
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // IME: Enter that confirms a composition must never send. keyCode 229
    // covers browsers that do not set isComposing on keydown.
    if (isComposing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }

  function handleCompositionStart() {
    isComposing = true;
  }

  function handleCompositionEnd() {
    isComposing = false;
  }

  function openFilePicker() {
    fileInput?.click();
  }

  function handleFilesSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      if (!attachments.includes(file.name)) {
        attachments.push(file.name);
      }
    }
    // Allow re-selecting the same file after removal / after send.
    input.value = "";
  }

  function removeAttachment(name: string) {
    attachments = attachments.filter((entry) => entry !== name);
  }

  // Programmatic value changes (send clears, failure restores) also resize.
  $effect(() => {
    void value;
    void tick().then(resize);
  });
</script>

<div class="composer">
  <input
    bind:this={fileInput}
    class="visually-hidden"
    type="file"
    multiple
    tabindex="-1"
    aria-hidden="true"
    onchange={handleFilesSelected}
  />
  <div class="composer-card">
    {#if attachments.length > 0}
      <ul class="attachments" aria-label="已选择的文件(仅展示,不会发送)">
        {#each attachments as name (name)}
          <li class="attachment">
            <span class="attachment-name">{name}</span>
            <button
              type="button"
              class="attachment-remove"
              aria-label={`移除文件 ${name}`}
              onclick={() => removeAttachment(name)}
            >
              <CloseIcon size={12} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="composer-row">
      <button
        type="button"
        class="round-button attach"
        aria-label="添加本地文件"
        title="添加本地文件(仅展示,不会随消息发送)"
        disabled={disabled && !streaming}
        onclick={openFilePicker}
      >
        <PlusIcon size={20} />
      </button>
      <label class="visually-hidden" for="composer-input">消息输入框</label>
      <textarea
        id="composer-input"
        bind:this={textarea}
        bind:value
        rows="1"
        placeholder="输入消息,Enter 发送,Shift+Enter 换行"
        disabled={disabled && !streaming}
        oninput={resize}
        onkeydown={handleKeydown}
        oncompositionstart={handleCompositionStart}
        oncompositionend={handleCompositionEnd}
      ></textarea>
      {@render beforeSend?.()}
      {#if streaming || stopping}
        <button
          type="button"
          class="round-button stop"
          aria-label={stopping ? "正在停止" : "停止生成"}
          title={stopping ? "正在停止..." : "停止"}
          disabled={stopping}
          onclick={onStop}
        >
          <StopIcon size={16} />
        </button>
      {:else}
        <button
          type="button"
          class="round-button send"
          aria-label="发送消息"
          title="发送"
          disabled={!canSend}
          onclick={submit}
        >
          <ArrowUpIcon size={18} />
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .composer {
    padding: var(--space-3) var(--space-4);
    /* Keep the composer above the iOS home indicator / software keyboard. */
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
    background: var(--bg);
  }

  /* ChatGPT-style card: a single rounded shell owns the border and
     shadow; the textarea inside is borderless. */
  .composer-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(100%, 900px);
    margin: 0 auto;
    padding: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
    transition: border-color var(--motion-fast);
  }

  .composer-card:focus-within {
    border-color: var(--accent);
  }

  .composer-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  textarea {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    max-height: 220px;
    padding: 6px var(--space-2);
    border: none;
    color: var(--text);
    background: transparent;
    /* 16px minimum prevents iOS auto-zoom on focus. */
    font-size: 1rem;
    line-height: 1.5;
    resize: none;
  }

  textarea:focus {
    outline: none;
  }

  textarea:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .round-button {
    display: inline-flex;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 50%;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .round-button.attach {
    color: var(--muted);
    background: transparent;
  }

  .round-button.attach:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-muted);
  }

  .round-button.send {
    color: var(--accent-contrast);
    background: var(--text);
  }

  .round-button.send:hover:not(:disabled) {
    background: var(--text-strong);
  }

  .round-button.stop {
    color: var(--accent-contrast);
    background: var(--text);
  }

  .round-button.stop:hover:not(:disabled) {
    background: var(--text-strong);
  }

  .round-button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  /* Display-only selected files (never sent; see PRD 08-08). */
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-1) var(--space-1) 0;
    list-style: none;
  }

  .attachment {
    display: inline-flex;
    max-width: 100%;
    min-height: 28px;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    background: var(--surface-muted);
    font-size: 0.78rem;
  }

  .attachment-name {
    overflow: hidden;
    max-width: 220px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-remove {
    display: inline-flex;
    width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 50%;
    color: var(--muted);
    background: transparent;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .attachment-remove:hover {
    color: var(--text);
    background: var(--border);
  }

  @media (max-width: 760px) {
    .composer {
      padding: var(--space-2) var(--space-3);
      padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
