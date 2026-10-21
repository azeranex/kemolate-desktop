import { describe, expect, it } from 'vitest'

import type { PageLog, RemotePagePaint } from '~/utils/paint/remote'
import type { Stroke } from '~~/server/database'

import { mergeLanded, mergeLogs, mergeRead } from '~/utils/paint/remote'

/**
 * Folding the server's answers into what a browser holds of a page's paint.
 *
 * The canvas re-reads a page past a cursor now, instead of reading every
 * surface's whole log on every collaborator's stroke, and its own strokes come
 * back from a batch rather than from a read. Each of those is a place a mark
 * can go missing or be drawn twice, and the rules that stop it are pure — so
 * they are pinned here, apart from any server or canvas:
 *
 * - a read that was in the air while this browser's batch landed must not take
 *   the batch's strokes off the page;
 * - a read past a cursor keeps what the cursor vouches for, and learns every
 *   retraction, old or new;
 * - a surface the server no longer has is dropped, unless this browser just
 *   made it;
 * - when the counts do not add up, the caller is told to read the page whole.
 *
 * Seam: `mergeRead`, `mergeLanded` and `mergeLogs`, on plain rows.
 */

const row = (id: number, seq: number, extra: Partial<Stroke> = {}): Stroke => ({
  id,
  surfaceId: 7,
  seq,
  clientId: 'peer',
  authorId: null,
  tool: 'brush',
  composite: null,
  params: { size: 20 },
  points: [0, 0, 10, 10],
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  retracted: false,
  createdAt: new Date(0),
  ...extra,
})

const answer = (horizon: number, strokes: Stroke[], extra: Partial<RemotePagePaint['surfaces'][number]> = {}): RemotePagePaint => ({
  horizon,
  surfaces: [{ id: 7, key: 'bg', strokes, ...extra }],
})

const ids = (log: PageLog, key = 'bg') => log.surfaces[key]?.rows.map((one) => one.id)

describe('mergeRead', () => {
  it('takes a whole read as the page, with the horizon as the next cursor', () => {
    const { log, agrees } = mergeRead(undefined, answer(12, [row(10, 1), row(12, 2)]), 0)

    expect(ids(log)).toEqual([10, 12])
    expect(log.cursor).toBe(12)
    expect(agrees).toBe(true)
  })

  it('keeps what the cursor vouches for and adds what is past it', () => {
    const held = mergeRead(undefined, answer(12, [row(10, 1), row(12, 2)]), 0).log
    const { log } = mergeRead(held, answer(20, [row(20, 3)], { retracted: [], total: 3 }), 12)

    expect(ids(log)).toEqual([10, 12, 20])
    expect(log.cursor).toBe(20)
  })

  /*
   * An undo of a mark read long ago: no new row, one flipped. The cursor alone
   * could never say it; the retraction ids do.
   */
  it('learns a retraction of a mark it already held, from a read past its cursor', () => {
    const held = mergeRead(undefined, answer(12, [row(10, 1), row(12, 2)]), 0).log
    const { log } = mergeRead(held, answer(12, [], { retracted: [10], total: 2 }), 12)

    expect(log.surfaces.bg!.rows.map((one) => one.retracted)).toEqual([true, false])
  })

  /*
   * The race this whole shape exists for: a page read goes out, this browser's
   * batch lands while it is in the air, and the read — which saw the page
   * before the batch — comes back after it. The batch's stroke stays.
   */
  it('keeps this browser\'s own marks that landed while a read was in the air', () => {
    const held = mergeLanded(undefined, 'bg', 7, [row(30, 5, { clientId: 'me' })])
    const { log } = mergeRead(held, answer(12, [row(10, 1)]), 0)

    expect(ids(log)).toEqual([10, 30])
  })

  it('drops a mark the read speaks for and does not have — it is not on the server', () => {
    const held: PageLog = { cursor: 0, surfaces: { bg: { id: 7, rows: [row(10, 1), row(11, 2)] } }, landed: [] }
    const { log } = mergeRead(held, answer(12, [row(10, 1)]), 0)

    expect(ids(log)).toEqual([10])
  })

  it('drops a surface the server no longer has, unless this browser just made it', () => {
    const held: PageLog = {
      cursor: 12,
      surfaces: { 'paint:gone': { id: 8, rows: [row(11, 1)] }, 'paint:new': { id: 9, rows: [row(40, 1, { clientId: 'me' })] } },
      landed: [40],
    }

    const { log } = mergeRead(held, answer(12, [row(10, 1)]), 0)

    expect(Object.keys(log.surfaces).sort()).toEqual(['bg', 'paint:new'])
  })

  it('reads a surface made again under an old key as new marks, not the old ones', () => {
    const held: PageLog = { cursor: 12, surfaces: { bg: { id: 6, rows: [row(11, 1)] } }, landed: [] }
    const { log } = mergeRead(held, answer(20, [row(20, 1)], { retracted: [], total: 1 }), 12)

    expect(ids(log)).toEqual([20])
  })

  it('says so when what it holds does not add up to what the server has', () => {
    const held = mergeRead(undefined, answer(12, [row(12, 2)]), 0).log
    const { agrees } = mergeRead(held, answer(20, [row(20, 3)], { retracted: [], total: 3 }), 12)

    expect(agrees).toBe(false)
  })

  it('lets go of a landed mark once a read has spoken for it', () => {
    const held = mergeLanded(undefined, 'bg', 7, [row(30, 5, { clientId: 'me' })])
    const { log } = mergeRead(held, answer(30, [row(30, 5, { clientId: 'me' })]), 0)

    expect(log.landed).toEqual([])
  })
})

describe('mergeLanded', () => {
  it('adds this browser\'s marks without moving the cursor past anybody else\'s', () => {
    const held = mergeRead(undefined, answer(12, [row(12, 1)]), 0).log
    const log = mergeLanded(held, 'bg', 7, [row(40, 2, { clientId: 'me' })])

    expect(ids(log)).toEqual([12, 40])
    expect(log.cursor).toBe(12)
  })
})

describe('mergeLogs', () => {
  /*
   * A stroke whose batch is in the air sits in both halves for a moment. Laid
   * twice, a soft brush darkens where it overlaps itself.
   */
  it('lays each mark once, keeping this browser\'s copy', () => {
    const theirs = [row(10, 1), row(11, 2, { clientId: 'me' })]
    const mine = [{ ...row(-1, 2, { clientId: 'me' }), retracted: true }]

    const merged = mergeLogs(theirs, mine)

    expect(merged.map((one) => `${one.clientId}:${one.seq}:${one.retracted}`)).toEqual(['peer:1:false', 'me:2:true'])
  })

  it('orders the union by seq, then client', () => {
    const merged = mergeLogs([row(10, 2, { clientId: 'b' })], [{ ...row(-1, 2, { clientId: 'a' }) }, { ...row(-2, 1, { clientId: 'c' }) }])

    expect(merged.map((one) => `${one.seq}:${one.clientId}`)).toEqual(['1:c', '2:a', '2:b'])
  })
})
