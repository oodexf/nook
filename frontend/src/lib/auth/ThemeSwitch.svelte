<script lang="ts">
  import MonitorIcon from "../components/MonitorIcon.svelte";
  import MoonIcon from "../components/MoonIcon.svelte";
  import SunIcon from "../components/SunIcon.svelte";
  import type { ThemePreference, ThemeStore } from "../theme/theme-store.svelte";

  /**
   * Theme control for the auth page: a three-segment pill (跟随系统 / 浅色 /
   * 深色) rather than a popover menu.
   *
   * The segments are native radios inside labels, so grouping, arrow-key
   * roving, and checked state come from the platform; the visible pill is the
   * styled label. No open/close state, no focus trap, nothing to dismiss —
   * the preference is one click away and the preference store persists it.
   */
  type Props = {
    theme: ThemeStore;
  };

  const { theme }: Props = $props();

  const OPTIONS: {
    value: ThemePreference;
    label: string;
    icon: typeof SunIcon;
  }[] = [
    { value: "system", label: "跟随系统", icon: MonitorIcon },
    { value: "light", label: "浅色", icon: SunIcon },
    { value: "dark", label: "深色", icon: MoonIcon }
  ];

  // Drives the sliding indicator; -1 is impossible in practice (the store
  // always holds one of the three preferences) but keeps the lookup total.
  const activeIndex = $derived(
    Math.max(
      0,
      OPTIONS.findIndex((option) => option.value === theme.preference)
    )
  );
</script>

<div class="switch" role="radiogroup" aria-label="外观主题" style="--active:{activeIndex}">
  <span class="indicator" aria-hidden="true"></span>
  {#each OPTIONS as option (option.value)}
    <label class="segment" class:selected={theme.preference === option.value}>
      <input
        type="radio"
        name="auth-theme-preference"
        value={option.value}
        checked={theme.preference === option.value}
        onchange={() => theme.setPreference(option.value)}
      />
      <option.icon size={16} />
      <span class="visually-hidden">{option.label}</span>
    </label>
  {/each}
</div>

<style>
  .switch {
    position: absolute;
    top: var(--space-5);
    right: var(--space-5);
    z-index: 2;
    display: flex;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  /* The pill that slides under the active segment. Width/offset are derived
     from the fixed 44px segment so the track needs no measurement. */
  .indicator {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 44px;
    height: 38px;
    border-radius: 999px;
    background: var(--surface-muted);
    transform: translateX(calc(var(--active) * 44px));
    transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .segment {
    position: relative;
    z-index: 1;
    display: grid;
    width: 44px;
    height: 38px;
    place-items: center;
    border-radius: 999px;
    color: var(--muted);
    cursor: pointer;
    transition: color var(--motion-fast);
  }

  .segment:hover {
    color: var(--text);
  }

  .segment.selected {
    color: var(--text-strong);
  }

  /* The native control stays in the DOM for semantics and keyboard roving;
     the label is the visible target. */
  .segment input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    opacity: 0;
    overflow: hidden;
  }

  /* Keyboard-only ring: a mouse click on the label must not leave one behind. */
  .segment:has(input:focus-visible) {
    outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  /* Coarse pointers get the full 44×44 target without inflating the pill. */
  @media (any-pointer: coarse) {
    .segment::after {
      position: absolute;
      top: 50%;
      left: 50%;
      width: var(--touch-target);
      height: var(--touch-target);
      transform: translate(-50%, -50%);
      content: "";
    }
  }

  @media (max-width: 480px) {
    .switch {
      top: var(--space-4);
      right: var(--space-4);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .indicator {
      transition: none;
    }
  }
</style>
