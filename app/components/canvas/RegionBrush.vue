<script setup lang="ts">
/**
 * The brush that hands a piece of the page to a reader.
 *
 * Paint over lettering the detector never found; on release the shape is cut
 * out of the scan, read, put on the page as a block, and translated. One
 * gesture, a finished line — which is the only shape this can take, because
 * the thing being pointed at is invisible to everything else here: there is no
 * block to press a button on, and drawing one by hand and then reading it is
 * three gestures for what is plainly one.
 *
 * ## Why it is not the mask brush with a different destination
 *
 * They look alike and share every helper worth sharing — the sizing drag, the
 * ring, the pointer arithmetic — but what they store is not the same kind of
 * thing. A mask stroke is *kept*: it belongs to a block, it is logged, it syncs
 * to the room and it is replayed every time the repair is made again. This
 * stroke is spent the moment it is read. Nothing is written down, nothing is
 * broadcast, and there is nothing to undo but the block it produced. Giving it
 * a surface and a seq would be paying the whole cost of a stroke that no longer
 * exists a second later.
 *
 * ## The edge is hard, and the preview says so
 *
 * The shape becomes a knockout — pixels in or pixels out, see `knockOut` — so
 * there is no soft edge to show and no softness dial in the bar. One flat band
 * at the brush's own width, which is exactly the shape that will be cut. The
 * mask brush feathers its preview because its stroke really does feather; this
 * one would be promising an edge it does not have.
 */
const props = defineProps<{
  page: ComicPage
  /**
   * Which of the two brushes this is.
   *
   * The mode rather than the tool id, because the tool is the caller's business
   * and this is the only part of it that reaches in here. Which model, on whose
   * key, at what effort is `runRegion`'s question and deliberately not asked
   * twice.
   */
  mode: RegionMode
}>()

const { runRegion } = useRegion()
const { progress } = useOcr()
const { size } = usePaintSettings()

const surface = useTemplateRef<HTMLElement>('surface')
const live = useTemplateRef<HTMLCanvasElement>('live')

/**
 * Setting the brush on the page — the right button, dragged. Shared with both
 * other brushes rather than written a third time; see `useBrushGesture`.
 */
const adjust = useBrushGesture()

/** The ring, drawn above the whole stack — see `useBrushCursor`. */
const { show: showCursor, hide: hideCursor } = useBrushCursor()

onScopeDispose(hideCursor)

/** The stroke in flight: where it has been, in the scan's own pixels. */
let painting: number[] | null = null

/**
 * Whether an errand is out.
 *
 * Its own flag rather than `useOcr.running`, because the errand is longer than
 * the reading: the translation that follows is a second round trip, and a
 * second stroke landing between them would read a region while the first was
 * still being carried over — two blocks appearing out of order, and a progress
 * line describing only one of them.
 */
const working = ref(false)

/** What is happening, for the note at the foot of the page. */
const stage = ref<string | null>(null)

/**
 * Where the surface is on the screen and how big it is laid out — read once per
 * gesture, not once per pointer move, the way the mask brush reads it.
 *
 * A hover read the rectangle twice a move — for the ring, and for a size
 * gesture whether one was running or not — and a stroke a third time, with both
 * offset sizes besides. The first of those after the previous move had moved
 * the ring was the browser laying the page out again to answer, once a move,
 * for a box that had not moved: 0.7 ms a move of a hover on the test chapter,
 * and 0.1 ms read once.
 *
 * ## And why this is not the stale computed the brush was first written with
 *
 * `shown` was a `computed` over `getBoundingClientRect` once, copied from the
 * mask brush, and it lied: a read of the DOM is not reactive state, so there was
 * nothing for it to be invalidated by. It kept its first answer for the life of
 * the component, and the page changes size every time the window is resized, a
 * dock column is dragged or a panel is opened — none of which remounts a brush —
 * so the mark went on being laid at the scale the page had when the tool was
 * picked up. The fix that shipped measured at every use instead, which could not
 * go stale and paid for it on every move.
 *
 * Kept, it is let go of on exactly the occasions that computed missed. The
 * surface covers the sheet, so it moves when the view moves or the room
 * changes, and both are watched below; so is the page, because one of another
 * shape — a spread after a single — lays the sheet out anew under a pointer that
 * never left. Every gesture starts afresh besides: a press reads it again, and a
 * hover begins after a pointer that left, which let it go.
 */
let placed: { rect: DOMRect, wide: number, tall: number } | null = null

function placement () {
  const element = surface.value

  if (!element) return null
  if (placed) return placed

  const read = { rect: element.getBoundingClientRect(), wide: element.offsetWidth, tall: element.offsetHeight }

  // A surface with no size yet is not laid out yet, and nothing is kept of it:
  // kept, it would refuse every point of the gesture as off the page.
  if (read.rect.width && read.rect.height) placed = read

  return read
}

function unplace () {
  placed = null
}

const { zoom, pan, room } = useComic()

watch([zoom, pan, room, () => props.page], unplace)

/** The pointer left: the ring goes, and the next hover measures afresh. */
function onLeave () {
  hideCursor()
  unplace()
}

/**
 * What one page pixel is worth on screen, for the sizing drag — which is
 * measured against the window, so it wants the size the page is actually drawn
 * at, transform and all. Off the gesture's reading of the surface — see
 * `placement`.
 */
function shown (): number {
  const scan = props.page.scan
  const box = placement()?.rect

  return scan?.width && box?.width ? box.width / scan.width : 0
}

/** Where a pointer is, in the scan's own pixels. */
function pointOf (event: PointerEvent) {
  const scan = props.page.scan
  const box = placement()?.rect

  if (!box || !scan?.width || !scan.height) return null

  if (!box.width || !box.height) return null

  return {
    x: ((event.clientX - box.left) / box.width) * scan.width,
    y: ((event.clientY - box.top) / box.height) * scan.height,
  }
}

/** The mark so far, drawn at screen scale so it lands under the pointer. */
function paint () {
  const canvas = live.value
  const at = placement()
  const scan = props.page.scan

  if (!canvas || !at) return

  const { wide, tall } = at

  if (canvas.width !== wide || canvas.height !== tall) {
    canvas.width = wide
    canvas.height = tall
  }

  const context = canvas.getContext('2d')

  if (!context) return

  context.clearRect(0, 0, canvas.width, canvas.height)

  if (!painting || painting.length < 2 || !scan?.width) return

  /*
   * The layout width, not the drawn one — the canvas sits inside the page and
   * is scaled by the same transform as everything else in it, so a backing
   * store sized to the transformed rect would scale the mark a second time.
   *
   * Taken from the `wide` the backing store was just sized to rather than
   * measured again. Two reads of the DOM are two chances to disagree, and the
   * pair only has to disagree once — a panel opening between them — for the
   * mark to be laid at a scale the canvas it is being laid on does not have.
   * One reading a gesture, from `placement`, is one answer to both.
   */
  const scale = wide / scan.width

  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(1, size.value * scale)
  // Translucent, because what is under the stroke is the whole point of
  // drawing it: this is a selection over lettering somebody is aiming at, and
  // an opaque mark would hide the thing being aimed at while it is aimed.
  context.strokeStyle = 'rgba(56,189,248,0.4)'

  context.beginPath()
  context.moveTo(painting[0]! * scale, painting[1]! * scale)

  for (let i = 2; i < painting.length - 1; i += 2) {
    context.lineTo(painting[i]! * scale, painting[i + 1]! * scale)
  }

  // A dot, for a press that never moved.
  if (painting.length === 2) context.lineTo(painting[0]! * scale + 0.01, painting[1]! * scale)

  context.stroke()
}

function onDown (event: PointerEvent) {
  // A gesture starts from a fresh reading of where the surface is — see
  // `placement`. Before the size gesture as well, which measures with it.
  unplace()

  // Nothing while the last stroke is still being read and carried over — see
  // `working`. The sizing drag is let through, because setting up the next
  // stroke while this one finishes is exactly what the wait is good for.
  if (adjust.begin(event)) return

  if (working.value || event.button !== 0) return

  const at = pointOf(event)

  if (!at) return

  painting = [at.x, at.y]

  // Synthetic pointers have no capturable id, and losing capture only costs a
  // stroke that ends at the window's edge.
  try {
    (event.target as HTMLElement).setPointerCapture(event.pointerId)
  } catch { /* nothing to capture */ }

  paint()
}

function onMove (event: PointerEvent) {
  showCursor(pointOf(event))

  if (adjust.move(event, shown())) return

  if (!painting) return

  const at = pointOf(event)

  if (!at) return

  // The economy both other brushes apply: a vertex every pixel is a longer
  // path than the mark, and here it is a path that gets walked twice — once to
  // find the bounds and once to cut the shape.
  const [lastX, lastY] = [painting.at(-2)!, painting.at(-1)!]

  if (Math.hypot(at.x - lastX, at.y - lastY) < 2) return

  painting.push(at.x, at.y)
  paint()
}

/**
 * Let go, and the errand runs — see `runRegion`, which is all of it.
 *
 * One call, and nothing here to keep in step with it. This used to read and
 * then translate as two awaited halves, with a note about reading the block's
 * id *after* the first because `useBlockSync` renames a fresh block out from
 * under it; that whole hazard went with the second call. The page is not
 * touched until there is an answer, so there is no id to go stale and nothing
 * on the page to tidy up if the request fails.
 */
async function onUp () {
  if (adjust.end()) return

  const path = painting

  painting = null
  paint()

  if (!path) return

  working.value = true
  stage.value = 'Reading the region…'

  try {
    await runRegion(props.page.id, { path, radius: size.value / 2 }, props.mode)
  } finally {
    working.value = false
    stage.value = null
  }
}
</script>

<template>
  <div
    ref="surface"
    class="absolute inset-0 cursor-none touch-none"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerleave="onLeave"
    @contextmenu.prevent
  >
    <canvas ref="live" class="pointer-events-none absolute inset-0 size-full" />

    <!--
      What it is doing, on the page rather than in a panel. The reading and the
      translation are both seconds long and both invisible — the block is not
      there yet — so without this a stroke that took is indistinguishable from a
      stroke that was dropped. The reader's own message where it has one: a
      first-time model download is a minute, and "Reading the region…" for a
      minute reads as a hang.
    -->
    <p
      v-if="stage"
      class="bg-background/90 text-muted-foreground absolute inset-x-2 bottom-2 rounded-md border px-2 py-1 text-center text-[11px]"
    >
      {{ progress?.message ?? stage }}
    </p>
  </div>
</template>
