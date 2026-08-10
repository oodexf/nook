<script lang="ts">
  import NookLogo from "../components/NookLogo.svelte";
  import { pickGreeting } from "./greetings";

  /**
   * Empty draft conversation (08-10 new chat UI upgrade): a quiet hero of
   * brand mark plus a time-of-day greeting. Model selection now lives in
   * the composer (ComposerModelSelector); the explanatory copy and the
   * centered model panel were removed.
   *
   * The greeting is picked once per mount so it never flickers within a
   * mounted view; re-entering the draft view re-rolls it.
   */
  const greeting = pickGreeting();
</script>

<div class="empty">
  <span class="brand-mark"><NookLogo size={56} variant="tile" /></span>
  <h2 class="greeting">{greeting}</h2>
</div>

<style>
  .empty {
    display: grid;
    min-height: 100%;
    align-content: center;
    justify-items: center;
    padding: var(--space-7) var(--space-5);
    text-align: center;
  }

  .brand-mark {
    display: grid;
    width: 56px;
    height: 56px;
    margin-bottom: var(--space-5);
    place-items: center;
  }

  /* Hero typography: the greeting is the single visual anchor of the
     empty draft view. */
  .greeting {
    max-width: 22em;
    margin: 0;
    font-size: clamp(1.5rem, 2.4vw, 1.9rem);
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.35;
    text-wrap: balance;
  }
</style>
