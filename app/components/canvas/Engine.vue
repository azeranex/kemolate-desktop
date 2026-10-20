<script setup lang="ts">
/**
 * The page engine: the bottom of the page — the scan, its placed pictures and
 * its repairs — drawn onto one canvas the size of the part of the page on
 * screen.
 *
 * It began as the scan alone, replacing an `<img>`, and the reason was
 * measured: on a chapter of 3732 × 5197 pages flicking through gave frames of
 * 100–220 ms a turn, the browser decoding a 19-megapixel JPEG on the main
 * thread. The pixels come from a worker (`utils/raster/decoder.ts`) at the
 * size the screen can show them — the page whole at its fitted size, tiles of
 * the full decode once a zoom wants more — and nothing here decodes a scan.
 *
 * The repairs and pictures followed for a different reason: every page turn
 * showed the printed lettering first and the cleaned balloons a moment later,
 * because each repair was an `<img>` of its own that decoded only once it was
 * on the page. Here they are decoded ahead with the scan (`engine/pictures`),
 * and a page is shown only once its scan *and* every repair it has are in hand
 * — then drawn in one frame. Which rows are drawn here rather than as elements
 * is `engineRun`'s decision; see there for why it is a run from the bottom.
 *
 * It stays *inside* the page and that is not incidental: the lettering shares
 * one z-order with every raster layer, and the stage's transform is a stacking
 * context nothing outside it can slot into. So the canvas is laid out in sheet
 * pixels over the visible part of the page (`view`), wears the stage's zoom,
 * and has a backing store of that box × zoom × device pixels.
 *
 * WebGPU where it opens (`engine/gpu.ts`), redrawn on every frame of a gesture;
 * 2D where it does not (`engine/canvas2d.ts`), where the stage carries the
 * last drawing until the view settles — see `update` for the measurements.
 */
import type { Gpu, Quad } from '~/utils/raster/engine/gpu'
import type { Over } from '~/utils/raster/engine/overs'
import type { RunRow } from '~/utils/raster/engine/run'
import type { PageRect, ScanView, Size } from '~/utils/raster/plan'

import { adjustLut } from '#shared/utils/adjust'
import { patchStands, usePatchMap } from '~/composables/useClean'
import { Cancelled, cancelScan, releaseScan, scanLevel, scanSize, scanTile } from '~/utils/raster/decoder'
import { draw2d } from '~/utils/raster/engine/canvas2d'
import { drawable, drawGpu, release, upload } from '~/utils/raster/engine/gpu'
import { engineGpu, startEngine, switchedOff } from '~/utils/raster/engine/mode'
import { placedOver, repairOvers } from '~/utils/raster/engine/overs'
import { keepPictures, pictureAt, wantPicture } from '~/utils/raster/engine/pictures'
import { surfaceKey, surfaceOf, surfacesChanged } from '~/utils/raster/engine/surfaces'
import { fitOf, holdFit, holdTile, keepFits, keepTilesOf, tileOf } from '~/utils/raster/held'
import { fitLevel, fittedHeight, tilesFor } from '~/utils/raster/plan'
import { cleaningSignature, previewSize, readCleaning, readPreview, readSketch } from '~/utils/raster/previews'

const props = withDefaults(defineProps<{
  page: ComicPage
  view: ScanView
  /**
   * The rows drawn here, bottom first — `engineRun`. Empty means the scan
   * alone, with its plate's opacity and filter left to the element around it.
   */
  rows?: RunRow[]
}>(), { rows: () => [] })

/** The page has been shown — scan and repairs together. The stand-in can go. */
const emit = defineEmits<{ drawn: [] }>()

const { pages, at, room, measure } = useComic()
const patchMap = usePatchMap()
const { urlFor } = usePlacedImages()

const dpr = useDevicePixelRatio().pixelRatio

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')

/** No backing store larger than this a side: a 4K screen at DPR 3 is not a reason to allocate 200 MB. */
const CAP = 4096

/** How far either side of the page on screen is decoded ahead. */
const REACH = 2

/**
 * How much further ahead, in the direction the reader is turning, while they
 * are turning one page at a time — see `heading`.
 */
const AHEAD = 3

/**
 * How far either side of the page on screen its sketch is held — see
 * `sketches`. A sketch is 1.4 MB decoded, so a whole long chapter would be
 * hundreds; this is some 70 MB, and a sketch reads in a few milliseconds, so
 * the window keeps ahead of a key held down.
 */
const SKETCH_REACH = 24

/**
 * The longest a page is held back waiting for its repairs. A repair that will
 * not decode must not keep a page blank; past this, what is ready is shown.
 */
const WAIT_MS = 400

const scan = computed(() => props.page.scan ?? null)
const key = computed(() => scan.value?.url ?? null)

/** The scan's own size — known from its header on open, or from `scanSize` below. */
const size = computed<Size>(() => pageSize(props.page))

/** Bumped when a bitmap lands, so the draw below knows to run. */
const landed = ref(0)

/**
 * How this canvas draws: WebGPU where it opens, 2D where it does not — see
 * `engine/mode.ts`, which the board reads too.
 *
 * A canvas takes one kind of context for good, so a WebGPU canvas draws
 * nothing until the device is open rather than starting on 2D and being stuck
 * there.
 */
startEngine()

const mode = computed<'2d' | 'pending' | Gpu>(() => (engineGpu.value === undefined ? 'pending' : engineGpu.value ?? '2d'))

/** On the GPU as soon as it arrives — see `upload`. Nothing to do on 2D. */
function ahead (bitmap: ImageBitmap) {
  if (typeof mode.value === 'object') upload(mode.value, bitmap)
}

/**
 * Bumped when the device changes — opened, or lost and opened again. A lost
 * device takes every picture with it (see `closeOnUpload`), so everything
 * within reach is asked for afresh.
 */
const generation = ref(0)

watch(mode, () => {
  generation.value++
  landed.value++
})

/**
 * Whether to redraw on every change of view — sharp all through a zoom — or
 * let the stage carry the last drawing until the view settles (`update`).
 *
 * Every frame on WebGPU, where it was measured at 9 ms frames zooming both
 * ways and 1 ms of main thread a redraw. Not on 2D, where the same was frames
 * of 17–33 ms: its cost is in compositing the canvas, not in the drawing.
 */
const everyFrame = computed(() => typeof mode.value === 'object' && !switchedOff('scan-every-frame'))

/* ---------- the scan ---------- */

/** Tiles asked for and not yet answered, so a redraw does not ask twice. */
const asked = new Set<string>()

/** Fit levels on their way, by page and size — so a second ask waits on the first. */
const fitting = new Map<string, Promise<void>>()

/** The fit level for a page, at the size it is laid out at here. */
function fitFor (target: ComicPage): Size | null {
  const own = pageSize(target)

  if (!own.width || !own.height) return null

  return fitLevel(own, fittedHeight(room.value, own.width / own.height), dpr.value)
}

/**
 * Ask for a page's fit level, unless one of that size is held or on its way.
 * The page on screen keeps its full decode for tiles; a neighbour does not.
 */
function wantFit (target: ComicPage, onScreen: boolean): Promise<void> {
  const file = target.scan?.file
  const url = target.scan?.url
  const want = fitFor(target)

  if (!file || !url || !want) return Promise.resolve()

  const held = fitOf(url)

  // Held at this size, or at this size and on its way. A page on screen whose
  // fit came from a neighbour's prefetch has no full decode behind it yet —
  // asked for here, as a keep, when the first tile needs it.
  if (held && held.width === want.width && held.height === want.height) return Promise.resolve()

  const name = `fit:${url}:${want.width}x${want.height}`
  const going = fitting.get(name)

  if (going) return going

  // From the page's preview on disk where there is one — 33–41 ms to decode
  // against 125–230 ms for the scan (`previews.ts`) — and from the scan
  // otherwise. Never kept from a preview: the full decode held for a zoom's
  // tiles has to be the scan's own pixels, so the first tile asks for it.
  //
  // A preview is decoded at its own size, a step at most above the fit: the
  // rescale to the exact fit was measured at twice the decode itself (71–88
  // ms against 36–42), for a difference the drawing scales away.
  const hash = target.scan?.hash
  const stored = previewSize(pageSize(target), want)
  const kept = hash ? readPreview(hash, stored).catch(() => null) : Promise.resolve(null)

  const done = kept
    .then((preview) => (preview
      ? scanLevel(url, preview, stored.width, stored.height, { keep: false, urgent: onScreen })
      : scanLevel(url, file, want.width, want.height, { keep: onScreen, urgent: onScreen })))
    .then((decoded) => {
      holdFit(url, { width: want.width, height: want.height, bitmap: decoded.bitmap })
      ahead(decoded.bitmap)
      if (url === key.value) landed.value++
    })
    .catch((error: unknown) => {
      if (!(error instanceof Cancelled)) console.warn('[kemolate] a page could not be drawn', error)
    })
    .finally(() => fitting.delete(name))

  fitting.set(name, done)

  return done
}

/*
 * A page with no size yet — a header that would not say — is measured from a
 * decode of its own, and only if the answer is still about the page on screen.
 * `measure` fills a missing size and never changes a known one; see there for
 * the drift that rule closed.
 */
watch(key, (url) => {
  const file = scan.value?.file

  if (!url || !file || (size.value.width && size.value.height)) return

  const id = props.page.id

  scanSize(url, file)
    .then((found) => { if (key.value === url) measure(id, found.width, found.height) })
    .catch(() => {})
}, { immediate: true })

/**
 * Which way the reader is turning, while they are: one page on (+1) or back
 * (−1) since the last turn, and nought for a jump or once they have stopped.
 *
 * Holding an arrow key turns a page every 80 ms or so, faster than a page is
 * decoded, and the neighbours of the page on screen are only asked for once
 * that page is in — the rule that keeps a neighbour from delaying the page
 * being turned to. So a run of turns never got ahead of itself: every page
 * was decoded only once it was reached, and each was shown grey until then.
 * Measured on istani, 16 turns at 80 ms: pages 9 to 1 grey for all their time
 * on screen, and the page stopped on grey for 522 ms.
 */
const heading = ref(0)
let headingFades: ReturnType<typeof setTimeout> | undefined

watch(at, (now, was) => {
  const step = was === undefined ? 0 : now - was

  heading.value = Math.abs(step) === 1 ? step : 0
  clearTimeout(headingFades)
  headingFades = setTimeout(() => { heading.value = 0 }, 600)
})

onScopeDispose(() => clearTimeout(headingFades))

/** The pages a turn can reach next, nearest first — this one, then out to `REACH` either side. */
const near = computed(() => {
  const out: ComicPage[] = []

  for (let step = 0; step <= REACH; step++) {
    for (const index of step ? [at.value + step, at.value - step] : [at.value]) {
      const target = pages.value[index]

      if (target?.scan) out.push(target)
    }
  }

  // And further on the way the reader is going, while they are going.
  for (let step = REACH + 1; heading.value && step <= REACH + AHEAD; step++) {
    const target = pages.value[at.value + heading.value * step]

    if (target?.scan) out.push(target)
  }

  return out
})

/*
 * Which pages' scans to hold: those within reach. Everything else is let go,
 * and so is every tile of a page that is no longer on screen.
 */
watch(
  () => [
    key.value,
    near.value.map((target) => target.scan!.url).join('\n'),
    // A new size wants a new fit level: the room, the screen's density, and a
    // page whose own size has only just been learned.
    dpr.value,
    room.value.w,
    room.value.h,
    size.value.width,
    generation.value,
  ] as const,
  ([url], old) => {
    const previous = old?.[0]

    if (previous && previous !== url) {
      cancelScan(previous)
      releaseScan(previous)
    }

    keepFits(new Set(near.value.map((target) => target.scan!.url)))

    if (url) keepTilesOf(url)

    // The page on screen first, and the pages around it only once it is in.
    // Asked together, a neighbour's preview could reach the decoder first —
    // it takes one request at a time — and the page being turned to waited on
    // a page nobody was looking at: measured at 100 ms a far turn, against the
    // 40 its own preview takes.
    wantFit(props.page, true).finally(() => {
      if (key.value !== url) return

      for (const target of near.value) {
        if (target !== props.page) wantFit(target, false)
      }
    })

    // In a run of turns, the pages ahead now rather than once this one is in:
    // it will be left before then, and waiting was what kept every page of the
    // run from being decoded before it was reached. See `heading`.
    if (heading.value) {
      for (const target of near.value) {
        const index = pages.value.indexOf(target)

        if ((index - at.value) * heading.value > 0) wantFit(target, false)
      }
    }
  },
  { immediate: true },
)

/** Where a view is, in the scan's own pixels, and how many device pixels each of those gets. */
function place (view: ScanView) {
  const own = size.value

  if (!own.width || !view.sheet.w || !view.w || !view.h) return null

  // Device pixels per sheet pixel, lowered where the box would pass the cap.
  const k = Math.min(view.zoom * dpr.value, CAP / Math.max(view.w, view.h))
  const perPage = view.sheet.w / own.width

  const rect: PageRect = { x: view.x / perPage, y: view.y / perPage, w: view.w / perPage, h: view.h / perPage }

  return { k, perPage, rect, density: perPage * k }
}

const placed = computed(() => place(props.view))

/** The tiles the view wants, or none while the fit level is enough. */
const wanted = computed(() => {
  const where = placed.value
  const want = fitFor(props.page)

  if (!where || !want) return []

  return tilesFor(size.value, where.rect, where.density, want)
})

/**
 * Whether the view is on the move — a zoom or a pan still arriving. Set by
 * `update` and cleared by its settle.
 */
const moving = ref(false)

/*
 * Tiles are asked for once the view comes to rest, not while it moves. A zoom
 * outwards passes through level after level, and asking for each on the way
 * was measured: sixteen hundred tile draws and a redraw nearly every frame of
 * ninety, each new tile's first draw a 4 MB upload. The fit level, and the
 * tiles already held, carry the gesture; the sharp ones follow the stop.
 */
watch([wanted, moving], ([list, busy]) => {
  const url = key.value
  const file = scan.value?.file

  // Not on WebGPU, which redraws every frame anyway and was measured smooth
  // taking tiles mid-gesture — which is what keeps a zoom sharp on the way in.
  if (!url || !file || (busy && !everyFrame.value)) return

  for (const tile of list) {
    const name = `tile:${url}:${tile.id}`

    if (tileOf(url, tile.id) || asked.has(name)) continue

    asked.add(name)

    scanTile(url, file, tile)
      .then((bitmap) => {
        if (url !== key.value) return bitmap.close()

        holdTile(url, tile.id, bitmap)
        ahead(bitmap)
        landed.value++
      })
      .catch(() => {})
      .finally(() => asked.delete(name))
  }
}, { immediate: true })

/* ---------- repairs and pictures ---------- */

const drawsClean = computed(() => props.rows.some((row) => row.kind === 'clean'))

/** A page's repairs, as the clean plate would draw them — see `repairOvers`. */
function repairsOf (target: ComicPage): Over[] {
  return drawsClean.value ? repairOvers(target, patchMap.value[target.id], patchStands) : []
}

/** A placed picture, where the page shows it — see `placedOver`. */
function placedOf (row: RunRow): Over | null {
  const url = row.image ? urlFor(row.image) : null

  return url && row.image ? placedOver(size.value, row.image, url) : null
}

/**
 * The last picture drawn for each repair of the page on screen, kept while a
 * new one decodes: a balloon cleaned again swaps its URL at once, and drawing
 * nothing until the new one arrived would show the printed lettering in
 * between — the very thing this component is here to stop.
 */
const lastRepair = new Map<string, Over & { bitmap: ImageBitmap }>()

/*
 * Decode, ahead, every repair and picture of the pages within reach — so the
 * page turned to has them in hand — and let go of everything else.
 */
watch(
  () => {
    const urls = new Set<string>()

    for (const target of near.value) {
      for (const over of repairsOf(target)) urls.add(over.url)
    }

    for (const row of props.rows) {
      const over = row.kind === 'image' ? placedOf(row) : null

      if (over) urls.add(over.url)
    }

    return `${generation.value}\n${[...urls].sort().join('\n')}`
  },
  (joined) => {
    const urls = new Set(joined.split('\n').slice(1).filter(Boolean))

    for (const kept of lastRepair.values()) urls.add(kept.url)

    keepPictures(urls)

    for (const url of urls) {
      if (pictureAt(url)) continue

      wantPicture(url).then((bitmap) => {
        if (!bitmap) return

        ahead(bitmap)
        landed.value++
      })
    }
  },
  { immediate: true },
)

/* ---------- a page's cleaning in one picture ---------- */

/**
 * The cleaning of each page within reach, as one decoded picture — see
 * `cleaningSignature` in `previews.ts`, which says what it is and why. By the
 * scan's URL, with the signature it was made for, so a page cleaned again is
 * never shown its old cleaning.
 */
const cleanings = new Map<string, { signature: string, bitmap: ImageBitmap }>()

/** The cleanings being read, as `url~signature`, so none is asked for twice at once. */
const cleaningAsked = new Set<string>()

/** A page's cleaning picture, if one is held for the repairs it has now and can be drawn. */
function cleaningFor (target: ComicPage): ImageBitmap | null {
  const url = target.scan?.url
  const held = url ? cleanings.get(url) : undefined

  return held && held.signature === cleaningSignature(repairsOf(target)) && drawable(held.bitmap) ? held.bitmap : null
}

/**
 * Read a page's cleaning off the disk, if the previews have made one for the
 * repairs it has. Decoded here rather than on the decode worker: the worker
 * takes one request at a time and is busy with the scans, and this is the half
 * of a page that has been keeping it grey.
 */
function wantCleaning (target: ComicPage) {
  const url = target.scan?.url
  const hash = target.scan?.hash
  const want = fitFor(target)
  const signature = cleaningSignature(repairsOf(target))

  if (!url || !hash || !want || !signature || cleanings.get(url)?.signature === signature) return

  const name = `${url}~${signature}`

  if (cleaningAsked.has(name)) return

  cleaningAsked.add(name)

  readCleaning(hash, previewSize(pageSize(target), want), signature)
    .then((file) => (file ? createImageBitmap(file) : null))
    .then((bitmap) => {
      if (!bitmap) return

      // Turned well past while it was read: not worth the memory.
      if (!near.value.some((candidate) => candidate.scan?.url === url)) {
        bitmap.close()

        return
      }

      const was = cleanings.get(url)

      if (was) release(was.bitmap)

      cleanings.set(url, { signature, bitmap })
      ahead(bitmap)

      if (url === key.value) landed.value++
    })
    .catch(() => {})
    .finally(() => cleaningAsked.delete(name))
}

watch(
  () => [
    near.value.map((target) => `${target.scan!.url}~${cleaningSignature(repairsOf(target))}`).join('\n'),
    generation.value,
  ] as const,
  (now, old) => {
    // A lost device took every held picture with it.
    if (old && now[1] !== old[1]) cleanings.clear()

    const reach = new Set(near.value.map((target) => target.scan!.url))

    for (const [url, held] of cleanings) {
      if (reach.has(url)) continue

      release(held.bitmap)
      cleanings.delete(url)
    }

    // The page on screen first; `near` is nearest first after it.
    for (const target of near.value) wantCleaning(target)
  },
  { immediate: true },
)

onScopeDispose(() => {
  for (const held of cleanings.values()) release(held.bitmap)
  cleanings.clear()
})

/* ---------- every page as a sketch ---------- */

/**
 * The pages about this one as sketches — see `SKETCH_WIDTH` in `previews.ts` —
 * by scan URL, with the cleaning each was drawn with. Drawn in place of a page
 * that is not ready yet, which was grey. Held by the engine, which stays
 * mounted from page to page, out to `SKETCH_REACH` either side.
 */
const sketches = new Map<string, { signature: string, bitmap: ImageBitmap }>()

/** A page's repairs, placed, whether or not the clean plate is drawn here. */
const cleaningOf = (target: ComicPage) => repairOvers(target, patchMap.value[target.id], patchStands)

/** The sketch of a page as it is cleaned now, if one is held and can be drawn. */
function sketchFor (target: ComicPage): ImageBitmap | null {
  const url = target.scan?.url
  const held = url ? sketches.get(url) : undefined

  return held && held.signature === cleaningSignature(cleaningOf(target)) && drawable(held.bitmap) ? held.bitmap : null
}

/**
 * Whether the sketch shows this page as the stack would: a sketch is the scan
 * with its cleaning in, so only while the scan is showing and the cleaning is
 * too — or there is none. The Read preset hides the cleaning, and a sketch
 * then would show a picture the page is not; it stays grey instead.
 */
function sketchFits (target: ComicPage): boolean {
  const art = props.rows.some((row) => row.kind === 'art' && row.visible)
  const clean = props.rows.some((row) => row.kind === 'clean' && row.visible)

  return art && (clean || !cleaningOf(target).length)
}

/** The pages whose sketches to hold, nearest first. */
function sketchReach (): ComicPage[] {
  const out: ComicPage[] = []

  for (let step = 0; step <= SKETCH_REACH; step++) {
    for (const index of step ? [at.value + step, at.value - step] : [at.value]) {
      const target = pages.value[index]

      if (target?.scan) out.push(target)
    }
  }

  return out
}

/** Read the sketches within reach, nearest first, and let go of the rest. */
let sketching = 0

async function readSketches () {
  const run = ++sketching
  const reach = sketchReach()
  const here = new Set(reach.map((target) => target.scan!.url))

  // Let go first, so a long run of turns never holds two windows at once.
  for (const [url, held] of sketches) {
    if (here.has(url)) continue

    release(held.bitmap)
    sketches.delete(url)
  }

  for (const target of reach) {
    const url = target.scan?.url
    const hash = target.scan?.hash

    if (!url || !hash) continue

    const signature = cleaningSignature(cleaningOf(target))
    const held = sketches.get(url)

    if (held?.signature === signature && drawable(held.bitmap)) continue

    const file = await readSketch(hash, signature).catch(() => null)
    const bitmap = file ? await createImageBitmap(file).catch(() => null) : null

    // Asked again meanwhile — a page cleaned, the chapter replaced.
    if (run !== sketching) {
      bitmap?.close()

      return
    }

    if (!bitmap) continue

    if (held) release(held.bitmap)

    sketches.set(url, { signature, bitmap })
    ahead(bitmap)

    if (url === key.value) landed.value++
  }
}

watch(
  () => [
    sketchReach().map((target) => `${target.scan!.hash ?? ''}~${cleaningSignature(cleaningOf(target))}`).join('\n'),
    generation.value,
  ] as const,
  (now, old) => {
    // A lost device took every held picture with it.
    if (old && now[1] !== old[1]) sketches.clear()

    readSketches().catch(() => {})
  },
  { immediate: true },
)

onScopeDispose(() => {
  sketching++

  for (const held of sketches.values()) release(held.bitmap)
  sketches.clear()
})

/* ---------- showing a page whole ---------- */

/** The scan the page was last shown with — once it is, nothing holds it back again. */
let shown: string | null = null

/** When the page on screen was turned to, for `WAIT_MS`. */
let arrived = 0
let waiting: ReturnType<typeof setTimeout> | undefined

watch(key, () => {
  arrived = performance.now()
  lastRepair.clear()
  clearTimeout(waiting)
  // Asked again once the wait is up, so a repair that never decodes cannot
  // keep the page blank.
  waiting = setTimeout(() => landed.value++, WAIT_MS + 10)
}, { immediate: true })

/**
 * Whether the page on screen can be shown: its scan, and every repair and
 * picture it has, decoded. A layer that is hidden does not count.
 */
function whole (url: string): boolean {
  if (!fitOf(url)) return false

  for (const row of props.rows) {
    if (!row.visible) continue

    // Every repair decoded, or the page's cleaning in one picture — see
    // `cleaningFor`.
    if (row.kind === 'clean' && repairsOf(props.page).some((over) => !pictureAt(over.url)) && !cleaningFor(props.page)) return false

    if (row.kind === 'image') {
      const over = placedOf(row)

      if (over && !pictureAt(over.url)) return false
    }
  }

  return true
}

/* ---------- drawing ---------- */

/**
 * What the canvas holds now — the view it was drawn for, which is where it is
 * laid out. Not the live view: see `update`.
 */
const drawn = shallowRef<ScanView | null>(null)

/** Which scan that drawing is of, so a new page is a redraw. */
let drawnFrom: string | null = null

/** The scan's own layer: the fit level, then the tiles held for this view. */
function scanQuads (url: string, where: NonNullable<ReturnType<typeof place>>): Quad[] {
  const fit = fitOf(url)
  const want = fitFor(props.page)

  if (!fit) return []

  const quads: Quad[] = [{ bitmap: fit.bitmap, sx: 0, sy: 0, sw: size.value.width, sh: size.value.height }]

  for (const tile of want ? tilesFor(size.value, where.rect, where.density, want) : []) {
    const bitmap = tileOf(url, tile.id)

    if (bitmap) quads.push({ bitmap, sx: tile.sx, sy: tile.sy, sw: tile.sw, sh: tile.sh })
  }

  return quads
}

/**
 * A paint surface of the page on screen — the retouching (`bg`) or a blank
 * sheet — laid over the whole page at the scan's size. Nothing while it has
 * no pixels: `CanvasPaint` sizes a surface only when there is paint on it.
 */
function surfaceQuads (surface: string): Quad[] {
  const name = surfaceKey(props.page.id, surface)
  const canvas = surfaceOf(name)

  if (!canvas?.width) return []

  return [{ bitmap: canvas, sx: 0, sy: 0, sw: size.value.width, sh: size.value.height, surface: name }]
}

/** The repairs of the page on screen, each the newest decoded picture it has. */
function repairQuads (): Quad[] {
  const out: Quad[] = []
  const overs = repairsOf(props.page)

  // The page's cleaning in one picture until every repair is in, and the
  // repairs once they are: they are sharp at any zoom, and this is sharp at the
  // size it was made for. Not both at once — a soft edge drawn twice is darker.
  if (overs.some((over) => !pictureAt(over.url))) {
    const whole = cleaningFor(props.page)

    if (whole) return [{ bitmap: whole, sx: 0, sy: 0, sw: size.value.width, sh: size.value.height }]
  }

  for (const over of overs) {
    const bitmap = pictureAt(over.url)

    if (bitmap) {
      lastRepair.set(over.block!, { ...over, bitmap })
      out.push({ bitmap, sx: over.sx, sy: over.sy, sw: over.sw, sh: over.sh })

      continue
    }

    // Not decoded yet: the one it replaces, where it was, until it is.
    const old = lastRepair.get(over.block!)

    if (old && drawable(old.bitmap)) out.push(old)
  }

  return out
}

/**
 * How many `scan:draw` timings are kept before they are cleared, and how many
 * have been taken since.
 *
 * The measure is there for traces — DevTools draws User Timing entries on the
 * timeline — and for reading draw times off the console. But the browser keeps
 * every entry for the life of the page, and on WebGPU a draw is every frame of
 * a gesture and a paint stroke, so an afternoon's lettering left hundreds of
 * thousands of them in memory. Cleared in batches rather than one at a time,
 * so the most recent draws are always there to read.
 */
const KEEP_TIMINGS = 1000
let timings = 0

function draw (view: ScanView) {
  const el = canvas.value
  const url = key.value
  const where = place(view)
  const how = mode.value

  if (!el || !url || !where || how === 'pending') return

  const width = Math.max(1, Math.round(view.w * where.k))
  const height = Math.max(1, Math.round(view.h * where.k))
  const start = performance.now()

  if (el.width !== width || el.height !== height) {
    el.width = width
    el.height = height
  }

  drawn.value = view
  drawnFrom = url

  // Held back until whole, the first time — or until the wait is up.
  const ready = shown === url || whole(url) || (fitOf(url) && performance.now() - arrived >= WAIT_MS)

  // Not ready: the page's sketch, where it shows the page as the stack would,
  // and nothing — the grey of the board — where it does not.
  const sketch = ready ? null : sketchFor(props.page)
  const standIn = sketch && sketchFits(props.page)
    ? [{ quads: [{ bitmap: sketch, sx: 0, sy: 0, sw: size.value.width, sh: size.value.height }], opacity: 1, luts: [] }]
    : []

  const layers = !ready
    ? standIn
    : props.rows.length
      ? props.rows.filter((row) => row.visible).map((row) => ({
          quads: row.kind === 'art'
            ? scanQuads(url, where)
            : row.kind === 'clean'
              // The repairs, and the hand retouching over them — one plate,
              // so its opacity and adjustments reach both, as they always did.
              ? [...repairQuads(), ...surfaceQuads('bg')]
              : row.kind === 'paint'
                ? surfaceQuads(row.key)
                : [placedOf(row)].flatMap((over) => {
                    const bitmap = over && pictureAt(over.url)

                    return bitmap ? [{ bitmap, sx: over.sx, sy: over.sy, sw: over.sw, sh: over.sh }] : []
                  }),
          opacity: row.opacity,
          luts: row.adjust.map((one) => adjustLut(one.adjust, one.strength)),
        }))
      : [{ quads: scanQuads(url, where), opacity: 1, luts: [] }]

  const frame = {
    layers,
    // Scan pixels onto canvas pixels: scale, then shift by where the view starts.
    scale: where.perPage * where.k,
    shift: { x: -view.x * where.k, y: -view.y * where.k },
    crisp: view.crisp,
  }

  if (how === '2d') draw2d(el, frame)
  else drawGpu(how, el, frame)

  performance.measure('scan:draw', { start })

  if (++timings >= KEEP_TIMINGS) {
    performance.clearMeasures('scan:draw')
    timings = 0
  }

  if (ready && shown !== url) {
    shown = url
    emit('drawn')
  }
}

/** Whether `outer` holds every pixel of `inner`, give or take rounding. */
function covers (outer: ScanView, inner: ScanView) {
  return outer.x <= inner.x + 0.5 && outer.y <= inner.y + 0.5
    && outer.x + outer.w >= inner.x + inner.w - 0.5 && outer.y + outer.h >= inner.y + inner.h - 0.5
}

/** Whether what the canvas holds will not do for this view, even for a frame. */
function stale (want: ScanView) {
  const was = drawn.value

  if (!was || drawnFrom !== key.value) return true
  if (was.crisp !== want.crisp || was.sheet.w !== want.sheet.w || was.sheet.h !== want.sheet.h) return true
  if (!covers(was, want)) return true

  // Enlarged or shrunk by the stage past this, the old drawing reads as soft
  // or as wasted pixels, and is worth the redraw.
  const ratio = want.zoom / was.zoom

  return ratio > 1.5 || ratio < 1 / 1.5
}

/**
 * A view drawn with room around it, for a zoom going outwards: every frame of
 * one uncovers a little more page, and without the room each of them would be
 * a redraw.
 */
function roomy (want: ScanView): ScanView {
  const was = drawn.value

  if (!was || want.zoom >= was.zoom) return want

  const x = Math.max(0, want.x - want.w / 4)
  const y = Math.max(0, want.y - want.h / 4)

  return {
    ...want,
    x,
    y,
    w: Math.min(want.sheet.w, want.x + want.w * 1.25) - x,
    h: Math.min(want.sheet.h, want.y + want.h * 1.25) - y,
  }
}

let settle: ReturnType<typeof setTimeout> | undefined

/**
 * Draw when the view changes — on every change on WebGPU, and on 2D only when
 * the canvas cannot show the view as it is, then exactly once it settles.
 *
 * Redrawing a 2D canvas on every frame of a gesture was measured: a
 * 7-megapixel canvas handed to the compositor sixty times a second is frames
 * of 17–33 ms, where the `<img>` it replaced was only moved. So there the
 * canvas is left where it was drawn — laid out in sheet pixels, it is carried
 * by the stage's transform like everything else on the page — and a gesture
 * costs a redraw only when that stops being good enough: the view leaves what
 * was drawn, or the zoom has moved half as far again.
 */
function update () {
  clearTimeout(settle)

  const want = props.view

  if (everyFrame.value) draw(want)
  else if (stale(want)) draw(roomy(want))

  const was = drawn.value

  if (was && (was.x !== want.x || was.y !== want.y || was.w !== want.w || was.h !== want.h || was.zoom !== want.zoom)) {
    moving.value = true
    settle = setTimeout(() => {
      moving.value = false
      draw(props.view)
    }, 150)
  } else if (everyFrame.value) {
    settle = setTimeout(() => { moving.value = false }, 150)
  }
}

// After the DOM has taken the new view — so a redraw that has to happen lands
// in the same frame as the transform that needed it.
watch([() => props.view, key, canvas], update, { flush: 'post', immediate: true })

// The layers changing — an eye, an opacity, a row moved in or out of the run —
// is a redraw of the view already drawn. Not through `update`, which on 2D
// redraws only when the view has moved and so left a hidden layer on screen.
watch(() => props.rows, () => landed.value++)

let frame = 0

/*
 * A bitmap arriving — a fit level, a tile, a repair — redraws what is already
 * drawn, where it is laid out, at most once a frame: several land together,
 * and each used to be a redraw of all the others.
 */
// A surface painted on — a stroke under the brush, an undo, a collaborator's
// hand — is a redraw too, batched with everything else into the next frame.
watch(surfacesChanged, () => landed.value++)

watch(landed, () => {
  if (frame) return

  frame = requestAnimationFrame(() => {
    frame = 0
    draw(drawn.value ?? props.view)
  })
})

// The page's repairs changing — a balloon cleaned, a record confirmed — is a
// redraw as well, once the new picture is in (see `lastRepair`).
watch(() => repairsOf(props.page).map((over) => over.url).join('\n'), () => landed.value++)

onBeforeUnmount(() => {
  clearTimeout(settle)
  clearTimeout(waiting)
  cancelAnimationFrame(frame)
  if (key.value) releaseScan(key.value)
})
</script>

<template>
  <canvas
    ref="canvas"
    class="absolute"
    :style="drawn ? { left: `${drawn.x}px`, top: `${drawn.y}px`, width: `${drawn.w}px`, height: `${drawn.h}px` } : { display: 'none' }"
  />
</template>
