<script lang="ts">
  type Props = {
    /** Square size in CSS pixels. */
    size?: number;
    /**
     * `mark` renders the bird-and-bubble subject on a transparent canvas;
     * `tile` renders the full rounded-square app icon.
     */
    variant?: "mark" | "tile";
  };

  const { size = 24, variant = "mark" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 1254 1254"
  aria-hidden="true"
  focusable="false"
>
  {#if variant === "tile"}
    <defs>
      <filter
        id="nook-tile-shadow"
        x="-12%"
        y="-12%"
        width="124%"
        height="126%"
        color-interpolation-filters="sRGB"
      >
        <feDropShadow
          dx="0"
          dy="4"
          stdDeviation="7"
          flood-color="#8A8A8A"
          flood-opacity="0.26"
        />
      </filter>
    </defs>
    <rect width="1254" height="1254" fill="#FCFCFC" />
    <rect
      x="37"
      y="32"
      width="1180"
      height="1194"
      rx="294"
      fill="#FFFFFF"
      stroke="#E9E9E9"
      stroke-width="1.5"
      filter="url(#nook-tile-shadow)"
    />
  {/if}

  <!-- Warm ivory speech bubble / nest -->
  <path
    fill="#F3EAD8"
    d="M271 491 C278 491 282 495 288 504 C351 602 457 665 573 683 C687 701 807 672 890 607 C924 580 952 545 972 507 C978 496 984 491 992 491 C1002 491 1000 503 1000 516 C1000 654 949 769 853 852 C778 916 674 939 558 923 C509 966 451 994 399 994 C389 994 387 988 393 979 C422 936 433 883 421 865 C311 781 254 659 254 517 C254 501 259 491 271 491 Z"
  />

  <!-- Muted teal bird silhouette -->
  <path
    fill="#5A9292"
    d="M305 488 C354 499 397 503 438 496 C520 482 570 431 622 377 C660 337 690 311 740 309 C805 306 853 340 876 395 L925 420 L883 441 C885 499 875 548 844 585 C810 627 755 657 677 662 C703 644 723 626 735 611 C742 601 731 598 723 607 C686 642 625 653 574 650 C464 645 361 581 305 488 Z"
  />

  <!-- Closed eye -->
  <path
    d="M747 416 C752 442 790 449 801 416"
    fill="none"
    stroke="#FFFFFF"
    stroke-width="11.5"
    stroke-linecap="round"
  />
</svg>
