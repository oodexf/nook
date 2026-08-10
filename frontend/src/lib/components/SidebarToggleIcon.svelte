<script lang="ts">
  type Props = {
    /** Square size in CSS pixels. */
    size?: number;
    /** Which action the button performs: hide or restore the sidebar. */
    direction?: "collapse" | "expand";
  };

  const { size = 24, direction = "collapse" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <rect x="3" y="4" width="18" height="16" rx="2" />
  <path d="M9 4v16" />
  {#if direction === "collapse"}
    <path d="m15 9-2.5 3 2.5 3" />
  {:else}
    <path d="m12.5 9 2.5 3-2.5 3" />
  {/if}
</svg>
