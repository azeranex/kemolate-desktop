<script setup lang="ts">
/**
 * The whole canvas region as somewhere to drop pages.
 *
 * It wraps rather than sits beside, so the target is everything the user might
 * reasonably aim at — the empty state, the page itself, the space around it —
 * instead of a strip they have to find. Dropping onto a comic that is already
 * open replaces it, which is what dropping a folder into a workspace means
 * everywhere else.
 *
 * Nothing is uploaded. The files are read where they are, by the browser, on
 * this machine — see `imagesFrom` for what a drop actually yields, and
 * `useLibrary` for what becomes of it.
 */
import { ImageDownIcon, LoaderCircleIcon } from '@lucide/vue'

const { opened, busy, failed } = useLibrary()

/**
 * Counted rather than set, because dragging across the page's own children
 * fires a leave for the one being left before the enter for the one being
 * arrived at — a flag flickers off between every element on the way in.
 */
const depth = ref(0)

const reading = ref(false)

/** Files, rather than the text and images dragged out of another page. */
function hasFiles (event: DragEvent) {
  return event.dataTransfer?.types.includes('Files') ?? false
}

function onEnter (event: DragEvent) {
  if (hasFiles(event)) depth.value++
}

function onLeave () {
  depth.value = Math.max(0, depth.value - 1)
}

function onOver (event: DragEvent) {
  if (!hasFiles(event) || !event.dataTransfer) return

  // Says "copy" under the pointer, and — more to the point — a dragover that
  // is not defaulted out of is a drop that never happens.
  event.dataTransfer.dropEffect = 'copy'
}

async function onDrop (event: DragEvent) {
  depth.value = 0

  if (!event.dataTransfer) return

  reading.value = true

  // Started before anything is awaited: a `DataTransfer` is emptied when this
  // handler returns, so the read has to have taken hold of it by then.
  const found = imagesFrom(event.dataTransfer)

  try {
    await opened(await found)
  } catch (error) {
    // A drop handler that throws throws into nothing — the browser has nowhere
    // to put it, so the drop simply appears not to have happened.
    failed('Those pages couldn’t be read.', error)
  } finally {
    reading.value = false
  }
}

/** The overlay says what is going on, so it stays up while anything is. */
const showing = computed(() => depth.value > 0 || reading.value || Boolean(busy.value))

const doing = computed(() => busy.value ?? (reading.value ? 'Reading pages…' : null))
</script>

<template>
  <div
    class="relative size-full"
    @dragenter="onEnter"
    @dragleave="onLeave"
    @dragover.prevent="onOver"
    @drop.prevent="onDrop"
  >
    <slot />

    <!--
      Over the canvas rather than in place of it: what is being dropped onto is
      worth still being able to see, and a target that replaced the page would
      be a target that moved out from under the pointer.
    -->
    <div
      v-if="showing"
      class="bg-background/70 border-primary pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed backdrop-blur-xs"
    >
      <LoaderCircleIcon v-if="doing" class="text-primary size-8 animate-spin" />
      <ImageDownIcon v-else class="text-primary size-8" />

      <p class="text-sm font-medium">
        {{ doing ?? 'Drop pages to open them' }}
      </p>
      <p class="text-muted-foreground max-w-64 text-center text-xs">
        Images, a PDF of them, or a folder of either. They stay on this computer — nothing is uploaded.
      </p>
    </div>
  </div>
</template>
