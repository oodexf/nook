<script lang="ts">
  type Props = {
    /** Square size in CSS pixels. */
    size?: number;
  };

  const { size = 24 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="currentColor"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <circle cx="5" cy="12" r="0.5" />
  <circle cx="12" cy="12" r="0.5" />
  <circle cx="19" cy="12" r="0.5" />
</svg>
