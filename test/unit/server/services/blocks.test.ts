import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { aWorkspace, reset } from '../harness'

import type { Block } from '~~/server/database'
import type { Context } from '~~/server/services/access'
import type { BlockPatch } from '~~/server/services/blocks'

import { blocks, client, db } from '~~/server/database'
import { update, updateOnPage } from '~~/server/services/blocks'
import { sync as syncPages } from '~~/server/services/pages'

/**
 * Joining blocks, letting them go, and the deletions that follow.
 *
 * **Needs the database harness.**
 *
 * Two things are being pinned here and they are not the same. The first is the
 * behaviour: a balloon among the chosen is dissolved rather than nested, and a
 * page stays one level deep. The second is the *cascade shape*, which is the
 * part with history — a drizzle-kit table rebuild on `layers` once dropped
 * every `surfaces` row and then every `strokes` row, silently, with the
 * migration reporting success. A test that asserts what a delete takes with it
 * is what turns that from a thing people remember into a thing that fails.
 *
 * Seam: `compound`, `release`, `remove` — and the database's own behaviour
 * afterwards, which is the one place querying rows directly is the point rather
 * than a side channel.
 */

describe('compound', () => {
  it.todo('joins loose blocks into a balloon, in the order it was given them')
  it.todo('dissolves a balloon among the chosen instead of nesting it')
  it.todo('adopts a dissolved balloon\'s columns before deleting the parent')
  it.todo('keeps the page one level deep however many balloons were joined')
  it.todo('refuses a block belonging to another page')
  it.todo('refuses a block already inside somebody else\'s balloon')
  it.todo('refuses when fewer than two blocks survive the flattening')
  it.todo('gives the columns positions counting from nought within the balloon')
})

describe('release', () => {
  it.todo('gives the columns back where the balloon stood')
  it.todo('deletes the parent only once nothing points at it')
  it.todo('refuses a block that is not a balloon')
})

describe('what a delete takes with it', () => {
  it.todo('a dissolved balloon takes its own translation and revisions')
  it.todo('a dissolved balloon does not take its columns')
  it.todo('deleting a block takes its translations, revisions and surfaces')
  it.todo('deleting a page takes its blocks and everything filed under them')
  it.todo('deleting a layer takes its surfaces and their strokes — the 2026-08-01 incident')
})

/**
 * The chapter's reading in one request — what a browser opening a chapter asks.
 *
 * Its answer per page has to be exactly `onPage`'s, because `useOcr.restore`
 * builds blocks out of either without knowing which it got, and a difference in
 * ordering is a different `position` on every row the next save writes back.
 */
describe('inChapter', () => {
  it.todo('answers each page with what onPage would, in the same order')
  it.todo('leaves out pages with no blocks')
  it.todo('carries a balloon\'s columns inside it, not beside it')
  it.todo('holds no page from another workspace')
})

/**
 * A page's blocks changed in one request, and the one-block patch beside it.
 *
 * **Needs the database harness.**
 *
 * `updateOnPage` is what a settle of `useBlockSync` sends — one request per page
 * where there used to be one per block. Three properties carry it, and none of
 * them shows in a reply that succeeded:
 *
 * - **Every row is proved to be on the page named**, and the page to be this
 *   workspace's, before anything is written. A batch mixing in a block from
 *   another page, or from another workspace altogether, is refused whole.
 * - **All of it or none of it.** A write that fails part-way takes back the ones
 *   before it. The failure is made by a trigger rather than a mock, for the
 *   reason `workspaces.test.ts` gives: it arrives from the database partway
 *   through the service's own statements, where a real one would.
 * - **A patch changes what it names and nothing else**, through statements
 *   compiled once per set of columns and kept. The cases below are the ways a
 *   cache like that goes wrong: a column written because a statement compiled
 *   for another shape named it, a null that cannot clear a column, and a
 *   timestamp frozen at the moment a statement was compiled.
 *
 * Seam: `updateOnPage` and `update`, the rows they leave behind, and the
 * notices the room is sent.
 */

/** A chapter's pages, each with `count` blocks written straight to the table. */
async function aChapter (context: Context, paths: string[], count = 3) {
  const pages = await syncPages(context, paths.map((path, position) => ({
    path,
    name: path,
    position,
    hash: `sha-${context.workspace.publicId}-${path}`,
  })))

  return Promise.all(pages.map(async (page) => ({
    page,
    rows: await db
      .insert(blocks)
      .values(Array.from({ length: count }, (_, position) => ({
        pageId: page.id,
        cx: 0.5,
        cy: 0.2 * (position + 1),
        w: 0.2,
        h: 0.1,
        position,
        source: `${page.path} line ${position}`,
        quad: [0, 0, 0.01, 0, 0, 0.01, 0, 0],
        room: { cx: 0.5, cy: 0.2 * (position + 1), w: 0.3, h: 0.2 },
      })))
      .returning(),
  })))
}

/** One page of its own. */
const aPage = async (context: Context) => (await aChapter(context, ['01.png']))[0]!

/** A row as the table holds it now, read past the services — which is the point. */
const stored = async (id: number) => db.query.blocks.findFirst({ where: { id } })

/** What each of these rows holds now, against what it held before. */
const unchanged = async (...rows: Block[]) => {
  for (const row of rows) expect(await stored(row.id)).toEqual(row)
}

/** Somebody else in the workspace, and every notice they are sent. */

/** What the trigger below answers with — ours, so a failure can be told to be the one it made. */
const REFUSAL = 'refused by the test'

/** A rejection that came from that trigger, which drizzle wraps and keeps as its `cause`. */
const REFUSED_BY_THE_TEST = { cause: expect.objectContaining({ message: REFUSAL }) }

/**
 * Make every write to one row fail, to the end of the test — `failEveryInsertInto`
 * in `workspaces.test.ts`, one row wide. Taken down however the test ends:
 * `reset` leaves triggers alone.
 */
function failEveryUpdateOf (row: number) {
  const trigger = `test_refuse_block_${row}`

  client.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON blocks WHEN OLD.id = ${row} BEGIN SELECT RAISE(ABORT, '${REFUSAL}'); END`)

  onTestFinished(() => client.exec(`DROP TRIGGER IF EXISTS ${trigger}`))
}

beforeEach(reset)

describe('updateOnPage', () => {
  it('writes every patch and hands the rows back in the order they were named', async () => {
    const context = await aWorkspace()
    const { page, rows: [a, b, c] } = await aPage(context)

    const written = await updateOnPage(context, page.id, [
      { id: c!.id, cx: 0.9, source: 'third' },
      { id: a!.id, cx: 0.1, source: 'first' },
    ])

    expect(written.map((row) => [row.id, row.cx, row.source])).toEqual([
      [c!.id, 0.9, 'third'],
      [a!.id, 0.1, 'first'],
    ])
    expect(await stored(c!.id)).toMatchObject({ cx: 0.9, source: 'third' })
    await unchanged(b!)
  })

  it('refuses the whole batch over a block on another page, and writes nothing', async () => {
    const context = await aWorkspace()
    const [one, two] = await aChapter(context, ['01.png', '02.png'])

    await expect(updateOnPage(context, one!.page.id, [
      { id: one!.rows[0]!.id, cx: 0.9 },
      { id: two!.rows[0]!.id, cx: 0.9 },
      { id: one!.rows[1]!.id, cx: 0.9 },
    ])).rejects.toMatchObject({ statusCode: 404, data: { missing: [two!.rows[0]!.id] } })

    await unchanged(...one!.rows, ...two!.rows)
  })

  it('refuses the whole batch over a block from another workspace, as if it did not exist', async () => {
    const context = await aWorkspace()
    const mine = await aPage(context)
    const theirs = await aPage(await aWorkspace())
    const nobodys = theirs.rows[2]!.id + 1000

    await expect(updateOnPage(context, mine.page.id, [
      { id: mine.rows[0]!.id, cx: 0.9 },
      { id: theirs.rows[0]!.id, cx: 0.9 },
      { id: nobodys, cx: 0.9 },
    ])).rejects.toMatchObject({ statusCode: 404, data: { missing: [theirs.rows[0]!.id, nobodys] } })

    await unchanged(...mine.rows, ...theirs.rows)
  })

  it('refuses another workspace\'s page with the answer a missing page gets', async () => {
    const context = await aWorkspace()
    const theirs = await aPage(await aWorkspace())

    await expect(updateOnPage(context, theirs.page.id, [{ id: theirs.rows[0]!.id, cx: 0.9 }]))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: 'No such page.' })

    await unchanged(...theirs.rows)
  })

  it('takes back the writes before one that fails', async () => {
    const context = await aWorkspace()
    const { page, rows } = await aPage(context)

    // The last of the three, so two have been written by the time it fails.
    failEveryUpdateOf(rows[2]!.id)

    await expect(updateOnPage(context, page.id, rows.map((row) => ({ id: row.id, cx: 0.9 }))))
      .rejects.toMatchObject(REFUSED_BY_THE_TEST)

    await unchanged(...rows)
  })
})

/** A patch naming every column a block has, as `useBlockSync` sends one. */
const EVERY_COLUMN: BlockPatch = {
  kind: 'caption',
  cx: 0.4,
  cy: 0.4,
  w: 0.2,
  h: 0.1,
  angle: 5,
  skewX: 0,
  skewY: 0,
  quad: null,
  room: null,
  source: 'whole',
  hidden: true,
  position: 0,
}

describe('a patch changes what it names and nothing else', () => {
  it('leaves a column alone that the patch does not name, whatever was compiled before it', async () => {
    const context = await aWorkspace()
    const { page, rows: [a, b] } = await aPage(context)

    // The whole block first, as the sync sends it — compiling a statement that
    // names every column — and then only a room, as a measuring run sends it.
    await updateOnPage(context, page.id, [{ id: a!.id, ...EVERY_COLUMN }])
    await updateOnPage(context, page.id, [{ id: b!.id, room: { cx: 0.5, cy: 0.5, w: 0.4, h: 0.3 } }])

    expect(await stored(b!.id)).toEqual({
      ...b,
      room: { cx: 0.5, cy: 0.5, w: 0.4, h: 0.3 },
      updatedAt: expect.any(Date),
    })
  })

  it('clears a quad or a room named as null, and keeps the one left out', async () => {
    const context = await aWorkspace()
    const { page, rows: [a, b] } = await aPage(context)

    await updateOnPage(context, page.id, [{ id: a!.id, quad: null }, { id: b!.id, room: null }])

    expect(await stored(a!.id)).toMatchObject({ quad: null, room: a!.room })
    expect(await stored(b!.id)).toMatchObject({ quad: b!.quad, room: null })
  })

  it('stamps a write with when it happened, not when its statement was compiled', async () => {
    const context = await aWorkspace()
    const { page, rows: [a] } = await aPage(context)

    onTestFinished(() => { vi.useRealTimers() })

    // A patch of `skewY` alone, which nothing else in this file sends: the
    // statement for it is compiled here, under a clock stopped in 2001. A stamp
    // taken while compiling would carry that year into every later write.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'))
    await updateOnPage(context, page.id, [{ id: a!.id, skewY: 1 }])
    vi.useRealTimers()

    await updateOnPage(context, page.id, [{ id: a!.id, skewY: 2 }])

    expect((await stored(a!.id))!.updatedAt.getUTCFullYear()).toBeGreaterThan(2001)
  })

  it('hands a row back as it stands for a patch that names nothing', async () => {
    const context = await aWorkspace()
    const { page, rows: [a, b] } = await aPage(context)

    // Handed to drizzle's builder this was "No values to set" — a 500.
    expect(await update(context, a!.id, {})).toEqual(a)
    expect(await updateOnPage(context, page.id, [{ id: b!.id }])).toEqual([b])
  })

  it('changes one block through the one-block patch exactly as a page of them would', async () => {
    const context = await aWorkspace()
    const { rows: [a, b] } = await aPage(context)

    expect(await update(context, a!.id, { source: 'fixed', quad: null })).toEqual({
      ...a,
      source: 'fixed',
      quad: null,
      updatedAt: expect.any(Date),
    })
    await unchanged(b!)
  })
})
