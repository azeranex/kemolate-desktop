<script setup lang="ts">
/**
 * The brush that corrects a mask.
 *
 * It paints no pixels. Every stroke is an instruction about the *mask* — add
 * ink the threshold missed, wipe artwork it mistook for lettering — and the
 * repair is then made again from the corrected mask. That indirection is the
 * whole point: a balloon fixed by hand improves again the day a better
 * inpainter arrives, because what was corrected was the instruction and not
 * the result.
 *
 * ## It has to feel like a brush
 *
 * The first version stored the right thing and felt like nothing: no mark
 * appeared until the stroke was over and the mask had been recomputed. A
 * brush that shows you nothing while you draw is a brush you cannot aim, so
 * the mark is drawn here, live, on a canvas of its own — and thrown away on
 * release, when the real mask redraws with the correction in it. The live
 * mark is a promise about what is being stored, not a second source of truth.
 *
 * The rings under the pointer are the other half of aiming: a brush whose size
 * you cannot see is one you set by trial. There are two, because the brush has
 * two edges — a solid one at the full-strength core and a dashed one where the
 * feather runs out — and with softness at two thirds the difference between
 * them is most of the mark.
 *
 * ## The pointer
 *
 * - **left** works in whatever mode the panel is set to — add, wipe, or erase;
 * - **shift + left** erases for the one stroke, whatever the panel says;
 * - **alt + right, dragged** sets the brush — across for the width, down for
 *   the softness, one or the other and never both at once.
 *
 * Shift rather than alt, and the swap is worth the note: alt is the *sampling*
 * modifier everywhere else on this canvas — it takes a clone source, and it
 * lifts a colour under the brush — so a mask brush that read it as "do the
 * opposite" was the one tool where the same key meant something else. Shift is
 * free here, and holding it to take something back is close enough to what it
 * does in a selection.
 *
 * The modifier used to *invert* the mode instead — wipe while in add — and that read
 * as an eraser without being one: it laid an opposing stroke on top, so the
 * mark you regretted was still there under a second mark, undo peeled them
 * off one at a time in reverse, and anywhere the two did not exactly overlap
 * the wipe ate auto mask it was never aimed at. Now the gesture means what
 * it looks like: the eraser cuts *through* strokes, taking exactly the part
 * it swept and leaving the rest of the mark standing. A cut is a retraction
 * of the stroke's own row plus fresh rows for what survived — the log stays
 * append-only — and one pass is one step of history, however many strokes
 * it crossed. The automatic mask is not made of strokes and cannot be cut,
 * so the pass also lays one wipe along its path — under the eraser, *all*
 * mask goes, whoever put it there — while Wipe stays in the bar as the
 * precise half: it takes auto mask without cutting anybody's corrections.
 *
 * ## A stroke belongs to a block
 *
 * Cleaning runs per block, so a mask outside every block could be drawn and
 * would then never be repaired — visible, and permanently uncleaned. Rather
 * than store a correction that cannot come true, a stroke that starts off
 * every block is refused and says why: widen a block over the lettering, or
 * draw one.
 *
 * The block is chosen at pointer *down*, by its padded box — the rectangle
 * the patch actually covers — and holds for the rest of the stroke, so a mark
 * that wanders past an edge still lands where it started.
 */
import { abandonClean } from '~/composables/useClean'
import { feathered, maskCore, maskReach } from '~/utils/paint/stamps'

const props = defineProps<{ page: ComicPage }>()

const { add, send, erase, on, edits } = useMaskEdits()
const { cleanBlockSoon } = useClean()
const { record } = useUndo()

// The same brush the paint tools use. One set of settings across the app is
// this codebase's own rule, and reaching for a different tool should not
// silently change the size of the mark you are about to make.
const { size, softness } = usePaintSettings()

/* ---------- the gesture, as other people see it ---------- */

const { shared } = useShared()
const { surfaceFor, keyFor, clientId } = useMaskEdits()

/** This page's row, for tagging a gesture and for placing other people's. */
const remote = computed(() => rowOfPage(shared.value?.pages ?? [], props.page)?.id ?? null)

/**
 * The surface the hand is drawing on, resolved at pointer-down.
 *
 * A mask brush is one canvas over every balloon on the page, so which surface
 * it is writing to changes with whichever block was pressed on — unlike a paint
 * canvas, which owns one for its lifetime.
 */
const drawingOn = ref<number | null>(null)
const drawingKey = ref('')

/**
 * Sending only. Other people's corrections are drawn by the mask plate, which
 * is mounted whenever the page is — this component exists only while the mask
 * tool is out, so a listener here could only ever watch while you were
 * yourself pretending to draw. See `CanvasMask`.
 */
const { begin: beginGesture, broadcast, end: endGesture } = useLiveStrokes({
  surface: drawingOn,
  page: remote,
  key: drawingKey,
  clientId,
  accepts: () => false,
})

/**
 * The surface being resolved, while it is being resolved.
 *
 * The first correction on a balloon has to make its surface, which is a round
 * trip — and a stroke can easily be over before that answers. `broadcast` needs
 * somewhere to send to, so those frames go nowhere, including the final one:
 * a quick correction was sent live not at all. Held so that release can wait
 * for it and still say the one thing that matters.
 */
let resolving: Promise<unknown> | null = null

/**
 * What the room is told about the stroke in progress.
 *
 * Takes the stroke rather than reading `drawing`, because the last frame is
 * sent after the pointer has let go and `drawing` is cleared by then — the
 * gesture still has to be describable for the moment it takes to say it.
 */
function sweeping (stroke: typeof drawing, force = false) {
  if (!stroke) return

  broadcast({
    tool: stroke.kind === 'wipe' ? 'eraser' : 'brush',
    composite: stroke.kind === 'wipe' ? 'destination-out' : null,
    params: { size: size.value, softness: softness.value },
    points: stroke.points,
  }, force)
}

/** Add, wipe, or erase — the brush's own mode, held across strokes. */
const mode = useState<'add' | 'wipe' | 'erase'>('mask-brush-mode', () => 'add')

/**
 * Alt held on the way down, which makes that one stroke an erase.
 *
 * Kept apart from `mode` rather than written into it: an early modifier that
 * set the mode directly put it back to a default nobody picked when the key
 * came up. As an override it composes the way a modifier should — the panel's
 * choice survives the gesture.
 *
 * Read at pointer *down* rather than watched as a key, because that is when a
 * stroke's meaning is decided — and because Alt is the resize modifier too, so
 * a listener on the key made merely reaching for the size change what the next
 * stroke would do. Shared state so the bar can show what the stroke in flight
 * is actually doing.
 */
const erasing = useState('mask-brush-erasing', () => false)

const surface = useTemplateRef<HTMLElement>('surface')
const live = useTemplateRef<HTMLCanvasElement>('live')

/**
 * The stroke in flight: the block it belongs to, what it does, and where it
 * has been.
 *
 * The kind is fixed at pointer down. A stroke that changed from an addition
 * to a wipe halfway along would be one mark with two meanings, and the log
 * has no way to say that.
 */
let drawing: { block: Block, kind: MaskEdit['kind'], points: number[] } | null = null

/**
 * The eraser pass in flight.
 *
 * The whole path is kept and every cut is recomputed from the strokes as
 * they stood at pointer down, rather than chopping incrementally at what is
 * on screen. Cutting the cuts would send every intermediate piece to the
 * server just to retract it a pointer-event later; from the originals, the
 * server hears about a pass exactly once, on release. `used` is every seq
 * spoken for on the page, so a piece can be stamped into the gap just after
 * its original — replay order is seq order, and a piece that jumped to the
 * end of the log would leap over any wipe laid across its original since.
 *
 * The automatic mask is not a stroke and cannot be cut, so the pass also
 * lays a wipe along its whole path — on *every* block whose crop it comes
 * within a brush-radius of, one wipe per block in `wipes`, each holding the
 * seq it was granted the moment its block was first touched. Every block's
 * mask is confined to its own tile, so a wipe filed under only the first
 * block the pass touched would leave the auto mask of every other block it
 * swept over standing — which is exactly the bug that teaches this: blocks
 * overlap, and "the block under the pointer" is not "the blocks under the
 * pass". A pass that crosses no block still cuts; there is no auto mask
 * off-block for a wipe to speak to.
 *
 * The wipes go into the page's corrections *live*, growing with the path,
 * and only their write waits for release. Mask vanishing under the brush is
 * the eraser's whole feedback — a preview mark on top would be a brush
 * saying "here is more paint" while it takes paint away, and a wipe that
 * only landed on release read as an eraser with a second of lag.
 */
let rubbing: {
  path: number[]
  snapshot: { block: Block, edits: MaskEdit[] }[]
  cut: Map<MaskEdit, { block: Block, pieces: MaskEdit[], sig: string }>
  wipes: Map<string, { block: Block, seq: number }>
  used: Set<number>
} | null = null

/**
 * Setting the brush on the page — the right button, dragged. Shared with the
 * paint brush rather than written twice; see `useBrushGesture`.
 */
const adjust = useBrushGesture()

const hint = ref<string | null>(null)

/**
 * Where the pointer is, in the scan's own pixels — and where the ring goes.
 *
 * Page pixels rather than the window's, because the ring is drawn inside the
 * page and has to move with it. An early version placed a `fixed` ring at the
 * pointer's window coordinates, which is right until an ancestor is
 * transformed — and this one always is, by the zoom. A transform makes itself
 * the containing block for anything fixed inside it, so the ring quietly
 * stopped being measured from the window and drifted off the mark it was
 * aiming. In page pixels there is nothing to drift.
 *
 * The ring itself is drawn by `CanvasBrushCursor`, above the whole stack —
 * see `useBrushCursor` for why it cannot be drawn here.
 */
const { show: showCursor, hide: hideCursor } = useBrushCursor()

onScopeDispose(hideCursor)

/**
 * Where the surface is on the screen and how big it is laid out — read once per
 * gesture, not once per pointer move.
 *
 * Measured on the test chapter: hovering read the rectangle twice a move (the
 * ring's point, and `shown` for a size gesture whether one was running or not),
 * and a stroke three times and both offset sizes besides. The first of those
 * after the previous move had written the ring and the mark was the browser
 * laying the page out to answer, once a move, for a box that had not moved.
 *
 * ## And why this is not the stale computed it replaced
 *
 * `shown` was a `computed` once, and it lied: a `getBoundingClientRect` is a
 * read of the DOM rather than reactive state, so there was nothing a computed
 * built on it could ever invalidate against. It cached the first answer, and
 * the page changes size every time the window is resized, a dock column is
 * dragged or a panel is opened — so the mark went on being laid at the scale the
 * page had when the tool was picked up. Found on the region brush, which copied
 * the pair from here.
 *
 * This is let go of on exactly those occasions. The surface covers the sheet,
 * so it moves when the view moves or the room changes, and both are watched
 * below; and every gesture starts afresh anyway — a press reads it again, and a
 * hover begins after a pointer that left, which let it go.
 *
 * Except one hover: a page turned from the keyboard, under a pointer that never
 * left. The sheet is laid out in the page's own shape, so a page of another
 * shape — a spread after a single — moves the surface with nothing above having
 * changed, and the ring would be placed by the last page's box until the next
 * press. So the page is watched too.
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
 * What one page pixel is worth on screen, for the ring — which is positioned
 * against the window, so it wants the size the page is *actually* drawn at,
 * transform and all. Off the gesture's reading of the surface — see
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

/**
 * A block's padded box — the crop its repair actually covers, which is what
 * can actually be corrected: a stroke just outside a balloon's own box is
 * still inside the crop the model will be handed, and refusing it there
 * would refuse a correction that would have worked.
 *
 * Its own corrections count towards it, because they have already widened
 * the crop. So a tail followed out past the margin in one stroke can be
 * picked up again in the next, and reaching a long sound effect is a matter
 * of working outwards rather than of getting it in a single pass.
 */
function boxOf (block: Block): Region | null {
  const scan = props.page.scan

  if (!scan?.width || !scan.height) return null

  return paddedBox({
    x: (block.x / 100) * scan.width,
    y: (block.y / 100) * scan.height,
    w: (block.w / 100) * scan.width,
    h: (block.h / 100) * scan.height,
  }, scan.width, scan.height, on(props.page.id, block.id))
}

/** The block a point falls in, by the padded box rather than the block's own. */
function blockAt (at: { x: number, y: number }): Block | null {
  for (const block of props.page.blocks) {
    if (block.hidden || block.type === 'garbage') continue

    const box = boxOf(block)

    if (box && at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h) return block
  }

  return null
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

  if (!scan?.width) return

  /*
   * The layout width, not the drawn one. The canvas sits inside the page and is
   * scaled by the same transform as everything else in it, so sizing its
   * backing store to the *transformed* rect scales the mark a second time —
   * which is exactly how a stroke came to land somewhere the pointer had not
   * been. The pointer still maps through `getBoundingClientRect`, because a
   * click arrives in window coordinates and has to come back through the
   * transform.
   *
   * Taken from the `wide` the backing store was just sized to rather than
   * measured a second time — see `placement`, which is where the pair's older
   * failure is written down.
   */
  const scale = wide / scan.width

  /**
   * One stroke, as the rasteriser would lay it — widest band first.
   *
   * A single hard line was easier to draw and was a promise the stored stroke
   * did not keep: set the brush to eighty per cent soft and the preview still
   * showed a crisp edge, so the mark you aimed was not the mark you got.
   *
   * The bands come from the brush itself now rather than being a second guess
   * at the same shape — `feathered` is what `mask.ts` strokes the stored
   * correction with, so this is the same brush and not merely a similar one.
   * Widest first because they composite normally rather than by taking a
   * maximum, so the overlap has to build the core up rather than wash it out;
   * that order is the function's, not a convention repeated here.
   */
  const lay = (points: number[], wipe: boolean, width: number, soft: number, alpha: number) => {
    if (points.length < 2) return

    context.lineCap = 'round'
    context.lineJoin = 'round'
    // Wiping is shown as what it does — taking mask away — rather than as
    // another colour to learn: the same magenta, hollow.
    context.strokeStyle = wipe ? 'rgba(236,72,153,0.35)' : 'rgba(236,72,153,0.85)'

    const trace = () => {
      context.beginPath()
      context.moveTo(points[0]! * scale, points[1]! * scale)

      for (let i = 2; i < points.length - 1; i += 2) context.lineTo(points[i]! * scale, points[i + 1]! * scale)

      // A dot, for a press that never moved.
      if (points.length === 2) context.lineTo(points[0]! * scale + 0.01, points[1]! * scale)

      context.stroke()
    }

    // `alpha` tints the whole preview rather than any one band — a wipe is
    // shown fainter than an addition — so it multiplies each band's share. Not
    // exact once the bands have composited, and it does not need to be: the
    // shape is the promise here, and the tint is only saying which of the two
    // this is.
    // Half the bands the stored correction gets. This redraws the whole path
    // every frame and the path grows with the gesture, so the count is paid
    // for on each one; a dozen keeps the staircase under a tenth of a level
    // that anybody could see through a translucent tint, and the mark that
    // matters is rasterised properly on release.
    for (const band of feathered(maskCore(1, soft), maskReach(1, soft), 12)) {
      context.globalAlpha = band.alpha * alpha
      context.lineWidth = Math.max(1, width * band.radius * scale)
      trace()
    }

    context.globalAlpha = 1
  }

  // The stroke being laid. The eraser draws none of its own: its feedback is
  // the mask disappearing from the plate, live, and a stroke-shaped preview on
  // top read as a brush painting rather than one taking away.
  if (!drawing || drawing.points.length < 2) return

  lay(drawing.points, drawing.kind === 'wipe', size.value, softness.value, 1)
}

function onDown (event: PointerEvent) {
  // No longer refused while a repair runs. That gate made every stroke wait
  // for the previous stroke's clean — seconds of inference over a mask the
  // reader was in the middle of changing. A stroke now calls off its block's
  // repair instead (`abandonClean`, below and in `cleanBlockSoon`), and the
  // block is cleaned once the hand stops.

  // A gesture starts from a fresh reading of where the surface is — see
  // `placement`. Before the size gesture as well, which measures with it.
  unplace()

  // The right button, dragged, is how every editor sizes a brush without
  // leaving the page to find a slider — see `useBrushGesture`, which the paint
  // brush answers to as well.
  if (adjust.begin(event)) return

  if (event.button !== 0) return

  const at = pointOf(event)

  if (!at) return

  const act = event.shiftKey ? 'erase' : mode.value

  /**
   * Erasing starts anywhere. A stroke to *lay down* must start on a block,
   * because a correction outside every block could never be repaired — but a
   * stroke being *taken* already belongs somewhere, so the eraser is free to
   * roam the page and take whatever it touches.
   */
  if (act === 'erase') {
    hint.value = null
    erasing.value = event.shiftKey

    /*
     * Everything the block has, wipes included — `rub` rebuilds the block's
     * whole list out of this snapshot, so anything left out of it would
     * disappear from the page for the length of the pass. Which of them may be
     * *cut* is a separate question, and one `rub` answers.
     */
    const snapshot = props.page.blocks
      .filter((block) => !block.hidden && block.type !== 'garbage')
      .map((block) => ({ block, edits: on(props.page.id, block.id) }))
      .filter((entry) => entry.edits.length)

    rubbing = {
      path: [at.x, at.y],
      snapshot,
      cut: new Map(),
      wipes: new Map(),
      used: new Set(snapshot.flatMap((entry) => entry.edits.map((edit) => edit.seq ?? 0))),
    }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    rub()

    return
  }

  const block = blockAt(at)

  if (!block) {
    hint.value = 'Nothing to correct here — widen a block over this lettering, or draw one.'

    return
  }

  hint.value = null
  drawing = { block, kind: act, points: [at.x, at.y] }

  // The repair of this balloon's current mask, if one is running, is of a mask
  // about to change — stopped now rather than on release, so the inference is
  // not still eating the machine while the stroke is drawn.
  abandonClean(props.page.id, block.id)

  /*
   * Where this gesture is going, asked for now rather than on release.
   *
   * `add` resolves the surface itself when the hand lifts, which is all a
   * *saved* stroke needs. A watched one needs it at the start: there is nothing
   * to broadcast to until the surface has an id, and asking at the end would
   * mean the room only ever heard the last frame.
   *
   * The seq is claimed here too — `add` stamps the same clock — so the drawing
   * on everybody else's canvas knows which row it is waiting for.
   */
  drawingKey.value = keyFor(block) ?? ''
  drawingOn.value = null
  beginGesture(Date.now() % 2_000_000_000)
  resolving = surfaceFor(props.page, block).then((id) => { drawingOn.value = id })

  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  paint()
}

/**
 * The pass so far, applied: every original re-clipped against the whole
 * path, the live wipes grown to match, and the page updated to show what
 * would survive a release right now.
 *
 * Only visible blocks are touched — the plate neither draws a hidden
 * block's corrections nor cleans them, so the eraser keeps its hands off
 * what cannot be seen. A stroke still waiting on its own seq is skipped for
 * the same reason it always was: there is no row to cut yet.
 *
 * The cut signature — run lengths, whose sum only ever shrinks as the path
 * grows — is what keeps a pointer resting over nothing from restamping
 * pieces. A block that has become a wipe's home redraws on every call
 * regardless, because its wipe has just grown by the path's newest point.
 */
function rub () {
  const pass = rubbing

  if (!pass) return

  const radius = size.value / 2

  /** The gap in the log just after `base`, claimed. */
  const free = (base: number): number => {
    let seq = base + 1

    while (pass.used.has(seq)) seq++

    pass.used.add(seq)

    return seq
  }

  const changed = new Set<string>()

  for (const { block, edits: originals } of pass.snapshot) {
    for (const edit of originals) {
      if (edit.seq === undefined) continue

      /*
       * A wipe is never cut. It is not a mark somebody made that the eraser can
       * take back off — it is the *absence* of one, and cutting it puts mask
       * back, which is the opposite of what this gesture means.
       *
       * The shape of that failure is worth writing down, because it is not the
       * one you would guess. Erasing an automatic mask lays a wipe over it;
       * erasing the same place again clipped a piece out of *that wipe's* path,
       * and taking a piece out of a stroke's centre line takes its painted
       * coverage away a whole brush-radius further out than the cut goes — so
       * the mask returned as a ring around the pointer, while the fresh wipe
       * only covered the path itself. Each pass bit a little more off, which
       * reads as an eraser that has to be gone over again and again.
       *
       * Passed over rather than filtered out of the snapshot: the list below is
       * rebuilt from that snapshot, so a wipe has to stay in it to stay on the
       * page. Uncut, `pass.cut` has nothing for it and it goes through whole.
       */
      if (edit.kind === 'wipe') continue

      const runs = clipEdit(edit, pass.path, radius)

      if (!runs) continue

      const sig = runs.map((run) => run.length).join(',')

      if (pass.cut.get(edit)?.sig === sig) continue

      changed.add(block.id)
      pass.cut.set(edit, {
        block,
        sig,
        pieces: runs.map((points) => ({ ...edit, points, seq: free(edit.seq!) })),
      })
    }
  }

  for (const block of props.page.blocks) {
    if (block.hidden || block.type === 'garbage') continue

    if (!pass.wipes.has(block.id)) {
      /**
       * The block's *own* box, not the padded crop. The automatic mask a
       * wipe exists to take is confined to the block's box; the crop's
       * quarter-page of context has no auto mask in it, so a pass grazing
       * a neighbour's margin used to hand that neighbour a wipe that
       * removed nothing — and a repair, seconds of inference, for it.
       */
      const scan = props.page.scan

      if (!scan?.width || !scan.height) continue

      const box = {
        x: (block.x / 100) * scan.width,
        y: (block.y / 100) * scan.height,
        w: (block.w / 100) * scan.width,
        h: (block.h / 100) * scan.height,
      }

      let inside = false

      for (let i = 0; i + 1 < pass.path.length && !inside; i += 2) {
        const x = pass.path[i]!
        const y = pass.path[i + 1]!

        inside = x >= box.x - radius && x <= box.x + box.w + radius && y >= box.y - radius && y <= box.y + box.h + radius
      }

      if (!inside) continue

      pass.wipes.set(block.id, { block, seq: free(Date.now() % 2_000_000_000) })
    }

    changed.add(block.id)
  }

  for (const id of changed) {
    const entry = pass.snapshot.find((one) => one.block.id === id)
    const base = entry ? entry.edits.flatMap((edit) => pass.cut.get(edit)?.pieces ?? [edit]) : []
    const wipe = pass.wipes.get(id)

    edits.value[props.page.id] = {
      ...edits.value[props.page.id],
      [id]: wipe ? [...base, wipeOf(pass, wipe.seq)] : base,
    }
  }
}

/** The pass as the wipe it lays: its whole path, at the brush's settings. */
function wipeOf (pass: NonNullable<typeof rubbing>, seq: number): MaskEdit {
  return {
    kind: 'wipe',
    seq,
    points: [...pass.path],
    size: size.value,
    hardness: 1 - softness.value,
  }
}

/**
 * A cut walked back on the page, for an original the server would not let
 * go of: its pieces come off and the whole mark returns. `erase` may have
 * already restored the original itself on failure, so presence is checked
 * rather than assumed — one of it, not two.
 */
function revert (block: Block, orig: MaskEdit, pieces: MaskEdit[]) {
  const gone = new Set(pieces.map((piece) => piece.seq))
  const current = (edits.value[props.page.id]?.[block.id] ?? []).filter((edit) => !gone.has(edit.seq))

  if (!current.some((edit) => edit.seq === orig.seq)) current.push(orig)

  edits.value[props.page.id] = {
    ...edits.value[props.page.id],
    [block.id]: current.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
  }
}

function onMove (event: PointerEvent) {
  showCursor(pointOf(event))

  if (adjust.move(event, shown())) return

  if (rubbing) {
    const at = pointOf(event)

    if (!at) return

    // The same economy the brush applies to its own points: a path vertex
    // every pixel is work the clip walks for nothing.
    const [lastX, lastY] = [rubbing.path.at(-2)!, rubbing.path.at(-1)!]

    if (Math.hypot(at.x - lastX, at.y - lastY) < 2) return

    rubbing.path.push(at.x, at.y)
    rub()

    return
  }

  if (!drawing) return

  const at = pointOf(event)

  if (!at) return

  // Skipped when the pointer has barely moved: a stroke is stored as its
  // points, and a point every pixel is a row far longer than the mark.
  const [lastX, lastY] = [drawing.points.at(-2)!, drawing.points.at(-1)!]

  if (Math.hypot(at.x - lastX, at.y - lastY) < 2) return

  drawing.points.push(at.x, at.y)
  sweeping(drawing)
  paint()
}

/**
 * Let go, and nothing is waited for.
 *
 * Both halves of finishing a stroke used to be awaited here — the write to the
 * server and then the repair — with the pointer still captured, so the canvas
 * seized on mouse-up for as long as the round trip and the model between them
 * took. Neither has anything the brush needs back: the correction is already
 * in the mask, the write reports its own failures, and the repair is now on a
 * timer that a following stroke pushes out again.
 */
function onUp () {
  if (adjust.end()) return

  if (rubbing) {
    const pass = rubbing

    rubbing = null
    erasing.value = false

    /**
     * The pass, committed: per stroke, the original retracted and then its
     * pieces written — in that order, so a piece can never land beside an
     * original the server refused to let go of. Nothing is waited for by
     * the pointer; the page already shows the cuts.
     *
     * One pass, one step, recorded once everything has answered — the
     * history can only work with rows the server actually flipped or made,
     * and a stroke it refused has already been put back on the page by
     * `revert` and has no business in the step.
     */
    const jobs = [...pass.cut.entries()].map(([orig, { block, pieces }]) =>
      erase(props.page, block, orig).then(async (taken) => {
        if (!taken) {
          revert(block, orig, pieces)

          return null
        }

        const made = await Promise.all(pieces.map((piece) => send(props.page, block, piece)))

        return { taken, made: made.filter((one) => one !== null) }
      }),
    )

    /**
     * The wipes are already on the page — `rub` grew them with the path —
     * so release only writes them down. Each block's wipe keeps the seq it
     * was granted mid-pass: `send` echoes it back, which is how the local
     * copy and the server row recognise each other, and `rowIds` crosses
     * from seq to row — two rows behind one seq would leave one of them
     * unreachable, which is why each block's wipe has its own.
     */
    const wipes = [...pass.wipes.values()].map(({ block, seq }) => {
      // The cuts re-clean their blocks through the retraction's version
      // bump; a wipe has no retraction, so its block is queued here.
      cleanBlockSoon(props.page, block)

      return send(props.page, block, wipeOf(pass, seq))
    })

    Promise.all([Promise.all(jobs), Promise.all(wipes)]).then(([results, sent]) => {
      const done = results.filter((one) => one !== null)
      const strokes = done.map((one) => one.taken)
      const remade = [...done.flatMap((one) => one.made), ...sent.filter((one) => one !== null)]

      if (strokes.length || remade.length) record({ kind: 'erase', strokes, remade })
    })

    return
  }

  const stroke = drawing

  /*
   * The last word on the gesture, once there is somewhere to send it.
   *
   * Awaited rather than fired and forgotten: on the first correction of a
   * balloon the surface is still being made, and without this every frame of a
   * short stroke — the final one included — was dropped for want of an id, so
   * the correction appeared to the room only when its row landed. `stroke`
   * still holds the points; `drawing` is cleared straight after.
   */
  const say = (resolving ?? Promise.resolve()).then(() => {
    sweeping(stroke, true)
    endGesture()
  })

  resolving = null

  drawing = null
  paint()

  say.catch(() => {})

  if (!stroke) return

  add(props.page, stroke.block, {
    kind: stroke.kind,
    points: stroke.points,
    size: size.value,
    hardness: 1 - softness.value,
  }).catch(() => {})

  // The correction changes the mask, so the repair made from the old one is no
  // longer a repair of anything — queue just this balloon.
  cleanBlockSoon(props.page, stroke.block)
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

    <p
      v-if="hint"
      class="bg-background/90 text-muted-foreground absolute inset-x-2 bottom-2 rounded-md border px-2 py-1 text-center text-[11px]"
    >
      {{ hint }}
    </p>
  </div>
</template>
