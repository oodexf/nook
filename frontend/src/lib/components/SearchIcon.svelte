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
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <circle cx="11" cy="11" r="7" />
  <path d="m21 21-4.35-4.35" />
</svg>
