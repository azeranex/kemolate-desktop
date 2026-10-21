import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import type { LayerDraft } from '~~/server/services/layers'
import type { SurfaceBatch } from '~~/server/services/paint'

import { client } from '~~/server/database'
import { sync as syncLayers } from '~~/server/services/layers'
import { sync as syncPages } from '~~/server/services/pages'
import { append, appendMany, everything, onPage, retract, surfaceFor } from '~~/server/services/paint'

/**
 * The bulk read of the paint log, and the three things it has to get right.
 *
 * **Needs the database harness.**
 *
 * `everything` exists for one caller — writing a project file — and that caller
 * cannot check its work. An export runs once, produces a file that looks
 * plausible whatever is in it, and is opened weeks later on a machine that no
 * longer has the original; a stroke this drops is a stroke nobody discovers is
 * missing until it is the only copy. So the assertions here are about
 * completeness rather than about shape.
 *
 * Three decisions are load-bearing and each is one a later reader might undo:
 *
 * 1. **By `key` and `uid`, never by row id.** An id names a row in the
 *    workspace being exported *from*, which is precisely the workspace the file
 *    will not be opened in. `useBlockCache.localise` is the note about what
 *    happens when a name outlives the thing it named.
 * 2. **Retracted marks are left out**, which is the one place this differs from
 *    `strokesSince`. That function keeps them because a peer needs telling
 *    about an undo it never saw; a file has no older state to correct, and an
 *    undone stroke restored on import is a decision quietly reversed.
 * 3. **Pages with nothing on them are dropped**, so a two hundred page volume
 *    with one cleaned balloon answers with one page.
 *
 * Seam: `everything`, against a workspace with real surfaces under it.
 */

const layer = (extra: Partial<LayerDraft> = {}): LayerDraft => ({
  uid: 'clean',
  position: 0,
  label: 'Cleaned',
  plate: 'clean',
  visible: true,
  opacity: 100,
  ...extra,
})

const mark = (seq: number, clientId = 'tab-a') => ({
  seq,
  clientId,
  tool: 'brush' as const,
  params: { size: 12, colour: '#ffffff' },
  points: [10, 10, 20, 20],
  x: 4,
  y: 4,
  w: 22,
  h: 22,
})

/** A workspace with one page, one stack row, and a surface to paint on. */
async function aPaintedPage (key = 'bg') {
  const context = await aWorkspace()
  const [page] = await syncPages(context, [{ path: '06.jpg', name: '06', position: 0, hash: 'sha-06' }])
  const [row] = await syncLayers(context, [layer()], page!.id)
  const surface = await surfaceFor(context, { pageId: page!.id, layerId: row!.id, key })

  return { context, page: page!, surface }
}

beforeEach(reset)

describe('everything', () => {
  /**
   * The mask corrections alone, for putting a chapter's cleaning back — which
   * reads this on every open and every clean, and has no use for the
   * retouching riding along with them.
   */
  it('answers with the mask corrections alone when asked for masks', async () => {
    const { context, page, surface } = await aPaintedPage('mask-14')
    const [row] = await syncLayers(context, [layer()], page.id)
    const background = await surfaceFor(context, { pageId: page.id, layerId: row!.id, key: 'bg' })

    await append(context, surface.id, mark(1))
    await append(context, background.id, mark(2))

    expect((await everything(context))[0]!.surfaces.map((one) => one.key).sort()).toEqual(['bg', 'mask-14'])
    expect((await everything(context, { masks: true }))[0]!.surfaces.map((one) => one.key)).toEqual(['mask-14'])
  })

  it('answers with a surface by key and the marks on it', async () => {
    const { context, page, surface } = await aPaintedPage()

    await append(context, surface.id, mark(1))
    await append(context, surface.id, mark(2))

    const held = await everything(context)

    expect(held).toHaveLength(1)
    expect(held[0]!.uid).toBe(page.uid)
    expect(held[0]!.surfaces).toHaveLength(1)
    expect(held[0]!.surfaces[0]!.key).toBe('bg')
    expect(held[0]!.surfaces[0]!.strokes).toHaveLength(2)
  })

  it('carries no row id, of a surface or of a stroke', async () => {
    const { context, surface } = await aPaintedPage()

    await append(context, surface.id, mark(1))

    const [held] = await everything(context)

    // The whole answer, flattened — an id would show up wherever it were
    // added, including in a field somebody introduces later.
    expect(JSON.stringify(held)).not.toContain('"id"')
  })

  it('keeps the paint order, which is `seq` then `clientId`', async () => {
    const { context, surface } = await aPaintedPage()

    await append(context, surface.id, mark(2, 'tab-b'))
    await append(context, surface.id, mark(1, 'tab-b'))
    await append(context, surface.id, mark(2, 'tab-a'))

    const [held] = await everything(context)

    expect(held!.surfaces[0]!.strokes.map((row) => `${row.seq}:${row.clientId}`))
      .toEqual(['1:tab-b', '2:tab-a', '2:tab-b'])
  })

  it('leaves out a mark somebody undid', async () => {
    const { context, surface } = await aPaintedPage()

    const kept = await append(context, surface.id, mark(1))
    const undone = await append(context, surface.id, mark(2))

    await retract(context, undone!.id)

    const [held] = await everything(context)

    expect(held!.surfaces[0]!.strokes).toHaveLength(1)
    expect(held!.surfaces[0]!.strokes[0]!.seq).toBe(kept!.seq)
  })

  it('drops a surface once every mark on it has been undone', async () => {
    const { context, surface } = await aPaintedPage()

    const only = await append(context, surface.id, mark(1))

    await retract(context, only!.id)

    expect(await everything(context)).toEqual([])
  })

  it('drops a page nobody has painted on', async () => {
    const context = await aWorkspace()

    await syncPages(context, [
      { path: '06.jpg', name: '06', position: 0, hash: 'sha-06' },
      { path: '07.jpg', name: '07', position: 1, hash: 'sha-07' },
    ])

    expect(await everything(context)).toEqual([])
  })

  it('tells two surfaces on one page apart, which is what per-block cleanup is', async () => {
    const { context, page, surface } = await aPaintedPage()
    const [row] = await syncLayers(context, [layer()], page.id)

    const balloon = await surfaceFor(context, { pageId: page.id, layerId: row!.id, key: 'block:14' })

    await append(context, surface.id, mark(1))
    await append(context, balloon.id, mark(1))

    const [held] = await everything(context)

    expect(held!.surfaces.map((one) => one.key).sort()).toEqual(['bg', 'block:14'])
  })

  it('answers nothing about another workspace', async () => {
    const { context, surface } = await aPaintedPage()

    await append(context, surface.id, mark(1))

    const elsewhere = await aWorkspace()

    expect(await everything(elsewhere)).toEqual([])
  })
})

/**
 * A run of strokes, and a page's paint, each in one request.
 *
 * **Needs the database harness.**
 *
 * The canvas used to make a surface the moment it looked at a page, POST each
 * stroke on its own, and send every collaborator back for the surface's whole
 * log after each one. `appendMany` is the write that replaced the POSTs and
 * `onPage` the read that replaced the making and the log, and what has to hold
 * for them is what held for the old ones and more:
 *
 * 1. **A stroke's identity is `(surface, client, seq)`.** A run sent twice —
 *    because its answer was lost — lands once, and the second answer names the
 *    rows the first wrote, which is what lets the browser let go of its copy.
 * 2. **Nothing is made by looking.** A surface, and the stack it hangs off, come
 *    into being with the first stroke; a read of a page makes nothing.
 * 3. **A read past a cursor misses nothing.** Newer marks come back, and so does
 *    every retraction, which is the one change that does not add a row.
 *
 * Seam: the services, against a real database, and the notices they raise as
 * the room's sockets would receive them.
 */

/** A page to paint on, in a workspace of its own. */
async function aPage () {
  const context = await aWorkspace()
  const [page] = await syncPages(context, [{ path: '06.jpg', name: '06', position: 0, hash: 'sha-06' }])

  return { context, page: page! }
}

/** The retouching's share of a run: `bg`, filed under the cleaned plate. */
const onBg = (pageId: number, strokes: SurfaceBatch['strokes']): SurfaceBatch => ({ pageId, key: 'bg', plate: 'clean', strokes })

const count = (table: string) => Number((client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n)

/** What the room hears, as its one socket would. */

describe('appendMany', () => {
  it('lays every stroke of a run in one call, on the surface it names', async () => {
    const { context, page } = await aPage()

    const [answer] = await appendMany(context, [onBg(page.id, [mark(1), mark(2), mark(3)])])

    expect(answer).toMatchObject({ status: 'kept', key: 'bg', pageId: page.id })
    expect(answer!.status === 'kept' && answer!.strokes.map((row) => row.seq)).toEqual([1, 2, 3])
    expect(count('strokes')).toBe(3)
  })

  /**
   * The surface, and the stack its row hangs off, arrive with the first mark —
   * and not before: reading the page first makes nothing at all.
   */
  it('makes the surface with its first stroke, and nothing for a page only read', async () => {
    const { context, page } = await aPage()

    expect(await onPage(context, page.id)).toEqual({ horizon: 0, surfaces: [] })
    expect([count('surfaces'), count('layers')]).toEqual([0, 0])

    await appendMany(context, [onBg(page.id, [mark(1)])])

    expect(count('surfaces')).toBe(1)
    expect(count('layers')).toBeGreaterThan(0)
  })

  /**
   * The answer was lost and the run is sent again. The index keeps each
   * stroke once, and the second answer is the rows the first one wrote.
   */
  it('lays a run sent twice once, and answers the second time with the same rows', async () => {
    const { context, page } = await aPage()

    const [first] = await appendMany(context, [onBg(page.id, [mark(1), mark(2)])])
    const [again] = await appendMany(context, [onBg(page.id, [mark(1), mark(2), mark(3)])])

    expect(count('strokes')).toBe(3)

    const ids = (answer: typeof first) => (answer?.status === 'kept' ? answer.strokes.map((row) => row.id) : [])

    expect(ids(again).slice(0, 2)).toEqual(ids(first))
  })

  /**
   * Undone while its batch was in the air: the resend carries the new word,
   * and it is the only thing about the row that changes.
   */
  it('takes a retraction on a resend, and nothing else', async () => {
    const { context, page } = await aPage()

    const [first] = await appendMany(context, [onBg(page.id, [mark(1)])])
    const [again] = await appendMany(context, [onBg(page.id, [{ ...mark(1), points: [0, 0, 1, 1], retracted: true }])])

    expect(count('strokes')).toBe(1)
    expect(again?.status === 'kept' && again.strokes[0]).toMatchObject({ retracted: true, points: [10, 10, 20, 20] })
    expect(first?.status === 'kept' && first.strokes[0]!.id).toBe(again?.status === 'kept' && again.strokes[0]!.id)
  })

  it('holds a sheet\'s strokes until the stack row it paints on exists', async () => {
    const { context, page } = await aPage()
    const sheet = (): SurfaceBatch => ({ pageId: page.id, key: 'paint:a1b2c3d4', layer: 'paint:a1b2c3d4', strokes: [mark(1)] })

    expect(await appendMany(context, [sheet()])).toEqual([{ pageId: page.id, key: 'paint:a1b2c3d4', status: 'waiting' }])
    expect([count('surfaces'), count('strokes')]).toEqual([0, 0])

    await syncLayers(context, [layer({ uid: 'paint:a1b2c3d4', plate: null, paint: true, label: 'Sketch' })], page.id)

    const [answer] = await appendMany(context, [sheet()])

    expect(answer?.status).toBe('kept')
    expect(count('strokes')).toBe(1)
  })

  it('answers gone for a page that is not this workspace\'s, and writes nothing there', async () => {
    const { page } = await aPage()
    const elsewhere = await aWorkspace()

    expect(await appendMany(elsewhere, [onBg(page.id, [mark(1)])])).toEqual([{ pageId: page.id, key: 'bg', status: 'gone' }])
    expect([count('surfaces'), count('strokes'), count('layers')]).toEqual([0, 0, 0])
  })
})

describe('onPage', () => {
  it('leaves out the mask corrections, which have their own reader', async () => {
    const { context, page, surface } = await aPaintedPage('mask-14')
    const [row] = await syncLayers(context, [layer()], page.id)
    const background = await surfaceFor(context, { pageId: page.id, layerId: row!.id, key: 'bg' })

    await append(context, surface.id, mark(1))
    await append(context, background.id, mark(2))

    expect((await onPage(context, page.id)).surfaces.map((one) => one.key)).toEqual(['bg'])
  })

  /**
   * What a collaborator's notice reads: the marks past the cursor, every
   * retraction on the surface whether old or new, and how many rows it has —
   * so an undo of a mark read long ago still arrives.
   */
  it('answers past a cursor with the newer marks, every retraction, and the count', async () => {
    const { context, page } = await aPage()

    const [first] = await appendMany(context, [onBg(page.id, [mark(1), mark(2)])])
    const read = await onPage(context, page.id)
    const older = first?.status === 'kept' ? first.strokes[0]!.id : 0

    await retract(context, older)
    await appendMany(context, [onBg(page.id, [mark(3)])])

    const since = await onPage(context, page.id, read.horizon)
    const [bg] = since.surfaces

    expect(bg!.strokes.map((row) => row.seq)).toEqual([3])
    expect(bg!.retracted).toEqual([older])
    expect(bg!.total).toBe(3)
    expect(since.horizon).toBe(bg!.strokes[0]!.id)
  })

  it('keeps its horizon to this page, so a mark on another page moves no cursor here', async () => {
    const { context, page } = await aPage()
    const [other] = await syncPages(context, [
      { path: '06.jpg', name: '06', position: 0, hash: 'sha-06' },
      { path: '07.jpg', name: '07', position: 1, hash: 'sha-07' },
    ]).then((rows) => rows.filter((row) => row.id !== page.id))

    await appendMany(context, [onBg(page.id, [mark(1)])])

    const before = (await onPage(context, page.id)).horizon

    await appendMany(context, [onBg(other!.id, [mark(1)])])

    expect((await onPage(context, page.id)).horizon).toBe(before)
  })
})
