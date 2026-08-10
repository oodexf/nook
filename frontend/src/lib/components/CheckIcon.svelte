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
  stroke-width="3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <!-- Lucide `check` icon -->
  <path d="M20 6 9 17l-5-5" />
</svg>
