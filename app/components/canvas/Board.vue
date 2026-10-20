<script setup lang="ts">
/**
 * The canvas — the view half of it, for now.
 *
 * In the web build `CanvasBoard` is the page and everything done to it: the
 * sheet with its plates (`CanvasSheet`), every block's lettering, grips and hit
 * areas, the rubber band, the tools' pointers. Most of its 2,400 lines are that
 * editing, and it arrives with blocks and layers. What is here is the part that
 * shows a page, taken from it as written:
 *
 * - the sheet laid out at `fittedHeight` in a viewport it measures, and the
 *   viewport's size written to `useComic.room` so a zoom about "the middle"
 *   from the status bar knows where the middle is;
 * - the stage's transform from `useComic`'s `zoom` and `pan`, scaled from the
 *   top left, as `zoomAt`'s arithmetic assumes;
 * - the view handed to the page art as a getter (`viewOf`), so a pan re-renders
 *   the engine and nothing else — see `CanvasPageArt`;
 * - the wheel: zoom with Alt or a pinch, pan when zoomed, otherwise turn pages
 *   (a notch is a page; a glide adds up to one);
 * - the keys: arrows and Page Up/Down turn, Home/End go to the ends, 0 fits,
 *   +/− zoom.
 *
 * What is on the page is `CanvasSheet`'s, as in the web build: the plates in
 * their pile — the art and its repairs (the engine's run), the lettering, placed
 * pictures — and every block's hit area. The board keeps what the web board
 * keeps for it: the paper under each block (`usePaper.restock`) and the fitted
 * sizes (`useLetteringFit.refit`), watched exactly as there.
 *
 * And the blocks' chrome: each one's box outlined in its type's colour while
 * hovered or picked (see `blockLook`) — standing in for the web board's
 * `blockChrome` overlay, without its grips or numbers yet. A click picks.
 *
 * Space or the middle button drags the view, standing in for the board's own
 * drag until the tools come across. There is no text editor yet, so the sheet
 * is never told a block is being typed into.
 */
import type { Block } from '~/composables/useComic'
import type { LetterSpace } from '~/utils/letterCss'
import type { BoardView } from '~/utils/view'
import type { ScanView } from '~/utils/raster/plan'

import { boxPlaced } from '~/utils/letterCss'
import { fittedHeight } from '~/utils/raster/plan'
import { sheetInView } from '~/utils/view'

const {
  page, pages, at, zoom, pan, room, eased, go, zoomAt, resetView,
  selection, select, blockShown, blockPickable, framedBox, styleOf, setDown,
} = useComic()

const { tool } = useTools()

/** Whether the Text tool is out — the sheet's hit areas take a text cursor. */
const texting = computed(() => tool.value === 'text')

const dims = computed(() => (page.value ? pageSize(page.value) : { width: 0, height: 0 }))

/** What one scan pixel is worth on the sheet as laid out — the board's `unit`. */
const unit = computed(() => {
  const tall = dims.value.height

  return tall ? pageHeight.value / tall : 0
})

/* ---------- the lettering's two watches, from the web board ---------- */

const { refit, faces, ready: fitsReady } = useLetteringFit()

const { restock: restockPaper } = usePaper()

/**
 * Keep the colour under each block current — the web board's watch, as
 * written. Keyed on the block's *own* box, which the ring is taken around, and
 * on the scan's URL rather than the page's id; see `usePaper`.
 */
watch(
  () => (page.value?.blocks ?? [])
    .map((block) => {
      const box = blockBoxOf(block)

      return [block.id, box.x, box.y, box.w, box.h].join(',')
    })
    .join('|') + `@${page.value?.scan?.url}`,
  () => { restockPaper(page.value) },
  { immediate: true },
)

/**
 * Keep the auto-fitted sizes current — the web board's watch, as written.
 * Before the render (`flush: 'pre'`), or the first frame of every page is drawn
 * at a guess and corrected a frame later; `faces` and `fitsReady` are in the key
 * so a face landing, or kept sizes being read back, fit again. See the web
 * board for the argument in full.
 */
const { standard: letterStandard } = useLetteringStandard()
const letterTarget = useState('workspace-target', () => 'en')

watch(
  () => (page.value?.blocks ?? []).map((block) => {
    const style = styleOf(block)
    const box = letterBoxOf(block)

    return [block.id, block.translation || block.source, box.w, box.h,
      style.font, block.type, style.size, style.line, style.spacing, style.bold, style.italic,
      setDown(block), style.shape, style.points?.join(','), style.anchor].join('|')
  }).join('\n') + `@${dims.value.width}x${dims.value.height}#${faces.value}:${fitsReady.value}~${letterStandard.value}~${letterTarget.value}`,
  () => refit(page.value, styleOf, setDown),
  { immediate: true, flush: 'pre' },
)

/* ---------- the blocks ---------- */

/**
 * The page as the sheet lays boxes out on it — `CanvasSheet`'s `space` — so a
 * block's box is placed by `boxPlaced`, turned and bent with it, exactly where
 * the web build's hit area sits.
 */
const space = computed<LetterSpace>(() => ({ page: dims.value, unit: unit.value }))

const hovered = ref<string | null>(null)

/**
 * A block's box: the sheet's hit area and, while it is hovered or picked, the
 * board's outline (`blockChrome`) in the block's type colour (`BLOCK_TONE`) —
 * drawn here as the hit area's own border rather than as a separate overlay,
 * which is the same outline wherever the box is a turned or bent rectangle,
 * since `boxPlaced` applies the same transform to both.
 */
function blockLook (block: Block) {
  const picked = selection.value.includes(block.id)
  const hover = hovered.value === block.id
  const dim = (blockPickable(block) ? 1 : 0.25) * (block.hidden ? 0.4 : 1)

  return {
    ...boxPlaced(framedBox(block), space.value),
    zIndex: CHROME_Z,
    opacity: picked || hover ? dim : 0,
    borderStyle: block.hidden ? 'dashed' : 'solid',
    backgroundColor: `color-mix(in oklab, currentColor ${picked ? 10 : 5}%, transparent)`,
  }
}

/** A click on a block picks it; Shift or Ctrl/Cmd adds it to what is picked — see `addsToSelection`. */
function onBlock (id: string, event: MouseEvent) {
  select(id, { add: addsToSelection(event) || event.shiftKey })
}

function onHover (id: string, over: boolean) {
  if (over) hovered.value = id
  else if (hovered.value === id) hovered.value = null
}

const viewport = useTemplateRef<HTMLElement>('viewport')

const { width, height } = useElementSize(viewport)

/**
 * The proportions of the page in the middle. A scan is whatever shape it was
 * scanned at, which is not always the shape a page is printed at — and until it
 * has loaded and said so, the usual page is the best guess going.
 */
const ratio = computed(() => {
  const { width, height } = dims.value

  return width && height ? width / height : PAGE_RATIO
})

const pageHeight = computed(() => fittedHeight({ w: width.value, h: height.value }, ratio.value))

const measured = computed(() => width.value > 0 && height.value > 0)

// The canvas's size, for the sake of the zoom: told to it rather than measured
// by it, so that a button in the status bar can zoom about the middle of a
// canvas it has no reference to.
watchEffect(() => {
  room.value = { w: width.value, h: height.value }
})

const stageStyle = computed(() => ({
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value ?? 1})`,
}))

const framed = computed<BoardView>(() => ({
  pan: { x: 0, y: 0 },
  zoom: zoom.value ?? 1,
  room: { w: width.value, h: height.value },
  sheet: { w: pageHeight.value * ratio.value, h: pageHeight.value },
}))

/** The whole view, pan and all — for the pointer, which arrives on the screen. */
const viewed = computed<BoardView>(() => ({ ...framed.value, pan: pan.value }))

/**
 * The part of the page on screen, and how it is being shown — what the engine
 * decodes for. A little past the edge, so a small pan does not uncover a page
 * that has not been drawn yet.
 */
const scanView = computed<ScanView>(() => ({
  ...sheetInView(viewed.value, 96),
  sheet: viewed.value.sheet,
  zoom: viewed.value.zoom,
  crisp: (zoom.value ?? 1) * pageHeight.value >= dims.value.height && dims.value.height > 0,
}))

/** Asked for, not given — see `CanvasPageArt`'s `view`. */
const viewOf = () => scanView.value

/* ---------- the wheel ---------- */

function step (event: WheelEvent) {
  return event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
}

function pixels (event: WheelEvent) {
  return event.deltaY * step(event)
}

function pointOf (event: WheelEvent) {
  const box = viewport.value?.getBoundingClientRect()

  return box ? { x: event.clientX - box.left, y: event.clientY - box.top } : undefined
}

const zoomed = computed(() => (zoom.value ?? 1) > 1.02)

const JITTER = 0.5
const NOTCH = 40
const TURN = 120
const STEP_PACE = 80
const GLIDE_PACE = 150

let turned = 0
let lastTurn = 0
let lastWheel = 0

function onWheel (event: WheelEvent) {
  event.preventDefault()

  if (event.altKey || event.ctrlKey || event.metaKey) {
    zoomAt(
      Math.min(2, Math.max(0.5, Math.exp(-pixels(event) * 0.0015))),
      pointOf(event),
      Math.abs(pixels(event)) >= NOTCH,
    )

    return
  }

  if (zoomed.value) {
    const k = step(event)

    eased.value = false
    pan.value = { x: pan.value.x - event.deltaX * k, y: pan.value.y - event.deltaY * k }

    return
  }

  const dy = pixels(event)

  if (Math.abs(dy) < JITTER) return

  const now = performance.now()
  const fresh = now - lastWheel > 200

  lastWheel = now

  if (fresh) turned = 0

  // A notch is one page, but not faster than the hand can mean it.
  if (Math.abs(dy) >= NOTCH) {
    if (now - lastTurn < STEP_PACE) return

    lastTurn = now
    turned = 0
    go(at.value + (dy > 0 ? 1 : -1))

    return
  }

  // A glide adds up to a page.
  turned += dy

  if (Math.abs(turned) >= TURN && now - lastTurn > GLIDE_PACE) {
    go(at.value + (turned > 0 ? 1 : -1))
    lastTurn = now
    turned = 0
  }
}

/* ---------- dragging the view ---------- */

const spaceHeld = ref(false)
const dragFrom = shallowRef<{ x: number, y: number, pan: { x: number, y: number } } | null>(null)

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.key === ' ' && !claimed(event)) spaceHeld.value = true
})
useEventListener(window, 'keyup', (event: KeyboardEvent) => {
  if (event.key === ' ') spaceHeld.value = false
})

function onPointerDown (event: PointerEvent) {
  if (event.button !== 1 && !(event.button === 0 && spaceHeld.value)) return

  event.preventDefault()
  eased.value = false
  dragFrom.value = { x: event.clientX, y: event.clientY, pan: { ...pan.value } }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove (event: PointerEvent) {
  if (!dragFrom.value) return

  pan.value = {
    x: dragFrom.value.pan.x + event.clientX - dragFrom.value.x,
    y: dragFrom.value.pan.y + event.clientY - dragFrom.value.y,
  }
}

function onPointerUp (event: PointerEvent) {
  if (!dragFrom.value) return

  dragFrom.value = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
}

/* ---------- keys ---------- */

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || claimed(event)) return

  const keys: Record<string, () => void> = {
    ArrowRight: () => go(at.value + 1),
    ArrowDown: () => go(at.value + 1),
    PageDown: () => go(at.value + 1),
    ArrowLeft: () => go(at.value - 1),
    ArrowUp: () => go(at.value - 1),
    PageUp: () => go(at.value - 1),
    Home: () => go(0),
    End: () => go(pages.value.length - 1),
    0: () => resetView(),
    '+': () => { zoomAt(1.25, undefined, true) },
    '=': () => { zoomAt(1.25, undefined, true) },
    '-': () => { zoomAt(1 / 1.25, undefined, true) },
  }

  const act = keys[event.key]

  if (!act) return

  event.preventDefault()
  act()
})
</script>

<template>
  <div
    ref="viewport"
    class="relative size-full overflow-hidden"
    :class="(spaceHeld || dragFrom) && 'cursor-grab'"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!--
      Scaled from the top left, because that is the corner the arithmetic in
      `zoomAt` is written against. The page inside is still centred, so at the
      fit it sits where it always did.
    -->
    <div class="absolute inset-0 flex origin-top-left items-center justify-center p-6" :style="stageStyle">
      <div
        v-if="page && measured"
        class="relative flex-none select-none"
        :style="{ height: `${pageHeight}px`, width: `${pageHeight * ratio}px` }"
      >
        <CanvasSheet
          :page="page"
          :unit="unit"
          :view="viewOf"
          :editing="null"
          :gripped="false"
          :texting="texting"
          @pick="onBlock"
          @hover="onHover"
        />

        <!-- The chrome: outlines only, so the sheet's hit areas take every press. -->
        <div
          v-for="block in page.blocks"
          v-show="blockShown(block)"
          :key="`chrome-${block.id}`"
          class="pointer-events-none absolute rounded-[2px] border-[1.5px] transition-opacity"
          :class="BLOCK_TONE[block.type]"
          :style="blockLook(block)"
        />
      </div>
    </div>
  </div>
</template>
