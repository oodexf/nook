<script lang="ts">
  import { onMount } from "svelte";

  import CloseIcon from "./CloseIcon.svelte";
  import type {
    EffectiveTheme,
    ThemePreference,
    ThemeStore
  } from "../theme/theme-store.svelte";

  /**
   * Settings dialog (08-08 UI polish).
   *
   * Same accessibility contract as `ConfirmDialog`: rendered conditionally
   * by the parent so mount equals open; focus moves into the dialog,
   * Tab/Shift+Tab are trapped, Escape and backdrop clicks close, and
   * closing restores focus to the element that opened it.
   */
  type Props = {
    theme: ThemeStore;
    onClose: () => void;
  };

  const { theme, onClose }: Props = $props();

  const titleId = `settings-dialog-title-${Math.random().toString(36).slice(2)}`;

  let dialog = $state<HTMLElement | null>(null);

  const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
    { value: "system", label: "跟随系统", hint: "自动匹配操作系统的浅色/深色设置" },
    { value: "light", label: "浅色", hint: "始终使用浅色外观" },
    { value: "dark", label: "深色", hint: "始终使用深色外观" }
  ];

  function effectiveLabel(effective: EffectiveTheme): string {
    return effective === "dark" ? "深色" : "浅色";
  }

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
      onClose();
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
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  onMount(() => {
    const active = document.activeElement;
    const previouslyFocused =
      active instanceof HTMLElement && active !== document.body
        ? active
        : null;
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  });
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div
    bind:this={dialog}
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
  >
    <div class="dialog-top">
      <h2 id={titleId}>设置</h2>
      <button
        type="button"
        class="close"
        aria-label="关闭设置"
        data-initial-focus
        onclick={onClose}
      >
        <CloseIcon size={18} />
      </button>
    </div>

    <fieldset class="group">
      <legend>主题</legend>
      <div class="options" role="radiogroup" aria-label="主题">
        {#each OPTIONS as option (option.value)}
          <label class="option" class:selected={theme.preference === option.value}>
            <input
              type="radio"
              name="theme-preference"
              value={option.value}
              checked={theme.preference === option.value}
              onchange={() => theme.setPreference(option.value)}
            />
            <span class="option-text">
              <span class="option-label">{option.label}</span>
              <span class="option-hint">{option.hint}</span>
            </span>
          </label>
        {/each}
      </div>
      <p class="current" role="status">
        当前生效:{effectiveLabel(theme.effective)}主题
      </p>
    </fieldset>
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
    width: min(100%, 400px);
    padding: var(--space-5) var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .dialog-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    letter-spacing: -0.01em;
  }

  .close {
    display: inline-flex;
    width: 36px;
    height: 36px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .close:hover {
    color: var(--text);
    background: var(--surface-muted);
  }

  .group {
    margin: var(--space-4) 0 0;
    padding: 0;
    border: none;
  }

  legend {
    padding: 0;
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .options {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .option:hover {
    background: var(--surface-muted);
  }

  .option.selected {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }

  .option input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }

  .option-text {
    display: grid;
    gap: 2px;
  }

  .option-label {
    font-size: 0.92rem;
    font-weight: 650;
  }

  .option-hint {
    color: var(--muted);
    font-size: 0.78rem;
  }

  .current {
    margin: var(--space-3) 0 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
