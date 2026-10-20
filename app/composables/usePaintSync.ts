/**
 * A page's paint between this browser and the server: read a page at a time,
 * sent a run at a time.
 *
 * It lived inside `CanvasPaint`, one copy per canvas, and every part of it cost
 * a request per something. Turning to a page made three before anything was
 * drawn — `layers/ensure` and `surfaces` to *make* the surface, whether or not
 * anybody was going to paint on it, then its log — so every page anybody
 * looked at left a founded stack and an empty surface behind. Every stroke was
 * its own POST, and every POST sent each collaborator back for the surface's
 * whole log, twice (the canvas heard the notice, and so did the version bump
 * `useLiveSync` makes of it): K strokes were K requests out and 2K whole-log
 * reads in on every other tab.
 *
 * Now:
 *
 * - **A page turn is one read** — `useLayerSync.pull` asks for the stack and
 *   the paint together (`readPaint`), and every canvas on the page takes its
 *   log from what that read filed here. Nothing is made for being looked at;
 *   a page nobody has painted comes back with no surfaces.
 * - **A stroke is queued, and a run is one request** (`upload`). The first
 *   stroke after a quiet spell goes at once, so a single mark reaches everyone
 *   as fast as it did; strokes laid while a request is in the air, or within
 *   `SPACING` of the last, wait and go together. The first stroke on a surface
 *   is what makes it (`paint.appendMany`).
 * - **A collaborator's run is one read, of what is new** (`refreshPaint`).
 *   Notices about a page are gathered for `GATHER` and answered with a read
 *   past the page's cursor — see `utils/paint/remote.ts` for why that cursor
 *   cannot skip a mark.
 *
 * ## Nothing is let go of until the server has it
 *
 * The queue *is* the local log. A stroke is laid in `usePaintCache` first, as
 * it always was, and a batch sends whatever that log holds that is not already
 * in the air; the local copy is forgotten only once the answer names the
 * stroke as filed, with the same `retracted` it has here now. A failed request
 * leaves every stroke where it was and is tried again, backing off; a refusal
 * (a viewer, a page that is gone) stops asking until the canvas asks again,
 * and the strokes stay on this machine either way. A stroke undone while its
 * batch was in the air is sent again with the new word rather than forgotten
 * as the server had it — see `strokeBatchSchema` on why the server takes it.
 *
 * Module state rather than `useState`: a stroke log is thousands of numbers
 * per mark, and in development every `useState` write walks the whole Nuxt
 * payload — see the note in `useBrushCursor`. None of this is rendered from a
 * payload, and none of it would survive a server render anyway.
 */
import { usePaintCache } from './usePaintCache'
import { useUndo } from './useUndo'

import type { PlateId } from '#shared/utils/layers'
import type { LocalStroke } from './usePaintCache'
import type { PageLog, RemotePagePaint, SurfaceLog } from '~/utils/paint/remote'
import type { Stroke } from '~~/server/database'

import { MAX_BATCH_POINTS, MAX_BATCH_STROKES } from '#shared/schemas/paint'
import { mergeLanded, mergeRead } from '~/utils/paint/remote'

/**
 * How long notices about one page are gathered before it is read again.
 *
 * Short: it only has to catch a burst — one batch touching the retouching and a
 * sheet is two notices, and the version bump `useLiveSync` makes of each is two
 * more — not to smooth anybody's painting.
 */
const GATHER = 120

/**
 * The least time between two batches.
 *
 * The first stroke after a quiet spell goes at once; this is how long the ones
 * after it wait for company. Long enough that a burst of marks shares a
 * request, short enough that a collaborator sees a run arrive as it is made.
 */
const SPACING = 250

/** The longest a batch that failed, or found its sheet not synced yet, waits to try again. */
const PATIENCE = 30_000

/** Where one local log's strokes go. */
export interface PaintDestination {
  workspace: string
  /** The local log — `<scan hash>:<surface>`, as `usePaintCache` files it. */
  store: string
  /** The server's page row. */
  pageId: number
  /** The surface's name on the page. */
  key: string
  /** The plate whose row files the surface — the retouching's `clean`. */
  plate: PlateId | null
  /** Or the sheet's stack id, for a sheet. */
  layer: string | null
  /** Told when the server refuses the strokes — a viewer, a page that is gone. */
  refused?: () => void
}

/* ---------- what is held ---------- */

/** Every page's paint as last read, by the server's page row. */
const held = shallowRef<Record<number, PageLog>>({})

/** Which workspace `held` is about. */
let holding = ''

/** Per page, the start of the last read applied — see `readPaint`. */
const applied = new Map<number, number>()

let clock = 0

/** One surface of a page, as held — its row id and its marks. */
function surfaceOf (pageId: number | null, key: string): SurfaceLog | null {
  return pageId ? held.value[pageId]?.surfaces[key] ?? null : null
}

/**
 * Read a page's paint, and the stack with it when `layers` is asked for.
 *
 * Filed under the page it is about, whichever page is on screen by the time it
 * lands — an answer about page one is still true of page one. Dropped when a
 * read of the same page that *started* later has already been applied: that
 * one saw a later moment, and folding the older one over it would put back a
 * state that no longer exists.
 */
export async function readPaint<Layer = unknown> (
  workspace: string,
  pageId: number,
  options: { layers?: boolean, after?: number } = {},
): Promise<RemotePagePaint<Layer> | null> {
  if (workspace !== holding) {
    // Another workspace's pages are row ids in another chapter; nothing held
    // about them is about anything open now.
    holding = workspace
    held.value = {}
    applied.clear()
  }

  const started = ++clock
  const after = options.after ?? 0

  const answer = await $fetch<RemotePagePaint<Layer>>(`/api/workspaces/${workspace}/pages/${pageId}/paint`, {
    query: { after, layers: options.layers ? 1 : 0 },
  }).catch((error: unknown) => {
    console.warn('[kemolate] paint not read:', error)

    return null
  })

  if (!answer || workspace !== holding || (applied.get(pageId) ?? 0) > started) return answer

  applied.set(pageId, started)

  const { log, agrees } = mergeRead(held.value[pageId], answer, after)

  held.value = { ...held.value, [pageId]: log }

  // What is held and what the server has do not add up. Read the page whole
  // rather than go on drawing a surface that may be missing a mark.
  if (!agrees) readPaint(workspace, pageId).catch(() => {})

  return answer
}

/** Pages with notices waiting, reads in the air, and reads asked for while one was. */
const gathering = new Map<number, ReturnType<typeof setTimeout>>()
const reading = new Set<number>()
const again = new Set<number>()

/**
 * Somebody painted on this page, or undid something there: read what is new.
 *
 * Gathered — every notice within `GATHER` of the first is the same read — and
 * one at a time per page, with one more after it if anything arrived while it
 * was in the air. A page nothing has been read for yet is read whole.
 */
export function refreshPaint (workspace: string, pageId: number) {
  if (workspace !== holding || gathering.has(pageId)) return

  gathering.set(pageId, setTimeout(() => {
    gathering.delete(pageId)

    if (reading.has(pageId)) {
      again.add(pageId)

      return
    }

    reading.add(pageId)

    readPaint(workspace, pageId, { after: held.value[pageId]?.cursor ?? 0 })
      .catch(() => {})
      .finally(() => {
        reading.delete(pageId)

        if (again.delete(pageId)) refreshPaint(workspace, pageId)
      })
  }, GATHER))
}

/* ---------- what is sent ---------- */

const destinations = new Map<string, PaintDestination>()

/** Local ids in a request right now — not sent twice at once. */
const flying = new Set<number>()

/** Local logs the server refused: kept, and not asked about again until the canvas asks. */
const parked = new Set<string>()

/**
 * Local logs waiting on a sheet whose stack row has not synced, by when to ask
 * again — and how many times they have been told to wait. Per log, so that one
 * sheet waiting does not hold back the strokes on every other surface.
 */
const stalled = new Map<string, { until: number, times: number }>()

let timer: ReturnType<typeof setTimeout> | null = null
let sending = false
let lastSent = -Infinity

/** How long the whole queue waits after a request that did not arrive, and until when. */
let backoff = 0
let backoffUntil = 0

/** The next wait in a doubling series that starts at a second and stops at `PATIENCE`. */
const longer = (was: number) => Math.min(Math.max(1000, was * 2), PATIENCE)

/**
 * What the sending needs from the rest of the app, taken from the canvas that
 * set up last: the local log, and the undo history's renumbering. Both are
 * the same shared state whoever hands them over.
 */
let deps: {
  paint: ReturnType<typeof usePaintCache>
  renumber: (from: number, to: number, surfaceId: number) => void
} | null = null

/**
 * When the next batch could have something to carry — now, or when a stalled
 * log may ask again — or null when every log is empty, in the air or refused.
 */
function due (): number | null {
  if (!deps) return null

  let next: number | null = null

  for (const [store] of destinations) {
    if (parked.has(store) || !deps.paint.on(store).some((row) => !flying.has(row.id))) continue

    const at = stalled.get(store)?.until ?? 0

    next = next === null ? at : Math.min(next, at)
  }

  return next
}

/** When the batch the timer is holding for goes. */
let timerAt = 0

/**
 * A batch at `at` at the earliest, and never sooner than `SPACING` after the
 * last. An earlier ask brings a later timer forward — a stroke laid while a
 * stalled sheet waits out its thirty seconds should not wait with it.
 */
function soon (at = 0) {
  if (sending) return

  const when = Math.max(Date.now(), at, lastSent + SPACING)

  if (timer && timerAt <= when) return
  if (timer) clearTimeout(timer)

  timerAt = when
  timer = setTimeout(() => {
    timer = null
    send().catch(() => {})
  }, when - Date.now())
}

/**
 * Send this log's strokes up, and keep sending until the server has them.
 *
 * Called when a stroke is laid, and when a canvas arrives at a page whose log
 * still holds marks from before — a workspace painted in alone and then
 * shared, a batch that failed on the way out of the last session. Asking again
 * is also what takes a refused log off the shelf.
 */
function upload (destination: PaintDestination) {
  destinations.set(destination.store, destination)
  parked.delete(destination.store)
  soon(backoffUntil)
}

/**
 * One batch: every log's strokes that are not in the air, up to what a request
 * may carry, for one workspace.
 */
async function send () {
  if (sending || !deps) return

  const { paint, renumber } = deps

  let workspace: string | null = null
  let strokes = 0
  let points = 0

  const groups: { destination: PaintDestination, rows: LocalStroke[] }[] = []

  const now = Date.now()

  for (const [store, destination] of destinations) {
    if (parked.has(store) || (stalled.get(store)?.until ?? 0) > now) continue

    const rows = paint.on(store).filter((row) => !flying.has(row.id))

    if (!rows.length) {
      // Everything it had has landed: nothing more to send from it until the
      // canvas asks again.
      if (!paint.on(store).some((row) => flying.has(row.id))) destinations.delete(store)

      continue
    }

    if (workspace && destination.workspace !== workspace) continue

    workspace ??= destination.workspace

    const taken: LocalStroke[] = []

    for (const row of rows) {
      if (strokes >= MAX_BATCH_STROKES || (strokes && points + row.points.length > MAX_BATCH_POINTS)) break

      taken.push(row)
      strokes++
      points += row.points.length
    }

    if (taken.length) groups.push({ destination, rows: taken })
  }

  if (!workspace || !groups.length) {
    // Only stalled logs have anything, and not yet: come back when they may.
    const next = due()

    if (next !== null) soon(next)

    return
  }

  for (const { rows } of groups) for (const row of rows) flying.add(row.id)

  sending = true
  lastSent = Date.now()

  try {
    const answer = await $fetch<{ surfaces: SurfaceAnswer[] }>(`/api/workspaces/${workspace}/strokes`, {
      method: 'POST',
      body: {
        surfaces: groups.map(({ destination, rows }) => ({
          pageId: destination.pageId,
          key: destination.key,
          plate: destination.layer ? null : destination.plate,
          layer: destination.layer,
          strokes: rows.map(({ id: _local, ...row }) => row),
        })),
      },
      headers: peerHeader(workspace),
    })

    backoff = 0
    backoffUntil = 0

    groups.forEach(({ destination, rows }, at) => {
      const reply = answer.surfaces[at]

      if (!reply || reply.status === 'gone') {
        // Not this workspace's page any more. Kept here, and not asked about
        // again until the canvas says otherwise.
        parked.add(destination.store)
        destination.refused?.()

        return
      }

      if (reply.status !== 'kept') {
        // A sheet whose stack row has not synced yet — it will have in a
        // moment, and if it does not, this asks less and less often.
        const times = (stalled.get(destination.store)?.times ?? 0) + 1

        stalled.set(destination.store, { until: Date.now() + longer(1000 * 2 ** (times - 2)), times })

        return
      }

      stalled.delete(destination.store)
      land(destination, reply.surfaceId, rows, reply.strokes, paint, renumber)
    })
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode ?? 0

    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      // Refused, and asking again will not change that: a viewer, a workspace
      // that is not theirs. The strokes stay on this machine, as they always
      // have when there is nowhere to send them.
      for (const { destination } of groups) {
        parked.add(destination.store)
        destination.refused?.()
      }

      console.warn('[kemolate] strokes not shared:', error)
    } else {
      // The network, or the server having a moment: every stroke is still in
      // the local log, and goes again.
      backoff = longer(backoff)
      backoffUntil = Date.now() + backoff
    }
  } finally {
    for (const { rows } of groups) for (const row of rows) flying.delete(row.id)

    sending = false

    const next = due()

    if (next !== null) soon(Math.max(next, backoffUntil))
  }
}

/** One surface's share of an answer, as `paint.appendMany` gives it. */
type SurfaceAnswer =
  | { pageId: number, key: string, status: 'kept', surfaceId: number, strokes: Stroke[] }
  | { pageId: number, key: string, status: 'waiting' | 'gone' }

/**
 * A surface's strokes, filed: the server's rows on the page, the local copies
 * let go of, and the undo history pointed at the rows that replaced them.
 *
 * All in one tick, so the canvas never draws a frame with the mark in both
 * logs or in neither. A stroke whose `retracted` moved while the batch was in
 * the air keeps its local copy and goes again — forgetting it would leave the
 * server's copy saying what this browser no longer does.
 */
function land (
  destination: PaintDestination,
  surfaceId: number,
  sent: LocalStroke[],
  filed: Stroke[],
  paint: ReturnType<typeof usePaintCache>,
  renumber: (from: number, to: number, surfaceId: number) => void,
) {
  const byName = new Map(filed.map((row) => [`${row.clientId}:${row.seq}`, row]))
  const now = new Map(paint.on(destination.store).map((row) => [row.id, row]))

  const landed: Stroke[] = []
  const letGo: number[] = []
  const renamed: [number, number][] = []

  for (const row of sent) {
    const stored = byName.get(`${row.clientId}:${row.seq}`)
    const current = now.get(row.id)

    if (!stored) continue

    if (current && current.retracted !== stored.retracted) continue

    landed.push(stored)
    renamed.push([row.id, stored.id])

    if (current) letGo.push(row.id)
  }

  if (destination.workspace === holding && landed.length) {
    held.value = { ...held.value, [destination.pageId]: mergeLanded(held.value[destination.pageId], destination.key, surfaceId, landed) }
  }

  if (letGo.length) paint.forget(destination.store, letGo)

  for (const [from, to] of renamed) renumber(from, to, surfaceId)
}

/** Send what is waiting now, rather than when the spacing says — the tab is going out of sight. */
function flushNow () {
  if (!timer || sending) return

  clearTimeout(timer)
  timer = null
  send().catch(() => {})
}

let listening = false

/**
 * The canvas's handle on all of this — and the one place the sending is given
 * what it needs, so that it can run from a timer long after the canvas that
 * queued a stroke has moved on to another page.
 */
export function usePaintSync () {
  deps = { paint: usePaintCache(), renumber: useUndo().renumber }

  if (import.meta.client && !listening) {
    listening = true

    // A tab going out of sight may not come back; what it painted should not
    // wait for the spacing. The strokes are in the local log regardless — this
    // only saves them the trip back next session.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow()
    })
  }

  return { held, surfaceOf, upload, refresh: refreshPaint }
}

/** Everything back to nothing — for tests, which share this module across cases. */
export function forgetPaintSync () {
  for (const pending of gathering.values()) clearTimeout(pending)
  if (timer) clearTimeout(timer)

  held.value = {}
  holding = ''
  applied.clear()
  gathering.clear()
  reading.clear()
  again.clear()
  destinations.clear()
  flying.clear()
  parked.clear()
  stalled.clear()
  timer = null
  sending = false
  lastSent = -Infinity
  backoff = 0
  backoffUntil = 0
}
