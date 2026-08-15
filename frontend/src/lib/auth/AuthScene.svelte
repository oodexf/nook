<script lang="ts">
  import type { Snippet } from "svelte";

  import ThemeSwitch from "./ThemeSwitch.svelte";
  import type { ThemeStore } from "../theme/theme-store.svelte";

  /**
   * Auth stage shell.
   *
   * Three quiet layers, no canvas and no per-frame work:
   *   1. `.ambience` — two soft CSS glows that give the page depth (z 0).
   *   2. the slotted auth content (checking / form / unavailable) — z 1.
   *   3. the theme switch, pinned to the top-right corner — z 2.
   *
   * Centering lives here rather than in each state, so every auth screen sits
   * in the same place and the backdrop persists across checking → form.
   */
  type Props = {
    theme: ThemeStore;
    children: Snippet;
  };

  const { theme, children }: Props = $props();
</script>

<div class="scene">
  <div class="ambience" aria-hidden="true"></div>
  <ThemeSwitch {theme} />
  {@render children()}
</div>

<style>
  .scene {
    position: relative;
    display: grid;
    width: 100%;
    min-height: 100vh;
    min-height: 100dvh;
    padding: var(--space-7) var(--space-5);
    place-items: center;
    isolation: isolate;
  }

  /* Two large, very low-contrast washes. They are the entire "art direction":
     enough atmosphere to keep the page from feeling like an empty form, quiet
     enough to never compete with the card. */
  .ambience {
    position: absolute;
    z-index: 0;
    inset: 0;
    background:
      radial-gradient(
        72% 52% at 50% 0%,
        var(--auth-glow-1) 0%,
        transparent 70%
      ),
      radial-gradient(
        64% 46% at 50% 100%,
        var(--auth-glow-2) 0%,
        transparent 72%
      );
    pointer-events: none;
    animation: drift 24s ease-in-out infinite alternate;
  }

  @keyframes drift {
    from {
      transform: scale(1) translate3d(0, 0, 0);
    }
    to {
      transform: scale(1.08) translate3d(0, -1.5%, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ambience {
      animation: none;
    }
  }

  @media (max-width: 480px) {
    .scene {
      padding: var(--space-6) var(--space-4);
    }
  }
</style>
