<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Shared role-aware message lane (Phase I-01; PRD R3/AC-15).
   *
   * One presentation contract for persisted messages (`MessageItem`) and
   * the in-flight turn (`StreamingTurn`): user rows justify to the right
   * with a bounded bubble that wraps only the body text — the meta row
   * sits above and the copy/retry actions below, both outside the bubble
   * on the trailing edge. Assistant rows justify to the left and keep a
   * wide Markdown reading column. Status, copy, retry, and error
   * treatment stay inside the owning lane; the `data-role` hook is the
   * shared alignment/test contract.
   */
  type Props = {
    role: "user" | "assistant";
    /** Accessible name for the message region (the speaker). */
    ariaLabel: string;
    children: Snippet;
  };

  const { role, ariaLabel, children }: Props = $props();
</script>

<article class="lane" data-role={role} aria-label={ariaLabel}>
  <div class="lane-column">
    {@render children()}
  </div>
</article>

<style>
  .lane {
    display: flex;
    min-width: 0;
  }

  .lane[data-role="user"] {
    justify-content: flex-end;
  }

  .lane[data-role="assistant"] {
    justify-content: flex-start;
  }

  .lane-column {
    display: grid;
    min-width: 0;
    gap: var(--space-2);
  }

  /* User messages: a bounded right-aligned column that stays readable on
     wide desktops and full-width phones. Each child opts into its own
     intrinsic width so a short message body is not stretched to the width
     of the metadata or action row after generation settles. */
  .lane[data-role="user"] .lane-column {
    max-width: min(85%, 34rem);
    justify-items: end;
  }

  /* The bubble chrome wraps only the body text (`.content`): the meta row
     above and the action row (copy/retry) below stay outside the bubble.
     Persisted messages and the streaming turn share the `.content` body
     class, so both receive the identical bubble. */
  .lane[data-role="user"] .lane-column > :global(.content) {
    width: fit-content;
    max-width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
  }

  /* Assistant messages: transparent full-width reading column; the parent
     message list already bounds the overall line length. */
  .lane[data-role="assistant"] .lane-column {
    width: 100%;
  }

  /* Right-side flow: the user lane keeps its meta row and action row on
     the trailing edge, mirroring the bubble alignment. */
  .lane[data-role="user"] .lane-column > :global(.meta),
  .lane[data-role="user"] .lane-column > :global(.actions) {
    justify-content: flex-end;
  }

  @media (max-width: 760px) {
    .lane[data-role="user"] .lane-column {
      max-width: 92%;
    }
  }
</style>
