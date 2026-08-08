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
  stroke="none"
  aria-hidden="true"
  focusable="false"
>
  <rect x="6" y="6" width="12" height="12" rx="2" />
</svg>
