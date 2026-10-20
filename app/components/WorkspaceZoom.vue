<script setup lang="ts">
/**
 * How far the page is zoomed, as the status bar says it.
 *
 * A component of its own for one reason, and it is not reuse. The zoom is
 * written on every frame of a pan, a zoom and a glide, and whatever template
 * reads it is drawn again on every one of them. Read in the workspace page's
 * status slot, that template was not the page's own: a slot is drawn by the
 * component that renders it, and this one is rendered from inside the splitter
 * panel the canvas column sits in — so every frame of a zoom drew the whole
 * column again, the context bar, the drop zone around the canvas and the status
 * bar's buttons with it, to change four characters. Measured on the test
 * chapter, sixty frames of a zoom drew the column sixty times, its three
 * buttons 180 and the drop zone 60: 0.3 ms of every frame, spent drawing
 * nothing new. Here the one span is drawn again and nothing around it is.
 *
 * Rounded before the template sees it, so a pinch that moves the zoom a
 * fraction of a percent at a time does not redraw even this.
 */
const { zoom } = useComic()

const percent = computed(() => Math.round((zoom.value ?? 1) * 100))
</script>

<template>
  <span class="w-12 text-center font-mono tabular-nums">{{ percent }}%</span>
</template>
