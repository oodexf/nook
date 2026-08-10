<script lang="ts">
  import { untrack } from "svelte";

  import ChevronRightIcon from "./ChevronRightIcon.svelte";

  /**
   * Collapsible thinking-chain block shared by the in-flight turn
   * (`StreamingTurn`) and persisted assistant messages (`MessageItem`).
   *
   * Collapse contract (task 08-10):
   * - streaming turns start expanded so the chain is visible while it
   *   grows; persisted history starts collapsed;
   * - when the answer content starts (`contentStarted`), the block
   *   auto-collapses exactly once — and only if the user has not manually
   *   toggled yet. After that the block is fully user-controlled;
   * - reasoning renders as plain text (never Markdown) in a de-emphasized
   *   style; the header is the single toggle, keyboard reachable with
   *   `aria-expanded` state.
   */
  type Props = {
    reasoning: string;
    /** True while the thinking chain may still be growing. */
    streaming: boolean;
    /** True once answer content started arriving (or exists in history). */
    contentStarted: boolean;
    /** Initial expanded state: true for live streams, false for history. */
    initiallyExpanded: boolean;
  };

  const {
    reasoning,
    streaming,
    contentStarted,
    initiallyExpanded
  }: Props = $props();

  // The prop only seeds the initial state; afterwards the block is
  // controlled by the user and the one-shot auto-collapse.
  let expanded = $state(untrack(() => initiallyExpanded));
  let userToggled = false;
  let hasAutoCollapsed = false;

  $effect(() => {
    if (contentStarted && !hasAutoCollapsed && !userToggled) {
      hasAutoCollapsed = true;
      expanded = false;
    }
  });

  function toggle(): void {
    userToggled = true;
    expanded = !expanded;
  }

  const label = $derived(streaming ? "正在思考…" : "思考过程");
  const panelId = `reasoning-panel-${Math.random().toString(36).slice(2)}`;
</script>

<section class="reasoning" data-streaming={streaming}>
  <button
    type="button"
    class="toggle"
    aria-expanded={expanded}
    aria-controls={panelId}
    onclick={toggle}
  >
    <span class="chevron" data-expanded={expanded}>
      <ChevronRightIcon size={14} />
    </span>
    <span class="label">{label}</span>
  </button>
  {#if expanded}
    <div class="panel" id={panelId}>
      <p class="text">{reasoning}</p>
    </div>
  {/if}
</section>

<style>
  .reasoning {
    display: grid;
    gap: var(--space-1);
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    width: fit-content;
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    background: var(--surface);
    font: inherit;
    font-size: 0.72rem;
    font-weight: 650;
    cursor: pointer;
  }

  .toggle:hover {
    background: var(--surface-muted);
  }

  .reasoning[data-streaming="true"] .toggle {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  }

  .chevron {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  .chevron[data-expanded="true"] {
    transform: rotate(90deg);
  }

  .panel {
    padding: var(--space-2) var(--space-3);
    border-left: 2px solid var(--border);
  }

  .text {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>
