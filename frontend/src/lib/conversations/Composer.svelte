<script lang="ts">
  import { tick } from "svelte";

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
  };

  let {
    value = $bindable(""),
    disabled,
    streaming,
    stopping = false,
    onSend,
    onStop
  }: Props = $props();

  const MAX_TEXTAREA_HEIGHT = 220;

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let isComposing = $state(false);

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

  // Programmatic value changes (send clears, failure restores) also resize.
  $effect(() => {
    void value;
    void tick().then(resize);
  });
</script>

<div class="composer">
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
  {#if streaming || stopping}
    <button
      type="button"
      class="action stop"
      disabled={stopping}
      onclick={onStop}
    >
      {stopping ? "正在停止…" : "停止"}
    </button>
  {:else}
    <button
      type="button"
      class="action send"
      disabled={!canSend}
      onclick={submit}
    >
      发送
    </button>
  {/if}
</div>

<style>
  .composer {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    /* Keep the composer above the iOS home indicator / software keyboard. */
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  textarea {
    flex: 1;
    min-width: 0;
    min-height: var(--touch-target);
    max-height: 220px;
    padding: var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--bg);
    /* 16px minimum prevents iOS auto-zoom on focus. */
    font-size: 1rem;
    line-height: 1.5;
    resize: none;
    transition: border-color var(--motion-fast);
  }

  textarea:focus {
    border-color: var(--accent);
    outline: none;
  }

  textarea:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .action {
    flex-shrink: 0;
    min-width: 72px;
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-size: 0.95rem;
    font-weight: 650;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .action.send {
    color: var(--accent-contrast);
    background: var(--accent);
  }

  .action.send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, #000000);
  }

  .action.stop {
    border-color: var(--border);
    color: var(--text);
    background: var(--surface);
  }

  .action.stop:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .action:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  @media (max-width: 760px) {
    .composer {
      padding: var(--space-2) var(--space-3);
      padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
