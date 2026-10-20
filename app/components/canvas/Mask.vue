<script setup lang="ts">
/**
 * The mask plate: what the repair will paint out, drawn where it will paint.
 *
 * The row this fills was once a set of block rectangles, which is why it was
 * taken out of the stack — it showed where a repair was *meant* to go and
 * never where it went. This draws the real thing: the automatic mask, whichever
 * one the cleaning is using, composited with the strokes somebody brushed on to
 * correct it, at the same resolution the inpainter will be handed. A mask
 * shown at one size and applied at another would be a mask that lies about
 * which pixels it covers.
 *
 * ## Whichever one, and why that word is load-bearing
 *
 * There are two automatic masks now — Otsu in `mask.ts`, and the learned
 * segmenter behind `useClean().settings.segmenter` — and this plate has to
 * draw the one the repair will actually be made from. It did not, once: the
 * toggle moved the *repair* onto the segmenter and left the plate thresholding,
 * so on a bold title over a dark banner the pink sat on the fill with the
 * glyphs showing through clear — the exact inversion the toggle exists to fix —
 * while the patch underneath came back correct. A preview that disagrees with
 * the repair is worse than no preview: it sends whoever is looking at it to
 * debug the wrong layer.
 *
 * So `render` mirrors `prepareRegion` step for step, fallback included. Anything
 * either of them does that the other does not is this bug again.
 *
 * Off by default in the stack, because it is a working view. You turn it on
 * to see what is about to be erased, or to fix it with the brush, and off
 * again to judge the result.
 *
 * Drawn to one canvas for the whole page rather than an element per block:
 * a mask is a shape, not a rectangle, so there is nothing to lay out — and
 * one canvas is one composite however many balloons a page has.
 */
import { blockOutline, partsWithin } from '~/utils/ocr/mask'

const props = defineProps<{
  page: ComicPage
  /**
   * Whether the plate is on. It stays mounted while it is off — the board
   * hides it rather than removing it, so the collaborator strokes below keep
   * their listener — which is why this is a prop rather than a mount.
   */
  shown: boolean
}>()

const { edits } = useMaskEdits()
const { settings } = useClean()
const { shared } = useShared()

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')

/* ---------- corrections other people are drawing ---------- */

/**
 * A collaborator's hand, mid-correction.
 *
 * Here rather than on the brush, which is where it was first put and was the
 * wrong place: `CanvasMaskBrush` only exists while *this* reader is holding the
 * mask tool, so the listener and the canvas that draws it both went away the
 * moment you picked up anything else. You could only watch somebody correct a
 * mask by pretending to correct one yourself.
 *
 * The plate is mounted whenever the page is, and shown when the mask is shown —
 * which is the honest gate. A mask stroke on a plate you have turned off is not
 * something you were going to see anyway.
 */
const ghosts = useTemplateRef<HTMLCanvasElement>('ghosts')

const remote = computed(() => rowOfPage(shared.value?.pages ?? [], props.page)?.id ?? null)

const { drawing: theirs } = useLiveStrokes({
  // Nothing is sent from here — the plate is a picture, not a tool.
  surface: computed(() => null),
  page: remote,
  key: computed(() => ''),
  clientId: computed(() => ''),
  accepts: (live) => live.pageId === remote.value && live.key.startsWith('mask-'),
})

/** Page pixels to the size the plate is drawn at. */
const laid = computed(() => {
  const scan = props.page.scan
  const wide = ghosts.value?.offsetWidth ?? 0

  return scan?.width && wide ? wide / scan.width : 0
})

/**
 * The in-flight corrections, and only those.
 *
 * A separate canvas from the plate on purpose. The plate's own `draw` crops
 * every block out of the scan and runs the mask over it — seconds of work,
 * cached per tile — and a gesture that moves twenty times a second cannot go
 * through it. This is a polyline, in the same magenta, over the top.
 */
function paintGhosts () {
  const element = ghosts.value

  if (!element) return

  const wide = element.offsetWidth
  const tall = element.offsetHeight

  if (element.width !== wide || element.height !== tall) {
    element.width = wide
    element.height = tall
  }

  const context = element.getContext('2d')

  if (!context) return

  context.clearRect(0, 0, element.width, element.height)

  const scale = laid.value

  if (!scale) return

  context.lineCap = 'round'
  context.lineJoin = 'round'

  for (const ghost of Object.values(theirs.value)) {
    const points = ghost.points

    if (points.length < 2) continue

    // Wiping is shown as what it does — taking mask away — rather than as
    // another colour to learn: the same magenta, hollow. Fainter than a
    // correction of your own, because it is not yours.
    context.strokeStyle = ghost.tool === 'eraser' ? 'rgba(236,72,153,0.2)' : 'rgba(236,72,153,0.45)'
    context.lineWidth = Math.max(1, (ghost.params.size ?? 24) * scale)

    context.beginPath()
    context.moveTo(points[0]! * scale, points[1]! * scale)

    for (let i = 2; i < points.length - 1; i += 2) context.lineTo(points[i]! * scale, points[i + 1]! * scale)

    if (points.length === 2) context.lineTo(points[0]! * scale + 0.01, points[1]! * scale)

    context.stroke()
  }
}

watch(theirs, () => paintGhosts(), { deep: true })

/* ---------- the learned mask, when the cleaning is using one ---------- */

/**
 * The page's segmenter answer, once it has arrived — nothing before that, and
 * nothing at all while the toggle is off.
 *
 * `render` is synchronous and an inference is not, which is the whole shape of
 * this. The plate cannot await a model per tile: `draw` runs on every block
 * edit and every brush stroke, and a canvas that waits on inference is a canvas
 * that stops repainting while somebody is drawing on it. So the page is read
 * *beside* the drawing — kicked off when the page or the toggle changes, held
 * here, and the plate renders from whatever is true at the moment it paints.
 * Getting the threshold's pink for a second and then the learned one is a
 * flicker; blocking the canvas would be a freeze.
 *
 * `shallowRef` because a `Segmented` is four megabytes of floats and there is
 * nothing inside it Vue could usefully track.
 */
const segmented = shallowRef<Segmented | null>(null)

/**
 * Which ask the answer above belongs to.
 *
 * An inference outlives the reason it was started — turn the page, or turn the
 * toggle off, and a run from ten seconds ago still resolves. Without this it
 * would resolve into the ref and the plate would draw one page's lettering over
 * another's artwork.
 */
let asking = 0

watch(
  () => [settings.value.segmenter ? 'learned' : 'threshold', props.page.scan?.hash ?? '', props.shown].join('@'),
  () => {
    const token = ++asking
    const scan = props.page.scan

    segmented.value = null

    /*
     * Off stays exactly as cheap as it was. `segmentedPage` is a model download
     * before it is an inference, and a plate somebody happened to leave visible
     * may not go and fetch one on behalf of a toggle they never touched.
     */
    if (!settings.value.segmenter || !scan?.hash || !scan.width) return

    /*
     * And nothing while the plate is off, which is the default and where it
     * nearly always is. The plate was mounted and hidden, and it segmented the
     * page anyway: on a chapter opening that was two runs of ten seconds each
     * across every core, drawn for nobody, competing with everything else the
     * chapter was doing to open. Turning the plate on asks for it then, and the
     * answer is filed under the scan, so a repair that already segmented the
     * page makes it free.
     */
    if (!props.shown) return

    // The scan's hash, not the run: the same page read for the cleaning and for
    // the plate is one inference, because `segmentedPage` files it under the
    // content — see its own header, and note the brush depends on that too.
    segmentedPage({ file: scan.file, width: scan.width }, scan.hash)
      .then((whole) => {
        if (token !== asking) return

        segmented.value = whole
      })
      .catch((thrown) => {
        // The plate falls back to the threshold, which is what it drew before
        // any of this existed. Said out loud rather than swallowed: the repair
        // itself refuses to run on a segmenter that will not load, so a plate
        // that quietly showed the other mask would be the only thing on screen
        // still claiming everything is fine.
        console.warn('[kemolate] the mask plate could not read the learned mask:', thrown)
      })
  },
  { immediate: true },
)

/**
 * Which answer the plate is drawing from, right now.
 *
 * Both a redraw trigger and part of every tile's cache key, and it has to be
 * both. The tiles map memoises a rendered tile against its block's geometry and
 * its corrections; flip the toggle and neither of those moved, so the plate
 * would go on showing whichever mask it happened to draw first and the switch
 * would look dead — which is this component's own bug one level down.
 *
 * Keyed off the answer rather than off the setting on purpose. The setting says
 * what somebody asked for; this says what is actually being drawn, so a page
 * still waiting on the model does not invalidate its tiles twice.
 */
const source = computed(() => (segmented.value ? 'learned' : 'threshold'))

/**
 * The scan, decoded once and kept.
 *
 * Every block is cropped out of it, so decoding per block would decode a
 * twenty-megapixel page a dozen times for one repaint.
 */
let bitmap: ImageBitmap | null = null
let decoded: string | null = null

/**
 * The tint. Magenta because no comic is magenta: whatever is underneath, the
 * mask reads as something laid over it rather than something in the artwork.
 */
const TINT = [236, 72, 153] as const

/**
 * Each block's rendered tile, kept between redraws.
 *
 * Thresholding a tile is the expensive part of this component — a crop, an
 * Otsu pass, a rasterisation — and a correction to one balloon used to buy
 * it for every balloon on the page, on every pointer move of a live erase.
 * The mask is per block, so the work is per block: a tile is re-rendered
 * only when its own key moves — its block's geometry, its own corrections,
 * the scan — and a redraw of the plate is otherwise nine cheap `drawImage`s.
 *
 * Rendered at the tile's working resolution rather than the plate's, so a
 * cached tile survives a zoom of the plate untouched.
 */
const tiles = new Map<string, { key: string, box: Region, image: OffscreenCanvas }>()

/**
 * How large the plate's own canvas is, at most, along its longest edge.
 *
 * The mask is a view rather than a thing that gets exported, so it is drawn
 * at a size that is comfortable to look at instead of the scan's own — a
 * four-thousand-pixel page would cost sixty megabytes of canvas to say the
 * same thing.
 */
const PLATE_MAX = 1600

async function draw () {
  const element = canvas.value
  const scan = props.page.scan

  if (!element || !scan?.width || !scan.height) return

  // Nothing for a plate nobody can see, which is how it is by default. It is
  // mounted anyway, for the collaborators' strokes it listens for, and it used
  // to draw anyway: on every page turn a full decode of the scan (70 ms at
  // 2700 × 4000) and a threshold pass over every block, in the frame after the
  // page appeared — the same work the segmenter watcher above already refuses
  // while hidden, and for the same reason. The bitmap is let go as well, since
  // it is 40 MB held for a picture that is not being drawn.
  if (!props.shown) {
    bitmap?.close()
    bitmap = null

    return
  }

  // `!bitmap` retries as well as re-decodes: restore can hand the scan over
  // before its bytes are readable, and remembering that one failed attempt
  // against the url would leave the plate blank for the life of the page.
  if (!bitmap || decoded !== scan.url) {
    bitmap?.close()
    bitmap = await createImageBitmap(scan.file).catch(() => null)
    decoded = scan.url
  }

  if (!bitmap) return

  const scale = Math.min(1, PLATE_MAX / Math.max(scan.width, scan.height))

  element.width = Math.round(scan.width * scale)
  element.height = Math.round(scan.height * scale)

  const context = element.getContext('2d')

  if (!context) return

  context.clearRect(0, 0, element.width, element.height)

  const alive = new Set<string>()

  // Read once for the page rather than per block, so every tile in one pass is
  // drawn from the same answer — and so the key below and the mask beside it
  // cannot disagree about which that was.
  const whole = segmented.value

  for (const block of props.page.blocks) {
    if (block.hidden || block.type === 'garbage') continue

    // Read before the box, because the box is partly made of them: a stroke
    // that ran past the context margin drags the crop out to cover itself.
    const mine = edits.value[props.page.id]?.[block.id] ?? []

    const key = `${scan.url}@${block.x}:${block.y}:${block.w}:${block.h}@${JSON.stringify(mine)}@${source.value}`

    alive.add(block.id)

    let held = tiles.get(block.id)

    if (held?.key !== key) {
      const rendered = render(block, mine, scan.width, scan.height, whole)

      if (!rendered) {
        tiles.delete(block.id)

        continue
      }

      held = { key, ...rendered }
      tiles.set(block.id, held)
    }

    context.drawImage(
      held.image,
      0, 0, held.image.width, held.image.height,
      held.box.x * scale, held.box.y * scale, held.box.w * scale, held.box.h * scale,
    )
  }

  // Tiles for blocks that left the page go with them — a deleted balloon's
  // mask held in memory is a leak with a bitmap attached.
  for (const id of [...tiles.keys()]) if (!alive.has(id)) tiles.delete(id)
}

/**
 * One block's mask, tinted, at its tile's own resolution.
 *
 * `whole` is the page's learned mask when there is one, sliced here rather than
 * inferred here — the model reads a page, and a plate that segmented per block
 * would pay for the page once per balloon.
 */
function render (block: Block, mine: MaskEdit[], pageW: number, pageH: number, whole: Segmented | null): { box: Region, image: OffscreenCanvas } | null {
  if (!bitmap) return null

  // The turned block's surrounding rectangle and its outline, exactly as
  // `prepareRegion` takes them — this plate mirrors it step for step.
  const { region, outline } = blockOutline(block, pageW, pageH)

  const box = paddedBox(region, pageW, pageH, mine)

  if (box.w < 2 || box.h < 2) return null

  const size = tileSize(box.w, box.h)
  const image = new OffscreenCanvas(size.w, size.h)
  const paint = image.getContext('2d', { willReadFrequently: true })

  if (!paint) return null

  paint.imageSmoothingQuality = 'high'
  paint.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, size.w, size.h)

  const { data } = paint.getImageData(0, 0, size.w, size.h)

  // Page pixels into this tile's own scale. One helper rather than the sum
  // written twice, because the block's box and its columns have to land in
  // that scale by identical arithmetic or the pieces sit off the whole.
  const onTile = (of: Region) => ({
    x: Math.round(((of.x - box.x) / box.w) * size.w),
    y: Math.round(((of.y - box.y) / box.h) * size.h),
    w: Math.round((of.w / box.w) * size.w),
    h: Math.round((of.h / box.h) * size.h),
  })

  // The block's own box within the tile — the threshold is taken from it
  // and the mask confined to it, exactly as the cleaning does.
  const inner = onTile(region)

  /*
   * And the columns the threshold is actually taken over, where this block is
   * a joined balloon — the same pieces `useClean.partsOf` hands the cleaning,
   * derived here rather than shared because this component knows a page's
   * pixels and that composable knows a scan's.
   *
   * Passing them is not an optimisation. Without them the plate shows one
   * global threshold while the repair uses one per column, so the pink a
   * reader checks their work against is not the mask that gets painted — and
   * the lines this whole change is about would look masked here and come back
   * untouched on the plate, which is worse than the bug it fixes.
   */
  // Kept only when they sit inside the balloon, exactly as the cleaning keeps
  // them — see `partsWithin`.
  const parts = partsWithin((block.children ?? []).map((child) => ({
    x: (child.x / 100) * pageW,
    y: (child.y / 100) * pageH,
    w: (child.w / 100) * pageW,
    h: (child.h / 100) * pageH,
  })), region).map(onTile)

  /*
   * The learned mask for this crop, when the cleaning is using one — the same
   * three steps `prepareRegion` takes, in the same order, off the same helpers.
   * `segFor` cuts the crop out of the model's square at the crop's own page
   * pixels; `learnedInk` puts it on this tile, confines it to the regions the
   * threshold would have used, and grows it the same way.
   *
   * `null` back means the model marked nothing inside this block, which is its
   * known weakness on invented sound effects. `prepareRegion` falls through to
   * the threshold there, so this falls through too — a plate that drew nothing
   * for those blocks would say a repair was not going to happen when it is,
   * which is the same lie as the one this whole file exists to stop, told the
   * other way round.
   */
  const learned = whole
    ? learnedInk(segFor(whole, box), box, size.w, size.h, parts.length ? parts : [inner])
    : null

  const mask = effectiveMask(
    data,
    size.w,
    size.h,
    inner,
    editsForTile(mine, box, size),
    parts,
    learned,
    outline?.map((point) => ({ x: ((point.x - box.x) / box.w) * size.w, y: ((point.y - box.y) / box.h) * size.h })),
  )

  // The soft copy, because it is the one that says *how much* — a feathered
  // correction should look feathered rather than snapping to a hard edge
  // the model will never see either.
  const tinted = paint.createImageData(size.w, size.h)

  for (let i = 0; i < size.w * size.h; i++) {
    tinted.data[i * 4] = TINT[0]
    tinted.data[i * 4 + 1] = TINT[1]
    tinted.data[i * 4 + 2] = TINT[2]
    tinted.data[i * 4 + 3] = Math.round(mask.soft[i]! * 255)
  }

  paint.putImageData(tinted, 0, 0)

  return { box, image }
}

/**
 * Redrawn on anything that moves a mask: the page, a block's geometry, a
 * correction, or the arrival of a learned mask that changes what every tile
 * on the page is made of. Not on every render — computing a page's worth of thresholds
 * is cheap but not free, and a render that recomputes on each frame is a
 * render that fights the pointer.
 *
 * The canvas ref is part of the key because `immediate` fires during setup,
 * before the template ref has bound — a first call that can only ever bail.
 * The plate used to get away with that by accident, redrawn when the restore
 * streamed blocks in after mount; a page whose data is already at rest when
 * the component mounts would stay blank forever. The ref binding is itself
 * the change that draws the first frame.
 *
 * ## Nothing asked while the plate is hidden, and the corrections by identity
 *
 * The key used to be worked out whatever the plate was doing, and part of it
 * was every correction on the page written out as JSON — every point of every
 * stroke, on every frame of a block being dragged, because a block's box is in
 * the key too. `draw` does nothing while the plate is hidden, which is where it
 * nearly always is, so hidden the key is only that: nothing about the page is
 * read, and turning the plate on is the change that draws it.
 *
 * Shown, the corrections are depended on by identity rather than by content.
 * Every writer of `useMaskEdits().edits` puts a new list in place of a block's
 * and a new object in place of the page's — the brush's own live erase
 * included — so a new object is exactly a changed correction. A writer that
 * pushed onto a list in place would be missed here, and would be a bug there
 * first: nothing else that reads the corrections would hear it either. The
 * tiles' own key (`draw`) still spells them out, so what is drawn is checked
 * against the corrections themselves.
 */
watch(
  [
    () => (props.shown
      ? [
          canvas.value ? 'up' : 'down',
          props.page.id,
          props.page.scan?.url,
          props.page.blocks.map((b) => `${b.id}:${b.x}:${b.y}:${b.w}:${b.h}:${b.hidden}:${b.type}`).join('|'),
          source.value,
        ].join('@')
      : 'hidden'),
    () => (props.shown ? edits.value[props.page.id] : null),
  ],
  () => { draw().catch(() => {}) },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(() => {
  bitmap?.close()
  bitmap = null
  tiles.clear()
})
</script>

<template>
  <canvas ref="canvas" class="absolute inset-0 size-full" />
  <!--
    Over the plate rather than in it: what is still being drawn is not part of
    the mask yet, and the plate's own composite is far too expensive to rebuild
    per frame. See `paintGhosts`.
  -->
  <canvas ref="ghosts" class="pointer-events-none absolute inset-0 size-full" />
</template>
