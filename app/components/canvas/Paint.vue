<script setup lang="ts">
/**
 * The paint layer of one page: a canvas over the scan, wired to the stroke log.
 *
 * What it owns is the joining-up. The pixels are `PaintSession`'s business and
 * the truth is the server's stroke log; this component holds the canvas
 * element, resolves *which* surface it is (page row, plate row, `bg`), replays
 * the log into it, and turns pointer gestures into appended rows. Undo never
 * touches it directly — `useUndo` bumps the surface's version and this replays,
 * which is the same thing a collaborator's undo will do when realtime lands.
 *
 * It only takes the pointer while a paint tool is out. Any other time it is
 * pointer-transparent, so selecting blocks and clearing selection keep working
 * exactly as before.
 *
 * ## Painting does not wait for a server
 *
 * Every stroke is laid in this browser first — see `usePaintCache` — and sent
 * up as well when the workspace has somewhere to send it. It used to be the
 * other way round: no surface, no mark, and a toast saying to share the
 * workspace. That made sharing the price of using the brush at all, which is
 * the opposite of every other part of this app, where the scans, the reading
 * and the cleaning all live perfectly well on one machine.
 *
 * So the canvas replays two logs merged into one: the workspace's rows and
 * this browser's. They order together by `(seq, clientId)` — the same rule the
 * server uses — so a page painted alone and then shared composites in the
 * order it was drawn rather than in the order it happened to be uploaded.
 *
 * ## Nor does it talk to the server itself
 *
 * The workspace's half is `usePaintSync`'s: read with the page's stack in the
 * one request a page turn makes, sent up in runs rather than a POST a stroke,
 * and re-read past a cursor when a collaborator paints. This component says
 * which surface it is, lays its strokes in the local log, and hands the log
 * over. It used to make the surface on connecting — two writes before a page
 * could show its paint, and a row for every page anybody turned to.
 */

import type { LocalStroke } from '~/composables/usePaintCache'
import type { PaintDestination } from '~/composables/usePaintSync'
import type { Box, PaintToolId } from '~/utils/paint/session'
import type { Stroke } from '~~/server/database'

import { patchStands, usePatchMap } from '~/composables/useClean'
import { usePaintSync } from '~/composables/usePaintSync'
import { keepPixels, keptPixels } from '~/utils/paint/kept'
import { mergeLogs } from '~/utils/paint/remote'
import { PaintSession } from '~/utils/paint/session'
import { composeUnder, underPlan, underScan, underUrls } from '~/utils/paint/under'
import { repairOvers } from '~/utils/raster/engine/overs'
import { dropSurface, holdSurface, surfaceKey, surfaceOf, surfacesChanged, surfaceVersion, touchSurface } from '~/utils/raster/engine/surfaces'

/**
 * Which surface this canvas is, and which stack row governs it.
 *
 * Defaulted to the retouching on the cleaned plate, which is what this
 * component was before there was anything else to be: `bg` on the `clean`
 * plate, the marks that belong to no block. A blank layer passes its own row
 * instead, so its marks land on a surface of its own and cannot be confused
 * with the repair — see `newPaintLayer`.
 *
 * The surface `key` is unique per page, which is exactly what a stack row's id
 * already is. `plate` is the row the server files it under, for the five a page
 * is made of; a blank layer has no plate and is filed under *its own* stack row
 * instead — which it has, now that the stack is stored. It used to hang off the
 * cleaned plate's row the way a mask correction hangs off the mask's, and that
 * was only ever a way of borrowing a row from something that had one.
 *
 * Which of the two a surface is, is the key's to say — `bg` is the plate's,
 * anything else is a sheet's own id — the same rule `isRowOf` draws the pile
 * by. Asking whether `plate` was given was the bug: it has a default, so every
 * sheet arrived claiming to be the cleaned plate.
 */
const props = withDefaults(
  defineProps<{
    page: ComicPage
    plate?: PlateId
    surface?: string
    active?: boolean
    /**
     * Whether the page engine draws this surface (`engineRun`). Then the
     * canvas is not on the page at all — the engine shows the part of it on
     * screen, composited with what is under it — and only the hit area below
     * is. Otherwise the canvas is in that hit area, as it always was.
     */
    engine?: boolean
  }>(),
  { plate: 'clean', surface: 'bg', active: undefined, engine: false },
)

const route = useRoute()
const { tool, painting: armed, setTool } = useTools()
const { shared } = useShared()
const { size, softness, colour } = usePaintSettings()
const { versions, record } = useUndo()

// The strokes this browser holds whether or not anybody has been invited.
const paint = usePaintCache()

// The ring under the pointer. Drawn by `CanvasBrushCursor` above the whole
// stack rather than here — this canvas is inside the cleaned plate, and a
// cursor faded by the plate's own opacity is not a cursor. See
// `useBrushCursor`.
const { show: showCursor, hide: hideCursor } = useBrushCursor()

// Put down when the tool changes or the page does: a ring left behind by a
// brush nobody is holding is a ring that never goes away.
watch(() => armed.value, (on) => { if (!on) hideCursor() })

onScopeDispose(hideCursor)

const workspace = computed(() => String(route.params.workspaceId ?? ''))

/**
 * The workspace's half of the paint, and where this canvas's strokes go — see
 * `usePaintSync`, and the header.
 */
const sync = usePaintSync()

/**
 * Whether this component owns the pointer right now — see `painting`, which is
 * where both halves of the question live: a paint tool out, and the plate it
 * paints on open to it. Asked rather than worked out here, so that the canvas
 * and the board cannot come to different answers about the same locked layer.
 *
 * With the cleaned plate hidden or shut this is inert and the pointer falls
 * through to the blocks underneath, which is what a locked layer should feel
 * like: still there, still visible, and not taking anything.
 */
const active = computed(() => props.active ?? armed.value)

/**
 * The surface: made here rather than in the template, because it is not
 * always on the page — see `engine`. One canvas either way, so the strokes,
 * the session and the pixels on it do not care which.
 */
const canvas = shallowRef<HTMLCanvasElement | null>(null)

if (import.meta.client) {
  const made = document.createElement('canvas')

  made.className = 'pointer-events-none absolute inset-0 size-full'
  canvas.value = made
}

/** What the pointer lands on, and what the canvas sits in when it is on the page. */
const host = useTemplateRef<HTMLDivElement>('host')

/** On the page or off it, as `engine` says. */
function place () {
  const el = canvas.value
  const into = host.value

  if (!el) return

  if (into && !props.engine) {
    if (el.parentElement !== into) into.appendChild(el)
  } else {
    el.remove()
  }
}

// Not `immediate`, and nothing below touches shared state during setup: this
// component is mounted in the middle of the board's render when a sheet is
// added, and a post-render watcher run straight from setup — or a write to the
// engine's state from it — lost this component its own mounted hook there, so
// a new sheet was never sized and took no paint. The first placing and the
// first handing over are done on mount instead.
watch(() => props.engine, place, { flush: 'post' })

/** This surface's name to the page engine. */
const surfaceName = computed(() => surfaceKey(props.page.id, props.surface))

watch(surfaceName, (key, was) => {
  const el = canvas.value

  if (!el) return

  if (was) dropSurface(was, el)
  holdSurface(key, el)
})

/** Tell the engine this surface changed — a rectangle of it, or all of it. */
const touch = (x?: number, y?: number, w?: number, h?: number) => touchSurface(surfaceName.value, x, y, w, h)

/* ---------- server identity ---------- */

/**
 * The server's row for the page this canvas is painting on.
 *
 * Through `rowOfPage` — uid, then an unambiguous hash, then path. The copy that
 * stood here matched on hash and then on *name*, which is a fifth private
 * opinion about a question that now has one answer: two pages of a chapter can
 * hold the same bytes (two blank pages do), and names collide the moment a
 * chapter has sub-folders. Either mistake files a stroke against the wrong
 * page's surface, which is the sort of thing nobody notices until somebody
 * turns to the page it landed on.
 */
const remote = computed(() => rowOfPage(shared.value?.pages ?? [], props.page) ?? null)

/** The page's row id — what the workspace's half of the paint is filed under. */
const pageRow = computed(() => remote.value?.id ?? null)

/**
 * The workspace's log for this surface, as last read, live and retracted both
 * — and the surface's row id, which only exists once somebody has painted here.
 *
 * Filed by page rather than held per canvas, and that was already the lesson
 * of the list it replaces: a page turn changes the page under this component
 * without making a new one, so a log held here went on drawing the page just
 * left until the new page's answer came back — a white chunk of somebody's
 * cleanup where nobody had painted. By page, a page turned to shows its own
 * log (the last one read, if it has been on screen before in this tab;
 * nothing, if not), and a late answer is filed under the page it is about.
 */
const surface = computed(() => sync.surfaceOf(pageRow.value, props.surface))

/** Null until the first stroke on this surface anywhere has landed — see `usePaintSync`. */
const surfaceId = computed(() => surface.value?.id ?? null)

const theirs = computed<readonly Stroke[]>(() => surface.value?.rows ?? [])

/** Whether this browser may add to the workspace's log, rather than only to its own. */
const writable = computed(() => Boolean(shared.value && atLeast(shared.value.role, 'editor')))

const clientId = useState('paint-client', () => crypto.randomUUID())

/**
 * The gesture channel — what this hand is doing, and what other hands are.
 *
 * Everything about a stroke *in flight* lives in `useLiveStrokes`: the
 * throttle, the incremental points, the drawings other people's hands are
 * making, and when one of those is retired. This component only draws them —
 * see `ghosts`.
 */
const { drawing, seq: claiming, begin: beginGesture, broadcast, end: endGesture, retire } = useLiveStrokes({
  surface: surfaceId,
  page: pageRow,
  key: computed(() => props.surface),
  clientId,
  // By page and key rather than by row id: a surface is made by its first
  // stroke now, and a canvas that has not re-read the page since has no id
  // to compare the gesture's with.
  accepts: (live) => live.pageId === pageRow.value && live.key === props.surface,
})

/**
 * What this canvas's local strokes are filed under: the page's own bytes, and
 * which surface of it this is.
 *
 * Both halves are needed. The hash alone is how blocks and patches are filed
 * and is right for "which page" — but a page now has more than one paint
 * canvas on it, and keying by the hash alone would pour every blank layer's
 * marks into the same log and replay all of them onto each.
 */
const store = computed(() => (props.page.scan?.hash ? `${props.page.scan.hash}:${props.surface}` : null))

/**
 * Everything to replay, from both logs, in the one order that composites
 * correctly.
 *
 * `(seq, clientId)` is the server's own rule, applied to the union rather than
 * to each half — so a local stroke drawn between two shared ones lands between
 * them, not after both. Retracted rows are kept in the list and skipped at
 * draw time, because that is what lets redo put a mark back *underneath* what
 * has been painted over it since.
 *
 * Each mark once: a stroke whose batch is in the air can be in both halves for
 * a moment, and `mergeLogs` keeps this browser's copy of it.
 */
const log = computed(() => mergeLogs<Stroke | LocalStroke>(theirs.value, paint.on(store.value)))

/** The next seq this client will claim: one past everything it has seen. */
const nextSeq = computed(() => log.value.reduce((most, row) => Math.max(most, row.seq + 1), 1))

/**
 * Where this canvas's local log goes, while it can go anywhere: a page the
 * workspace knows, and the right to add to it.
 */
function destination (): PaintDestination | null {
  const key = store.value

  if (!key || !pageRow.value || !writable.value) return null

  const sheet = props.surface !== 'bg'

  return {
    workspace: workspace.value,
    store: key,
    pageId: pageRow.value,
    key: props.surface,
    plate: sheet ? null : props.plate,
    layer: sheet ? props.surface : null,
    refused,
  }
}

/**
 * Hand this canvas's local strokes over, if it has any and somewhere to send
 * them — a stroke just laid, or strokes left from before: a workspace painted
 * in alone and then shared should share the painting, and a batch that did not
 * land last session is still in the log. `usePaintSync` sends only what is not
 * already on its way, so asking again is free.
 */
function handOver () {
  const to = destination()

  if (to && paint.on(to.store).length) sync.upload(to)
}

/**
 * Somebody else painted on this surface, or took a mark back — read what is new.
 *
 * Only for this component's own surface, matched by page and key: every plate
 * on the page mounts one of these and they all hear every notice, and a
 * surface somebody's first stroke has just made has an id nobody here has
 * seen yet. The read is the page's, gathered — the notice itself and the
 * version bump `useLiveSync` makes of it are one read, not two, and a run of
 * strokes is one read past the page's cursor rather than a whole log per mark.
 */
onSwarmChange((room, change) => {
  if (room !== workspace.value || change.scope !== 'strokes') return
  if (change.pageId !== pageRow.value || change.key !== props.surface) return

  sync.refresh(workspace.value, change.pageId)
})

// The ghosts are not in `log`, so the redraw that watches it does not see them
// move. `ghosts` rather than `redraw`: a gesture repaints the committed pixels
// it was handed, and does not rebuild them.
watch(drawing, ghosts, { flush: 'post', deep: true })

/* ---------- pixels ---------- */

let session: PaintSession | null = null

/**
 * The page under this surface and the paint on it so far, flattened — what the
 * sampling tools read. See `paint/under.ts` for what "under" takes in.
 *
 * Nothing while the picture in hand is not of the page on screen — see
 * `under`. Clone and heal refuse a null flat rather than sample another page,
 * which is what they were doing.
 */
function buildFlat (region?: Box, into?: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const el = canvas.value
  const below = underReady() ? under : null

  if (!el || !below) return null

  // A picture already made for this batch, brought up to date only where the
  // stroke about to open reads — see `PaintSession.replayRows`.
  const reuse = Boolean(region && into && into.width === el.width && into.height === el.height)
  const flat = reuse ? into! : document.createElement('canvas')

  if (!reuse) {
    flat.width = el.width
    flat.height = el.height
  }

  const c = flat.getContext('2d')

  if (!c) return null

  if (!region) {
    c.drawImage(below, 0, 0, flat.width, flat.height)
    c.drawImage(el, 0, 0)

    return flat
  }

  const { x, y, w, h } = region

  if (w <= 0 || h <= 0) return flat

  // `below` is drawn scaled to the layer, as the whole picture is above.
  const sx = below.width / flat.width
  const sy = below.height / flat.height

  c.clearRect(x, y, w, h)
  c.drawImage(below, x * sx, y * sy, w * sx, h * sy, x, y, w, h)
  c.drawImage(el, x, y, w, h, x, y, w, h)

  return flat
}

/**
 * The page under this surface, at the scan's size, for the sampling tools —
 * heal, clone and the picker — and which scan it is of.
 *
 * It was the scan alone, decoded per *scan* rather than per size: decoded in
 * `prepare`, which runs when the page's size changes, a chapter of same-sized
 * pages kept the first page's bitmap, so the picker read the page you came
 * from, clone copied its artwork, and heal wrote its colours into the saved
 * stroke. The same rule holds for what replaced it — `underOf` is the scan's
 * object URL.
 *
 * And only while something here can use it (`needsUnder`): it is the page's
 * full size — 78 MB on a 3732 × 5197 page — and a canvas nobody is painting on
 * and that holds no clone stroke never samples anything. It takes the place of
 * the decoded scan this used to hold, so a brush out costs what it did.
 */
let under: HTMLCanvasElement | null = null

/** Which scan `under` is of — its object URL. */
let underOf: string | null = null

/** Whether the picture in hand is of the page on screen. */
const underReady = () => Boolean(under) && underOf === props.page.scan?.url

/**
 * Whether this canvas needs the page under it: it is the one being painted on,
 * so a sampling tool may be picked up at any moment, or its log holds a clone
 * stroke, which replays by copying from the page.
 */
const needsUnder = computed(() => active.value || log.value.some((row) => row.tool === 'clone' && !row.retracted))

const { page: onScreen, pile } = useComic()
const patchMap = usePatchMap()
const { urlFor } = usePlacedImages()

/** The rows under this surface, as pictures — see `underPlan`. Null off screen. */
const plan = computed(() => {
  const scan = props.page.scan

  if (!scan?.width || !scan.height || onScreen.value?.id !== props.page.id) return null

  const repairs = repairOvers(props.page, patchMap.value[props.page.id], patchStands)

  return underPlan(pile.value, props.surface, scan, repairs, (surface) => surfaceKey(props.page.id, surface), urlFor)
})

/**
 * What the page under this surface is made of, as one string: the scan, the
 * plan, and how far each sheet under it has been painted. Moving is what asks
 * for it to be composed again; this surface's own painting does not move it.
 */
const underKey = computed(() => {
  // Read for the dependency: a surface's version is not reactive by itself.
  const changed = surfacesChanged.value
  const scan = props.page.scan
  const drawn = plan.value

  if (!scan || !drawn) return null

  const painted = drawn.flatMap((layer) => layer.parts.flatMap((part) =>
    part.from === 'surface' ? [`${part.surface}@${surfaceVersion(part.surface)}`] : []))

  return changed >= 0 ? JSON.stringify([scan.url, drawn, painted]) : null
})

/** The key `under` was composed from. */
let underBuilt: string | null = null

/** Bumped per composition, so one that finishes after a newer one began is dropped. */
let composing = 0

function dropUnder () {
  if (under) under.width = 0

  under = null
  underOf = null
  underBuilt = null
}

/**
 * Compose the page under this surface — the scan and every picture in it
 * decoded first, off this thread where the browser can (see `raster/jobs.ts`
 * on why a full-size decode here costs no frames) — and, where this surface
 * holds clone strokes, draw them again from it.
 */
async function composeBelow () {
  const key = underKey.value
  const drawn = plan.value
  const scan = props.page.scan

  if (!needsUnder.value || !key || !drawn || !scan || key === underBuilt) return

  const token = ++composing

  const [bitmap, pictures] = await Promise.all([
    underScan(drawn) ? createImageBitmap(scan.file).catch(() => null) : Promise.resolve(null),
    Promise.all(underUrls(drawn).map(async (url) => {
      const picture = await fetch(url).then((response) => response.blob()).then((blob) => createImageBitmap(blob)).catch(() => null)

      return [url, picture] as const
    })),
  ])

  const decoded = new Map(pictures.flatMap(([url, picture]) => (picture ? [[url, picture] as const] : [])))
  const letGo = () => {
    bitmap?.close()
    for (const picture of decoded.values()) picture.close()
  }

  // Asked again while decoding, or turned past: this one is of no use now.
  if (token !== composing || props.page.scan?.url !== scan.url) {
    letGo()

    return
  }

  const made = composeUnder(scan, drawn, bitmap, decoded, surfaceOf)

  letGo()

  if (!made) return

  dropUnder()
  under = made
  underOf = scan.url
  underBuilt = key

  // A clone replayed without it was left off the picture — see `redraw` — and
  // one replayed from the last picture copied from what is no longer there. A
  // watched clone's source was built from it as well.
  session?.dropGhostSource()

  // Not where the canvas already holds them drawn from this same page — kept
  // pixels taken up on the way in (`drawnUnder`).
  if (log.value.some((row) => row.tool === 'clone' && !row.retracted) && drawnUnder !== key) replayAll()
}

/** Composed soon after it is asked for — a sheet under this one painted a stroke at a time asks often. */
let composeSoon: ReturnType<typeof setTimeout> | undefined

function askBelow () {
  clearTimeout(composeSoon)

  if (!needsUnder.value) {
    dropUnder()

    return
  }

  // At once while there is nothing in hand for this page; a moment later when
  // what is in hand is only out of date.
  if (!underReady()) composeBelow()
  else composeSoon = setTimeout(composeBelow, 250)
}

/**
 * Whether this surface has anything to show or take: marks in its log, a hand
 * of this browser's about to make some, or a collaborator's moving over it.
 *
 * Nothing else earns it a canvas. A surface's pixels are the scan's size — on
 * a 3732 × 5197 page, 78 MB — and every page mounts one for the clean plate
 * and one per blank sheet whether or not anybody ever painted there, with a
 * second copy of each beside it (since removed — see `drawn`). Almost every
 * page of almost every chapter is one nobody retouched, so that was 155 MB a
 * page spent on transparency.
 */
const needed = computed(() => active.value
  || log.value.some((row) => !row.retracted)
  || Object.keys(drawing.value).length > 0)

async function prepare () {
  const el = canvas.value
  const scan = props.page.scan

  if (!el || !scan || !scan.width || !scan.height) return

  // Sized to the page while there is something to hold, and to nothing while
  // there is not — see `needed`. The session is the canvas's, so it goes and
  // comes with the size.
  const width = needed.value ? scan.width : 0
  const height = needed.value ? scan.height : 0

  if (el.width === width && el.height === height && !!session === !!width) return

  // The pixels on the canvas belong to whatever was here before — another page,
  // or this one at another size — and resizing is about to clear them. Kept for
  // that surface first, so turning back to it costs a copy; and forgotten here,
  // which is what stops the next log change being mistaken for an append onto a
  // base that is no longer underneath it.
  stash()

  el.width = width
  el.height = height

  session = width ? new PaintSession(el, buildFlat, touch) : null
  touch()

  redraw()
}

/**
 * Which rows this canvas holds, in the order they were laid down — the
 * committed log, already drawn, so a gesture does not have to redraw it.
 *
 * This is the difference between a peer's stroke arriving smoothly and
 * arriving in lurches. Replaying one stroke is not cheap — `replay` opens a
 * stroke, which sizes three page-sized buffers, and then walks every point —
 * so rebuilding the whole log is proportional to everything ever painted on
 * the surface. So the log is rasterised when the *log* changes, and a stroke
 * arriving costs the length of that stroke.
 *
 * The canvas itself is that raster. There used to be a second copy beside it,
 * `settled`, the page's size — 78 MB on a 3732 × 5197 page, for every surface
 * with a mark on it — so that a collaborator's gesture could be drawn over the
 * committed pixels and wiped off again. That copy is now made only while a
 * gesture is being drawn here (`backup`), and a frame puts back only the part
 * of it the last frame drew over.
 *
 * Besides these rows the canvas may hold two things the log does not say: this
 * hand's stroke while it is being made, and other hands' gestures (`ghostRect`).
 */
let drawn: string[] = []

/** Which surface the canvas holds — `store` when it was drawn. */
let drawnFor: string | null = null

/**
 * The page under this surface that the clone strokes on the canvas copied
 * from (`underKey`), or null where it holds none.
 *
 * What lets a surface with a clone stroke on it take up its kept pixels. They
 * were never taken: a clone stroke is a picture of the page under it, so until
 * that page had been composed again the surface was cleared, and once it had
 * been every stroke was replayed — on page 6 of the large-page test chapter,
 * 24 strokes, the retouching arrived 0.4 s after the page on every turn to it,
 * and most of that was the GPU drawing clone dabs it had drawn the last time.
 * Kept with the pixels (`keepPixels`), it says whether they were drawn from
 * the page that is under the surface now; where they were, they are still
 * right, and nothing is replayed.
 */
let drawnUnder: string | null = null

/**
 * The committed pixels, while somebody else's gesture is drawn over them — so
 * each frame can take the last frame's line off. Made on a gesture's first
 * frame, dropped when no hand is left.
 */
let backup: HTMLCanvasElement | null = null

/** Where the gestures were drawn last frame, in canvas pixels. */
let ghostRect: { x: number, y: number, w: number, h: number } | null = null

/**
 * Whether this hand's stroke on the canvas was cut into while it was being
 * made — a gesture's rectangle put back over part of it. Then the pixels are
 * not the log's, and the stroke landing rebuilds rather than keeping them.
 */
let interleaved = false

/**
 * A redraw asked for while this hand was down, to run when it lifts — `replay`
 * when what a clone copies from changed, which `redraw` would not see.
 */
let deferred: 'redraw' | 'replay' | null = null

/**
 * Hand this canvas's finished pixels to `kept.ts` and start from nothing.
 *
 * What moving off a surface does — another page, another size, the component
 * going away — so that coming back is a copy rather than a replay of every
 * stroke. A copy, since the canvas goes on to be the next surface; made from
 * `backup` where a gesture is drawn over the canvas, because that is the one
 * holding only the log.
 */
function stash () {
  const el = canvas.value

  if (el?.width && drawnFor && drawn.length) {
    const copy = document.createElement('canvas')

    copy.width = el.width
    copy.height = el.height
    copy.getContext('2d')?.drawImage(backup ?? el, 0, 0)
    keepPixels(drawnFor, copy, drawn, drawnUnder)
  }

  if (el?.width && (drawn.length || ghostRect)) {
    el.getContext('2d')?.clearRect(0, 0, el.width, el.height)
    touch()
  }

  drawn = []
  drawnFor = null
  drawnUnder = null
  dropBackup()
  interleaved = false
}

function dropBackup () {
  if (backup) backup.width = 0

  backup = null
  ghostRect = null
}

/**
 * Take up a kept picture of this surface, if it is still a picture of the log.
 *
 * Copied in rather than taken, so a log that turns out a moment later to be
 * shorter than it will be — the local rows land before the server's — does
 * not use the kept pixels up on a comparison that fails. "Still a picture of
 * the log" is the same prefix test `redraw` makes against its own drawing:
 * every kept row is where it was, and anything after them is new.
 */
function adopt (key: string, keys: string[], el: HTMLCanvasElement) {
  const hit = keptPixels(key)

  if (!hit || hit.pixels.width !== el.width || hit.pixels.height !== el.height) return
  if (hit.keys.length > keys.length || !hit.keys.every((was, at) => keys[at] === was)) return

  // Clone strokes copied from a page that is no longer the one under this
  // surface: the pixels are a picture of that page — see `drawnUnder`.
  if (hit.under !== null && hit.under !== underKey.value) return

  const c = el.getContext('2d')

  if (!c) return

  c.clearRect(0, 0, el.width, el.height)
  c.drawImage(hit.pixels, 0, 0)
  touch()
  drawn = [...hit.keys]
  drawnUnder = hit.under
}

const keyOf = (row: { clientId: string, seq: number }) => `${row.clientId}:${row.seq}`

/**
 * The row this hand has just let go of, whose pixels are already on the canvas.
 *
 * Set between the stroke ending and the log's watcher running, and read once —
 * see the top of `redraw`, which is the whole reason it exists.
 */
let laid: string | null = null

/**
 * Bring the committed pixels up to date, doing as little as the change allows.
 *
 * Almost every change to the log is one stroke arriving at the end of it — the
 * hand that just lifted, or a peer's. Rebuilding the whole log for that is the
 * stutter people feel when somebody else finishes a stroke: `replay` costs a
 * readback per segment, so redrawing everything ever painted on the surface
 * costs the sum of every stroke's length, every time any of them lands.
 *
 * So an append is treated as an append: the rows already on the canvas stay,
 * and only the new ones are laid over them, which makes the cost of a stroke
 * arriving the length of *that* stroke rather than of the whole page's
 * history.
 *
 * Anything else — an undo, a retraction, a fetch that reorders — falls back to
 * the full rebuild, because the pixels underneath genuinely changed and there
 * is no honest shortcut. Those are rare and deliberate; a stroke landing is
 * neither.
 */
function redraw () {
  const el = canvas.value
  const c = el?.getContext('2d')

  if (!el || !c || !session) return

  // Not while this hand is down. Replaying a row opens and closes a stroke on
  // the session, and the one being drawn is the session's open stroke: a
  // collaborator's mark landing mid-stroke ended this hand's, and it was never
  // saved. Done when the hand lifts instead — see `deferred`.
  if (painting.value) {
    deferred ??= 'redraw'

    return
  }

  const live = log.value.filter((row) => !row.retracted)
  const keys = live.map(keyOf)

  // Another surface than the one these pixels are of: keep them for it, and
  // start this one from what is kept for *it*, if anything is.
  if (drawnFor !== store.value) stash()

  drawnFor = store.value

  const mine = laid

  laid = null

  // The gestures off first, so what is left is the log — and this hand's
  // stroke, which putting their rectangle back may have cut into.
  if (ghostRect && (mine || painting.value)) interleaved = true

  clearGhosts()

  const clones = (rows: readonly { tool: string }[]) => rows.some((row) => row.tool === 'clone')

  // A clone stroke replays by copying from the page under it, so without that
  // the picture would be drawn short — and then kept, and adopted on the way
  // back. Nothing until `composeBelow` lands, which draws them; what was drawn
  // is another page's.
  //
  // Unless what is here, or kept, was drawn from the very page that is under
  // this surface now (`drawnUnder`): then it is right as it stands, and only
  // rows after it that copy from nothing need laying down.
  if (!underReady() && clones(live)) {
    if (store.value && !drawn.length) adopt(store.value, keys, el)

    const held = drawn.length > 0
      && drawnUnder !== null
      && drawnUnder === underKey.value
      && drawn.every((was, at) => keys[at] === was)
      && !clones(live.slice(drawn.length))

    if (held) {
      session.replayRows(live.slice(drawn.length))
      drawn = keys
      settle()

      return
    }

    c.clearRect(0, 0, el.width, el.height)
    drawn = []
    drawnUnder = null
    interleaved = false
    dropBackup()
    touch()

    return
  }

  // Nothing to draw.
  if (!keys.length) {
    if (drawn.length) {
      c.clearRect(0, 0, el.width, el.height)
      touch()
    }

    drawn = []
    drawnUnder = null
    interleaved = false
    settle()

    return
  }

  if (store.value && !drawn.length) adopt(store.value, keys, el)

  // A prefix match means nothing already drawn has changed or moved.
  const extends_ = keys.length >= drawn.length && drawn.every((was, at) => keys[at] === was)

  /*
   * The hand that just lifted has already been drawn — so keep the pixels
   * rather than making them a second time.
   *
   * A live stroke composites itself onto this canvas batch by batch as it is
   * drawn, and the row that follows it into the log describes exactly those
   * pixels: per-segment and gathered-then-committed are the same picture, which
   * is what `commit` is allowed to exist on. Replaying it costs the stroke over
   * again — every dab, and a `getImageData` over its whole bounding box, which
   * at page size is a fifth of a second for a wide sweep and is felt as the
   * page locking up the moment the button comes up. The eraser shows it worst
   * because an eraser is swept over an area rather than drawn along a line.
   *
   * Only when nothing was drawn over it or cut out of it while it was being
   * made (`interleaved`) — then the pixels are not the log's, and it falls
   * through to the honest rebuild. The first stroke on a bare surface counts
   * as well: nothing drawn is a prefix of anything, and requiring more sent
   * every first mark on a page through the rebuild — with the engine drawing
   * this canvas, all 78 MB of it uploaded again for a mark a few hundred
   * pixels wide.
   */
  if (mine && !interleaved && extends_ && keys.length === drawn.length + 1 && keys[keys.length - 1] === mine) {
    drawn = keys
    settle()

    return
  }

  if (extends_ && !(mine && interleaved)) {
    // Laid over what is there, so only the rows replayed are news to the
    // engine, and they say so themselves (`onDirty`).
    const added = live.slice(drawn.length)

    session.replayRows(added)

    // The page under a clone stroke laid down now is the one composed now;
    // one laid down earlier from another is `composeBelow`'s to put right.
    if (drawnUnder === null && clones(added)) drawnUnder = underBuilt
  } else {
    c.clearRect(0, 0, el.width, el.height)
    session.replayRows(live)
    touch()
    interleaved = false
    drawnUnder = clones(live) ? underBuilt : null
  }

  drawn = keys
  settle()
}

/**
 * Every stroke drawn again from nothing — what the page under a clone stroke
 * changing asks for.
 *
 * Not `redraw`: that is right to take kept pixels up when the log matches
 * them (`adopt`), and here the log has not moved — what a clone copied from
 * has. Kept pixels drawn from the old page would be taken for current.
 */
function replayAll () {
  const el = canvas.value
  const c = el?.getContext('2d')

  if (!el || !c || !session) return

  // Not while this hand is down, for the reason `redraw` gives.
  if (painting.value) {
    deferred = 'replay'

    return
  }

  if (drawnFor !== store.value) stash()

  drawnFor = store.value
  laid = null
  clearGhosts()

  const live = log.value.filter((row) => !row.retracted)

  c.clearRect(0, 0, el.width, el.height)
  session.replayRows(live)
  touch()

  drawn = live.map(keyOf)
  drawnUnder = underReady() && live.some((row) => row.tool === 'clone') ? underBuilt : null
  interleaved = false
  settle()
}

/**
 * The log has moved and the canvas holds it: a gesture still being drawn here
 * needs a fresh copy of what is under it, and then its frame.
 */
function settle () {
  dropBackup()
  ghosts()
}

/** Put back what the last frame's gestures drew over. */
function clearGhosts () {
  const el = canvas.value
  const c = el?.getContext('2d')
  const r = ghostRect

  ghostRect = null

  if (!el || !c || !r || !backup) return

  c.clearRect(r.x, r.y, r.w, r.h)
  c.drawImage(backup, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
  touch(r.x, r.y, r.w, r.h)
}

/** The rectangle a gesture's line covers, in canvas pixels, clamped to the canvas. */
function gestureRect (hand: { params: { size?: number }, points: number[] }, el: HTMLCanvasElement) {
  const points = hand.points

  if (points.length < 2) return null

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity

  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]!)
    x1 = Math.max(x1, points[i]!)
    y0 = Math.min(y0, points[i + 1]!)
    y1 = Math.max(y1, points[i + 1]!)
  }

  // Half the line either side, and a little over for the round caps' antialiasing.
  const pad = (hand.params.size ?? 24) / 2 + 2
  const x = Math.max(0, Math.floor(x0 - pad))
  const y = Math.max(0, Math.floor(y0 - pad))

  return {
    x,
    y,
    w: Math.max(0, Math.min(el.width, Math.ceil(x1 + pad)) - x),
    h: Math.max(0, Math.min(el.height, Math.ceil(y1 + pad)) - y),
  }
}

/**
 * The committed pixels, plus whatever hands are moving over them.
 *
 * Ghosts last, because a mark still being made is the newest thing on the page,
 * and unordered against the log because it has no `seq` yet — it is not a row,
 * it is a gesture.
 *
 * Drawn straight onto the canvas, over the log, and taken off again the next
 * frame by putting back the rectangle they covered from `backup`. The whole
 * canvas used to be cleared and redrawn from `settled` each frame, and with the
 * engine drawing this surface that was all 78 MB of it uploaded twenty times a
 * second while anybody drew; now a frame is the gesture's own rectangle.
 */
function ghosts () {
  const el = canvas.value
  const c = el?.getContext('2d')

  if (!el || !c || !session) return

  // Putting the rectangle back cuts into this hand's stroke, if one is being
  // made under it — see `interleaved`.
  if (ghostRect && painting.value) interleaved = true

  clearGhosts()

  const hands = Object.values(drawing.value)

  if (!hands.length) {
    dropBackup()

    return
  }

  if (!backup) {
    backup = document.createElement('canvas')
    backup.width = el.width
    backup.height = el.height
    backup.getContext('2d')?.drawImage(el, 0, 0)
  }

  // `preview`, not `replay`: a gesture is redrawn on every frame it moves, and
  // the honest replay costs a readback per segment — see its note. This is one
  // path, whatever the stroke's length.
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity

  for (const hand of hands) {
    session.preview(hand)

    const r = gestureRect(hand, el)

    if (!r || !r.w || !r.h) continue

    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }

  if (x1 > x0 && y1 > y0) {
    ghostRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    touch(x0, y0, x1 - x0, y1 - y0)
  }
}

/* ---------- pointer ---------- */

/**
 * Screen to page pixels, through whatever transform the stage is wearing —
 * measured on the hit area, which is where the canvas is laid out when it is
 * on the page and exactly where it would be when it is not.
 */
function toPage (event: PointerEvent): Point {
  const el = canvas.value!
  const box = host.value!.getBoundingClientRect()

  return {
    x: (event.clientX - box.left) * (el.width / box.width),
    y: (event.clientY - box.top) * (el.height / box.height),
  }
}

/*
 * The clone stamp's source lives in `useCloneStamp` rather than here, because
 * the *preview* of it has to be drawn above the whole layer stack — the same
 * reason the brush ring is not drawn here either; see `useBrushCursor`.
 *
 * Dropped when the tool changes and when the page does. A source is a point on
 * one scan, and carrying one across a page turn would copy from coordinates
 * that mean something else entirely on the page you turned to.
 */
const { anchor, pin, clear: forgetClone } = useCloneStamp()

watch([tool, () => props.page.id], forgetClone)

const painting = ref(false)

// What was put off while the hand was down — see `deferred`. After the log's
// own watcher, so a stroke that did land is in the log it redraws from.
watch(painting, (down) => {
  if (down || !deferred) return

  const what = deferred

  deferred = null
  nextTick(() => (what === 'replay' ? replayAll() : redraw()))
}, { flush: 'post' })

/**
 * Setting the brush on the page — the right button, dragged.
 *
 * The mask brush has had this since it was written and the paint brush never
 * did, while the bar's tooltip promised it for both: reaching for the size with
 * the brush in hand simply did nothing, and there was nothing to say why. One
 * definition now answers for both — see `useBrushGesture`.
 */
const adjust = useBrushGesture()

/** Screen pixels per page pixel, which is what a size drag is measured in. */
function shown (): number {
  const el = canvas.value

  if (!el?.width || !host.value) return 1

  return host.value.getBoundingClientRect().width / el.width
}

let warned = false

/**
 * The server would not take this canvas's strokes. Not an error the person has
 * to act on: the marks are on the page and in this browser's log, and go up the
 * next time there is a surface to put them on. Worth saying once, so that a
 * workspace that is silently read-only does not look like one that is saving.
 */
function refused () {
  if (warned) return

  warned = true
  toast.warning('Kept on this machine', {
    description: 'Your strokes are saved here but could not be shared — you may not have editor access.',
  })
}

/**
 * The colour under the pointer, into the swatch.
 *
 * Reached two ways for one act, so it is written once: the pipette tool, and
 * alt with the brush already in hand. It samples the page *flattened* rather
 * than the plate being painted on — what you point at is what you get, whichever
 * layer it happens to live on, which is the only reading that matches what the
 * eye is doing when somebody aims at a colour.
 */
function lift (at: Point): boolean {
  const picked = session?.sample(at.x, at.y)

  if (!picked) return false

  colour.value = picked

  return true
}

function onDown (event: PointerEvent) {
  if (!active.value) return

  // Before the button test below, which is what kept this brush from ever
  // having the gesture: it answers to the *right* button, and this handler
  // returned on anything but the left.
  if (adjust.begin(event)) {
    event.stopPropagation()

    return
  }

  if (event.button !== 0 || !session) return

  event.stopPropagation()

  const at = toPage(event)

  if (tool.value === 'picker') {
    // The pipette is a fetch, not a mode: colour in hand, back to painting.
    if (lift(at)) setTool('brush')

    return
  }

  /*
   * Alt is the sampling modifier on this canvas, and now it is that for the
   * brush as well: the clone stamp takes a source with it, the brush takes a
   * colour. Every editor a reader arrives from puts the pipette here, and
   * reaching for the tool in the bar to match one tone and then reaching back
   * is the sort of round trip that gets counted in hundreds over a page.
   *
   * Before the press does anything else, and returning rather than falling
   * through: a modifier that both lifted a colour and laid a mark would put
   * paint on the page every time somebody sampled one.
   */
  if (event.altKey && tool.value === 'brush') {
    lift(at)

    return
  }

  if (event.altKey && tool.value === 'clone') {
    // The page as it is now, so the preview shows what would be copied rather
    // than what the repair has since made of it — see `useCloneStamp.anchor`.
    anchor(at, session.flatten())

    return
  }

  /*
   * This press is what fixes the offset, if it is the first since the source
   * was anchored. From here the source travels with the brush at a constant
   * distance, which is what lets a repair be more than one stroke long — see
   * `useCloneStamp`, where the two moments are set out.
   */
  const opened = session.begin(at, {
    tool: tool.value as PaintToolId,
    size: size.value,
    softness: softness.value,
    colour: colour.value,
    cloneOffset: tool.value === 'clone' ? pin(at) : null,
  })

  if (!opened) {
    if (tool.value === 'clone') toast.info('Anchor a source first — alt-click where the clone should copy from.')

    return
  }

  painting.value = true

  // A fresh gesture, claiming the seq it will finally be written with — the
  // room is told that number as the stroke is drawn, so the drawing on
  // everybody else's canvas knows which row it is waiting for.
  beginGesture(nextSeq.value)

  // Synthetic pointers (and some pens) have no capturable id; losing capture
  // only costs the stroke ending at the edge, so it is not worth failing over.
  try {
    host.value?.setPointerCapture(event.pointerId)
  } catch { /* nothing to capture */ }
}

function onMove (event: PointerEvent) {
  // Hovering counts. The ring is how you aim, so it has to be there before the
  // press rather than appear with the first mark — and until it was, a brush
  // over the page looked like no tool at all.
  if (active.value) showCursor(toPage(event))

  // Before the stroke, and returning: a settings drag is not a mark, and the
  // ring above has already followed the pointer so the size can be seen as it
  // is chosen.
  if (adjust.move(event, shown())) return

  if (!painting.value || !session) return

  // Coalesced events carry the pen's real path between frames — without them a
  // fast stroke is a chain of chords.
  const moves = 'getCoalescedEvents' in event ? event.getCoalescedEvents() : []

  for (const move of moves.length ? moves : [event]) {
    session.lineTo(toPage(move))
  }

  broadcast(session.peek())
}

/**
 * How often to tell the room what this hand is doing.
 *
 * Pointer moves arrive per frame and faster with coalescing, and every one of
 * them would be a socket write carrying the whole stroke so far — which grows.
 * Twenty a second is past the point anybody can see the difference and an order
 * of magnitude less traffic. The gesture ending is sent regardless of the
 * clock, because that is the frame that has to be right.
 */
/**
 * Let go: the mark goes into this browser's log, and up to the server too if
 * there is one.
 *
 * Local first and unconditionally, because that is the copy the person can see
 * — the canvas is already showing it, and anything that could make it vanish
 * had better be an undo. The upload is an *addition*: it succeeds and the
 * stroke becomes everybody's, or it fails and the stroke stays yours, and
 * either way the page looks the same. It is queued rather than sent from here
 * — the first stroke after a pause goes at once, the ones that follow go
 * together — see `usePaintSync`.
 */
function onUp () {
  // A settings drag ends here too, and ends nothing else: there is no stroke to
  // close, no row to write and nobody watching to tell.
  if (adjust.end()) return

  if (!painting.value || !session) return

  painting.value = false

  // The last word on the gesture before it is torn down, so the drawing on
  // everybody else's canvas is whole rather than however far the throttle had
  // got — then that the hand has lifted, which is not the same as asking them
  // to rub it out. See `useLiveStrokes`.
  broadcast(session.peek(), true)
  endGesture()

  const draft = session.end()
  const key = store.value

  if (!draft || !key) return

  // The seq claimed when the gesture began, not one read now: the room was told
  // that number as the stroke was drawn, and the drawing on everybody else's
  // canvas is waiting for a row that carries it — see `retire`.
  const row = paint.add(key, { ...draft, seq: claiming.value || nextSeq.value, clientId: clientId.value })

  // Claimed before the log's watcher gets to run, and spent there: these pixels
  // are on the canvas already — see the top of `redraw`.
  laid = keyOf(row)

  // The surface may not exist yet — its first stroke is what makes it — and the
  // entry is pointed at it when the batch lands (`useUndo.renumber`).
  record({
    kind: 'stroke',
    strokeId: row.id,
    surfaceId: surfaceId.value ?? 0,
    seq: row.seq,
    clientId: row.clientId,
    pageId: pageRow.value ?? 0,
    pageName: props.page.name,
  })

  handOver()
}

/* ---------- wiring ---------- */

// Two sources, not one getter returning an array: that getter made a new array
// every time it ran, and it ran on every page turn, so a same-sized page was
// prepared twice — a second session, the drawn pixels thrown away, and every
// stroke replayed again. On page 19 of the istani chapter that was 0.7 s a turn.
//
// And on `needed`: a surface is given its pixels when something arrives to put
// there, and gives them back when nothing is left.
watch([() => props.page.scan?.width, () => props.page.scan?.height, needed], prepare)
// The page under this surface follows the scan, not its size — see `under` —
// and whatever it is made of.
watch([underKey, needsUnder], askBelow, { immediate: true })

// Undo, redo, and a collaborator's hand: the version moves, what is new on the
// page is read, and the canvas is rebuilt from what it says.
//
// Only a version moving on the same surface: the surface arriving — read with
// the page, or made by its first stroke — moves this watcher's value as well,
// and is not a change to anything already drawn.
watch(
  () => [surfaceId.value, surfaceId.value ? versions.value[surfaceId.value] ?? 0 : 0] as const,
  ([id, version], [was, wasVersion]) => {
    if (id && id === was && version !== wasVersion && pageRow.value) sync.refresh(workspace.value, pageRow.value)
  },
)

// The one redraw. Both logs feed `log`, so whatever moved — a fetch, a fresh
// mark, an undo on either side — the canvas is rebuilt from the merged order
// and there is no path that repaints from only half of it.
//
// `retire` first: the arriving row is what a drawing was waiting for, and
// taking it off before the repaint is what makes the handover invisible rather
// than a frame with both on the page.
watch(log, () => {
  retire(log.value)
  // What a watched clone stroke copies from has just changed, and this is the
  // only thing that can change it — see `PaintSession.ghostSource`, which is
  // cached precisely so that the live frames in between do not rebuild it.
  session?.dropGhostSource()
  redraw()
}, { flush: 'post' })

// This browser's own strokes, read back for whichever page is open. Awaited
// before the first redraw so a reload does not flash a blank plate over paint
// that is about to appear.
watch(store, async (key) => { if (key) await paint.load(key) }, { immediate: true })

// And handed over the moment there is somewhere to hand them to — a page the
// workspace knows, and the right to add to it: sharing a workspace that was
// painted in alone should share the painting. On the log's length as well, so
// strokes read back off the disk after the page was already known go too.
//
// By the page's row id rather than the row: `rowOfPage` answers with an element
// of the page list, which is a new array every time the workspace record is
// fetched again — every collaborator's page notice.
watch([store, pageRow, writable, () => paint.on(store.value).length], handOver)

onMounted(async () => {
  place()
  if (canvas.value) holdSurface(surfaceName.value, canvas.value)

  await prepare()

  // A log already in memory moves none of the watcher's sources on the way in.
  handOver()
})

onScopeDispose(() => {
  clearTimeout(composeSoon)
  composing++
  dropUnder()

  if (canvas.value) dropSurface(surfaceName.value, canvas.value)

  // A page turn that remounts this canvas keeps what it had drawn — see `stash`.
  stash()
})
</script>

<template>
  <!--
    `pointer-events-auto` said outright, because the plate around this one is
    `pointer-events-none` — a plate is a picture and must not shadow what is
    under it — so a child that really is a control has to opt back in. Without
    it the brush was unreachable: the press landed on whichever plate happened
    to be topmost and never got here.

    `cursor-none` while it is out, because the ring is the cursor. An arrow
    inside a circle is two cursors disagreeing about where the mark will land.

    And *not* smoothed, which is a reversal worth recording because the
    argument against it is a good one.

    `image-rendering` is inherited, and the sheet asks for `pixelated` from 1:1
    upwards — rightly, because a screentone interpolated is a screentone turned
    to mush, and enlarging the scan is how you check one. This plate used to
    exempt itself on the grounds that a feather is a ramp of two or three levels
    per pixel, and nearest-neighbour turns that into a stair of flat blocks at
    exactly the zoom somebody is inspecting softness at. All true.

    What it missed is that the exemption costs the other ninety per cent of the
    time. The plate holds the *same resolution as the scan* — both 1128×1600 on
    the page this was measured on — so smoothing does not enlarge the mark, it
    interpolates pixels that are already there, spreading a full-hardness edge
    across six screen pixels while the artwork beside it stays crisp. A hard
    brush looked soft, and worse, looked soft *against* something sharp, which
    reads as the paint being lower quality than the page rather than as a filter
    choice.

    So both are drawn the same way and the mismatch is gone. The feather does
    stair-step past a few hundred per cent; that is the price, it was chosen
    knowingly, and it is one attribute to put back.
  -->
  <div
    ref="host"
    class="absolute inset-0 size-full"
    :class="active ? 'pointer-events-auto cursor-none touch-none' : 'pointer-events-none'"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerleave="hideCursor"
    @contextmenu.prevent
  />
</template>
