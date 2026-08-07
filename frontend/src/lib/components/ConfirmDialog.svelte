<script lang="ts">
  import { onMount } from "svelte";

  /**
   * Accessible confirmation dialog.
   *
   * Rendered conditionally by the parent (`{#if open}`), so mount equals open:
   * focus moves into the dialog, Tab/Shift+Tab are trapped, Escape and
   * backdrop clicks cancel, and closing restores focus to the element that
   * opened the dialog (or `onRestoreFocus` when that element is gone).
   */
  type Props = {
    title: string;
    description?: string | null;
    confirmLabel: string;
    cancelLabel?: string;
    /** Disables actions while the destructive request is in flight. */
    busy?: boolean;
    /** Inline failure message for a rejected confirmation. */
    errorMessage?: string | null;
    onConfirm: () => void;
    onCancel: () => void;
    /** Fallback focus target when the opener no longer exists (e.g. deleted). */
    onRestoreFocus?: () => void;
  };

  const {
    title,
    description = null,
    confirmLabel,
    cancelLabel = "取消",
    busy = false,
    errorMessage = null,
    onConfirm,
    onCancel,
    onRestoreFocus
  }: Props = $props();

  const titleId = `confirm-dialog-title-${Math.random().toString(36).slice(2)}`;
  const descriptionId = `confirm-dialog-description-${Math.random()
    .toString(36)
    .slice(2)}`;

  let backdrop = $state<HTMLElement | null>(null);
  let dialog = $state<HTMLElement | null>(null);

  function focusableElements(): HTMLElement[] {
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !busy) {
      onCancel();
    }
  }

  onMount(() => {
    const active = document.activeElement;
    const previouslyFocused =
      active instanceof HTMLElement && active !== document.body
        ? active
        : null;
    // Default focus lands on cancel: the destructive action is never the
    // accidental Enter target.
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      } else {
        onRestoreFocus?.();
      }
    };
  });
</script>

<div
  class="backdrop"
  role="presentation"
  bind:this={backdrop}
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div
    bind:this={dialog}
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined}
  >
    <h2 id={titleId}>{title}</h2>
    {#if description}
      <p id={descriptionId} class="description">{description}</p>
    {/if}
    {#if errorMessage}
      <p class="dialog-error" role="alert">{errorMessage}</p>
    {/if}
    <div class="actions">
      <button
        type="button"
        class="cancel"
        data-initial-focus
        disabled={busy}
        onclick={onCancel}
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        class="confirm"
        disabled={busy}
        onclick={onConfirm}
      >
        {busy ? "正在处理…" : confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    display: grid;
    place-items: center;
    padding: var(--space-5);
    background: rgb(24 24 27 / 0.45);
  }

  .dialog {
    width: min(100%, 420px);
    padding: var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    letter-spacing: -0.01em;
  }

  .description {
    margin: var(--space-3) 0 0;
    color: var(--muted);
    font-size: 0.925rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .dialog-error {
    margin: var(--space-3) 0 0;
    color: var(--danger);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }

  .actions button {
    min-height: var(--touch-target);
    min-width: 96px;
    padding: 0 var(--space-4);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-weight: 650;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .actions button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .cancel {
    border-color: var(--border);
    color: var(--text);
    background: var(--surface);
  }

  .cancel:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .confirm {
    color: var(--accent-contrast);
    background: var(--danger);
  }

  .confirm:hover:not(:disabled) {
    background: #98281d;
  }
</style>
