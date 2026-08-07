<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    variant?: "primary" | "secondary";
    fullWidth?: boolean;
    type?: "button" | "submit";
    disabled?: boolean;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  };

  const {
    variant = "primary",
    fullWidth = false,
    type = "button",
    disabled = false,
    onclick,
    children
  }: Props = $props();
</script>

<button
  class:button-secondary={variant === "secondary"}
  class:button-full={fullWidth}
  {type}
  {disabled}
  {onclick}
>
  {@render children()}
</button>

<style>
  button {
    display: inline-flex;
    min-height: var(--control-height);
    align-items: center;
    justify-content: center;
    padding: 0 var(--space-5);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--accent-contrast);
    background: var(--text);
    font-weight: 700;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      opacity var(--motion-fast);
  }

  button:hover:not(:disabled) {
    background: var(--text-strong);
  }

  button:active:not(:disabled) {
    opacity: 0.85;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .button-secondary {
    border-color: var(--border);
    color: var(--text);
    background: var(--surface);
  }

  .button-secondary:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .button-full {
    width: 100%;
  }
</style>
