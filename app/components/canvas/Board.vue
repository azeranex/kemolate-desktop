<script setup lang="ts">
/**
 * The work area: one page of the comic, and every block found on it drawn over
 * the top.
 *
 * The page is laid out once, at the size that fits the room, and zooming moves
 * and scales it with a transform rather than resizing it. That is the whole
 * difference between a zoom that glides and one that lurches: a size in pixels
 * has to be laid out again on every event, and the page carries a dozen blocks
 * and their lettering with it, so each notch of the wheel costs a full pass
 * over the lot. A transform is applied after the layout, so nothing is measured
 * twice and the step can be as fine as the wheel can report.
 *
 * It is also why there is no scroll bar here. The pan is part of the same
 * transform as the scale, which keeps the two from ever disagreeing about
 * where the page is — see `zoomAt`.
 *
 * Pressing the background clears the selection. That is worth doing explicitly:
 * with only the blocks handling presses, the one gesture everybody reaches for
 * to mean "nothing" would do nothing at all.
 *
 * ## Three layers, and what re-renders when the view moves
 *
 * What is drawn *on* the page — plates, lettering, repairs, hit areas — is
 * `CanvasSheet`, inside the stage; nothing it is given changes with the pan or
 * the zoom, so a view change leaves it alone (see there for what that saved).
 * What is drawn *about* the page — outlines, grips, numbers, the band — is the
 * chrome, outside the stage and in screen pixels, and its container wears the
 * pan as a transform of its own: a pan moves two elements and recomputes
 * nothing, and a zoom recomputes the chrome of the blocks that have any, which
 * is the picked and the hovered. This file is the third layer: the view, the
 * pointer, and the gestures that tie the other two to it.
 */
import type { ScanView } from '~/utils/raster/plan'
import type { BoardView } from '~/utils/view'

import CanvasSheet from '~/components/canvas/Sheet.vue'
import { useBalloonDebug } from '~/composables/useBalloonDebug'
import { useLetteringStandard } from '~/composables/useLetteringStandard'
import { fittedHeight } from '~/utils/raster/plan'
import { sheetInView, sheetToView, viewToSheet } from '~/utils/view'

// Imported rather than auto-imported: a new composable's export is unknown to
// the running dev server until it restarts, and so are a new component and a
// new file of utilities.

const {
  page, pages, at, selection, selected, keyed, writing, zoom, pan, room, eased,
  select, selectAll,
  selectWithin, blockShown, blockPickable, styleOf, setDown, update, updateMany, addBlock, dropBlock,
  removeBlock, go, zoomAt, resetView,
  framing, writesLetter, framedBox,
} = useComic()

const { tool, painting, stroking } = useTools()

/**
 * Whether the Select tool is out — the one tool that changes nothing by being
 * chosen, and the only one a press on empty page means a rubber-band for.
 */
const selecting = computed(() => tool.value === 'select')

/**
 * Whether the Text tool is out — the one tool whose press *makes* something
 * rather than picking, marking or painting what is already there.
 */
const texting = computed(() => tool.value === 'text')

/**
 * Whether a cleaning is running — for the brush's ring, which fades while the
 * brush refuses strokes. The repairs themselves are the sheet's to draw.
 */
const { running: cleaning } = useClean()

/**
 * What one scan pixel is worth on screen.
 *
 * Lettering is measured in the scan's own pixels — see `shared/utils/lettering`,
 * which says why — and the page is drawn at whatever height fits the room, so
 * every length has to come through here. Nought until the file has been
 * measured, which is the signal to leave the type alone: a scale worked out
 * against a page whose real size is still unknown would set the whole page in
 * the wrong size for a frame, and a frame is enough to see.
 */
/**
 * The page's own pixel space, whichever half of the page knows it.
 *
 * Every length below is in it — the lettering, the transform arithmetic, the
 * nudge keys — and it used to be read straight off the scan, which meant a page
 * whose picture is not on this computer had no coordinate space at all: no type
 * size, no draggable blocks, no arrow keys. That is the wrong answer for what
 * that state now is. The chapter's pages are all here and only the pictures are
 * elsewhere, and lettering a page you cannot see is a real thing to be doing —
 * the boxes and the words are what the translator is working on. `pageSize`
 * gives the scan's size where there is a scan and the workspace's record of it
 * where there is not, so nothing changes for a page that is here.
 */
const dims = computed(() => (page.value ? pageSize(page.value) : { width: 0, height: 0 }))

const unit = computed(() => {
  const tall = dims.value.height

  return tall ? pageHeight.value / tall : 0
})

const { refit, faces, ready: fitsReady } = useLetteringFit()

const { restock: restockPaper } = usePaper()

/**
 * Keep the colour under each block current.
 *
 * Watched rather than computed for the reason the fit below is — the answer is
 * a canvas read — and keyed on the block's *own* box, which is the one the ring
 * is taken around; see `usePaper`, which says why the lettering frame is not
 * used. Widening a balloon for the English therefore does not re-read anything,
 * which is correct: the balloon is the colour it was.
 *
 * The scan's URL is in the key and the page's id is not. Two pages can carry the
 * same blocks through a re-detect, and a page turn is a new file — it is the
 * file that decides what is under the box.
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
 * Keep the auto-fitted sizes current.
 *
 * Watched rather than computed, because measuring lays the page out and a
 * render that lays the page out to decide how to render is a render that
 * fights itself — see `useLetteringFit`. Not tied to `unit`: a fit is measured
 * in the scan's own pixels, so making the window wider changes what the page is
 * drawn at and not what it is set in.
 *
 * `faces` is in the key and is not a property of any block: a block whose face
 * has not landed is left unfitted (and undrawn), so a face arriving has to bring
 * it back through here. `fitsReady` likewise, for the sizes kept from earlier
 * visits being read back.
 *
 * Before the render (`flush: 'pre'`), not after it. Fitting measures on its own
 * off-page probe, not on this component's DOM, so nothing here has to be laid
 * out first — and after the render meant the first frame of every page was
 * drawn at a guess and corrected a frame later, which was the lettering jumping.
 */
const { standard: letterStandard } = useLetteringStandard()
const letterTarget = useState('workspace-target', () => 'en')

watch(
  () => (page.value?.blocks ?? []).map((block) => {
    const style = styleOf(block)
    // The lettering frame's size, not the block's: what a line has to fit into
    // is the room the letterer gave it — see `Block.letter`. Keyed on the
    // block's box instead, widening a balloon for English re-fitted nothing.
    const box = letterBoxOf(block)

    return [block.id, block.translation || block.source, box.w, box.h,
      style.font, block.type, style.size, style.line, style.spacing, style.bold, style.italic,
      setDown(block), style.shape, style.points?.join(','), style.anchor, style.emphasis].join('|')
    // The chapter's standard size and the language being lettered decide a fit
    // as much as anything on the block does — see `useLetteringFit.keyOf`.
  }).join('\n') + `@${dims.value.width}x${dims.value.height}#${faces.value}:${fitsReady.value}~${letterStandard.value}~${letterTarget.value}`,
  () => refit(page.value, styleOf, setDown),
  { immediate: true, flush: 'pre' },
)

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

/**
 * The page's laid-out size — the tallest it can be and still fit, with a margin
 * to breathe in, and nothing to do with the zoom. The scale is worn by the
 * stage above it, so this changes only when the room does.
 *
 * `fittedHeight`, the one rule: the scan canvas asks it too, of the pages
 * either side, to decode them ahead at the size they will be shown.
 */
const pageHeight = computed(() => fittedHeight({ w: width.value, h: height.value }, ratio.value))

/**
 * Whether the room has been measured yet.
 *
 * An element's size starts at nought and is only reported once the observer has
 * run, and nought is *not yet* rather than *no room*. Drawing against it lands
 * on the floor above — a page a hundred and twenty pixels tall, sat in the
 * middle of an empty canvas for a frame, which is the thumbnail people see for
 * an instant on every refresh and reasonably take for the real thing.
 */
const measured = computed(() => width.value > 0 && height.value > 0)

// The canvas's size, for the sake of the zoom: told to it rather than measured
// by it, so that a button in the status bar can zoom about the middle of a
// canvas it has no reference to.
watchEffect(() => {
  room.value = { w: width.value, h: height.value }
})

/**
 * Whether the view is moving — a pan or a zoom still arriving. On from its
 * first step, off a moment after its last.
 *
 * Worn by the sheet as `data-moving`, which is what holds the lettering still
 * while the view moves — see the lettering plates in `CanvasSheet`, which say
 * why, and why it is an attribute rather than a prop.
 */
const gesturing = ref(false)
let still: ReturnType<typeof setTimeout> | undefined

watch([pan, zoom], () => {
  gesturing.value = true
  clearTimeout(still)
  still = setTimeout(() => { gesturing.value = false }, 200)
})

onBeforeUnmount(() => clearTimeout(still))

/**
 * Translate first, then scale, against a corner rather than the middle.
 *
 * No transition, deliberately. An eased zoom is animated in the state itself —
 * see `glideView` in `useComic` — so the stage just draws the numbers each
 * frame, and the chrome outside it, drawn from the same numbers, cannot fall
 * out of step with it. A CSS transition here was exactly that falling out:
 * the page glided while the outlines had already arrived.
 */
const stageStyle = computed(() => ({
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value ?? 1})`,
}))

/**
 * The view with its pan left out — the frame the chrome is drawn in.
 *
 * The chrome's container wears the pan as a transform of its own (`chromeStyle`),
 * so nothing in it is worked out against the pan, and nothing in it has to be
 * worked out again when the pan moves. Every outline, grip and number is placed
 * from this; a pan is then two transforms written, the stage's and this one's.
 * Measured before the split: every frame of a pan recomputed the outline of
 * every block that had one and placed a number badge per block on the page,
 * shown or not.
 */
const framed = computed<BoardView>(() => ({
  pan: { x: 0, y: 0 },
  zoom: zoom.value ?? 1,
  room: { w: width.value, h: height.value },
  sheet: { w: pageHeight.value * ratio.value, h: pageHeight.value },
}))

/** The whole view, pan and all — for the pointer, which arrives on the screen. */
const viewed = computed<BoardView>(() => ({ ...framed.value, pan: pan.value }))

const chromeStyle = computed(() => ({
  transform: `translate(${pan.value.x}px, ${pan.value.y}px)`,
}))

/**
 * A click on a block on the page. Shift adds the one, and never spans.
 *
 * A range is a *list* gesture: "everything between these two" means something
 * where the things are in a row, and the block list beside the page is the only
 * place they are. On the page they are scattered over the art, so shift-clicking
 * a second balloon used to take every block that happened to fall between them
 * in the list's order — which from the canvas looks like a handful of unrelated
 * balloons lighting up somewhere else on the page. Nothing about where the
 * pointer went says which those should be.
 *
 * So Shift here means what it means to the rubber band a press on the backdrop
 * starts (see `bandAdds`): add to what is already picked. Cmd does the same,
 * because on the page the two asks are the same ask.
 */
function onBlock (id: string, event: MouseEvent) {
  select(id, { add: addsToSelection(event) || event.shiftKey })
}

/*
 * A block's hit area, answered — see `CanvasSheet`, which draws them and says
 * only which block and how. With the grips out a press takes hold and a click
 * is left to the release (`endGrab`); without them the click picks.
 */
function onPress (block: Block, event: PointerEvent) {
  if (gripped.value) beginGrab('move', block, event)
}

function onPick (id: string, event: MouseEvent) {
  if (!gripped.value) onBlock(id, event)
}

function onHover (id: string, over: boolean) {
  if (over) hovered.value = id
  else if (hovered.value === id) hovered.value = null
}

/**
 * The viewport's top left on the screen, read once per gesture.
 *
 * The pointer arrives in the window's coordinates and the view is worked out
 * in the viewport's, and this is the whole of the difference between them. It
 * is read when a gesture starts — a press, a grab, the first notch of a wheel —
 * and kept until the next, because the thing it replaced was read on every
 * move: the sheet's rectangle, taken straight after the previous move's render
 * had written to the page, which is the browser laying the page out again to
 * answer. Measured on a rubber band, one of those per pointer move. The
 * viewport itself does not move under a hand; the page inside it does, and
 * that is `viewed`'s to say, not a rectangle's.
 */
let origin: { x: number, y: number } | null = null

function originOf (fresh = false) {
  if (fresh || !origin) {
    const box = viewport.value?.getBoundingClientRect()

    origin = box ? { x: box.left, y: box.top } : null
  }

  return origin
}

// A room that changed size has usually moved as well — a dock column dragged,
// a panel opened — so the next reading is taken afresh.
watch([width, height], () => { origin = null })

/* ---------- transform ---------- */

/**
 * A drag on a block or one of its grips.
 *
 * The boxes are captured at the moment the drag begins and every move is
 * measured from those, rather than applied on top of the last frame. Added up
 * move by move, a hand carried past the edge and back again would have dragged
 * an accumulated distance it never showed — the same reason the pan is measured
 * from where it started.
 */
const grab = ref<{
  kind: 'move' | HandleKind | 'rotate'
  id: string
  at: { x: number, y: number }
  box: Oriented
  /** The rest of the selection, which a move carries and nothing else does. */
  others: { id: string, box: Oriented }[]
  /** What the release should do if the pointer never actually travelled. */
  click: { add: boolean }
  moved: boolean
} | null>(null)

/** Whether grips should be showing: the Select tool, on what it can reach. */
const gripped = computed(() => selecting.value && !painting.value)

/**
 * What one scan pixel is worth on screen, zoom and all.
 *
 * `unit` is what it is worth in the sheet's own coordinates; the stage above it
 * wears the zoom. Worked out rather than measured, so a drag costs no layout
 * read per pointer move — and so it stays right if the page is zoomed mid-drag,
 * which a captured rectangle would not.
 */
const onScreen = computed(() => unit.value * (zoom.value ?? 1))

/** A box as the transform arithmetic wants it. Null before the page's size is. */
function orientedOf (box: LetterBox) {
  const scan = dims.value

  return scan.width && scan.height ? toOriented(box, scan) : null
}

/**
 * One transform written down, onto whichever of a block's two boxes this drag
 * took hold of — see `Block.letter`.
 *
 * The lettering frame is replaced whole rather than patched into. `letter` is
 * either present and complete or absent, and merging a partial patch into a
 * frame that is not there yet would leave a box half in one space and half in
 * the other. The block's own box, by contrast, *is* patched: `toBoxed` leaves a
 * turn of nought off entirely so that an unturned block carries no angle, and
 * assigning the patch is what keeps that true.
 *
 * Which of the two is decided per call rather than captured when the drag began,
 * and nothing can change the answer mid-drag: the pointer is captured, so
 * neither the mode nor the translation can be touched while it is down.
 */
function writeBox (id: string, patch: Partial<LetterBox>) {
  const block = page.value?.blocks.find((candidate) => candidate.id === id)

  if (block) update(id, boxPatch(block, patch))
}

/** What `writeBox` writes onto a block — the division it makes, as a patch. */
function boxPatch (block: Block, patch: Partial<LetterBox>): Partial<Block> {
  return writesLetter(block) ? { letter: { ...letterBoxOf(block), ...patch } } : patch
}

/** A whole transform, in the space it is stored in. */
function setBox (id: string, box: Oriented, scan: { width: number, height: number }) {
  writeBox(id, toBoxed(box, scan))
}

/**
 * The same move written onto several blocks as one step — see `BlocksEntry`.
 *
 * `merge` is what folds a gesture's events into that step. Through `setBox` a
 * block at a time, each event filed a step per block that no later event could
 * fold into, so dragging three balloons for half a second emptied the history.
 */
function setBoxes (moves: { id: string, box: Oriented }[], scan: { width: number, height: number }, merge: string) {
  const blocks = page.value?.blocks ?? []

  updateMany(moves.flatMap(({ id, box }) => {
    const block = blocks.find((candidate) => candidate.id === id)

    return block ? [{ id, patch: boxPatch(block, toBoxed(box, scan)) }] : []
  }), undefined, merge)
}

function beginGrab (kind: 'move' | HandleKind | 'rotate', block: Block, event: PointerEvent) {
  const box = orientedOf(framedBox(block))

  if (!box || event.button !== 0) return

  // The grips and the block both belong to this drag, not to the canvas under
  // them: without this a press would also start a rubber band.
  event.stopPropagation()
  event.preventDefault()

  // The start of a gesture, and so the one place its moves may measure from.
  originOf(true)

  // Either modifier adds, and neither spans — the reading `onBlock` sets out.
  const add = addsToSelection(event) || event.shiftKey

  // Taking hold of something outside the selection picks it, before the drag
  // rather than after — otherwise the ring stays on blocks standing still while
  // a different one moves under the pointer. With a modifier the press may yet
  // turn out to be a click that adds, so that waits for the release.
  if (kind === 'move' && !add && !selection.value.includes(block.id)) {
    select(block.id, {})
  }

  grab.value = {
    kind,
    id: block.id,
    at: { x: event.clientX, y: event.clientY },
    box,
    // Only a move takes the others with it. Resizing or turning several at once
    // means something different for each — one shared corner to pull, one shared
    // centre to spin about — and that is not this.
    others: kind !== 'move'
      ? []
      : (page.value?.blocks ?? [])
          .filter((other) => other.id !== block.id && selection.value.includes(other.id))
          .flatMap((other) => {
            const box = orientedOf(framedBox(other))

            return box ? [{ id: other.id, box }] : []
          }),
    click: { add },
    moved: false,
  }

  window.addEventListener('pointermove', onGrabMove)
  window.addEventListener('pointerup', endGrab)
  window.addEventListener('pointercancel', endGrab)
}

function onGrabMove (event: PointerEvent) {
  const held = grab.value
  const scan = dims.value

  if (!held || !scan.width || !scan.height || !onScreen.value) return

  // Screen pixels into the scan's own, which is the square space the arithmetic
  // works in — see `shared/utils/transform`.
  const dx = (event.clientX - held.at.x) / onScreen.value
  const dy = (event.clientY - held.at.y) / onScreen.value

  if (!held.moved && Math.hypot(dx, dy) * onScreen.value < 3) return

  held.moved = true

  if (held.kind === 'rotate') {
    // Measured from the block's centre out to where the pointer actually is,
    // not along how far it has travelled: a turn is an absolute bearing, and
    // taking it off the movement vector leaves the grip swinging away from the
    // cursor the moment the drag starts anywhere but the centre.
    //
    // The centre is put on the screen through the view rather than read off the
    // sheet's rectangle. Read here, straight after the previous move's turn had
    // been written to the page, the rectangle was a layout of the page per move
    // — see `originOf`.
    const corner = originOf()

    if (!corner) return

    const at = sheetToView(viewed.value, { x: held.box.cx * unit.value, y: held.box.cy * unit.value })
    const centre = { x: corner.x + at.x, y: corner.y + at.y }

    // The one transform written as a single field rather than a whole box, and
    // it has to stay that way: `toBoxed` leaves a turn of nought off, so putting
    // a block back upright through it would keep the angle it was at.
    return writeBox(held.id, {
      angle: snapped(angleTo(centre, { x: event.clientX, y: event.clientY }), event.shiftKey),
    })
  }

  if (held.kind === 'move') {
    // Shift locks the drag to one axis, by the larger of the two movements —
    // dropped rather than damped, so a row of balloons stays a row however much
    // the hand wanders on the way across.
    const mx = event.shiftKey && Math.abs(dx) < Math.abs(dy) ? 0 : dx
    const my = event.shiftKey && Math.abs(dy) <= Math.abs(dx) ? 0 : dy

    const moving = [{ id: held.id, box: held.box }, ...held.others]

    setBoxes(
      moving.map(({ id, box }) => ({ id, box: { ...box, cx: box.cx + mx, cy: box.cy + my } })),
      scan,
      `move:${moving.map(({ id }) => id).join()}`,
    )

    return
  }

  // Width, height and lean are measured along the box's own edges, so a drag on
  // a turned box has to be read in that frame: pulling the corner of a box lying
  // on its side widens it *along its own length*, whichever way that points.
  const local = unmapped(matrixOf(held.box), dx, dy)
  const pull = PULL[held.kind]
  const corner = Boolean(pull[0] && pull[1])

  // The transform modifier, as Photoshop assigns it. On a corner it frees that
  // corner alone — distort — and with Alt and Shift as well it sends the corner
  // opposite along its edge the other way, which is perspective. On a side,
  // where there is no single corner to free, it leans the edge instead.
  if (addsToSelection(event) || event.ctrlKey) {
    const bent = corner
      ? distorted(held.box, pull, local, event.altKey && event.shiftKey)
      : skewed(held.box, pull, local)

    return setBox(held.id, bent, scan)
  }

  setBox(held.id, scaled(held.box, {
    pull,
    local,
    fromCentre: event.altKey,
    proportional: event.shiftKey,
  }), scan)
}

function endGrab () {
  const held = grab.value

  grab.value = null
  window.removeEventListener('pointermove', onGrabMove)
  window.removeEventListener('pointerup', endGrab)
  window.removeEventListener('pointercancel', endGrab)

  // A press that moved nothing is a click, and picks by the same rules a click
  // on the page does. Decided by whether the drag ever travelled rather than by
  // comparing boxes, which would misread a drag that ended where it began.
  if (held && !held.moved) select(held.id, held.click)

  // The same release settles a placement, and by the same reading of it — see
  // `finishPlace`, where a box that was dragged and a box that was clicked part
  // company.
  if (placing) finishPlace(Boolean(held?.moved))
}

onScopeDispose(endGrab)

/* ---------- lettering placed by hand ---------- */

/**
 * The block whose words are being typed on the page, while that lasts.
 *
 * Typed *on the page* rather than only in the Text panel because the thing
 * being judged is how the words sit on the art, and a field beside the canvas
 * cannot show that. What is typed goes into `translation` like every other line
 * — see `addBlock` — so the lettering plate, the fit, the local cache and undo
 * carry it without knowing a tool put it there.
 *
 * Three things are remembered besides the block:
 *
 * - `placed`, whether this tool made it. It is the only thing that decides
 *   whether leaving the block empty takes it away again — emptying an OCR
 *   block's translation is a thing somebody may well mean.
 * - `page`, so a placement abandoned by turning the page is settled on the page
 *   it was made on rather than looked for on the one now open.
 * - `grows`, point text against area text — see `finishPlace`.
 */
const editing = ref<{ id: string, page: string, placed: boolean, grows: boolean } | null>(null)

/** The block being typed into, while it is still on the open page. */
const typing = computed(() => {
  const id = editing.value?.id

  return (id ? page.value?.blocks.find((block) => block.id === id) : null) ?? null
})

/**
 * The sheet's contents, for the one element in them this file drives: the
 * editor, which `CanvasSheet` draws in place on the page and hands back.
 */
const contents = useTemplateRef<InstanceType<typeof CanvasSheet>>('contents')

const editor = computed(() => contents.value?.editor ?? null)

/**
 * And the same thing where the rest of the app can see it — see `writing`.
 *
 * Mirrored by a watcher rather than written at each of the four places
 * `editing` is set, which is the same argument `useBlockSync` makes for
 * watching the blocks instead of calling a save from every tool: a second
 * assignment to remember is one that will be forgotten at the next one, and
 * forgetting this one costs somebody the sentence they were typing when a
 * collaborator's edit landed.
 *
 * Cleared on unmount, because a caret cannot outlive the canvas holding it and
 * a stale id here would protect a block nobody is touching from ever being
 * brought up to date.
 */
watch(() => editing.value?.id ?? null, (id) => { writing.value = id })
onUnmounted(() => { writing.value = null })

/** The placement still under the pointer, until the press is let go of. */
let placing: string | null = null

/**
 * The size hand-placed point text is set at, in the scan's own pixels.
 *
 * A share of the page's width rather than a number, because that is the unit
 * lettering is measured in — see `shared/utils/lettering` — and a scan is
 * whatever size it happened to be scanned at. Written this way, the same press
 * lands the same-looking type on a 1200-pixel page and a 3000-pixel one. Held
 * inside the range the sliders offer on this page, so the Lettering panel can
 * carry on from wherever this leaves off.
 */
function seedSize (scan: { width: number }) {
  const { min, max } = letteringRange(scan.width).size

  return Math.max(min, Math.min(max, Math.round(scan.width * 0.022)))
}

/**
 * A press with the Text tool out: a block where the pointer is, and — once the
 * press is let go of — the caret in it.
 *
 * The box starts as one line's worth at the point pressed and is dragged out by
 * the transform tool's own machinery. `beginGrab('se', …)` is exactly "pull the
 * south-east corner of a box anchored here", mirroring past the anchor
 * included, so a drag in any direction lands the box somebody drew — and there
 * is no second pointer path to keep in step with the first. A press that never
 * travels leaves the seed box behind, which is what `finishPlace` reads as a
 * click.
 */
function beginPlace (event: PointerEvent) {
  const here = page.value
  const scan = dims.value
  const spot = pagePoint(event)

  if (!here || !scan.width || !scan.height || !spot) return

  const size = seedSize(scan)
  const block = addBlock({
    x: spot.x,
    y: spot.y,
    w: (size / scan.width) * 100,
    h: ((size * AUTO_LINE) / scan.height) * 100,
  })

  // Refused rather than made invisible — see `addBlock`. Said out loud, because
  // a tool that does nothing at all for no stated reason reads as broken.
  if (!block) {
    toast.info('Nowhere to letter: the layer a new block lands on is hidden or locked.')

    return
  }

  beginEdit({ id: block.id, page: here.id, placed: true, grows: true })
  placing = block.id
  beginGrab('se', block, event)
}

/**
 * The release that settles what a placement turned out to be.
 *
 * Two gestures, and the difference between them is point text against area
 * text. A drag drew a box, so the box is kept and the words are fitted into it
 * — which is what a block with no size of its own already means everywhere
 * else here. A click drew no box, so there is nothing to fit to: the size is
 * written down and the box follows the words instead, growing from the corner
 * that was pressed.
 *
 * The other way round is the failure this shape prevents. Left to auto-fit, a
 * click would set its line inside whatever seed box the press happened to
 * leave — type a sentence into it and it is set two pixels tall, in a box
 * nobody drew and nobody can see.
 */
function finishPlace (dragged: boolean) {
  const id = placing
  const scan = dims.value

  placing = null

  if (!id || !editing.value) return

  if (!dragged && scan.width) update(id, { style: { size: seedSize(scan) } })

  editing.value = { ...editing.value, grows: !dragged }

  // Picked, however it was made. A click arrives here already selected — the
  // release read it as a click and `endGrab` picked what was under it — and a
  // drag does not, which left the panels beside the page describing whatever
  // was selected before the block you are looking at was placed.
  select(id, {})
  focusEditor()
}

/** Put the caret in a block that is already on the page. */
function editBlock (id: string) {
  const here = page.value

  if (!here) return

  beginEdit({ id, page: here.id, placed: false, grows: false })
  // Picked as well as opened: the panels beside the page work on the selection,
  // and a block being typed into that they had nothing to say about would be
  // the one block on the page you could not restyle while looking at it.
  select(id, {})
  focusEditor()
}

/**
 * Take the caret to a block, settling whatever it was in first.
 *
 * The settling cannot be left to the blur, and this is why: the press that
 * starts the next placement is prevented from moving focus — see
 * `onPointerDown` — and the editor element is reused rather than remade, so
 * going from one block to the next fires no blur at all. Focus only genuinely
 * leaves when something outside the canvas takes it, which is the one case the
 * blur handler is there for.
 */
function beginEdit (state: NonNullable<typeof editing.value>) {
  if (editing.value) settle(editing.value)

  editing.value = state
}

/**
 * The end of one block's turn with the caret.
 *
 * A block with nothing in it at all goes. Nothing at all is the whole of the
 * test — no reading behind it *and* nothing typed into it — which is what keeps
 * this away from the blocks it must never touch: a balloon whose translation
 * somebody cleared still has the printed line in it, and clearing that field is
 * a thing people mean. A hand-placed block that has been emptied has nothing
 * left to be: no words, no box worth seeing, and a row in the list reading
 * "Block 7".
 *
 * How it goes depends on whether the block outlived its placement. Placed in
 * this same gesture, it never happened, and neither did the keystrokes — see
 * `dropBlock`, which strikes them rather than filing a deletion on top. Emptied
 * later, it is an ordinary deletion by an ordinary route, undoable like any
 * other.
 */
function settle (state: NonNullable<typeof editing.value>) {
  const block = pages.value
    .find((one) => one.id === state.page)?.blocks
    .find((candidate) => candidate.id === state.id)

  if (!block || block.source || block.translation.trim()) return

  if (state.placed) dropBlock(block.id)
  else removeBlock(block.id)
}

/** Done typing: Escape, a page turn, another tool. */
function stopEdit () {
  const state = editing.value

  if (!state) return

  editing.value = null
  settle(state)
  editor.value?.blur()
}

/** Focus gone somewhere else entirely — a panel, another window. */
function onBlur () {
  const state = editing.value

  editing.value = null

  if (state) settle(state)
}

/**
 * Put the caret in the editor, at the end of whatever is already there.
 *
 * The words are written into the element once, here, and never bound to it. A
 * contenteditable rendered from the state it edits fights the caret: every
 * keystroke replaces the text node under it and the caret jumps back to the
 * front, which is the most familiar way there is to get in-place editing wrong.
 * So the element is the live copy while it has focus and the block is written
 * from it — see `onType` — rather than the other way about.
 */
async function focusEditor () {
  await nextTick()

  const el = editor.value

  if (!el) return

  el.innerText = typing.value?.translation ?? ''
  el.focus()

  const range = document.createRange()

  range.selectNodeContents(el)
  range.collapse(false)

  const caret = getSelection()

  caret?.removeAllRanges()
  caret?.addRange(range)
}

/**
 * What has been typed, written onto the block.
 *
 * The box goes in the *same* call as the words where it grows with them, and
 * that is not tidiness. `recordBlock` folds a run of edits into one step only
 * while the set of fields being written stays the same, so filing the text and
 * then the box as two calls would fold neither — the merge key would alternate
 * on every keystroke, and a typed sentence would cost a press of Cmd+Z per
 * character.
 */
/**
 * Keys pressed inside the editor.
 *
 * Escape ends the typing and stops there: the window's own handler reads it as
 * "select nothing", which would let go of the very block being typed into.
 * Everything else is a letter — "b" is the Brush everywhere else on this page,
 * and while there is a caret it is a b. `claimed` already keeps the shortcuts
 * off anything editable; stopping the press here as well means a shortcut added
 * later that forgets to ask cannot reach in either.
 */
function onKeys (event: KeyboardEvent) {
  if (event.key !== 'Escape') return

  event.preventDefault()
  stopEdit()
}

function onType () {
  const el = editor.value
  const block = typing.value

  if (!el || !block) return

  // One trailing newline is the break a browser keeps at the end of a
  // contenteditable, not a line anybody typed.
  const translation = el.innerText.replace(/\n$/, '')

  if (!editing.value?.grows) return update(block.id, { translation })

  update(block.id, { translation, ...grown(el) })
}

/**
 * The typed line's own size, in the percentages a block is held in.
 *
 * Measured off the element rather than reckoned from the text, because the
 * element is the thing that knows: it is wearing the face, size, spacing and
 * wrapping rules the lettering plate will draw with — see `setStyle` — so what
 * it measures is what will be set.
 */
function grown (el: HTMLElement) {
  const across = pageHeight.value * ratio.value

  // Never nought across: an empty line measures nothing, and a box of no width
  // is one the caret stands outside of and no pointer can find. Floored at half
  // a line deep, so the floor scales with the type rather than with the screen.
  return {
    w: (Math.max(el.offsetWidth, el.offsetHeight / 2) / across) * 100,
    h: (el.offsetHeight / pageHeight.value) * 100,
  }
}

// Nothing carries the caret off the page it was on. Turning the page or putting
// another tool out ends the typing where it started, rather than leaving an
// editor floating over a block that is no longer under it — and, for a
// placement, leaving an empty box behind on a page nobody is looking at.
watch(() => page.value?.id, () => stopEdit())
watch(tool, (id) => {
  if (id !== 'text') stopEdit()
})

/**
 * Where each grip sits on the block, as a share of its box, and what the
 * pointer should look like over it.
 *
 * Named against the box's own edges rather than the screen's: `nw` is the
 * corner at the top left *of the block*, wherever the block has been turned to.
 * The cursor cannot follow it round — there are eight of those and a box may be
 * at any angle — so it names the axis and lets the shape of the thing say the
 * rest.
 */
const CURSORS: Record<HandleKind, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  w: 'ew-resize',
  e: 'ew-resize',
  sw: 'nesw-resize',
  s: 'ns-resize',
  se: 'nwse-resize',
}

/** How far the turn grip stands off the top edge, in screen pixels. */
const STALK = 22

/**
 * A point on the sheet, in the chrome's own pixels — the stage's transform, done
 * as arithmetic, less the pan that the chrome's container wears (see `framed`).
 *
 * This is what lets the chrome live *outside* the stage. Everything drawn
 * inside it wears the zoom, so every line and grip needed a `1 / zoom`
 * somewhere to stay the same size on screen — and a CSS border could not
 * comply at all, since the browser holds one at a whole pixel of the space it
 * is laid out in: at eight times zoom the thinnest border on offer was eight
 * screen pixels of stripe. Drawn out here, a pixel is a pixel, and the
 * counter-scaling disappears rather than being repeated per element.
 *
 * The mapping is the stage's own, written down in `sheetToView`: the sheet is
 * centred in the viewport before the pan says anything — the same offset
 * `bound` adds and removes — then the whole thing is scaled about the top left
 * and panned.
 */
function toChrome (p: { x: number, y: number }) {
  return sheetToView(framed.value, p)
}

/**
 * The part of the sheet on screen, in the sheet's own pixels — the viewport's
 * corners run back through the view, with a margin so a pan shows no undrawn
 * edge in the frame before the canvas catches up. The scan canvas draws exactly
 * this much of the page; see `CanvasEngine`.
 */
const scanView = computed<ScanView>(() => ({
  ...sheetInView(viewed.value, 96),
  sheet: viewed.value.sheet,
  zoom: viewed.value.zoom,
  crisp: pixelPeek.value,
}))

/**
 * The same, as the sheet's contents are handed it: asked for, not given. A
 * value here would be a new prop for `CanvasSheet` on every frame of a pan, and
 * so a render of the whole page's lettering per frame — the thing that
 * component exists to stop. Called by the page art, the view is that
 * component's dependency alone.
 */
const viewOf = () => scanView.value

/**
 * The sheet's top left corner, in the chrome's pixels — the origin anything
 * given in page pixels is measured from once it is drawn out here with the
 * chrome.
 */
const sheetOrigin = computed(() => toChrome({ x: 0, y: 0 }))

/**
 * Where a block's corners sit on the screen.
 *
 * Worked out rather than left to CSS, and that is the whole reason this is not
 * simply a box wearing the same transform as the block. A distorted box is a
 * quadrilateral: its corners are not where scaling and turning would put them,
 * so a grip laid out at "100% across" would sit off the corner it moves. And a
 * container that carried the block's lean would lean the grips with it, leaving
 * a row of little parallelograms to aim at.
 *
 * So the corners come out of the same `cornersOf` the drag arithmetic uses, run
 * through the same matrix, and land in the chrome's pixels — see `toChrome`.
 */
function cornersAt (frame: LetterBox) {
  const box = orientedOf(frame)

  if (!box || !unit.value) return null

  const m = matrixOf(box)
  const u = unit.value
  const at = (p: { x: number, y: number }) => {
    const q = mapped(m, p.x, p.y)

    return toChrome({ x: (box.cx + q.x) * u, y: (box.cy + q.y) * u })
  }

  // The real corners, quad and all, so a grip stays on the corner it moves and
  // the outline drawn through them is the shape the words are actually in.
  return cornersOf(box).map(at)
}

/** Four corners as an SVG polygon's points. */
const pointsOf = (corners: { x: number, y: number }[]) =>
  corners.map((p) => `${p.x},${p.y}`).join(' ')

function gripsFor (block: Block) {
  const c = cornersAt(framedBox(block))

  if (!c) return null

  const mid = (i: number, j: number) => ({ x: (c[i]!.x + c[j]!.x) / 2, y: (c[i]!.y + c[j]!.y) / 2 })

  const grips: { kind: HandleKind, x: number, y: number, cursor: string }[] = [
    { kind: 'nw', ...c[0]!, cursor: CURSORS.nw },
    { kind: 'n', ...mid(0, 1), cursor: CURSORS.n },
    { kind: 'ne', ...c[1]!, cursor: CURSORS.ne },
    { kind: 'w', ...mid(0, 3), cursor: CURSORS.w },
    { kind: 'e', ...mid(1, 2), cursor: CURSORS.e },
    { kind: 'sw', ...c[3]!, cursor: CURSORS.sw },
    { kind: 's', ...mid(3, 2), cursor: CURSORS.s },
    { kind: 'se', ...c[2]!, cursor: CURSORS.se },
  ]

  // The stalk stands off the top edge along its outward normal, so it follows a
  // dragged corner instead of hanging over where the corner used to be.
  const top = mid(0, 1)
  const ex = c[1]!.x - c[0]!.x
  const ey = c[1]!.y - c[0]!.y
  const len = Math.hypot(ex, ey) || 1

  return {
    grips,
    top,
    turn: { x: top.x + (ey / len) * STALK, y: top.y - (ex / len) * STALK },
    // The transform box itself, as four points to draw a line through — flat
    // geometry rather than a bordered element wearing the homography. That is
    // the whole trick: the outline traces the real quad, corner for corner, and
    // there is no perspective anywhere in it to curve the edges or taper the
    // stroke. A CSS border on the distorted element could do one or the other,
    // never both.
    outline: pointsOf(c),
  }
}

/**
 * Which blocks are lit, and what they wear: the tint and the outline, as one
 * polygon each.
 *
 * One shape on purpose. The tint used to be the chip's own background, drawn
 * by the DOM inside the zoomed stage, under an outline stroked by SVG out
 * here — two rasterisers rounding the same edge to different device pixels,
 * which at most zooms left a hairline of artwork showing between the fill and
 * its line. A polygon's fill and stroke are one geometry and cannot part.
 *
 * The stroke is the same four edges the transform box draws, from the same
 * corners, and it stands down while that box is up: a second line half a
 * hairline out of register beside it looked like a fault in the box rather
 * than a box. The fill stays — the box strokes edges, it does not tint.
 */
const blockChrome = computed(() => (page.value?.blocks ?? []).flatMap((block) => {
  const picked = selection.value.includes(block.id)
  const hover = hovered.value === block.id

  if (!blockShown(block) || (!picked && !hover)) return []

  const corners = cornersAt(framedBox(block))

  if (!corners) return []

  // As faint as the chip it stands for: locked away entirely, or merely kept
  // out of the render, the chrome dims the way the block does.
  const dim = (blockPickable(block) ? 1 : 0.25) * (block.hidden ? 0.4 : 1)

  return [{
    id: block.id,
    points: pointsOf(corners),
    tone: BLOCK_TONE[block.type],
    fill: (picked ? 0.1 : 0.05) * dim,
    line: picked && gripped.value ? 0 : (picked ? 1 : 0.45) * dim,
    // The key object wears a heavier line — see `keyed`, and `gripBoxes`, which
    // says the same thing about the transform box for the tool that draws one.
    // Thickness rather than a colour, because the outlines already spend colour
    // on what kind of block it is, and a second meaning on the same channel
    // would make a caption and a key indistinguishable from each other.
    width: keyed.value === block.id ? 3 : 1.5,
    // A hidden block keeps saying so in the one way a line can.
    dashed: block.hidden,
  }]
}))

/** The block the pointer is over, if any — what used to be a `:hover` border. */
const hovered = ref<string | null>(null)

/**
 * The box the handles are *not* on, drawn faint and dashed beside the one they
 * are — the reading under a lettering frame that has been moved off it, or the
 * frame beside a reading being corrected.
 *
 * This is what keeps the framing mode from being the trap a mode usually is (see
 * `Framing`). Without it the two boxes are one box wherever they agree and an
 * unexplained jump wherever they do not: a letterer widens a balloon, the
 * repair stays the size it always was, and nothing on screen says why. With it,
 * the moment the two part company you can see both — where the words are, and
 * where the artwork under them was cut from.
 *
 * Only for blocks that are picked or under the pointer, and only where the two
 * genuinely differ, so a page nobody has re-lettered draws nothing extra at all.
 * A translated block lettered into its balloon's room (`Block.room`) is one
 * that differs without anybody having moved anything, which is exactly when
 * the ghost is needed most: the words are in the balloon and the reading is
 * the narrow column it came from.
 *
 * In the block's own tone, at half strength, rather than in a neutral grey. The
 * grey was the first attempt and it is the mistake `STANDING_IN_TONE` argues
 * against one file along: this line is drawn *on the scan*, the scans are black
 * and white, and grey over grey art is the one colour that will not separate
 * from what is under it. The tone is also the truer statement — this is the same
 * block's other box, not a second block — and what says it is not the live one
 * is the dash, the absent fill and the thinner stroke.
 */
const frameGhosts = computed(() => (page.value?.blocks ?? []).flatMap((block) => {
  if (!(block.letter || (block.room && block.translation)) || !blockShown(block) || !blockPickable(block)) return []
  if (!selection.value.includes(block.id) && hovered.value !== block.id) return []

  const corners = cornersAt(writesLetter(block) ? blockBoxOf(block) : letterBoxOf(block))

  return corners ? [{ id: block.id, points: pointsOf(corners), tone: BLOCK_TONE[block.type] }] : []
}))

const { on: balloonDebug, fills: balloonFills, note: balloonNote, busy: balloonBusy, measure: measureBalloons, keyOf: balloonKey } = useBalloonDebug()

// Measured when the view goes on and again when the page or its blocks change —
// see `useBalloonDebug` on why the fill is measured rather than stored.
watch(
  () => (balloonDebug.value && page.value ? balloonKey(page.value) : null),
  (key) => {
    if (key && page.value) measureBalloons(page.value)
  },
  { immediate: true },
)

/** Where the measured fills sit on screen: the whole page's box, as the stage draws it. */
const balloonFillRect = computed(() => {
  const measured = balloonFills.value

  if (!balloonDebug.value || !measured || !page.value || measured.key !== balloonKey(page.value) || !unit.value) return null

  const from = toChrome({ x: 0, y: 0 })
  const to = toChrome({ x: dims.value.width * unit.value, y: dims.value.height * unit.value })

  return { url: measured.url, left: from.x, top: from.y, width: to.x - from.x, height: to.y - from.y }
})

/** What each verdict is called on a label when it disagrees with what is stored. */
const NOW: Record<string, string> = {
  room: 'room',
  found: 'room (dark shape)',
  clear: 'room (clear paper)',
  skipped: 'hidden or rubbish',
  crowded: 'refused: covers another block',
  'not-balloon': 'no balloon',
  tilted: 'tilted',
  'no-fence': 'no balloon drawn',
  shared: 'shares a balloon',
  'no-paper': 'no paper',
  escaped: 'escaped',
  smaller: 'smaller than the block',
}

/**
 * View › Balloon debug: each block's three frames, and which one its lettering
 * is set in — see `useBalloonDebug`. Every shown block rather than the picked
 * ones, because the question it answers is about a page, not a block: which
 * lines got their balloon and which fell back to the narrow reading.
 *
 * The label says what a translation *would* be set in, so an untranslated block
 * is labelled too — the room is measured at the reading, before any words exist.
 * `gain` is the room against the Reading box by area, the number the OCR lab
 * prints, worked out in page percentages where both boxes live.
 */
const balloonFrames = computed(() => {
  if (!balloonDebug.value) return []

  return (page.value?.blocks ?? []).flatMap((block) => {
    if (!blockShown(block)) return []

    const reading = cornersAt(blockBoxOf(block))

    if (!reading) return []

    const room = block.room ? cornersAt({ ...block.room }) : null
    const frame = block.letter ? cornersAt(block.letter) : null
    const gain = block.room && block.w * block.h > 0
      ? (block.room.w * block.room.h) / (block.w * block.h)
      : null
    const uses: 'frame' | 'room' | 'reading' = block.letter ? 'frame' : block.room ? 'room' : 'reading'
    const stored = uses === 'frame'
      ? `hand frame${gain === null ? '' : ` · room ${gain.toFixed(1)}×`}`
      : uses === 'room' ? `room ${gain!.toFixed(1)}×` : 'no room · reading box'

    // What the rules say now, where it disagrees with what is stored: a room
    // kept then and refused now, or the other way round.
    const now = balloonFills.value?.verdicts[block.id]
    const roomNow = now?.reason === 'room' || now?.reason === 'found' || now?.reason === 'clear'
    const label = now && roomNow !== Boolean(block.room)
      ? `${stored} · now: ${NOW[now.reason] ?? now.reason}`
      : stored

    return [{
      id: block.id,
      reading: pointsOf(reading),
      room: room && pointsOf(room),
      frame: frame && pointsOf(frame),
      uses,
      label,
      // Under the Reading box's lowest left corner, clear of the number badge.
      at: reading.reduce((low, p) => (p.y > low.y || (p.y === low.y && p.x < low.x) ? p : low)),
    }]
  })
})

/** The label's colour: the colour of the frame the lettering is in. */
const BALLOON_TONE = { frame: 'text-blue-500', room: 'text-green-500', reading: 'text-pink-500' } as const

/**
 * The number labels of the blocks that are picked or under the pointer, pinned
 * above each north-west corner. Chrome like the outlines, and out in screen
 * space for the same reason: inside the chip the label had to be counter-scaled
 * by the zoom, and at eight times in the un-scaled disc buried the corner grip
 * it sat on.
 *
 * Only those, and that is a change with a cost. Every block's label used to be
 * rendered, shown or not, so the opacity could fade out as well as in — which
 * put a corner worked out and a label restyled per block on the page into every
 * frame of a zoom, for labels nobody could see. Now a label fades in as it
 * arrives (`starting:` in the template) and goes at once, which is what the
 * tint and the outline it labels have always done.
 */
const blockBadges = computed(() => {
  const lit = new Set(selection.value)

  if (hovered.value) lit.add(hovered.value)

  if (!lit.size) return []

  return (page.value?.blocks ?? []).flatMap((block, index) => {
    if (!lit.has(block.id) || !blockShown(block)) return []

    const corners = cornersAt(framedBox(block))

    if (!corners) return []

    return [{
      id: block.id,
      number: index + 1,
      tone: BLOCK_TONE[block.type],
      dimmed: !blockPickable(block),
      at: corners[0]!,
    }]
  })
})

/** A grip's own placement: centred on its point, in screen pixels. */
const gripStyle = (grip: { x: number, y: number, cursor?: string }) => ({
  left: `${grip.x}px`,
  top: `${grip.y}px`,
  ...(grip.cursor ? { cursor: grip.cursor } : {}),
  transform: 'translate(-50%, -50%)',
})

/** Every transform box on screen, worked out once rather than per grip. */
const gripBoxes = computed(() => {
  if (!gripped.value) return []

  return selected.value.flatMap((block) => {
    if (!blockShown(block) || !blockPickable(block)) return []

    const found = gripsFor(block)

    // The key object's box is drawn heavier. With the Select tool out the
    // transform box is the only outline a picked block has — `blockChrome`
    // stands its own line down so the two cannot sit half a hairline apart —
    // so without this the one thing that says which block the align panel is
    // measuring from would be invisible for the tool it is used with.
    return found ? [{ block, key: keyed.value === block.id, ...found }] : []
  })
})

/* ---------- the rubber band ---------- */

/**
 * The band being pulled, in page percentages, from where it began to where the
 * pointer is now. Kept as two corners rather than a normalised box because
 * either one may end up the smaller — a band can be drawn in any direction, and
 * squaring it up is the last thing done rather than the first.
 */
const band = ref<{ x0: number, y0: number, x1: number, y1: number } | null>(null)

/** Whether the band adds to the selection instead of replacing it. */
let bandAdds = false

/**
 * Where a pointer is on the page, as a percentage, whatever the zoom and pan.
 *
 * Through the view rather than off the sheet's rectangle — see `originOf`,
 * which says what reading the rectangle on every move of a band cost.
 */
function pagePoint (event: PointerEvent) {
  const at = originOf()
  const { w, h } = viewed.value.sheet

  if (!at || !w || !h) return null

  const p = viewToSheet(viewed.value, { x: event.clientX - at.x, y: event.clientY - at.y })

  // Clamped, so a band pulled off the edge of the page stops at the edge rather
  // than reaching for blocks at coordinates no block can have.
  return {
    x: Math.max(0, Math.min(100, (p.x / w) * 100)),
    y: Math.max(0, Math.min(100, (p.y / h) * 100)),
  }
}

/** The band squared up into a box, whichever way round it was drawn. */
const bandBox = computed(() => {
  const b = band.value

  if (!b) return null

  return {
    x: Math.min(b.x0, b.x1),
    y: Math.min(b.y0, b.y1),
    w: Math.abs(b.x1 - b.x0),
    h: Math.abs(b.y1 - b.y0),
  }
})

/** The band as the screen-space chrome draws it — see `toChrome`. */
const bandStyle = computed(() => {
  const b = bandBox.value

  if (!b) return null

  const z = zoom.value ?? 1
  const w = pageHeight.value * ratio.value
  const h = pageHeight.value
  const at = toChrome({ x: (b.x / 100) * w, y: (b.y / 100) * h })

  return {
    left: `${at.x}px`,
    top: `${at.y}px`,
    width: `${(b.w / 100) * w * z}px`,
    height: `${(b.h / 100) * h * z}px`,
  }
})

/**
 * Below this a band is a click that wandered, not a band. A press on empty page
 * has already cleared the selection on the way down, so there is nothing left
 * for a band this small to say.
 */
const BAND_FLOOR = 1

/* ---------- navigation & zoom ---------- */

/**
 * A notch, in pixels.
 *
 * Mice report one as pixels, lines or pages depending on the browser and the
 * device, so everything below would otherwise mean three different amounts of
 * turning on three different machines.
 */
function step (event: WheelEvent) {
  return event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
}

function pixels (event: WheelEvent) {
  return event.deltaY * step(event)
}

/** When the wheel last asked where the pointer was — see `pointOf`. */
let wheeled = 0

/**
 * Where a pointer is, measured from the canvas's own corner.
 *
 * From the corner read when the wheel started turning rather than on every
 * notch — see `originOf`. A pinch is a hundred of these a second, each landing
 * just after the last one's zoom was written to the page.
 */
function pointOf (event: WheelEvent) {
  const now = performance.now()
  const at = originOf(now - wheeled > 200)

  wheeled = now

  return at ? { x: event.clientX - at.x, y: event.clientY - at.y } : undefined
}

/**
 * Whether the page is bigger than the room it is in, which is the only thing
 * that decides who the wheel belongs to.
 */
const zoomed = computed(() => (zoom.value ?? 1) > 1.02)

/** Below this a delta is the wheel settling rather than anyone turning it. */
const JITTER = 0.5

/** At or above this, one event is a whole notch of a stepped wheel. */
const NOTCH = 40

/** How much gliding comes to a page. */
const TURN = 120

/**
 * The fastest the pages may be walked, per kind of wheel, in milliseconds.
 *
 * Two figures because the two devices are asking for different things. A notch
 * is a deliberate act — you cannot make more than about ten a second — so its
 * gate is only there to stop a free-spinning wheel from flinging the chapter
 * past; anything longer is felt as the page lagging behind the hand.
 *
 * A glide is not deliberate in the same way. One flick of a trackpad is a
 * hundred events and would come to a page's worth several times over, so that
 * one keeps a gap long enough to walk the book rather than fly through it.
 */
const STEP_PACE = 80
const GLIDE_PACE = 150

let turned = 0
let lastTurn = 0
let lastWheel = 0

/**
 * How quickly a glided scroll catches up with where the wheel has asked it to
 * be — the time it takes to close about two thirds of the remaining distance.
 *
 * Short enough to feel like the page is being pushed rather than towed. Longer
 * than a couple of frames or the smoothing would be doing nothing; much longer
 * and the wheel starts to feel like it is steering something heavy.
 */
const GLIDE_TAU = 55

/* ---------- bounds ---------- */

/**
 * How far past its own edge the page may be pushed — the same air it is given
 * at the fit.
 *
 * Not nought: an edge flush against the side of the canvas is hard to read and
 * harder to work on, and a corner block would sit half under the panel beside
 * it. A little slack lets the outermost lettering be brought properly into
 * view without letting the page wander off.
 */
const SLACK = 24

/**
 * The furthest the page can be pulled past its bounds while a hand is on it.
 *
 * Only ever while dragging. A hand on the page is a direct thing — the page is
 * under the pointer and moves with it — so resistance and a spring back read as
 * the page pushing against your hand, which is how every canvas says "this is
 * the end" without a word. A wheel has none of that: no contact, and no release
 * to spring back from, so it gets the edge flash instead.
 */
const RUBBER = 96

/**
 * How far past a bound something has actually got, given how far it is asking
 * to go.
 *
 * One to one at first, easing to a stop at `most` however hard it is pulled —
 * so it starts by following the hand exactly and stiffens as it goes, rather
 * than feeling slack from the off.
 */
function stretch (excess: number, most: number) {
  return Math.sign(excess) * most * (1 - Math.exp(-Math.abs(excess) / most))
}

/**
 * One axis of the pan, held to what can actually be looked at.
 *
 * `v` is the pan, `size` how big the page is on screen once scaled, and `room`
 * the canvas across that axis. The pan is not where the page *is* — the page is
 * centred in the stage before any of this — so the offset it sits at with no
 * pan at all has to be added in, clamped, and taken back off again.
 *
 * Two cases, and the boundary between them is continuous:
 *
 * - Bigger than the room: it may be moved, but not so far that the room is
 *   showing more than a strip of nothing.
 * - Smaller: there is nothing to move to. Anything else would be dragging a
 *   page that already fits out of sight of a canvas it fits in.
 *
 * `give` is the rubber band, and is nought for everything but a drag.
 */
function bound (v: number, size: number, room: number, give = 0) {
  const z = zoom.value ?? 1

  // Where the page's near edge lands when the pan is nought.
  const base = (room * z - size) / 2

  const pinned = size + SLACK * 2 < room
  const near = pinned ? (room - size) / 2 : room - size - SLACK
  const far = pinned ? (room - size) / 2 : SLACK

  const at = v + base
  const held = Math.min(far, Math.max(near, at))

  return held + (give ? stretch(at - held, give) : 0) - base
}

/** The pan, held inside those bounds on both axes. */
function clamped (p: { x: number, y: number }, give = 0) {
  if (!measured.value) return p

  const z = zoom.value ?? 1
  const h = pageHeight.value * z

  return {
    x: bound(p.x, h * ratio.value, width.value, give),
    y: bound(p.y, h, height.value, give),
  }
}

/**
 * Anything that changes what the bounds *are* has to bring the pan back inside
 * them: zooming out shrinks the page under a pan that was fine a moment ago,
 * and so does dragging the panels wider. Written back only when it has actually
 * moved, so this cannot chase itself.
 */
watch([zoom, width, height, pageHeight], () => {
  const to = clamped(pan.value)

  if (to.x !== pan.value.x || to.y !== pan.value.y) pan.value = to
})

/* ---------- the edge flash ---------- */

/**
 * The four strips down the sides of the canvas, lit when the wheel asks for
 * more page than there is.
 *
 * A cue rather than a movement, and that is the point: the wheel has no release
 * to spring back from, so anything that moved the page would have to un-move it
 * on a timer — which reads as drift rather than as an edge. A shadow says the
 * same thing without putting the page anywhere it is not.
 */
const EDGES = [
  { at: 'left', box: 'inset-y-0 left-0 w-14 bg-linear-to-r from-foreground/15 to-transparent' },
  { at: 'right', box: 'inset-y-0 right-0 w-14 bg-linear-to-l from-foreground/15 to-transparent' },
  { at: 'top', box: 'inset-x-0 top-0 h-14 bg-linear-to-b from-foreground/15 to-transparent' },
  { at: 'bottom', box: 'inset-x-0 bottom-0 h-14 bg-linear-to-t from-foreground/15 to-transparent' },
] as const

const lit = reactive({ left: false, right: false, top: false, bottom: false })

let unlight = 0

/**
 * Light the side the page ran out on, from what the bounds would not give.
 *
 * A pan that grows is the page sliding right, which uncovers its left edge — so
 * the leftover is the opposite way round from the side that gets lit.
 *
 * Held rather than blinked: the timer is pushed back by every event, so a wheel
 * kept turning at the edge keeps the strip lit and it fades once the turning
 * stops. Anything shorter would strobe at one flash per notch.
 */
function flash (x: number, y: number) {
  // Whichever axis was refused more — a diagonal into a corner lights the side
  // it mostly ran into, rather than lighting two and reading as a flicker.
  const across = Math.abs(x) > Math.abs(y)
  const most = across ? x : y

  if (Math.abs(most) < 0.5) return

  const edge = across
    ? (most > 0 ? 'left' : 'right')
    : (most > 0 ? 'top' : 'bottom')

  lit.left = lit.right = lit.top = lit.bottom = false
  lit[edge] = true

  clearTimeout(unlight)
  unlight = window.setTimeout(() => {
    lit.left = lit.right = lit.top = lit.bottom = false
  }, 260)
}

onScopeDispose(() => clearTimeout(unlight))

/* ---------- gliding ---------- */

/** Where the scroll is heading, while it is still on its way there. */
let heading: { x: number, y: number } | null = null
let frame = 0
let lastFrame = 0

function stopGlide () {
  if (frame) cancelAnimationFrame(frame)

  frame = 0
  heading = null
}

function tick (now: number) {
  frame = 0

  const to = heading

  if (!to) return

  // Against the clock rather than per frame: the same fraction each frame is a
  // different speed on a 60Hz screen and a 120Hz one, and the wheel would feel
  // twice as eager on the better monitor.
  //
  // Floored at nought as well as capped: a frame that arrived before the last
  // one would make the easing negative, which is not a slower glide but a page
  // accelerating the wrong way, further out on every frame.
  const dt = Math.min(64, Math.max(0, now - lastFrame))

  lastFrame = now

  const dx = to.x - pan.value.x
  const dy = to.y - pan.value.y

  // Near enough is arrived: an exponential approach never quite lands, and a
  // frame spent moving a fifth of a pixel is a frame wasted.
  if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) {
    pan.value = to
    heading = null

    return
  }

  const k = 1 - Math.exp(-dt / GLIDE_TAU)

  pan.value = { x: pan.value.x + dx * k, y: pan.value.y + dy * k }
  frame = requestAnimationFrame(tick)
}

/**
 * Move the page, either at once or on a glide.
 *
 * A stepped wheel says a whole notch in one event, and a page that jumped the
 * lot is the thing that reads as coarse — so those are eased across a few
 * frames. A trackpad has already done that work: it reports the same journey
 * as dozens of slivers, and smoothing what is smooth only adds a lag between
 * the fingers and the page. So the size of the delta decides, as it does for
 * turning pages.
 *
 * Distances add onto where it is *heading* rather than where it is, so a
 * second notch during a glide goes twice as far instead of restarting.
 */
function glideTo (to: { x: number, y: number }) {
  // The glide is run frame by frame here, so the CSS transition must be off —
  // two easings over one transform would only fight.
  eased.value = false
  heading = to

  if (!frame) {
    lastFrame = performance.now()
    frame = requestAnimationFrame(tick)
  }
}

function panBy (dx: number, dy: number, glide: boolean) {
  const from = heading ?? pan.value
  const want = { x: from.x + dx, y: from.y + dy }

  // Bounded here rather than frame by frame: the glide runs between two points
  // that are both inside the bounds, and everything between them is too.
  const to = clamped(want)

  // Whatever the bounds refused is what the flash is for.
  flash(want.x - to.x, want.y - to.y)

  if (!glide) {
    stopGlide()
    pan.value = to

    return
  }

  glideTo(to)
}

// Anything that moves the page some other way wins: a zoom recomputes the pan
// from where the page is now, and a glide still running would drag it off that
// mark a frame later.
watch(zoom, stopGlide)
onScopeDispose(stopGlide)

function onWheel (event: WheelEvent) {
  event.preventDefault()

  /**
   * A pinch on a trackpad arrives as a wheel event with ctrl already held —
   * the browser saying "this was a zoom" rather than anyone reaching for a
   * modifier. Since ctrl now means something else here, the two have to be
   * told apart, and the only thing that separates them is whether the key is
   * actually down: `modHeld` is what the keyboard has reported, `ctrlKey` is
   * what the gesture claims.
   */
  const pinch = (event.ctrlKey || event.metaKey) && !modHeld.value

  if (event.altKey || pinch) {
    // By how far the wheel actually turned rather than by a fixed notch: a
    // trackpad glides in many small deltas where a mouse sends one big one,
    // and a step that suited either would be wrong for the other. Clamped so
    // one flick cannot leap several times over.
    //
    // A notch-sized delta is one jump, and glides to where it is going. A
    // glide is already continuous and is left to arrive by itself.
    zoomAt(
      Math.min(2, Math.max(0.5, Math.exp(-pixels(event) * 0.0015))),
      pointOf(event),
      Math.abs(pixels(event)) >= NOTCH,
    )

    return
  }

  // Ctrl or cmd turns the wheel on its side. Only the page's own axis changes:
  // a wheel with no sideways axis of its own gets one, and a trackpad that has
  // one already can still use it unmodified.
  if (event.ctrlKey || event.metaKey) {
    // Nothing to move sideways while the whole page is on screen — and moving
    // it anyway would slide the page out of a room it fits in.
    if (!zoomed.value) return

    const dx = -pixels(event)

    panBy(dx, 0, Math.abs(dx) >= NOTCH)

    return
  }

  // Zoomed in, the wheel moves the page being looked at. Turning to the next
  // one in the middle of inspecting this is never what was meant, and there is
  // nowhere else to put the gesture — a wheel that did nothing here would be
  // worse than one that does the obvious thing.
  if (zoomed.value) {
    const k = step(event)
    const dx = -event.deltaX * k
    const dy = -event.deltaY * k

    panBy(dx, dy, Math.max(Math.abs(dx), Math.abs(dy)) >= NOTCH)

    return
  }

  const dy = pixels(event)

  if (Math.abs(dy) < JITTER) return

  const now = performance.now()
  const fresh = now - lastWheel > 200

  lastWheel = now

  if (fresh) turned = 0

  /**
   * A wheel that steps says a whole notch at once, and waiting for it to add up
   * to a page would mean slow ticking never turned anything. A wheel that
   * glides — a free-spinning one, or a trackpad — says the same journey in
   * dozens of slivers, and turning on the first of those would turn the page
   * for the smallest touch, over and over.
   *
   * So the size of the delta decides which it is, rather than an assumption
   * about what is plugged in.
   *
   * Every notch, and not merely the first of a gesture. Only the first used to
   * turn and the rest fell into the accumulator below, which sounds like a
   * detail and is not: a notch is about a hundred pixels and a page's worth is
   * a hundred and twenty, so the second notch of every gesture came up short
   * and did nothing at all. Keep scrolling and the wheel turned a page every
   * *other* click — the sluggishness was a notch being swallowed, not a timer
   * being slow.
   */
  if (Math.abs(dy) >= NOTCH) {
    if (now - lastTurn < STEP_PACE) return

    lastTurn = now
    // Anything part-counted belonged to the same movement and has just been
    // spent; left standing it would tip the next glide over early.
    turned = 0
    go(at.value + (dy > 0 ? 1 : -1))

    return
  }

  turned += dy

  // Paced, so that a long glide walks the book rather than flying through it.
  if (Math.abs(turned) >= TURN && now - lastTurn > GLIDE_PACE) {
    go(at.value + (turned > 0 ? 1 : -1))
    lastTurn = now
    turned = 0
  }
}

/* ---------- panning ---------- */

/**
 * Whether space is being held, which is the whole of what makes a left drag a
 * pan rather than a press.
 *
 * Space used to turn the page, and it cannot do both: a key that pans while it
 * is down and turns the page when it comes up would turn one every time you
 * finished panning. Every canvas worth the name gives space to the hand, and
 * the page still has the arrows, Page Up and Page Down, and the wheel.
 *
 * Let go of on losing the window as well as on key-up — a hand that was down
 * when you switched away is not still down when you come back, and there is no
 * key-up to say so.
 */
const spaceHeld = ref(false)

/**
 * Whether ctrl or cmd is genuinely down, as against a trackpad pinch claiming
 * it is — see the top of `onWheel`, which is the whole reason this is tracked.
 */
const modHeld = ref(false)

/** Where a drag began, and where the page was when it did. */
const drag = ref<{ x: number, y: number, px: number, py: number } | null>(null)

/** Nothing to pan while the whole page is on screen. */
const pannable = computed(() => zoomed.value)

/** Whether a key event is one of the two modifiers being watched for. */
function isMod (event: KeyboardEvent) {
  return event.key === 'Control' || event.key === 'Meta'
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (isMod(event)) modHeld.value = true

  if (claimed(event)) return

  // Select All takes everything the stack leaves within reach, which is the
  // whole of the rule: hidden layers are not on the page and locked ones are not
  // yours, so neither is in the list this reads.
  if (event.key.toLowerCase() === 'a' && addsToSelection(event) && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    selectAll()

    return
  }

  // Escape lets go of everything — the one gesture that always means "nothing",
  // and the way out of a selection made by a band that caught too much.
  if (event.key === 'Escape' && selection.value.length) {
    event.preventDefault()
    select(null)

    return
  }

  if (event.code !== 'Space') return

  // Held, not pressed: the browser would otherwise scroll whatever is behind.
  event.preventDefault()
  spaceHeld.value = true
})

useEventListener(window, 'keyup', (event: KeyboardEvent) => {
  if (isMod(event)) modHeld.value = false
  if (event.code === 'Space') spaceHeld.value = false
})

useEventListener(window, 'blur', () => {
  spaceHeld.value = false
  modHeld.value = false
})

function onPointerDown (event: PointerEvent) {
  // The middle button pans from anywhere — over a block, over its lettering —
  // because nothing else there wants it. Space does the same for the left one.
  const panning = event.button === 1 || (event.button === 0 && spaceHeld.value)

  if (!panning) {
    if (event.button !== 0) return

    // The start of a gesture, whatever it turns out to be: a band or a placement
    // measures its moves from here — see `originOf`.
    originOf(true)

    // A press on a block is that block's to answer — it is the thing being
    // aimed at, and a band started under it would be a band started by
    // clicking something.
    const onBlockBox = (event.target as HTMLElement | null)?.closest('[data-block]')

    /**
     * The Text tool takes the press before anything else can have it: over the
     * page it places a block, over a block already there it puts the caret in
     * that one — which is what every editor's type tool does, and the only
     * reading of a press on lettering while a lettering tool is out.
     *
     * The default is prevented so that focus stays where this puts it. Without
     * that the browser moves it to whatever was pressed on the way past, and
     * the editor is blurred by the very gesture that opened it.
     */
    if (texting.value) {
      // A press inside the editor belongs to the caret, and to nothing here.
      if ((event.target as HTMLElement | null)?.closest('[data-lettering]')) return

      event.preventDefault()

      const id = (onBlockBox as HTMLElement | null)?.dataset.block

      if (id) editBlock(id)
      else beginPlace(event)

      return
    }

    if (selecting.value && !onBlockBox) {
      const from = pagePoint(event)

      if (!from) return

      // Either modifier adds, the way every canvas takes both here: Shift for a
      // second sweep and Cmd for a considered addition amount to the same ask.
      bandAdds = addsToSelection(event) || event.shiftKey

      // A bare press clears first, so that a band which catches nothing leaves
      // nothing — and so does a plain click on empty page.
      if (!bandAdds) select(null)

      band.value = { x0: from.x, y0: from.y, x1: from.x, y1: from.y }
      viewport.value?.setPointerCapture(event.pointerId)

      return
    }

    // Every other tool: the press that means "nothing", on the backdrop only.
    if (event.target === event.currentTarget) select(null)

    return
  }

  event.preventDefault()

  if (!pannable.value) return

  // A drag is a continuous thing and must not be eased, or the page would keep
  // arriving a moment after the hand — and a scroll still gliding would go on
  // pulling the page somewhere the hand is no longer taking it.
  eased.value = false
  stopGlide()
  drag.value = { x: event.clientX, y: event.clientY, px: pan.value.x, py: pan.value.y }
  viewport.value?.setPointerCapture(event.pointerId)
}

function onPointerMove (event: PointerEvent) {
  if (band.value) {
    const to = pagePoint(event)

    if (to) band.value = { ...band.value, x1: to.x, y1: to.y }

    return
  }

  const from = drag.value

  if (!from) return

  // Measured from where the drag began rather than added up move by move, so
  // that a hand carried past the edge and back again picks the page up where it
  // left it instead of having dragged an accumulated distance it never showed.
  pan.value = clamped({
    x: from.px + (event.clientX - from.x),
    y: from.py + (event.clientY - from.y),
  }, RUBBER)
}

function endDrag () {
  const pulled = bandBox.value

  if (pulled) {
    band.value = null

    if (pulled.w >= BAND_FLOOR || pulled.h >= BAND_FLOOR) selectWithin(pulled, bandAdds)

    return
  }

  if (!drag.value) return

  drag.value = null

  // Letting go is what the rubber band was waiting for. Glided back rather than
  // snapped, because the whole of what it was saying was that the page is being
  // held out of place — and a page that jumped back would only have flickered.
  const to = clamped(pan.value)

  if (to.x !== pan.value.x || to.y !== pan.value.y) glideTo(to)
}

/**
 * The keys, which say the same things the wheel does and a few it cannot.
 *
 * Nothing fires while something else has the press: in a field the arrows
 * belong to the caret and space to the sentence, and in an open list they
 * belong to the list — an arrow that walked the language menu and turned the
 * page under it was doing two people's jobs at once. See `claimed`.
 */
/**
 * Move the selection by the arrow keys, in the scan's own pixels.
 *
 * Shift takes the coarse step, the way every canvas offers a fine one and a
 * fast one. Whole pixels of the scan rather than of the screen, so the same
 * press moves a block the same distance whatever the page is zoomed to — a
 * nudge is an adjustment to the page, not to the view of it.
 */
function nudge (dx: number, dy: number, far: boolean) {
  const scan = dims.value

  if (!scan.width || !scan.height) return

  const step = far ? 10 : 1

  // A run of presses — a key held down — folds into one step, like a drag.
  setBoxes(selected.value.map((block) => {
    const box = toOriented(framedBox(block), scan)

    return { id: block.id, box: { ...box, cx: box.cx + dx * step, cy: box.cy + dy * step } }
  }), scan, `nudge:${selection.value.join()}`)
}

/** Which way each arrow nudges. */
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

function onKeydown (event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return

  if (claimed(event)) return

  // The arrows belong to the selection while there is one and the Select tool
  // is out; only with nothing picked do they go back to turning the page. A key
  // that did both would move a block *and* leave the page it was on.
  const push = NUDGE[event.key]

  if (push && gripped.value && selected.value.length) {
    event.preventDefault()
    nudge(push[0], push[1], event.shiftKey)

    return
  }

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
    // Which box the handles are on — see `Framing`. A bare letter, because it is
    // reached for mid-transform and a panel two columns away is not: the whole
    // reason the detection box needs its own mode is that somebody is looking at
    // a balloon and can see the repair under it is cut wrong. `f` for frame, and
    // free — every tool's own letter is taken by `useToolShortcuts`.
    f: () => { framing.value = framing.value === 'lettering' ? 'reading' : 'lettering' },
    '+': () => { zoomAt(1.25, undefined, true) },
    '=': () => { zoomAt(1.25, undefined, true) },
    '-': () => { zoomAt(1 / 1.25, undefined, true) },
  }

  const act = keys[event.key]

  if (!act) return

  event.preventDefault()
  act()
}

useEventListener(window, 'keydown', onKeydown)

/**
 * Whether the page is being shown at its own pixels or better, which is when
 * the browser should stop smoothing it.
 *
 * Enlarged, smoothing is guesswork: it invents values between the pixels that
 * are there, and a screentone turns to mush exactly when you have zoomed in to
 * look at it. Shrunk, the opposite holds — dropping rows beats a dot screen
 * into moiré, and smoothing is the right answer to that. So this asks for
 * pixels only from 1:1 upwards.
 *
 * There is deliberately no `will-change` anywhere near it. That is a promise to
 * the compositor that the page is about to move, which it keeps by rasterising
 * once and stretching the result — bilinearly, whatever this says. The pixels
 * would be decided a step earlier and nothing here could reach them.
 */
const pixelPeek = computed(() => {
  const scan = page.value?.scan

  return !!scan?.width && pageHeight.value * ratio.value * (zoom.value ?? 1) >= scan.width
})
</script>

<template>
  <!--
    Clipped rather than scrolled: the pan lives in the stage's transform, and a
    scroll bar would be a second, separate opinion about where the page is.
    `touch-none` for the same reason — the browser's own panning would fight it.
  -->
  <div
    ref="viewport"
    class="bg-muted/40 relative size-full touch-none overflow-hidden"
    :class="drag ? 'cursor-grabbing' : pannable && spaceHeld ? 'cursor-grab' : ''"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @contextmenu="endDrag"
    @mousedown.middle.prevent
    @auxclick.prevent
  >
    <!--
      Nothing on the page is text to be selected — hence `select-none` on the
      sheet below. A rubber-band is a drag across lettering, and without it the
      browser reads that as one and highlights every word the band crosses: the
      band ends, the highlight stays, and the page is left daubed in blue.

      Scaled from the top left, because that is the corner the arithmetic in
      `zoomAt` is written against — from the middle, every step would also move
      the page by half of what it grew, and the point under the pointer would
      wander off on its own.

      The page inside is still centred, so at the fit it sits where it always
      did; the transform starts from nothing and only takes over once there is
      a zoom to speak of.
    -->
    <div class="absolute inset-0 flex origin-top-left items-center justify-center p-6" :style="stageStyle">
      <!--
        The sheet: the page's laid-out box, and the frame everything on the
        page is drawn in — by `CanvasSheet`, which says why that is a component
        of its own and why it renders into this element rather than being it.
        `group/sheet` and `data-moving` are how the lettering plates in there
        hear that the view is moving without being handed a prop that changes.
      -->
      <div
        v-if="page && measured"
        class="group/sheet relative flex-none select-none"
        :class="[pixelPeek && '[image-rendering:pixelated]', texting && 'cursor-text']"
        :style="{ height: `${pageHeight}px`, width: `${pageHeight * ratio}px` }"
        :data-moving="gesturing || undefined"
      >
        <CanvasSheet
          ref="contents"
          :page="page"
          :unit="unit"
          :view="viewOf"
          :editing="editing"
          :gripped="gripped"
          :texting="texting"
          @press="onPress"
          @pick="onPick"
          @hover="onHover"
          @type="onType"
          @blur="onBlur"
          @keys="onKeys"
        />
      </div>
    </div>

    <!--
      The chrome: outlines, transform boxes, grips, number labels and the
      rubber band — everything drawn *about* the page rather than *on* it.

      Outside the stage, deliberately. The stage wears the zoom, so chrome
      drawn inside it had to counter-scale every size it owned — grips,
      labels, stroke widths — and a CSS border could not comply at all, being
      held to a whole pixel of the zoomed space. Out here a pixel is a screen
      pixel, the lines stay hairlines at any zoom, and `toChrome` does the
      stage's arithmetic once instead of every element undoing it.

      The container wears the pan and nothing else, so a pan moves it rather
      than placing everything in it again — see `framed`. The zoom it cannot
      wear, for the reason above, so a zoom still re-places what is here; that
      is the chrome of the picked and the hovered, and nothing for the rest.
    -->
    <div v-if="page && measured" class="pointer-events-none absolute inset-0" :style="chromeStyle">
      <!--
        The blocks' tints and edges, drawn rather than styled onto the chips —
        fill and stroke of one polygon, in the tone of the block it belongs
        to, so no seam can open between them. It also traces a pulled quad's
        real corners, which no border on the rectangle could.
      -->
      <!--
        View › Balloon debug's fills: each balloon's interior as the flood finds
        it now, in the OCR lab's colours, and the detector's balloons dashed.
        One transparent picture over the whole page, under every line.
      -->
      <img
        v-if="balloonFillRect"
        :src="balloonFillRect.url"
        alt=""
        class="absolute max-w-none [image-rendering:pixelated]"
        :style="{
          left: `${balloonFillRect.left}px`,
          top: `${balloonFillRect.top}px`,
          width: `${balloonFillRect.width}px`,
          height: `${balloonFillRect.height}px`,
        }"
      >

      <svg class="absolute inset-0 size-full overflow-visible">
        <polygon
          v-for="line in blockChrome"
          :key="`edge-${line.id}`"
          :points="line.points"
          fill="currentColor"
          :fill-opacity="line.fill"
          stroke="currentColor"
          :class="line.tone"
          :stroke-width="line.width"
          :stroke-opacity="line.line"
          :stroke-dasharray="line.dashed ? '5 4' : undefined"
        />

        <!--
          The other box: where the reading is, under a lettering frame that has
          been moved off it — or the frame, while the reading is being
          corrected. Stroke only, dashed and half strength, so it reads as a
          note about this block rather than as a second one. See `frameGhosts`.
        -->
        <polygon
          v-for="ghost in frameGhosts"
          :key="`ghost-${ghost.id}`"
          :points="ghost.points"
          fill="none"
          stroke="currentColor"
          :class="ghost.tone"
          stroke-width="1"
          stroke-opacity="0.5"
          stroke-dasharray="2 3"
        />

        <!--
          View › Balloon debug — see `balloonFrames`. The Reading box dashed in
          pink, the room in green and a hand-placed frame in blue, as the OCR
          lab draws them; whichever the lettering is in drawn heavier.
        -->
        <g v-for="debug in balloonFrames" :key="`balloon-${debug.id}`">
          <polygon
            :points="debug.reading"
            fill="none"
            stroke="currentColor"
            class="text-pink-500"
            :stroke-width="debug.uses === 'reading' ? 2.5 : 1.5"
            stroke-dasharray="4 3"
          />
          <polygon
            v-if="debug.room"
            :points="debug.room"
            fill="none"
            stroke="currentColor"
            class="text-green-500"
            :stroke-width="debug.uses === 'room' ? 2.5 : 1.5"
          />
          <polygon
            v-if="debug.frame"
            :points="debug.frame"
            fill="none"
            stroke="currentColor"
            class="text-blue-500"
            stroke-width="2.5"
          />
        </g>
      </svg>

      <!--
        The number labels, above each box's top left corner rather than on it:
        the corner is where the north-west grip lives, and two things in one
        place means one of them cannot be got at. Faded in from nothing as each
        arrives — `@starting-style`, so no element is kept about to fade — and
        gone at once; see `blockBadges`.
      -->
      <span
        v-for="badge in blockBadges"
        :key="`num-${badge.id}`"
        class="bg-background absolute rounded-xs border border-current px-1 text-xs font-medium transition-opacity starting:opacity-0"
        :class="[badge.tone, badge.dimmed && 'opacity-25']"
        :style="{
          left: `${badge.at.x + 8}px`,
          top: `${badge.at.y - 4}px`,
          transform: 'translateY(-100%)',
        }"
      >
        {{ badge.number }}
      </span>

      <span
        v-for="debug in balloonFrames"
        :key="`balloon-label-${debug.id}`"
        class="bg-background/90 absolute rounded-xs px-1 text-[10px] font-medium whitespace-nowrap"
        :class="BALLOON_TONE[debug.uses]"
        :style="{ left: `${debug.at.x}px`, top: `${debug.at.y + 3}px` }"
      >
        {{ debug.label }}
      </span>

      <!--
        The transform box: eight grips to pull and one on a stalk to turn by.
        Drawn on the selection rather than reached for from a rail — Photoshop
        keeps free transform behind a command, but on a page of speech balloons
        the thing you have just picked is almost always the thing you are about
        to move, and a mode to enter first would be a mode to leave after.

        Its own box, over the block rather than inside it, so the grips are not
        children of a button and a press on one is not a press on the block
        underneath.
      -->
      <div
        v-for="box in gripBoxes"
        :key="`grips-${box.block.id}`"
        class="pointer-events-none absolute inset-0"
      >
        <!--
          The transform box, and the stalk the turn grip stands on. Both are
          plain geometry in screen pixels — nothing here wears the block's
          transform, which is what keeps a pulled-about quad's outline four
          straight lines instead of a thing in perspective.
        -->
        <svg class="pointer-events-none absolute inset-0 size-full overflow-visible">
          <polygon
            :points="box.outline"
            fill="none"
            class="stroke-primary"
            :stroke-width="box.key ? 3 : 1.5"
          />
          <line
            :x1="box.top.x"
            :y1="box.top.y"
            :x2="box.turn.x"
            :y2="box.turn.y"
            class="stroke-primary"
            :stroke-width="1"
          />
        </svg>

        <span
          v-for="grip in box.grips"
          :key="grip.kind"
          class="border-primary bg-background pointer-events-auto absolute block size-2.5 rounded-[2px] border"
          :style="gripStyle(grip)"
          @pointerdown="beginGrab(grip.kind, box.block, $event)"
        />

        <!--
          Turning has a grip of its own on a stalk. Hovering just outside a
          corner for it, as some editors ask, is a hit target you cannot see —
          and with the corners free to be dragged anywhere, "just outside"
          stops being a place at all.
        -->
        <span
          class="border-primary bg-background pointer-events-auto absolute block size-2.5 cursor-grab rounded-full border active:cursor-grabbing"
          :style="gripStyle(box.turn)"
          @pointerdown="beginGrab('rotate', box.block, $event)"
        />
      </div>

      <!--
        The rubber band, over everything including the boxes it is gathering:
        it is the gesture in progress, and a band that ran behind what it was
        picking up would be a band you could not see the end of.
      -->
      <div
        v-if="bandStyle"
        class="border-primary bg-primary/10 absolute border border-dashed"
        :style="bandStyle"
      />

      <!--
        The ring under the pointer, for whichever brush is out. Last, so it is
        over every other piece of chrome: it is where the hand is.

        Out here with the rest of the chrome rather than on the page, and that
        move is the whole of what makes it read correctly at a zoom. Drawn
        inside the stage it was a page-space box wearing the zoom, so its one
        pixel of border came out `zoom` pixels of stripe — eaten inwards, since
        the box is bordered from its own edge, so the ring's line thickened and
        its diameter shrank away from the mark it was describing as somebody
        zoomed in. Small brushes were worse still: a border as thick as the
        radius has no room left for a round inner edge, and the browser draws
        the hole as a lozenge — a cursor that stops being a circle exactly when
        it is magnified enough to be looked at closely.

        `onScreen` and `toChrome` do the stage's arithmetic once, so the ring is
        the brush's real diameter in screen pixels and its outline is a hairline
        at any zoom. Its origin is the chrome's, pan left out, because it sits in
        the container that wears the pan.
      -->
      <CanvasBrushCursor
        v-if="page.scan && stroking"
        :scale="onScreen"
        :origin="sheetOrigin"
        :busy="cleaning"
      />
    </div>

    <!--
      Over the page and outside the transform: the strips belong to the canvas
      rather than to what is in it, so they stay put and stay the same width
      however far the page has been zoomed. The balloon debug's note too, which
      is about the view rather than a place on the page — in the chrome it
      would be carried off by the pan.
    -->
    <div class="pointer-events-none absolute inset-0">
      <div
        v-for="edge in EDGES"
        :key="edge.at"
        class="absolute transition-opacity duration-300"
        :class="[edge.box, lit[edge.at] ? 'opacity-100' : 'opacity-0']"
      />

      <span
        v-if="balloonDebug && (balloonBusy || balloonNote)"
        class="bg-background/90 text-muted-foreground absolute top-2 left-2 rounded-sm px-2 py-1 text-xs"
      >
        {{ balloonBusy ? 'Measuring the balloons…' : balloonNote }}
      </span>
    </div>
  </div>
</template>
