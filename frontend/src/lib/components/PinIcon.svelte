<script lang="ts">
  type Props = {
    /** Square size in CSS pixels. */
    size?: number;
    /** Filled glyph for the pinned (active) state. */
    filled?: boolean;
  };

  const { size = 24, filled = false }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled ? "currentColor" : "none"}
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="M12 17v5" />
  <path d="M9 3h6l1 7 3 2v2H5v-2l3-2Z" />
</svg>
