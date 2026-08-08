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
  <path d="M12 15V4" />
  <path d="m7 9 5-5 5 5" />
  <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
</svg>
