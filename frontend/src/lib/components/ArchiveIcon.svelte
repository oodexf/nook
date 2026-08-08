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
  <rect x="3" y="4" width="18" height="4" rx="1" />
  <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
  <path d="M10 12h4" />
</svg>
