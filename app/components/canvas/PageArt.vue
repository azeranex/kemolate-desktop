<script setup lang="ts">
/**
 * A page of the comic: the scan it was opened from.
 *
 * A page without one draws nothing rather than something invented. It used to
 * draw a stand-in — real frame outlines with soft shapes inside them — which
 * was honest while every page was invented and became misleading the moment
 * some were not: a page whose file has not arrived looked exactly like a page
 * whose file had, and was drawn.
 *
 * The box still holds its shape either way, so a chapter whose scans are not to
 * hand lays out as a chapter rather than collapsing to nothing. What has
 * changed is that such a page is now an ordinary sight rather than a moment
 * between two states — a chapter opened on a second computer is entirely made
 * of them — so the empty box says what it is instead of leaving the reader to
 * work out whether it is loading, broken or blank. See `showMissing` in
 * `useShared`.
 */
import { ImageOffIcon } from '@lucide/vue'

import type { RunRow } from '~/utils/raster/engine/run'
import type { ScanView } from '~/utils/raster/plan'

const props = defineProps<{
  page: ComicPage
  /**
   * Drawn small — the Pages strip rather than the canvas.
   *
   * A preview may use the thumbnail; the canvas never does, because the page
   * being worked on is the one place the real pixels are the point.
   */
  preview?: boolean
  /**
   * The part of the page on screen — the canvas's, from the board. Given, the
   * scan is drawn by `CanvasEngine` from decoded bitmaps rather than as an
   * `<img>`; see there for why. The Pages strip gives none and keeps the
   * `<img>`, which at a thumbnail's size costs nothing worth moving.
   *
   * A getter rather than the value, and that is measured. The value changes on
   * every frame of a pan or a zoom, and a prop that changes re-renders every
   * component it is handed through on the way here — which was the board, and
   * with it every block's lettering and repair and hit area, 90 times for 90
   * frames of pan, to move a canvas that was the only thing needing to know.
   * Called here, the view is a dependency of this component alone.
   */
  view?: () => ScanView
  /** The rows the engine draws over the scan — see `engineRun`. */
  rows?: RunRow[]
  /**
   * Whether the page's thumbnail may stand in while it decodes. Not for a page
   * with repairs or pictures over it: the thumbnail is the original, printed
   * lettering and all.
   */
  standIn?: boolean
}>()

/**
 * Which opening of the chapter this is — `useComic`'s `epoch`, reached for
 * directly rather than through `useComic`.
 *
 * The Pages strip draws one of these per page, and `useComic` is not a cheap
 * thing to call: a dozen computeds, the undo machinery and some sixty closures,
 * made for each tile to read one number off. The same state either way — this
 * is the `comic-epoch` that composable owns, as `useUndo` reaches for its
 * pages. `measure`, the only other thing this wanted from it, is asked for in
 * the one moment it is needed; see `onLoad`.
 */
const epoch = useState<number>('comic-epoch', () => 0)

const { urls } = useThumbs()

/** The view, called — see `view`. */
const shownPart = computed(() => props.view?.() ?? null)

/**
 * Which opening of the chapter the page on screen was last shown in — for the
 * Pages strip, which waits for it (`waited`).
 */
const shownIn = useState<number>('page-shown-in', () => -1)

/**
 * Whether the strip may load its thumbnails: once the page on screen has been
 * shown, in this opening of the chapter.
 *
 * Measured: with the strip open, the first flick through a freshly opened
 * chapter had a frame of 125–135 ms; with it closed, none over 9. Its images
 * were being decoded in the same moments as the page being read, and the page
 * is the one somebody is waiting for.
 */
const waited = computed(() => shownIn.value === epoch.value)

/**
 * What is drawn: on the canvas the scan itself, and in the Pages strip the
 * page's thumbnail only — `''` while there is none yet, or while the page on
 * screen is still coming (`waited`), which shows a placeholder.
 *
 * It used to fall back to the scan until the thumbnail existed, on the grounds
 * that a heavy picture beats an empty box. On a chapter of 20 MB scans that
 * was every tile of the strip decoding a whole scan to show it an inch across,
 * then decoding its thumbnail over it — beside the page being read.
 */
const src = computed(() => {
  const scan = props.page.scan

  if (!scan) return null

  if (!props.preview) return scan.url

  return waited.value && scan.hash ? urls.value[scan.hash] ?? '' : ''
})

/**
 * Whether what is on screen is the scan itself, and so whether it may be
 * measured. A thumbnail's `naturalWidth` is the thumbnail's — measuring from
 * one would tell the whole app the page is three hundred pixels wide, and
 * every box on it is a share of that number.
 */
const measurable = computed(() => src.value === props.page.scan?.url)

/**
 * The proportions to hold the box at. A scan is its own shape, but only once
 * it has loaded — until then the usual page is a better guess than nothing,
 * because *nothing* is a box of no height that the layout settles around.
 *
 * Through `pageSize`, so that a page with no file here is drawn at the shape
 * the workspace recorded for it rather than at the usual page. It is not
 * decoration: the boxes on a page are shares of this box, so a chapter drawn at
 * the wrong proportions has every balloon in the wrong place.
 */
const ratio = computed(() => {
  const { width, height } = pageSize(props.page)

  return width && height ? width / height : PAGE_RATIO
})

/**
 * Whether the scan now shown has been drawn — by the canvas, or by the
 * `<img>` in the Pages strip.
 *
 * Until then it shows nothing of the scan, which is the point: a page turned
 * to must never show the page it replaced. It used to be one `<img>` whose
 * `src` changed, and a browser keeps painting an image's old picture until the
 * new one is ready — the page you came from, under the new page's lettering
 * and repairs, for as long as the decodes were behind.
 */
const loaded = ref(false)

watch(src, () => { loaded.value = false })

/**
 * What shows while the scan decodes: this page's own thumbnail, which is small
 * and long since decoded. The right page, a little soft for a moment, rather
 * than the wrong one sharp. On the canvas only — a preview already is one.
 */
const standIn = computed(() => {
  const hash = props.page.scan?.hash

  return !props.preview && props.standIn !== false && hash ? urls.value[hash] ?? null : null
})

/** The page on screen has been shown — see `waited`. */
function shown () {
  loaded.value = true
  shownIn.value = epoch.value
}

if (!props.preview) {
  // And never waited on for long: a page on screen with no scan here is never
  // drawn, and a strip that waited for it would stay empty for good.
  watch(() => props.page.scan, (scan) => { if (!scan) shownIn.value = epoch.value }, { immediate: true })

  const cap = setTimeout(() => { shownIn.value = epoch.value }, 3000)

  onBeforeUnmount(() => clearTimeout(cap))
}

/** Deterministic, so a page looks the same every time it is drawn. */
function onLoad (event: Event) {
  const image = event.target as HTMLImageElement

  // Only the element for the scan this page shows now. A page turn replaces the
  // element (see the key), and one still loading when it is replaced finishes
  // anyway and fires this — by which time `props.page` is the next page. It was
  // measured with the old scan's size: a chapter opened on page one and turned
  // to the page it was left on came up with that page drawn at page one's
  // proportions — grey down the sides, every balloon and repair off its mark.
  if (image.getAttribute('src') !== src.value) return

  loaded.value = true

  if (!measurable.value) return

  // Called here rather than kept from setup — see `epoch`. Only a scan drawn
  // whole as an `<img>` is measured, which is page art given no view: never the
  // strip's, which shows thumbnails, and never the board's, whose engine
  // measures its own. So this is seldom reached, and costs nothing until it is.
  useComic().measure(props.page.id, image.naturalWidth, image.naturalHeight)
}
</script>

<template>
  <div
    class="relative overflow-hidden bg-neutral-200 shadow-sm dark:bg-neutral-300"
    :style="{ aspectRatio: ratio }"
  >
    <!--
      The scan as it came in, and nothing over it. `draggable` off because the
      page is inside a drop target and a page dragged out of one and back into
      it would read as opening itself.
    -->
    <img
      v-if="standIn && !loaded"
      :src="standIn"
      alt=""
      aria-hidden="true"
      class="absolute inset-0 size-full object-contain"
      draggable="false"
    >

    <CanvasEngine
      v-if="src && shownPart && !preview"
      :page="page"
      :view="shownPart"
      :rows="rows"
      @drawn="shown"
    />

    <img
      v-else-if="src"
      :key="src"
      :src="src"
      :alt="page.name"
      class="relative size-full object-contain"
      decoding="async"
      draggable="false"
      @load="onLoad"
    >

    <!--
      A page that has a scan and nothing to show for it yet — a Pages tile
      waiting for its thumbnail, or for the page on screen to be shown first.
      A soft pulse, so it reads as coming rather than as missing, which is the
      mark below.
    -->
    <div
      v-else-if="page.scan"
      class="bg-muted absolute inset-0 animate-pulse"
      aria-hidden="true"
    />

    <!--
      No file to hand. Still empty rather than illustrated — a page waiting on
      its scan and a page that has one must not look alike — but no longer
      silent: an unmarked grey rectangle is the same picture as a page that is
      still decoding and as a page that failed, and the reader has to be able to
      tell which of the three they are looking at before they can do anything
      about it.

      The mark is drawn faintly and in the middle rather than as a badge in a
      corner, because the boxes and the lettering of this page are on top of it
      and they are the part worth reading.
    -->
    <div
      v-else
      class="text-muted-foreground/70 absolute inset-0 flex flex-col items-center justify-center gap-1
        p-2 text-center"
    >
      <ImageOffIcon :class="preview ? 'size-4' : 'size-8'" />

      <!--
        The name only at full size. In the strip the tile already has it
        underneath, and repeating it inside a thumbnail an inch across leaves
        room for neither.
      -->
      <template v-if="!preview">
        <p class="text-sm font-medium">
          Not on this computer
        </p>
        <p class="max-w-64 text-xs">
          <!-- Desktop: the reader's own file, not found — see `CanvasAbsent`. -->
          “{{ page.name }}” is part of this chapter, and its work is safe; the
          file itself was not found. Give it back from the page list.
        </p>
      </template>
    </div>
  </div>
</template>
