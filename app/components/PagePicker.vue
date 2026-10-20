<script setup lang="ts">
/**
 * The page counter in the header, and the way to any page from it.
 *
 * It was a readout — `pointer-events-none`, deliberately, since a thing that
 * looks pressable and is not is a promise broken. Now it keeps the promise:
 * pressing it opens every page of the chapter — a slider across them and the
 * thumbnails under it. Drag or arrow to a page and Go (or Enter), or click its
 * tile. The arrows either side of the counter still turn one page; this is for
 * the page forty turns away, which otherwise meant opening the Pages panel and
 * scrolling its strip.
 *
 * The thumbnails are the Pages strip's own (`useThumbs`), so opening this
 * costs no decoding the chapter has not already done. A page without one — no
 * scan on this machine, or not made yet — shows its number on a blank tile.
 */
const { pages, at, go } = useComic()
const { urls } = useThumbs()

const open = ref(false)

/**
 * The page the slider is on, one-based. Moving it goes nowhere by itself —
 * dragging across a chapter would otherwise turn every page on the way, each
 * one decoded for nothing. It marks the tile it names instead (`aimed`) and
 * says the number over the thumb while it moves, and Go is the turn.
 */
const typed = ref(1)

const grid = ref<HTMLElement | null>(null)

/** Go to a page by its index, and put this away. */
function pick (index: number) {
  if (index < 0 || index >= pages.value.length) return

  go(index)
  open.value = false
}

/** Go, or Enter on the slider: the page it is on. */
function jump () {
  pick(Math.round(typed.value) - 1)
}

/** The slider's value as the array it takes, one thumb. */
const aim = computed({
  get: () => [typed.value],
  set: (value: number[] | undefined) => { if (value?.[0]) typed.value = value[0] },
})

/** The tile the slider names, when it is not the page you are on. */
const aimed = computed(() => typed.value - 1)

watch(aimed, async (index) => {
  if (!open.value) return

  await nextTick()

  grid.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
})

/**
 * Opening starts the slider on the page you are on, and scrolls the grid to
 * that page — on a fifty-page chapter the page you are on is otherwise below
 * the fold half the time. The popover's own opening focus lands on the thumb,
 * so the arrow keys move it straight away.
 */
watch(open, async (now) => {
  if (!now) return

  typed.value = at.value + 1

  await nextTick()

  grid.value?.querySelector('[data-current]')?.scrollIntoView({ block: 'center' })
})

/** The page's shape, for its tile — the thumbnail's own where it has one. */
const aspectOf = (target: ComicPage) => {
  const { width, height } = pageSize(target)

  return width && height ? `${width} / ${height}` : '2 / 3'
}
</script>

<template>
  <UPopover v-model:open="open">
    <UPopoverTrigger as-child>
      <UButton
        variant="outline"
        size="sm"
        class="font-mono tabular-nums"
        aria-live="polite"
        :aria-label="`Page ${at + 1} of ${pages.length} — go to a page`"
      >
        {{ at + 1 }} / {{ pages.length }}
      </UButton>
    </UPopoverTrigger>

    <UPopoverContent align="center" class="w-80 p-0">
      <!--
        No room kept above the track for the bubble over the thumb: the
        popover does not clip, so while it shows it sits over the popover's
        top edge rather than holding a strip of empty space open for good.
        The readout beside it says the same number when nothing is moving.
      -->
      <div class="flex items-center gap-3 border-b px-3 py-2.5">
        <USlider
          v-model="aim"
          :min="1"
          :max="Math.max(1, pages.length)"
          :step="1"
          :disabled="pages.length < 2"
          :label="(value) => String(value)"
          class="min-w-0 flex-1"
          aria-label="Page to go to"
          @keydown.enter.prevent="jump"
        />
        <span class="text-muted-foreground flex-none font-mono text-xs tabular-nums">
          {{ typed }}<span class="opacity-60">/{{ pages.length }}</span>
        </span>
        <UButton size="sm" class="h-7 flex-none px-3" :disabled="aimed === at" @click="jump">
          Go
        </UButton>
      </div>

      <div ref="grid" class="grid max-h-[60vh] grid-cols-4 gap-2 overflow-y-auto p-2">
        <button
          v-for="(target, index) in pages"
          :key="target.id"
          type="button"
          class="
            group hover:bg-accent focus-visible:ring-ring flex min-w-0 flex-col items-center gap-1
            rounded-md
            p-1 focus-visible:ring-2 focus-visible:outline-none
          "
          :class="index === at && 'bg-accent'"
          :data-current="index === at || undefined"
          :data-index="index"
          :aria-current="index === at ? 'page' : undefined"
          :aria-label="`Page ${index + 1}${target.name ? `, ${target.name}` : ''}`"
          @click="pick(index)"
        >
          <span
            class="
              bg-muted ring-border block w-full overflow-hidden rounded-sm
              ring-1
            "
            :class="index === at ? 'ring-primary ring-2' : index === aimed && 'ring-ring ring-2'"
            :style="{ aspectRatio: aspectOf(target) }"
          >
            <img
              v-if="target.scan?.hash && urls[target.scan.hash]"
              :src="urls[target.scan.hash]"
              alt=""
              loading="lazy"
              decoding="async"
              class="size-full object-cover"
            >
          </span>
          <span
            class="text-muted-foreground font-mono text-[11px] tabular-nums"
            :class="index === at && 'text-foreground'"
          >{{ index + 1 }}</span>
        </button>
      </div>
    </UPopoverContent>
  </UPopover>
</template>
