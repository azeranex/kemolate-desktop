/**
 * A person's corrections to a block's mask, kept.
 *
 * The automatic mask is recomputed from the scan every time it is wanted —
 * see `utils/ocr/mask.ts` — so it is never stored. These are the other half:
 * the strokes somebody drew to say "this is lettering too" or "leave that
 * alone", which cannot be derived from anything and are therefore the only
 * part of a cleaning worth writing down.
 *
 * ## Why they are strokes and not a bitmap
 *
 * They ride the `strokes` table, unchanged. That buys three things at once,
 * and the third is the one that makes it the only sensible choice:
 *
 * - appending commutes, so two people correcting two balloons both survive;
 * - a retraction is an undo, which the log already knows how to do;
 * - a polyline can be rasterised at whatever size the tile is worked at.
 *
 * That last is not a nicety. `clean.ts` scales small balloons up to a floor
 * and large ones down to a ceiling, so a stored raster would have to be
 * resampled to the tile — softening the edge, which is then thresholded,
 * which gives a ragged mask. Drawn from the line at the tile's own scale the
 * edge is exactly as crisp as the model can use.
 *
 * ## Where they hang
 *
 * On a surface of their own, keyed `mask-<block>`, with a null `blockId` —
 * the schema's "spare raster" case, and necessary because the one surface a
 * block may own is already the one its retouching paints into.
 *
 * The layer is the mask plate's own row. These were filed under `clean` for a
 * while, when the stack had no mask row to put them on; that was a compromise
 * and this is not — a stroke somebody drew onto the mask belongs to the mask.
 *
 * ## Coordinates
 *
 * Page pixels, like every other stroke. Deliberately not relative to the
 * block: resizing a box does not move the ink underneath it, so a correction
 * pinned to the box would drift off the thing it was drawn for.
 */
import type { LocalStroke } from './usePaintCache'
import type { StrokeEntry } from './useUndo'
import type { MaskEdit } from '~/utils/ocr/mask'

/** What the eraser hands the history for one stroke it took. */
type Erased = Omit<StrokeEntry, 'kind'>

/** A stroke as the server keeps it, to the depth this file reads. */
interface StrokeRow {
  id: number
  seq: number
  tool: string
  params: { size?: number, softness?: number }
  points: number[]
  retracted: boolean
}

/**
 * The stamp that says which automatic mask a correction was drawn against.
 *
 * Recorded per stroke because the auto half is recomputed: change the
 * threshold or the dilation and every saved correction is suddenly sitting
 * over a different base. Kept with the stroke rather than centrally so an old
 * one can be recognised individually — see `MASK_RECIPE`.
 */
const RECIPE_KEY = 'm'

/**
 * Surfaces being made right now, by `page:key`.
 *
 * Outside the composable because it is not state anybody renders — it is one
 * in-flight request, and two callers a frame apart have to find the same one.
 */
const making = new Map<string, Promise<number | null>>()

/**
 * Reads of a block's corrections that are already in the air, by `page:block`.
 *
 * The same bargain as `making` directly above, and it is here because the same
 * block is asked for far more often than anybody would guess. The chain that
 * restores a chapter — blocks, then this browser's cache, then the repairs —
 * hangs off a watcher counting how many pages have been hashed, and hashing
 * runs in the background one page at a time. A ten-page chapter therefore runs
 * the whole chain about eleven times, the runs overlap, and every one of them
 * asks the server for every block's strokes before it can work out what the
 * repair is called: hundreds of requests on a cold open, for one answer that
 * did not change between the first and the eleventh.
 *
 * Coalescing them is not a cache and deliberately not one — the entry is
 * dropped the moment the request settles, so the next caller asks again and a
 * correction somebody else drew is never served from memory. All this says is
 * that two callers a frame apart wait on one request rather than two.
 */
const reading = new Map<string, Promise<MaskEdit[]>>()

/**
 * One request per key while that request is in the air, and no memory of it
 * afterwards.
 *
 * The shape `making` above has always had, written down once now that a second
 * map wants it. The `finally` is the whole of the care required: an entry left
 * behind by a request that threw would answer every later caller with the same
 * rejection, which is a block nobody can retry past — a cache of a failure,
 * from something that is not meant to be a cache at all.
 */
export function shareInFlight<T> (
  held: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const already = held.get(key)

  if (already) return already

  const asked = start().finally(() => { held.delete(key) })

  held.set(key, asked)

  return asked
}

/**
 * The versions this browser has already acted on.
 *
 * Outside the composable, because this one is called from several components at
 * once and anything held inside it exists several times over: a `seen` map per
 * caller meant each of them thought every version was new, and one retraction
 * reloaded the same block once per caller and re-cleaned it as many times.
 *
 * The watcher that reads it lives in the scope below, not behind a flag of its
 * own — see the note there.
 */
const seen = new Map<number, number>()

/**
 * The scope the two listeners live in — other people's corrections arriving,
 * and this browser's own undo landing.
 *
 * Detached, and once. This composable is called from several components, so a
 * listener registered plainly would exist several times over and load the same
 * block once per caller. A module flag alone is not enough either: the listener
 * would belong to whichever component happened to register first and would die
 * when that one unmounted, with the flag still set and nothing to re-create it.
 * A detached scope has no parent to be collected by.
 */
let listening: ReturnType<typeof effectScope> | null = null

/**
 * Server row ids by seq, for the strokes this browser has seen.
 *
 * A `MaskEdit` deliberately carries no row id — the mask code has no use for
 * one, and stringifying it into the redraw keys would redraw the plate for a
 * bookkeeping change. But the eraser retracts *rows*, so the crossing from a
 * stroke on screen to the row it landed as lives here, off to the side.
 */
const rowIds = new Map<number, number>()

/**
 * Every correction on screen, by page and block, in page pixels.
 *
 * ## Not a `useState`, though it was one
 *
 * An eraser writes here on every move — `MaskBrush.rub` puts the page's
 * corrections back with the pass's wipe grown by the newest point — and a
 * `useState` lives in Nuxt's payload, which Nuxt DevTools watches *deeply* in
 * development, walking all of it after any write. Worse, this was most of what
 * it walked: every point of every stroke, on every page, so each write to *any*
 * `useState` paid for the corrections too, and more the longer the mask had been
 * worked. Measured on the test chapter with sixty thousand numbers of
 * corrections held, the write an eraser makes on a move cost 18.1 ms in the
 * payload and 0.01 ms out of it, and any other write to the payload 18.2 ms
 * against 0.9. See `useBrushCursor`, where the ring's position left the payload
 * for the same reason.
 *
 * Module scope, like the maps above, and safe for the reason the ring's is:
 * nothing on the server writes a correction. Every writer answers a pointer, a
 * scan, or a read made after the page has mounted, and the server has none of
 * those — so no request can see another's. What it costs is development's hot
 * reload of this one file, which starts the list empty where a `useState` came
 * through; each block's corrections come back the next time it is read.
 *
 * Deep, where the ring's is shallow. The writers put a new object in place of a
 * page's corrections — `edits.value[pageId] = { … }` — rather than replacing the
 * whole map, and a shallow ref would not hear that.
 */
const edits = ref<Record<string, Record<string, MaskEdit[]>>>({})

export function useMaskEdits () {
  const route = useRoute()
  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const { shared } = useShared()
  const { pages } = useComic()

  // The history is `useUndo`'s, and it needs nothing from here — a mask
  // correction is a stroke like any other.
  const { record, versions, bump } = useUndo()

  const clientId = useState('mask-client', () => crypto.randomUUID())

  // Where a local workspace keeps its corrections — see `localKey`.
  const paint = usePaintCache()

  /** Surfaces already made, by their key, so one page costs one round trip each. */
  const surfaces = useState<Record<string, number>>('mask-surfaces', () => ({}))

  /**
   * Which block each mask surface belongs to, so a retraction can be traced
   * back to the balloon whose repair has to be made again.
   *
   * `useUndo` speaks in surfaces, because that is what the log is filed
   * under; everything here speaks in blocks. This is the one crossing.
   */
  const owners = useState<Record<number, { pageId: string, blockId: string }>>('mask-owners', () => ({}))

  /**
   * A block's key, or nothing.
   *
   * Only a block the server knows has one: an unsaved block's id is minted
   * fresh on every reading, so a correction filed under it would be lost the
   * next time the page was read — which is worse than refusing to store it,
   * because it would look stored until it was not.
   */
  function keyFor (block: Block): string | null {
    const id = block.id.startsWith('block:') ? block.id.slice('block:'.length) : null

    return id && /^\d+$/.test(id) ? `mask-${id}` : null
  }

  /**
   * Whether this is a local workspace, whose corrections live in this browser.
   *
   * They used to live only on the server, so on a local workspace the mask
   * brush drew, the plate showed the stroke, and nothing kept it: the clean
   * that followed read no corrections, asked for the repair it already had and
   * put it straight back. A local workspace keeps everything in the browser,
   * and its corrections are strokes like any other — so they go where the
   * paint brush's already go, `usePaintCache`, which is also what a project
   * file gathers retouching from.
   *
   * A cloud workspace keeps the server path. A block there without a row yet is
   * still refused a correction, for the reason `keyFor` gives.
   */
  const isLocal = () => !shared.value

  /**
   * The paint-cache surface a local block's corrections are filed under.
   *
   * By the page's content and the block's own id. A local block's id is the
   * `read:` one it was given when the page was read, and it survives a reload
   * because the block cache keeps it; reading the page again makes new blocks,
   * and their corrections start empty, which is what re-reading means.
   */
  const localKey = (page: ComicPage, block: Block) =>
    (page.scan?.hash ? `${page.scan.hash}:mask-${block.id}` : null)

  /** A local stroke as the mask code wants it — the shape `toEdit` makes of a server row. */
  const localEdit = (row: LocalStroke): MaskEdit => ({
    kind: row.tool === 'eraser' ? 'wipe' : 'add',
    seq: row.seq,
    points: row.points,
    size: row.params.size ?? 24,
    hardness: 1 - (row.params.softness ?? 0),
  })

  /**
   * The server's page row for a local page.
   *
   * Through the shared rule rather than a fourth copy of it — uid, then an
   * unambiguous hash, then path. The copy that used to live here preferred the
   * hash outright, so on a chapter holding the same image twice both pages
   * resolved to one row and their mask surfaces collided: corrections drawn on
   * one page turned up under the other.
   */
  function remotePage (page: ComicPage): number | null {
    return rowOfPage(shared.value?.pages ?? [], page)?.id ?? null
  }

  /** The surface a block's corrections live on, made on first ask. */
  async function surfaceFor (page: ComicPage, block: Block): Promise<number | null> {
    const key = keyFor(block)
    const pageId = remotePage(page)

    if (!key || !pageId || !atLeast(shared.value?.role, 'editor')) return null

    const held = surfaces.value[`${pageId}:${key}`]

    if (held) {
      remember(held, page, block)

      return held
    }

    // Whoever asked first is making it; everyone else waits on that. Two
    // strokes drawn before the first surface exists would otherwise each make
    // one, and a block's corrections would end up split across two rows with
    // only one of them ever read back.
    const flight = making.get(`${pageId}:${key}`)

    if (flight) return flight

    const made = create(pageId, key)

    making.set(`${pageId}:${key}`, made)

    return made
      .then((id) => {
        if (id) remember(id, page, block)

        return id
      })
      .finally(() => { making.delete(`${pageId}:${key}`) })
  }

  /**
   * Note which block a surface belongs to.
   *
   * Written on every ask rather than only when the surface is made, because
   * the map is per session and the surface is not: a chapter reopened finds
   * its surfaces already there and would otherwise have no way back from a
   * retraction to the balloon it belongs to.
   */
  function remember (surface: number, page: ComicPage, block: Block) {
    const known = owners.value[surface]

    if (known?.pageId === page.id && known.blockId === block.id) return

    owners.value = { ...owners.value, [surface]: { pageId: page.id, blockId: block.id } }
  }

  /**
   * Bring a correction surface into being — through the shared transport.
   *
   * `resolveSurface` is the same call the paint canvases make. It used to be
   * written out here as well, and the two copies drifted: the endpoint's key
   * pattern was tightened around *these* keys and silently refused the other's,
   * so paint on a blank layer went nowhere for as long as that lasted.
   */
  async function create (pageId: number, key: string): Promise<number | null> {
    const id = await resolveSurface(workspace.value, {
      pageId,
      layer: { plate: 'mask' },
      key,
      blockId: null,
    })

    if (id) surfaces.value = { ...surfaces.value, [`${pageId}:${key}`]: id }

    return id
  }

  /** A stored stroke, as the mask code wants it. */
  function toEdit (row: StrokeRow): MaskEdit {
    return {
      kind: row.tool === 'eraser' ? 'wipe' : 'add',
      seq: row.seq,
      points: row.points,
      size: row.params.size ?? 24,
      hardness: 1 - (row.params.softness ?? 0),
    }
  }

  /**
   * Read back a block's corrections, once however many callers ask at once.
   *
   * The waiting is all this does — `reading` holds the request only while it is
   * in the air, so nothing here decides that an answer is still good. See the
   * map's own note for the burst this exists to survive.
   */
  function load (page: ComicPage, block: Block): Promise<MaskEdit[]> {
    return shareInFlight(reading, `${page.id}:${block.id}`, () => read(page, block))
  }

  async function read (page: ComicPage, block: Block): Promise<MaskEdit[]> {
    if (isLocal()) {
      const key = localKey(page, block)

      if (!key) return []

      const rows = await paint.load(key)

      // So the eraser can find a stroke drawn before the reload — see `erase`.
      for (const row of rows) rowIds.set(row.seq, row.id)

      const live = rows.filter((row) => !row.retracted).map(localEdit)

      // The same merge as the server's, for the same reason: a stroke drawn a
      // moment ago may not be in what was read.
      const known = new Set(rows.map((row) => row.seq))
      const pending = (edits.value[page.id]?.[block.id] ?? [])
        .filter((entry) => entry.seq === undefined || !known.has(entry.seq))
      const kept = [...live, ...pending]

      edits.value[page.id] = { ...edits.value[page.id], [block.id]: kept }

      return kept
    }

    const surface = await surfaceFor(page, block)

    if (!surface) return []

    const rows = (await strokesOn(workspace.value, surface) ?? []) as unknown as StrokeRow[]

    for (const row of rows) rowIds.set(row.seq, row.id)

    const live = rows.filter((row) => !row.retracted).map(toEdit)

    const held = edits.value[page.id]?.[block.id] ?? []

    /**
     * The server's list, plus whatever this machine drew that the server has
     * not echoed back yet.
     *
     * Two mistakes stood here in turn. Replacing the local list outright
     * threw away a stroke whose write was still in flight — the fetch is a
     * snapshot from a moment before it landed — so adding and wiping came
     * out identical, cleaned with no corrections at all. Then "the longer
     * list wins" protected that stroke and broke undo instead: a retraction
     * *shrinks* the server's list, which is exactly the case a length
     * contest refuses to believe, so the retracted stroke could never leave.
     *
     * Matching by `seq` is what tells the two apart. A local edit whose seq
     * is nowhere in the fetched rows — retracted or not — is a write the
     * server has not seen yet, and stays. One whose seq comes back retracted
     * is an undo, and goes. No counting involved.
     */
    const echoed = new Set(rows.map((row) => row.seq))
    const pending = held.filter((entry) => entry.seq === undefined || !echoed.has(entry.seq))
    const kept = [...live, ...pending]

    edits.value[page.id] = { ...edits.value[page.id], [block.id]: kept }

    return kept
  }

  /**
   * Every block's corrections in the chapter, from one request.
   *
   * What `useClean.restore` reads instead of calling `load` per balloon. A
   * repair's name includes its block's corrections, so putting a chapter's
   * cleaning back used to ask for each block's in turn — and `load` goes
   * through `surfaceFor`, which is three requests one after another (the
   * page's stack, the surface, its strokes) and *makes* the surface when there
   * is none. On a fifty-page chapter that was around five hundred requests and
   * thirty-five seconds before the last page's cleaning appeared, and a mask
   * surface row written for every balloon nobody had ever corrected.
   *
   * The bulk read is the one project export already uses, so it creates
   * nothing. It orders strokes by `(seq, clientId)`, the same as the
   * per-surface read, which is not a nicety: the order is part of the
   * fingerprint in `patchKey`, and a different order is a different name that
   * finds no file.
   *
   * Null where there is nothing to ask — no server record — or the request
   * failed; the caller falls back to `load`, which answers a local block with
   * nothing and without a request.
   */
  async function chapterEdits (): Promise<Map<string, MaskEdit[]> | null> {
    if (!workspace.value || !shared.value) return null

    const pages = await $fetch<{ uid: string, surfaces: { key: string, strokes: Omit<StrokeRow, 'id' | 'retracted'>[] }[] }[]>(
      // The mask corrections only; the retouching is the export's business.
      `/api/workspaces/${workspace.value}/surfaces?keys=mask`,
    ).catch(() => null)

    if (!pages) return null

    const found = new Map<string, MaskEdit[]>()

    for (const page of pages) {
      for (const surface of page.surfaces) {
        // Retouching comes back in the same answer and is not a mask.
        if (!surface.key.startsWith('mask-')) continue

        found.set(`${page.uid}:${surface.key}`, surface.strokes.map((row) => toEdit({ ...row, id: 0, retracted: false })))
      }
    }

    return found
  }

  /**
   * One block's corrections out of `chapterEdits`, or null where that answer
   * cannot speak for it — a page with no uid is matched some other way, so it
   * goes back to `load`.
   *
   * Merged with what this tab drew and has not seen echoed, exactly as `read`
   * does, so a stroke in flight is not dropped from the name.
   */
  function editsFrom (chapter: Map<string, MaskEdit[]>, page: ComicPage, block: Block): MaskEdit[] | null {
    const key = keyFor(block)

    if (!key || !page.uid) return null

    const live = chapter.get(`${page.uid}:${key}`) ?? []
    const echoed = new Set(live.map((entry) => entry.seq))
    const pending = (edits.value[page.id]?.[block.id] ?? [])
      .filter((entry) => entry.seq === undefined || !echoed.has(entry.seq))
    const kept = [...live, ...pending]

    // Kept, as `read` keeps what it reads: the mask plate draws a block's
    // corrections from here, and a block whose corrections came from the bulk
    // read was otherwise drawn uncorrected until something happened to `load`
    // it.
    edits.value[page.id] = { ...edits.value[page.id], [block.id]: kept }

    return kept
  }

  /** The corrections already read for a block, without asking again. */
  const on = (pageId: string, blockId: string) => edits.value[pageId]?.[blockId] ?? []

  /**
   * Lay a correction down.
   *
   * Kept locally whether or not it reaches the server: a stroke that has been
   * drawn is on the page as far as the person drawing it is concerned, and a
   * workspace that cannot be written to is a reason to say so rather than to
   * make the brush appear broken.
   */
  async function add (page: ComicPage, block: Block, edit: MaskEdit): Promise<void> {
    /**
     * Stamped now, before anything is awaited — and onto the local copy too.
     *
     * `seq` is what the corrections are replayed in order of, and the order
     * they are replayed in decides the mask — so it has to be the order they
     * were *drawn* in. Taken after the await it would be the order the writes
     * happened to reach this line, and the first stroke on a block waits for
     * its surface to be made while the second does not.
     *
     * On the local copy because `load` merges by it: a local edit whose seq
     * the server has not echoed back yet is a write in flight, and without
     * the stamp it would be indistinguishable from one the server threw out.
     */
    const seq = Date.now() % 2_000_000_000
    const stamped: MaskEdit = { ...edit, seq }
    const held = edits.value[page.id]?.[block.id] ?? []

    edits.value[page.id] = { ...edits.value[page.id], [block.id]: [...held, stamped] }

    /**
     * Sent, not waited for.
     *
     * The stroke is already in `edits` and the mask already reflects it, so
     * nothing on screen is waiting on this round trip — and the brush used to
     * hold the pointer through it, which on a slow reply read as the whole
     * canvas seizing up the moment the mouse came up. `send` reports its own
     * failures, and on one the local copy stands, which is the same outcome
     * as before.
     *
     * Recorded here rather than by `send`, because the eraser sends pieces
     * too and those belong to *its* step, not to steps of their own. A
     * stroke the server refused is not undoable — correctly: there is
     * nothing on the server to take back.
     */
    send(page, block, stamped).then((made) => {
      if (made) record({ kind: 'stroke', ...made })
    })
  }

  /**
   * The wire half of laying a stroke down: the write, and nothing local.
   *
   * The caller has already put the stroke in `edits` — drawn is on the page,
   * whatever the network thinks — and already stamped its seq, because seq
   * is drawn order and only the caller knows when that was. What comes back
   * is the shape the history files, the same for a fresh stroke as for a
   * piece the eraser carved off an old one.
   */
  async function send (page: ComicPage, block: Block, edit: MaskEdit): Promise<Erased | null> {
    if (edit.seq === undefined) return null

    const xs = edit.points.filter((_, i) => i % 2 === 0)
    const ys = edit.points.filter((_, i) => i % 2 === 1)
    const pad = edit.size / 2

    // A local workspace's correction goes into this browser's stroke log — see
    // `isLocal`. Its id comes back negative, which is what tells undo to take it
    // back here rather than ask a server (`useUndo.flip`).
    if (isLocal()) {
      const key = localKey(page, block)

      if (!key) return null

      await paint.load(key)

      const row = paint.add(key, {
        seq: edit.seq,
        clientId: clientId.value,
        tool: edit.kind === 'wipe' ? 'eraser' : 'brush',
        composite: edit.kind === 'wipe' ? 'destination-out' : null,
        params: { size: edit.size, softness: 1 - edit.hardness, [RECIPE_KEY]: MASK_RECIPE },
        points: edit.points,
        x: Math.floor(Math.min(...xs) - pad),
        y: Math.floor(Math.min(...ys) - pad),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs) + edit.size),
        h: Math.ceil(Math.max(...ys) - Math.min(...ys) + edit.size),
      })

      rowIds.set(row.seq, row.id)

      return { strokeId: row.id, surfaceId: 0, seq: row.seq, clientId: clientId.value, pageId: 0, pageName: page.name }
    }

    const surface = await surfaceFor(page, block)

    if (!surface) return null

    try {
      const row = await appendStroke(workspace.value, surface, {
        seq: edit.seq,
        clientId: clientId.value,
        tool: edit.kind === 'wipe' ? 'eraser' : 'brush',
        composite: edit.kind === 'wipe' ? 'destination-out' : null,
        params: { size: edit.size, softness: 1 - edit.hardness, [RECIPE_KEY]: MASK_RECIPE },
        points: edit.points,
        x: Math.floor(Math.min(...xs) - pad),
        y: Math.floor(Math.min(...ys) - pad),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs) + edit.size),
        h: Math.ceil(Math.max(...ys) - Math.min(...ys) + edit.size),
      })

      if (!row) return null

      rowIds.set(row.seq, row.id)

      return {
        strokeId: row.id,
        surfaceId: surface,
        seq: row.seq,
        clientId: clientId.value,
        pageId: remotePage(page) ?? 0,
        pageName: page.name,
      }
    } catch (error) {
      console.warn('[kemolate] mask stroke not saved:', error)

      return null
    }
  }

  /**
   * Take one correction off the page — the eraser's verb.
   *
   * Not a wipe stroke laid on top: stacking an opposite mark over a mark you
   * regret leaves both in the log, undoes one at a time in reverse, and eats
   * auto mask anywhere the two do not exactly overlap. Erasing retracts the
   * stroke's own row — the very flip undo performs — so the log stays
   * append-only, a peer sees the stroke leave, and putting it back is one
   * more flip rather than an archaeology of overlapping corrections.
   *
   * The stroke leaves the screen synchronously, before anything is awaited,
   * for the same reason `add` puts one on synchronously — and also so a
   * sweep that crosses it twice cannot take it twice. If the server refuses,
   * it comes back where it was: hiding a stroke the server still holds would
   * only last until the next read.
   *
   * Returns what the history needs to put the stroke back, or null for one
   * that could not be taken — including a stroke whose own write is still in
   * flight, which has no row to retract yet. The caller gathers these into
   * one step per pass of the eraser; nothing is recorded here.
   */
  /**
   * A block has just been given its row on a cloud workspace: send up the
   * corrections this browser kept for it under the name it had before.
   *
   * A local workspace files a block's corrections in this browser's stroke log
   * by the block's own id (`localKey`), and a cloud one reads them from the
   * server by the block's row (`mask-<row>`). A block crosses from one to the
   * other when it is first saved — the workspace moved to the cloud, a project
   * file opened into a cloud workspace, a reading taken before the workspace
   * was shared — and until this the corrections stayed behind under the old
   * name, where nothing on a cloud workspace ever looks. The repair made from
   * them still showed; cleaning the balloon again lost them.
   *
   * Sent in their order and then let go of here, so they are not sent twice.
   * `from` is the id the block had; `block` has its row by now.
   */
  async function carryLocal (page: ComicPage, block: Block, from: string): Promise<void> {
    const hash = page.scan?.hash

    if (isLocal() || !hash || !workspace.value) return

    const key = `${hash}:mask-${from}`
    const rows = (await paint.load(key)).filter((row) => !row.retracted)

    if (!rows.length) return

    const surface = await surfaceFor(page, block)

    if (!surface) return

    const sent: number[] = []

    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
      const { id, retracted: _retracted, ...draft } = row
      const stroke = await appendStroke(workspace.value, surface, draft).catch(() => null)

      if (!stroke) break

      sent.push(id)
      rowIds.set(stroke.seq, stroke.id)
    }

    if (sent.length) paint.forget(key, sent)

    // Read back as the server's, so the plate and the next clean see them.
    await load(page, block).catch(() => {})
  }

  function erase (page: ComicPage, block: Block, edit: MaskEdit): Promise<Erased | null> {
    const id = edit.seq === undefined ? undefined : rowIds.get(edit.seq)

    if (!id) return Promise.resolve(null)

    const held = edits.value[page.id]?.[block.id] ?? []

    edits.value[page.id] = { ...edits.value[page.id], [block.id]: held.filter((entry) => entry.seq !== edit.seq) }

    // By seq rather than at an index, because the list may have been merged
    // under us while the round trip was out; the sort keeps replay order,
    // which is drawn order, which is seq order.
    const restore = () => {
      const current = edits.value[page.id]?.[block.id] ?? []

      edits.value[page.id] = {
        ...edits.value[page.id],
        [block.id]: [...current, edit].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
      }
    }

    // Local: taken back in this browser's log, which the watcher below hears
    // and re-cleans from — the part `bump` does for a server stroke.
    if (id < 0) {
      if (!paint.retract(id, true)) {
        restore()

        return Promise.resolve(null)
      }

      return Promise.resolve({ strokeId: id, surfaceId: 0, seq: edit.seq!, clientId: clientId.value, pageId: 0, pageName: page.name })
    }

    return surfaceFor(page, block)
      .then(async (surface) => {
        if (!surface) {
          restore()

          return null
        }

        // The bump below is this tab's own way of hearing about it, so the
        // notice `retractStroke` raises is for everybody else.
        const gone = await retractStroke(workspace.value, id)

        if (!gone) {
          restore()

          return null
        }

        // The bump is what re-reads the block and remakes its repair — the
        // same path an undo or a peer's retraction arrives by.
        bump(surface)

        return {
          strokeId: id,
          surfaceId: surface,
          seq: edit.seq!,
          clientId: clientId.value,
          pageId: remotePage(page) ?? 0,
          pageName: page.name,
        }
      })
      .catch((error: unknown) => {
        console.warn('[kemolate] mask stroke not erased:', error)
        restore()

        return null
      })
  }

  /**
   * Undo and redo, followed through to the page.
   *
   * `useUndo` retracts the row and bumps the surface's version — that is all
   * it can do, because it knows nothing about masks. What it cannot know is
   * that a retracted correction changes the mask, and a changed mask makes
   * the repair a repair of something else. So the version is watched here:
   * the block's corrections are read again, and its patch is remade from
   * them.
   *
   * The same path serves a peer's correction arriving, which is the same
   * event from this browser's point of view — the log for a surface changed.
   *
   * Installed once, whoever asks first, and comparing against `seen` rather
   * than the watcher's own `before`: a deep watch on a reactive object is
   * handed the *same* proxy as both arguments — old and new are one object —
   * so comparing them found every version unchanged and this never ran once.
   * That is why undo appeared to do nothing at all: the row was retracted on
   * the server, and nothing here ever asked again.
   */
  if (import.meta.client && !listening) {
    listening = effectScope(true)

    listening.run(() => {
    /**
     * Somebody else's correction, landing.
     *
     * Heard directly rather than through `versions`, and that is the fix. The
     * bump path can only act on a surface this browser has resolved for itself —
     * `owners` is filled by `surfaceFor`, so a correction on a balloon nobody
     * over here had cleaned arrived as a surface id naming nothing, and was
     * dropped. It came back eventually, the next time that block happened to be
     * cleaned, which is not the same as arriving.
     *
     * The notice now carries the page and the key, so the block can be found from
     * the notice alone: `mask-<row>` names the block's row, and the page row
     * names the page. Noted in `owners` on the way past, so the *next* thing to
     * touch this surface — an undo, a retraction — finds it the quick way.
     */
      onSwarmChange((room, change) => {
        if (room !== workspace.value) return
        if (change.scope !== 'strokes' || !change.key.startsWith('mask-')) return

        const row = Number(change.key.slice('mask-'.length))

        if (!Number.isInteger(row)) return

        const target = pages.value.find((candidate) => remotePage(candidate) === change.pageId)
        const block = target?.blocks.find((candidate) => rowOf(candidate) === row)

        if (!target || !block) return

        remember(change.surfaceId, target, block)

        // Reached for here rather than at the top of this composable, for the
        // reason the version watcher gives: `useClean` asks *this* one for a
        // block's corrections, so a binding up there is two composables waiting on
        // each other.
        const { cleanBlockSoon } = useClean()

        load(target, block).then(() => cleanBlockSoon(target, block)).catch(() => {})
      })

      /*
       * The same scope as the listener above, and that is the whole of this
       * fix.
       *
       * It was a plain `watch` behind a module flag, which is precisely the
       * trap the scope's own note warns about: a watcher registered that way
       * belongs to whichever component asked first and is stopped when that
       * component unmounts, with the flag still set and nothing left to
       * re-create it. For the mask the first caller is `MaskBrush`, which is
       * mounted only while its brush is out — so reaching for any other tool
       * killed the one thing that follows an undo through to the page. The row
       * was retracted on the server, the version was bumped, and the
       * correction stayed on screen: undo doing nothing, exactly as before,
       * and only after the brush had been put down once.
       */
      watch(versions, (now) => {
        for (const [id, version] of Object.entries(now)) {
          const surface = Number(id)

          if (seen.get(surface) === version) continue

          seen.set(surface, version)

          const owner = owners.value[surface]

          const target = owner ? pages.value.find((candidate) => candidate.id === owner.pageId) : null
          const block = target?.blocks.find((candidate) => candidate.id === owner?.blockId)

          if (!target || !block) continue

          // Reached for here rather than at the top of this composable:
          // `useClean` asks *this* one for a block's corrections, so holding it
          // as a binding up there would be two composables each waiting on the
          // other.
          const { cleanBlockSoon } = useClean()

          load(target, block).then(() => cleanBlockSoon(target, block)).catch(() => {})
        }
      }, { deep: true })

      /**
       * A local workspace's corrections changing — the local half of the
       * `versions` watcher above.
       *
       * A server stroke taken back by undo arrives as a version bump; a local
       * one is flipped in `usePaintCache` (see `useUndo.flip`) and nothing else
       * hears of it. Without this an undone correction would stay in the plate
       * and in the repair until the page was cleaned again by hand.
       *
       * Keyed by which strokes are live, so a stroke added here — which the
       * brush has already asked to be cleaned — is one more harmless pass
       * through the same settle rather than a second repair.
       */
      const localLive = computed(() => Object.entries(paint.strokes.value)
        .filter(([key]) => key.includes(':mask-'))
        .map(([key, rows]) => `${key}=${rows.filter((row) => !row.retracted).map((row) => row.id).join(',')}`))

      watch(localLive, (now, before) => {
        // By key, and a key's first appearance is not a change. `paint.load`
        // files an entry for every block it reads, corrections or none, and
        // `useClean.restore` reads every block it has not shown yet — so when
        // any new entry counted, opening a local workspace queued a clean of
        // every such block in the chapter: inference for each one nobody had
        // cleaned, and today's model over repairs made with another. A stroke
        // drawn here still counts: `send` loads first and adds after, so the
        // key is already known when its ids change.
        const was = new Map((before ?? []).map((entry) => [entry.slice(0, entry.indexOf('=')), entry]))

        for (const entry of now) {
          const key = entry.slice(0, entry.indexOf('='))
          const prior = was.get(key)

          if (prior === undefined || prior === entry) continue

          const split = key.indexOf(':mask-')
          const hash = key.slice(0, split)
          const blockId = key.slice(split + ':mask-'.length)

          const target = pages.value.find((candidate) => candidate.scan?.hash === hash)
          const block = target?.blocks.find((candidate) => candidate.id === blockId)

          if (!target || !block) continue

          const { cleanBlockSoon } = useClean()

          load(target, block).then(() => cleanBlockSoon(target, block)).catch(() => {})
        }
      })
    })
  }

  return { keyFor, surfaceFor, clientId, load, chapterEdits, editsFrom, on, add, send, erase, edits, carryLocal }
}
