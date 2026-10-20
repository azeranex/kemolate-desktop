<script setup lang="ts">
/**
 * The app's mark — a speech bubble with round ears and forehead stripes.
 * The bubble takes the accent colour and the face is cut from the card colour
 * behind it, so the mark sits on any of the app's panels without a plate. SVG
 * paint attributes cannot take a utility class, so the cut-outs name --card
 * directly.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 27 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 96 96"
    aria-hidden="true"
    class="text-primary"
  >
    <circle cx="22" cy="14" r="9" fill="currentColor" />
    <circle cx="74" cy="14" r="9" fill="currentColor" />
    <path
      d="M26 16 H70 A18 18 0 0 1 88 34 V52 A18 18 0 0 1 70 70 H44 L24 88 L31 70 H26 A18 18 0 0 1 8 52 V34 A18 18 0 0 1 26 16 Z"
      fill="currentColor"
    />
    <path
      d="M42 17 V26 M48 17 V30 M54 17 V26"
      stroke="var(--card)"
      stroke-width="4.5"
      stroke-linecap="round"
    />
    <circle cx="33" cy="41" r="4.5" fill="var(--card)" />
    <circle cx="63" cy="41" r="4.5" fill="var(--card)" />
    <path d="M44 47 L52 47 L48 52 Z" fill="var(--card)" />
    <path
      d="M38 52 Q43 59 48 53 Q53 59 58 52"
      fill="none"
      stroke="var(--card)"
      stroke-width="4"
      stroke-linecap="round"
    />
  </svg>
</template>
