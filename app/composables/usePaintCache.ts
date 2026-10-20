/**
 * Retouching, kept in this browser.
 *
 * The same argument as `useBlockCache`, and it is the codebase's own: sharing
 * is a thing you do when you want other people in, and it is not a reasonable
 * price for your own work existing. Everything else about an open chapter
 * already survives without a server — the scans are in the browser's storage,
 * the reading is cached, a cleaned balloon is a file in the patch cache — and
 * paint was the last thing that did not. A brush that refuses to mark until the
 * workspace has been shared is a brush that does not work, whatever the toast
 * explaining it says.
 *
 * So a stroke is laid here first and always. The server copy, when there is
 * one, is the *shared* copy — what other people replay — and it is written
 * alongside rather than instead.
 *
 * ## Keyed by the scan, not by the workspace
 *
 * Filed under the hash of the page's bytes, exactly as blocks and patches are.
 * Re-importing the same chapter finds the retouching again, and a page whose
 * bytes changed is a different page and rightly starts blank.
 *
 * ## Ids
 *
 * Negative, and counted down. A row here has no server id and may never get
 * one, but undo names strokes by id and cannot hold two kinds of name. The sign
 * *is* the distinction: anything below zero lives in this file, anything above
 * it is a row on the server, and no arithmetic is needed to tell them apart.
 *
 * ## Rows are never proxied
 *
 * Every row is `markRaw`, and a row is replaced rather than edited. The log is
 * reactive where it has to be — which rows a surface holds — and nowhere else,
 * because the rest is thousands of numbers a mark. Proxied, every save walked
 * all of them through Vue's traps to copy them out (`JSON.parse(JSON.stringify
 * (…))`, since structured clone refuses a proxy) — on a surface of 400 strokes,
 * 55 ms after every stroke at 200 points a stroke and 136 ms at 500, against 5
 * and 13 ms for the same write of raw rows. In development the Nuxt payload
 * watcher walked every point as well, on every `useState` write anywhere in the
 * app; it stops at a raw row.
 *
 * What is left is still the whole surface per save — IndexedDB writes a value
 * whole — so a local page painted for hours still pays for its length, at a
 * tenth of the old rate. A save proportional to the stroke would mean a record
 * per stroke, which is a change of layout that everything reading these keys
 * (`gather.ts`, the move to local, project files) would have to learn.
 */
import type { StrokeParams } from '~~/server/database'

import { idbKey } from '~/utils/idbKeys'

/** A stroke as this browser holds it — the server's shape, minus the server. */
export interface LocalStroke {
  /** Negative. See the note on ids above. */
  id: number
  seq: number
  clientId: string
  tool: string
  composite: string | null
  params: StrokeParams
  points: number[]
  x: number
  y: number
  w: number
  h: number
  retracted: boolean
}

/** What is written per page. Versioned so a later shape can be recognised. */
interface CachedPaint {
  v: 1
  strokes: LocalStroke[]
}

const VERSION = 1

/** The name a page's retouching is filed under. */
const keyOf = (hash: string) => idbKey.paint(hash)

/**
 * How long a page has to sit still before its strokes are written.
 *
 * Short, because the write is local and nothing is waiting on it — but not
 * nought, because a fast hand lays several marks a second and each of them
 * would otherwise be a serialisation of the whole page's log.
 */
const SETTLE = 250

/**
 * The next local id, counting down, shared across every page.
 *
 * Module scope rather than state: it is a counter, nobody renders it, and two
 * pages minting the same negative number would give undo two strokes with one
 * name.
 */
let minted = -1

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * The workspace in the address, for telling this browser's other tabs.
 *
 * From the address rather than the router: a save runs off a timer, where there
 * is no component to ask, and the address is the one answer that is always
 * right about which chapter the strokes were drawn in.
 */
const workspaceNow = () => (import.meta.client ? /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? '' : '')

/**
 * A row as this file keeps it: never proxied, never edited — see the header.
 * Every way a row comes to be here goes through this.
 */
const unwatched = (row: LocalStroke): LocalStroke => markRaw(row)

/** What can differ between two copies of one log: which rows, and which are taken back. */
const signature = (rows: readonly LocalStroke[]) => rows.map((row) => `${row.id}${row.retracted ? '-' : '+'}`).join(',')

export function usePaintCache () {
  /** Every local stroke on screen, by the hash of the page it is on. */
  const strokes = useState<Record<string, LocalStroke[]>>('paint-local', () => ({}))

  /** Bumped on every change, so a canvas can watch one thing and redraw. */
  const revision = useState('paint-local-revision', () => 0)

  const on = (hash: string | null | undefined) => (hash ? strokes.value[hash] ?? [] : [])

  function touch (hash: string) {
    revision.value++

    const held = timers.get(hash)

    if (held) clearTimeout(held)

    timers.set(hash, setTimeout(() => {
      timers.delete(hash)
      save(hash).catch(() => {})
    }, SETTLE))
  }

  /** Read a page's retouching back off the disk, if this browser has any. */
  async function load (hash: string): Promise<LocalStroke[]> {
    // Already in hand — a second read would replace live strokes with an older
    // snapshot of themselves, which is how a mark drawn during a page turn
    // would disappear.
    if (strokes.value[hash]) return strokes.value[hash]!

    const held = await idb.get<CachedPaint>(keyOf(hash)).catch(() => null)
    const kept = held?.v === VERSION ? held.strokes.map(unwatched) : []

    /**
     * Drop the counter below everything just read back.
     *
     * It is module state and starts at −1 on every page load, while the ids on
     * disk were minted by earlier ones — so without this the first stroke after
     * a reload is handed an id a stored stroke already has. Undo names strokes
     * by id, so one Cmd+Z then took back both of them, and the older mark
     * vanished from a page nobody had touched.
     */
    for (const row of kept) minted = Math.min(minted, row.id - 1)

    strokes.value = { ...strokes.value, [hash]: kept }

    return kept
  }

  async function save (hash: string): Promise<void> {
    const kept = strokes.value[hash]

    if (!kept) return

    // An empty log is worth removing rather than writing: a page nobody has
    // retouched should cost nothing, and undoing back to nothing should leave
    // no trace behind.
    if (!kept.length) {
      await idb.del(keyOf(hash)).catch(() => {})
      announceLocal(workspaceNow(), 'paint', hash)

      return
    }

    /**
     * The list unwrapped, and nothing else to do: the rows in it were never
     * proxies — see the header.
     *
     * Structured clone, which is how IndexedDB stores, refuses a proxy outright,
     * and handing the reactive list straight in once threw `DataCloneError` on
     * every write — which the catch below turned into silence: painting looked
     * saved for the whole session and came back empty after a reload. The fix
     * then was a JSON round trip through every proxy of every point, and that
     * walk was the cost of a save.
     */
    await idb.set(keyOf(hash), { v: VERSION, strokes: toRaw(kept) } satisfies CachedPaint)
      .then(() => announceLocal(workspaceNow(), 'paint', hash))
      .catch((error: unknown) => {
        // Not fatal — the strokes are still on the page and still in memory —
        // but never silent again.
        console.warn('[kemolate] retouching not kept:', error)
      })
  }

  /**
   * Read one surface's log again, because another tab on this chapter wrote
   * it — see `hearOtherTabs`.
   *
   * Only a surface this tab already holds (nothing else here is looking at
   * the rest), and not while a save of this tab's own is waiting: that one is
   * newer, and it will be announced in turn. The counter moves below every id
   * read, as `load` does, so the next mark here is not given one of the other
   * tab's ids.
   */
  async function reload (key: string): Promise<void> {
    if (timers.has(key) || !strokes.value[key]) return

    const held = await idb.get<CachedPaint>(keyOf(key)).catch(() => null)

    if (timers.has(key) || !strokes.value[key]) return

    const kept = held?.v === VERSION ? held.strokes.map(unwatched) : []

    for (const row of kept) minted = Math.min(minted, row.id - 1)

    // Compared by what can differ between two copies of a log — which rows,
    // and which of them are taken back — rather than by writing both out. A
    // row's path never changes after it is laid.
    if (signature(strokes.value[key] ?? []) === signature(kept)) return

    strokes.value = { ...strokes.value, [key]: kept }
    revision.value++
  }

  /**
   * Take up the strokes this browser's other tabs lay down, on a local
   * workspace — retouching and mask corrections alike, since both are logs
   * here. Called once, by the workspace page.
   *
   * A local workspace only: a cloud one hears strokes from the server, and its
   * local logs are only the marks not yet sent — reading another tab's of
   * those would draw them twice once they arrive from the server as well.
   *
   * Without it two tabs each drew from the log they opened with, and whichever
   * saved last wrote its log over the other's: a mark made in one tab was gone
   * after a reload if the other tab painted anything afterwards.
   */
  function hearOtherTabs (isLocal: () => boolean) {
    onLocalChange((room, scope, key) => {
      if (scope === 'paint' && key && room === workspaceNow() && isLocal()) reload(key).catch(() => {})
    })
  }

  /** Lay a stroke down, and hand back the row as it was filed. */
  function add (hash: string, draft: Omit<LocalStroke, 'id' | 'retracted'>): LocalStroke {
    const row = unwatched({ ...draft, id: minted--, retracted: false })

    strokes.value = { ...strokes.value, [hash]: [...on(hash), row] }
    touch(hash)

    return row
  }

  /**
   * Take a stroke back, or put it back — undo's half of the bargain.
   *
   * Retracted rather than removed, exactly as the server does it: the row keeps
   * its place in the paint order, so redo puts the mark back *under* whatever
   * was painted over it since. False when no such stroke is held here, which is
   * how the caller knows to ask the server instead.
   */
  function retract (id: number, retracted: boolean): boolean {
    for (const [hash, kept] of Object.entries(strokes.value)) {
      const found = kept.find((row) => row.id === id)

      if (!found) continue

      strokes.value = {
        ...strokes.value,
        [hash]: kept.map((row) => (row.id === id ? unwatched({ ...row, retracted }) : row)),
      }
      touch(hash)

      return true
    }

    return false
  }

  /**
   * Lay down a whole log at once, as an import does.
   *
   * Every mark is given a fresh local id on the way in, which is the one thing
   * this must do and the reason it is not simply a `set`. Ids in a project file
   * are deliberately absent — see `ProjectStroke` — and an id kept from
   * anywhere else would collide with the counter this browser is minting from,
   * which is how one Cmd+Z takes back two strokes.
   *
   * `seq` and `clientId` are kept exactly as they arrived: they are the paint
   * order, and a repaint that loses it is a different picture. Written straight
   * through rather than added one at a time, so a page of four hundred marks
   * costs one serialisation instead of four hundred.
   */
  async function seed (hash: string, surface: string, laid: Omit<LocalStroke, 'id'>[]): Promise<void> {
    if (!laid.length) return

    const key = `${hash}:${surface}`
    const rows = laid.map((row) => unwatched({ ...row, id: minted-- }))

    strokes.value = { ...strokes.value, [key]: [...on(key), ...rows] }

    await idb.set(keyOf(key), { v: VERSION, strokes: toRaw(strokes.value[key]!) } satisfies CachedPaint)

    announceLocal(workspaceNow(), 'paint', key)
    revision.value++
  }

  /**
   * Let a surface's whole log go — a sheet deleted from the stack.
   *
   * Emptied and saved rather than deleted here, so the ordinary save does the
   * rest: an empty log removes its record (`save`) and tells this browser's
   * other tabs, and a save still waiting for the surface is folded into this
   * one rather than writing the strokes back a moment later. Deleting a sheet
   * used to leave this record behind for good — on a cloud workspace the
   * server's copy goes with the layer (`surfaces.layer_id` cascades), and
   * only the browser's was kept, for a surface nothing could open again.
   */
  function drop (key: string): void {
    strokes.value = { ...strokes.value, [key]: [] }
    touch(key)
  }

  /** Let go of strokes that have made it to the server — see `Paint`'s flush. */
  function forget (hash: string, ids: number[]): void {
    const gone = new Set(ids)

    strokes.value = { ...strokes.value, [hash]: on(hash).filter((row) => !gone.has(row.id)) }
    touch(hash)
  }

  return { strokes, revision, on, load, reload, add, seed, retract, forget, drop, hearOtherTabs }
}
