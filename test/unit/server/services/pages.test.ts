import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import type { Page } from '~~/server/database'
import type { Context } from '~~/server/services/access'
import type { PageDraft } from '~~/server/services/pages'

import { blocks, db, layers, strokes, surfaces, translationRevisions, translations } from '~~/server/database'
import { list, remove, sync } from '~~/server/services/pages'

/**
 * Bringing the server's idea of a chapter into line with a browser's — and the
 * two different ways a page can leave.
 *
 * **Needs the database harness.**
 *
 * `sync` is **additive and will not remove**, deliberately: a page the browser
 * did not mention is not evidence that the page is gone, and blocks,
 * translations and paint hang off page rows, so a short list must never be able
 * to take an evening's work with it by cascade. `remove` is the other path, and
 * it is the one that actually deletes.
 *
 * Which means "the page came back" is not one bug, it is the seam between those
 * two. If a reader removes a page and only `sync` runs, the row survives, the
 * next restore hands it back, and the page reappears — reliably, not
 * intermittently. These cases are written to tell those two paths apart, so a
 * failure says *which* of them was wrong rather than that pages are flaky.
 *
 * The matching rule is the other half. A page is found by `hash` first and
 * `path` second — content before name, because a chapter is renamed far more
 * often than it is re-scanned — and a hash is only usable once it has been
 * computed, which happens in the background well after the pages are on screen.
 * So the interesting cases are the ones where a page arrives unhashed, is
 * matched by path, and then gains a hash that must not create a second row.
 *
 * Seam: `list`, `sync`, `remove`, `reorder`, `measure`.
 */

/**
 * One page as a browser would send it. Named for what it is on disk, because
 * every case here turns on the difference between the file's name and its
 * bytes, and a fixture that blurred the two would hide exactly that.
 */
const scan = (path: string, position: number, hash?: string): PageDraft => ({
  path,
  name: path.replace(/\.\w+$/, ''),
  position,
  hash,
})

/** A chapter already on the server, in the order it was opened. */
const aChapter = (context: Context, ...paths: string[]): Promise<Page[]> =>
  sync(context, paths.map((path, position) => scan(path, position, `sha-${path}`)))

/**
 * An evening's work on one page: a block, what it says, what it said before,
 * and the paint over the art underneath.
 *
 * Written straight to the tables rather than through `blocks.create` and its
 * neighbours. Those are other services with their own rules, and a page test
 * that went through them would fail when one of *those* changed — what is
 * being pinned here is only that these rows exist, hang off the page, and go
 * or stay with it.
 */
async function workDoneOn (page: Page, workspaceId: number) {
  const [block] = await db
    .insert(blocks)
    .values({ pageId: page.id, cx: 0.5, cy: 0.5, w: 0.2, h: 0.1, position: 0, source: '見て' })
    .returning()

  const [translation] = await db
    .insert(translations)
    .values({ blockId: block!.id, locale: 'en', text: 'Look' })
    .returning()

  const [revision] = await db
    .insert(translationRevisions)
    .values({ translationId: translation!.id, text: 'Look at that', engine: 'ai-text' })
    .returning()

  const [layer] = await db
    .insert(layers)
    .values({ workspaceId, pageId: page.id, uid: 'clean', label: 'Clean', plate: 'clean', position: 0 })
    .returning()

  const [surface] = await db
    .insert(surfaces)
    .values({ pageId: page.id, layerId: layer!.id, key: `patch-${page.id}` })
    .returning()

  const [stroke] = await db
    .insert(strokes)
    .values({
      surfaceId: surface!.id,
      seq: 0,
      clientId: 'a-tab',
      tool: 'brush',
      params: { size: 12 },
      points: [0, 0, 1, 1],
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    })
    .returning()

  return {
    blockId: block!.id,
    translationId: translation!.id,
    revisionId: revision!.id,
    layerId: layer!.id,
    surfaceId: surface!.id,
    strokeId: stroke!.id,
  }
}

/** What survived, counted through the rows rather than through a service. */
async function whatSurvives (of: Awaited<ReturnType<typeof workDoneOn>>) {
  return {
    blocks: (await db.query.blocks.findMany({ where: { id: of.blockId } })).length,
    translations: (await db.query.translations.findMany({ where: { id: of.translationId } })).length,
    revisions: (await db.query.translationRevisions.findMany({ where: { id: of.revisionId } })).length,
    layers: (await db.query.layers.findMany({ where: { id: of.layerId } })).length,
    surfaces: (await db.query.surfaces.findMany({ where: { id: of.surfaceId } })).length,
    strokes: (await db.query.strokes.findMany({ where: { id: of.strokeId } })).length,
  }
}

const ALL_OF_IT = { blocks: 1, translations: 1, revisions: 1, layers: 1, surfaces: 1, strokes: 1 }
const NONE_OF_IT = { blocks: 0, translations: 0, revisions: 0, layers: 0, surfaces: 0, strokes: 0 }

beforeEach(reset)

describe('sync — what it adds', () => {
  it('adds a page the workspace has never seen', async () => {
    const context = await aWorkspace()

    const [page] = await sync(context, [scan('01.png', 0, 'sha-01')])

    expect(page).toMatchObject({
      workspaceId: context.workspaceId,
      path: '01.png',
      name: '01',
      position: 0,
      hash: 'sha-01',
    })

    // The browser sent no `uid`, so the server minted one — the page's only
    // identity, and the thing every later sync will recognise it by.
    expect(page!.uid).toEqual(expect.any(String))
    expect(page!.uid.length).toBeGreaterThan(0)
  })

  it('matches an existing page by hash before path', async () => {
    // A renumber: both scans keep their bytes and shift up a name. The draft
    // for `02.png` names by *path* the row that page used to be, and by *hash*
    // the row that used to be `01.png` — two different rows, and the hash is
    // the one to believe.
    const renumbered = [scan('02.png', 0, 'sha-01.png'), scan('03.png', 1, 'sha-02.png')]

    // Sent in both orders, because the order a browser happens to walk a folder
    // in is not a thing it should have to get right. There is no safe order
    // here anyway — `01.png` has to move onto a name `02.png` has not left yet,
    // or the other way about — so a `sync` that only worked one way round was
    // one that worked by luck.
    for (const drafts of [renumbered, [...renumbered].reverse()]) {
      const context = await aWorkspace()
      const [first, second] = await aChapter(context, '01.png', '02.png')

      const synced = await sync(context, drafts)

      // Two pages, not three: had the path won, it would have found a row
      // already claimed by this same request and filed the scan as a new page.
      expect(synced).toHaveLength(2)
      expect(synced.map((page) => [page.uid, page.path, page.hash])).toEqual([
        [first!.uid, '02.png', 'sha-01.png'],
        [second!.uid, '03.png', 'sha-02.png'],
      ])
    }
  })

  it('does not hand a page\'s work to a different scan that took its name', async () => {
    const context = await aWorkspace()
    const [original] = await aChapter(context, '01.png')
    const work = await workDoneOn(original!, context.workspaceId)

    // A page inserted at the front of the folder. The file called `01.png` is
    // now a different scan, and the page that used to be called that has
    // shifted along — the commonest thing anybody does to a chapter, and the
    // one case where trusting the name over the bytes is silently wrong.
    const synced = await sync(context, [
      scan('01.png', 0, 'sha-inserted'),
      scan('02.png', 1, 'sha-01.png'),
    ])

    expect(synced).toHaveLength(2)
    expect(new Map(synced.map((page) => [page.uid, [page.path, page.hash]])).get(original!.uid))
      .toEqual(['02.png', 'sha-01.png'])

    // And the evening's work went with the page rather than staying at the
    // name: a block that ends up on a row describing different bytes is a
    // reading of one drawing sitting on top of another.
    expect(await whatSurvives(work)).toEqual(ALL_OF_IT)

    const [block] = await db.query.blocks.findMany({ where: { id: work.blockId } })

    expect(block!.pageId).toBe(original!.id)
  })

  it('matches by path when the hash is not known yet', async () => {
    const context = await aWorkspace()
    const [known] = await aChapter(context, '01.png')

    // A second browser, moments after opening the folder: it has the file's
    // name and nothing else, because hashing happens in the background well
    // after the pages are on screen.
    const synced = await sync(context, [{ path: '01.png', name: 'Cover', position: 0 }])

    expect(synced).toHaveLength(1)
    expect(synced[0]).toMatchObject({
      uid: known!.uid,
      name: 'Cover',
      // Filled in, never blanked: the browser that has not measured a page yet
      // must not erase what another one already knew about it.
      hash: 'sha-01.png',
    })
  })

  it('brings a matched page\'s position and name up to date', async () => {
    const context = await aWorkspace()
    const [first, second] = await aChapter(context, '01.png', '02.png')

    const synced = await sync(context, [
      { ...scan('01.png', 1, 'sha-01.png'), name: 'Back' },
      { ...scan('02.png', 0, 'sha-02.png'), name: 'Front' },
    ])

    expect(synced.map((page) => [page.uid, page.name, page.position])).toEqual([
      [second!.uid, 'Front', 0],
      [first!.uid, 'Back', 1],
    ])
  })

  it('does not add a second row when an already-matched page gains its hash', async () => {
    const context = await aWorkspace()

    const [unhashed] = await sync(context, [{ path: '01.png', name: '01', position: 0 }])
    const synced = await sync(context, [scan('01.png', 0, 'sha-01.png')])

    // The hashing burst arriving is the commonest sync there is, and a second
    // row here would be the same page twice for the rest of the chapter's life.
    expect(synced).toHaveLength(1)
    expect(synced[0]).toMatchObject({ id: unhashed!.id, uid: unhashed!.uid, hash: 'sha-01.png' })
  })

  it('keeps two pages whose bytes are identical apart', async () => {
    const context = await aWorkspace()

    // Two blank pages. Honestly one hash, honestly two pages.
    const added = await sync(context, [
      { ...scan('05.png', 0), hash: 'sha-blank' },
      { ...scan('06.png', 1), hash: 'sha-blank' },
    ])

    expect(added).toHaveLength(2)
    expect(new Set(added.map((page) => page.uid)).size).toBe(2)

    // And again, which is where a hash shared by two rows would name neither of
    // them: they have to find their own rows by path, or the chapter loses one.
    const synced = await sync(context, [
      { ...scan('05.png', 0), hash: 'sha-blank', name: 'Blank front' },
      { ...scan('06.png', 1), hash: 'sha-blank', name: 'Blank back' },
    ])

    expect(synced.map((page) => [page.uid, page.path, page.name])).toEqual([
      [added[0]!.uid, '05.png', 'Blank front'],
      [added[1]!.uid, '06.png', 'Blank back'],
    ])
  })
})

/**
 * The other half of the matching rule: a draft that *names itself*.
 *
 * A uid-less draft is a folder held up to be recognised, and everything above
 * is about how well that is done. A draft carrying a uid is not asking — it is
 * a page somebody deliberately put here, minted by the browser as it was
 * dropped, and the server files it under that name rather than hunting for a
 * row with the same picture.
 *
 * The distinction is load-bearing because the fall-through it removes was doing
 * real damage. Dropping a page onto a chapter that already held the same
 * picture silently re-pointed the file at the existing row, which is a
 * *re-link* wearing a drop's clothes — and it made "drop the folder in" the
 * only way a second computer could get its pictures back, since every page
 * there has a row and no file. Re-linking is now its own gesture, aimed at the
 * page it is about, and a drop means what it says.
 */
describe('sync — a page that names itself', () => {
  /**
   * The same picture under another name — a page downloaded twice, or pulled
   * out of a second copy of the chapter. This is the drop the old rule ate: the
   * hash found `01.png`, the draft quietly became it, and the reader who meant
   * "and this one too" got nothing.
   *
   * Two paths rather than one, because `(workspace_id, path)` is unique and
   * means it, and the browser cannot produce a repeat anyway — `appendImages`
   * turns a file away when the chapter already holds its path.
   */
  it('files a dropped page under its own uid rather than a row with the same picture', async () => {
    const context = await aWorkspace()
    const [original] = await aChapter(context, '01.png')

    const minted = crypto.randomUUID()

    const synced = await sync(context, [
      scan('01.png', 0, 'sha-01.png'),
      { ...scan('01 (copy).png', 1, 'sha-01.png'), uid: minted },
    ])

    expect(synced).toHaveLength(2)
    expect(synced.map((page) => page.uid)).toEqual([original!.uid, minted])
  })

  it('does not match a self-named page by path either', async () => {
    const context = await aWorkspace()
    const [original] = await aChapter(context, '01.png')

    // No hash on either side — the case the path fallback exists for, and one a
    // page asserting its own name must still not fall into. The path is the one
    // `01.png` is about to vacate, so the name is free for it to take.
    const synced = await sync(context, [
      { ...scan('01-old.png', 0), uid: original!.uid },
      { ...scan('01.png', 1), uid: crypto.randomUUID() },
    ])

    expect(synced).toHaveLength(2)
    expect(synced.map((page) => page.path)).toEqual(['01-old.png', '01.png'])
  })

  it('still recognises the row a page it has been told about belongs to', async () => {
    const context = await aWorkspace()
    const [original] = await aChapter(context, '01.png')

    // The uid the server handed back, sent again. This is every sync after the
    // first, and it must go on matching or the chapter doubles on every push.
    const synced = await sync(context, [{ ...scan('01.png', 0, 'sha-01.png'), uid: original!.uid }])

    expect(synced).toHaveLength(1)
    expect(synced[0]!.id).toBe(original!.id)
  })

  /**
   * The guard that refuses a whole foreign chapter asks only the drafts that
   * are guessing. Counting a self-named page in the denominator refused the
   * first file dropped onto a chapter opened on a second computer — where the
   * browser holds no pages yet, so there is nothing for the drop to overlap
   * with and the reader is most obviously working on the right chapter.
   */
  it('accepts a page dropped into a chapter whose scans are all elsewhere', async () => {
    const context = await aWorkspace()

    await aChapter(context, '01.png', '02.png')

    const synced = await sync(context, [
      { ...scan('a-page-nobody-here-has-seen.png', 2, 'sha-new'), uid: crypto.randomUUID() },
    ])

    expect(synced).toHaveLength(3)
  })

  it('still refuses a whole chapter that overlaps nothing', async () => {
    const context = await aWorkspace()

    await aChapter(context, '01.png', '02.png')

    await expect(sync(context, [scan('other/01.png', 0, 'sha-other-01'), scan('other/02.png', 1, 'sha-other-02')]))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('sync — what it refuses to do', () => {
  it('leaves a page the browser did not mention exactly where it was', async () => {
    const context = await aWorkspace()
    const [, unmentioned] = await aChapter(context, '01.png', '02.png', '03.png')

    await sync(context, [scan('01.png', 0, 'sha-01.png'), scan('03.png', 1, 'sha-03.png')])

    const kept = (await list(context)).find((page) => page.uid === unmentioned!.uid)

    expect(kept).toMatchObject({ path: '02.png', name: '02', position: 1 })
  })

  it('leaves that page\'s blocks, translations and paint attached to it', async () => {
    const context = await aWorkspace()
    const [, unmentioned] = await aChapter(context, '01.png', '02.png')
    const work = await workDoneOn(unmentioned!, context.workspaceId)

    await sync(context, [scan('01.png', 0, 'sha-01.png')])

    // The whole reason `sync` refuses to remove. A page row leaving takes all
    // of this with it by cascade, and a list that happened to be short is not a
    // reason to lose an evening.
    expect(await whatSurvives(work)).toEqual(ALL_OF_IT)
  })

  it('does not reorder pages it was not told about', async () => {
    const context = await aWorkspace()
    const [first, second, third] = await aChapter(context, '01.png', '02.png', '03.png')

    await sync(context, [scan('03.png', 0, 'sha-03.png')])

    const positions = new Map((await list(context)).map((page) => [page.uid, page.position]))

    // Only the page that was mentioned moved. Renumbering the others to close
    // the gap would be `sync` deciding what the chapter looks like from a list
    // it was told nothing about.
    expect(positions.get(third!.uid)).toBe(0)
    expect(positions.get(first!.uid)).toBe(0)
    expect(positions.get(second!.uid)).toBe(1)
  })

  it('survives a reader who opened only part of the folder', async () => {
    const context = await aWorkspace()
    await aChapter(context, '01.png', '02.png', '03.png', '04.png', '05.png')

    const synced = await sync(context, [scan('02.png', 0, 'sha-02.png'), scan('03.png', 1, 'sha-03.png')])

    // Not an error, and not a two-page chapter: the reply is the whole of what
    // the workspace holds, which is how the browser that opened half a folder
    // finds out about the other half.
    //
    // Sorted, because the order it comes back in is not a fact worth pinning
    // here: the two pages that were mentioned took positions nought and one
    // while the three that were not kept theirs, so three of the five now share
    // a position with somebody and `orderBy` has nothing left to decide with.
    expect(synced.map((page) => page.path).sort()).toEqual([
      '01.png',
      '02.png',
      '03.png',
      '04.png',
      '05.png',
    ])
  })

  it('refuses a scan that would take the name of a page that is staying', async () => {
    const context = await aWorkspace()
    await aChapter(context, '01.png', '02.png')

    // The reader replaced `01.png` with a better scan of the same page and
    // changed nothing else. Since the hashes disagree it is not that page any
    // more, and since `01.png` is not being vacated it cannot be a new one
    // either — there is one name and two scans wanting it.
    //
    // Said plainly, because the alternative is a unique-index violation
    // arriving at the browser as a 500 with a SQL string in it. Nothing here
    // can tell a better scan from a renumber that lost a file on the way, so
    // the answer is to refuse and say which name is contested.
    await expect(sync(context, [
      scan('01.png', 0, 'sha-rescanned'),
      scan('02.png', 1, 'sha-02.png'),
    ])).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('01.png') })

    expect((await list(context)).map((page) => [page.path, page.hash])).toEqual([
      ['01.png', 'sha-01.png'],
      ['02.png', 'sha-02.png'],
    ])
  })

  it('leaves the chapter as it was when one page in the list cannot be filed', async () => {
    const context = await aWorkspace()
    await aChapter(context, '01.png', '02.png')

    // A list that cannot be true: the third scan wants a name the second one
    // has already claimed in the same breath. Whatever the browser did to
    // produce it, only one of them can have it.
    await expect(sync(context, [
      scan('05.png', 0, 'sha-01.png'),
      scan('06.png', 1, 'sha-02.png'),
      { path: '06.png', name: 'twice', position: 2, hash: 'sha-strange' },
    ])).rejects.toThrow()

    // A sync is one claim about what the chapter is, so it lands whole or not
    // at all. Two pages renamed and the third refused is the worst of both: the
    // browser is told it failed and retries against a chapter that has already
    // half-moved underneath it.
    expect((await list(context)).map((page) => [page.path, page.hash])).toEqual([
      ['01.png', 'sha-01.png'],
      ['02.png', 'sha-02.png'],
    ])
  })
})

describe('remove — the path that does delete', () => {
  it('deletes the page a reader asked to remove', async () => {
    const context = await aWorkspace()
    const [, middle] = await aChapter(context, '01.png', '02.png', '03.png')

    await remove(context, middle!.id)

    expect((await list(context)).map((page) => page.path)).toEqual(['01.png', '03.png'])
  })

  it('takes its blocks, and their translations and revisions', async () => {
    const context = await aWorkspace()
    const [doomed, survivor] = await aChapter(context, '01.png', '02.png')
    const doomedWork = await workDoneOn(doomed!, context.workspaceId)
    const survivingWork = await workDoneOn(survivor!, context.workspaceId)

    await remove(context, doomed!.id)

    expect(await whatSurvives(doomedWork)).toMatchObject({ blocks: 0, translations: 0, revisions: 0 })
    expect(await whatSurvives(survivingWork)).toMatchObject({ blocks: 1, translations: 1, revisions: 1 })
  })

  it('takes its layers, surfaces and strokes', async () => {
    const context = await aWorkspace()
    const [doomed] = await aChapter(context, '01.png')
    const work = await workDoneOn(doomed!, context.workspaceId)

    await remove(context, doomed!.id)

    // The chain a drizzle-kit table rebuild once broke silently: the page's
    // stack goes, the surfaces filed under those layers go, and the strokes on
    // those surfaces go with them. Nothing is left pointing at a page that is
    // gone.
    expect(await whatSurvives(work)).toEqual(NONE_OF_IT)
  })

  it('leaves the other pages, and their positions, alone', async () => {
    const context = await aWorkspace()
    const [first] = await aChapter(context, '01.png', '02.png', '03.png')

    await remove(context, first!.id)

    // "Alone" is about the reading order, not the integers: the survivors are
    // still in the order they were opened in, and they close up rather than
    // leaving a hole at nought for the next reorder-by-index to fall into.
    expect((await list(context)).map((page) => [page.path, page.position])).toEqual([
      ['02.png', 0],
      ['03.png', 1],
    ])
  })

  it('refuses a page belonging to another workspace', async () => {
    const context = await aWorkspace()
    const elsewhere = await aWorkspace()
    const [theirs] = await aChapter(elsewhere, '01.png')

    // A 404 rather than a 403, and that is the point: refusing by saying "not
    // yours" would confirm that the id names a page at all.
    await expect(remove(context, theirs!.id)).rejects.toMatchObject({
      statusCode: 404,
      message: 'No such page.',
    })

    expect(await list(elsewhere)).toHaveLength(1)
  })
})

describe('a removed page stays removed', () => {
  it.todo('is not brought back by the next sync that does not mention it')
  it.todo('is not brought back by a sync that does mention it, if the reader removed it')
})

describe('reorder', () => {
  it.todo('puts the pages in the order it was given')
  it.todo('refuses a list that is missing a page, rather than guessing')
  it.todo('refuses ids from another workspace')
  it.todo('leaves the blocks on each page where they were')
})
