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
  aria-hidden="true"
  focusable="false"
>
  <path
    d="M12 2c.48 5.4 3.1 8.02 8.5 8.5-5.4.48-8.02 3.1-8.5 8.5-.48-5.4-3.1-8.02-8.5-8.5 5.4-.48 8.02-3.1 8.5-8.5Z"
  />
</svg>
