import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import type { PlacedImage, PresetId, StackLayer } from '#shared/utils/layers'
import type { Context } from '~~/server/services/access'
import type { LayerDraft, PresetDraft } from '~~/server/services/layers'

import { DEFAULT_STACK, LAYER_PRESETS, standardUids } from '#shared/utils/layers'
import { client, db, strokes, surfaces } from '~~/server/database'
import { ensurePlate, preset, stack, sync } from '~~/server/services/layers'
import { remove as removePage, sync as syncPages } from '~~/server/services/pages'

/**
 * The one write that speaks for a whole chapter, and the allowlist that makes
 * it safe.
 *
 * **Needs the database harness.**
 *
 * A stack belongs to a page — `layers.pageId` — so almost everything here is a
 * write about one page and carries its own blast radius. `preset` is the
 * exception: one press sets `visible`, `opacity` and `locked` on the seven
 * standard rows of *every page in the chapter*. That is only defensible because
 * it can do nothing else, and the service is where "nothing else" is enforced.
 *
 * The distinction these tests exist to hold is between the shape of a preset —
 * which is data, and covered in `test/unit/shared/utils/layers.test.ts` — and
 * the server's refusal to *trust* it. `standardUids` is recomputed here rather
 * than taken from the request, so a caller naming somebody's paint sheet gets
 * it dropped rather than applied. A test that only checks the constants would
 * pass while that guard was removed.
 *
 * The second group is the incident. A drizzle-kit table rebuild on `layers`
 * once ran `DROP TABLE` with foreign keys live inside a transaction, which took
 * every `surfaces` row and then every `strokes` row — all the paint in the
 * database, silently, with the migration reporting success. Asserting the
 * cascade is what turns "remember not to do that" into a failing test.
 *
 * Seam: `preset`, `setStack`, and what the database does afterwards.
 */

/** The standard rows as a browser sends them: `DEFAULT_STACK`, flattened parents-first. */
function standardRows (): LayerDraft[] {
  const rows: LayerDraft[] = []

  const walk = (layers: StackLayer[], parentUid: string | null) => {
    layers.forEach((layer, position) => {
      rows.push({
        uid: layer.id,
        parentUid,
        position,
        label: layer.label,
        hint: layer.hint ?? null,
        plate: layer.plate ?? null,
        visible: layer.visible,
        opacity: layer.opacity,
        locked: layer.locked ?? false,
        fixed: layer.fixed ?? false,
      })
      walk(layer.children ?? [], layer.id)
    })
  }

  walk(DEFAULT_STACK, null)

  return rows
}

/*
 * A reader's own rows, one of each kind, named the way the panel names them.
 * Every one belongs to the page it was made on and to no preset — the last is
 * filed *inside* a standard group, where a placed clean lands by default, so
 * the group's eye changes over it while the row itself must not.
 */
const SHEET: LayerDraft = { uid: 'paint:a1b2c3d4', position: 4, label: 'Sketch', visible: true, opacity: 80, paint: true }
const GROUP: LayerDraft = { uid: 'group:c3d4e5f6', position: 5, label: 'Notes', visible: true, opacity: 100 }
const INSIDE: LayerDraft = { uid: 'paint:e5f6a7b8', parentUid: GROUP.uid, position: 0, label: 'Arrows', visible: false, opacity: 60, paint: true }
const LEVELS: LayerDraft = {
  uid: 'adjust:0a1b2c3d',
  position: 6,
  label: 'Levels',
  visible: true,
  opacity: 100,
  adjust: { type: 'levels', inBlack: 10, inWhite: 240, gamma: 1.2, outBlack: 0, outWhite: 255 },
}
const PLACED: LayerDraft = {
  uid: 'image:9a8b7c6d',
  parentUid: 'cleanup',
  position: 2,
  label: '006_clean',
  visible: true,
  opacity: 100,
  image: { hash: 'ab'.repeat(32), ext: 'png', name: '006_clean.png', width: 1754, height: 2480 },
}

const READERS = new Set([SHEET, GROUP, INSIDE, LEVELS, PLACED].map((row) => row.uid))

/** A stage exactly as the panel sends it — see `useLayerPresets.apply`. */
const asked = (id: PresetId): PresetDraft[] =>
  Object.entries(LAYER_PRESETS.find((one) => one.id === id)!.rows).map(([uid, row]) => ({ uid, ...row }))

/** Every layer row in the database, whole, oldest first. */
const allRows = () => client.prepare('SELECT * FROM layers ORDER BY id').all() as Record<string, unknown>[]

/** A row without the three things a preset may set, or the clock that moves when it sets them. */
const shape = ({ visible: _visible, opacity: _opacity, locked: _locked, updated_at: _at, ...rest }: Record<string, unknown>) => rest

type Look = Record<string, { visible: boolean, opacity: number, locked: boolean }>

/** Each row of a page's stack, as a preset sees it: shown or not, how strongly, and whether it is shut. */
async function looks (context: Context, pageId: number): Promise<Look> {
  return Object.fromEntries((await stack(context, pageId)).map((row) => [row.uid, { visible: row.visible, opacity: row.opacity, locked: row.locked }]))
}

/** What a stage should leave a page looking like, from how it looked before. */
function dressedAs (id: PresetId, before: Look): Look {
  const rows = LAYER_PRESETS.find((one) => one.id === id)!.rows

  return Object.fromEntries(Object.entries(before).map(([uid, was]) => {
    const wanted = rows[uid]

    return [uid, wanted ? { visible: wanted.visible, opacity: wanted.opacity ?? was.opacity, locked: wanted.locked ?? was.locked } : was]
  }))
}

/** How `DEFAULT_STACK` looks before anybody has pressed anything. */
const founded = (): Look => Object.fromEntries(standardRows().map((row) => [row.uid, { visible: row.visible, opacity: row.opacity, locked: row.locked ?? false }]))

/**
 * A chapter of four pages, and a second workspace beside it.
 *
 * - `dressed` has the standard stack and a reader's own rows of every kind;
 * - `plain` has the standard stack alone;
 * - `partial` has one standard row and none of the others;
 * - `bare` has no rows at all, which the browser shows as `DEFAULT_STACK`.
 *
 * The other workspace has the standard stack under the same uids, which is
 * what a preset scoped by uid alone would reach into.
 */
async function aChapter () {
  const context = await aWorkspace()
  const [dressed, plain, partial, bare] = await syncPages(context, ['01', '02', '03', '04'].map((name, position) => ({
    path: `${name}.png`,
    name,
    position,
    hash: `sha-${name}`,
  })))

  await sync(context, [...standardRows(), SHEET, GROUP, INSIDE, LEVELS, PLACED], dressed!.id)
  await sync(context, standardRows(), plain!.id)
  await sync(context, standardRows().filter((row) => row.uid === 'dialogue'), partial!.id)

  const other = await aWorkspace()
  const [theirs] = await syncPages(other, [{ path: '01.png', name: '01', position: 0, hash: 'sha-theirs' }])

  await sync(other, standardRows(), theirs!.id)

  return { context, other, theirs: theirs!, dressed: dressed!, plain: plain!, partial: partial!, bare: bare! }
}

/** Every change notice the workspace's room hears from here to the end of the test. */

describe('preset', () => {
  it('dresses the standard rows on every page of the chapter', async () => {
    const { context, dressed, plain, partial } = await aChapter()
    const was = [await looks(context, dressed.id), await looks(context, plain.id), await looks(context, partial.id)]

    // A stage that changes nothing would pass everything below.
    expect(dressedAs('clean', was[1]!)).not.toEqual(was[1])

    await preset(context, asked('clean'), dressed.id)

    expect(await looks(context, dressed.id)).toEqual(dressedAs('clean', was[0]!))
    expect(await looks(context, plain.id)).toEqual(dressedAs('clean', was[1]!))
    expect(await looks(context, partial.id)).toEqual(dressedAs('clean', was[2]!))
  })

  it('drops a row the request named that is not in the allowlist', async () => {
    const { context, dressed } = await aChapter()
    const theirs = () => allRows().filter((row) => READERS.has(row.uid as string))
    const before = theirs()

    await preset(context, [
      ...asked('clean'),
      { uid: SHEET.uid, visible: false, opacity: 0, locked: true },
      { uid: GROUP.uid, visible: false, locked: true },
      { uid: PLACED.uid, visible: false },
    ], dressed.id)

    expect(theirs()).toEqual(before)
  })

  it('leaves a reader\'s own paint sheet exactly as it was', async () => {
    const { context, dressed } = await aChapter()
    const sheet = () => allRows().find((row) => row.uid === SHEET.uid)
    const before = sheet()

    await preset(context, asked('final'), dressed.id)

    expect(sheet()).toEqual(before)
  })

  it('leaves a group a reader added, and its children, where they were', async () => {
    const { context, dressed } = await aChapter()
    const group = () => allRows().filter((row) => row.uid === GROUP.uid || row.uid === INSIDE.uid)
    const before = group()

    await preset(context, asked('read'), dressed.id)

    expect(group()).toEqual(before)
    expect(before.find((row) => row.uid === INSIDE.uid)?.parent_id).toBe(before.find((row) => row.uid === GROUP.uid)?.id)
  })

  it('leaves an adjustment layer alone', async () => {
    const { context, dressed } = await aChapter()
    const levels = () => allRows().find((row) => row.uid === LEVELS.uid)
    const before = levels()

    await preset(context, asked('letter'), dressed.id)

    expect(levels()).toEqual(before)
  })

  /**
   * Read hides the whole Cleanup group, which is how it keeps a placed clean
   * off the page — through the group's eye, the one lever a preset may pull.
   * The picture's own row is the reader's and is not touched.
   */
  it('reaches a reader\'s row inside a standard group only through the group\'s eye', async () => {
    const { context, dressed } = await aChapter()
    const placed = () => allRows().find((row) => row.uid === PLACED.uid)
    const before = placed()

    await preset(context, asked('read'), dressed.id)

    expect(placed()).toEqual(before)
    expect((await looks(context, dressed.id)).cleanup?.visible).toBe(false)
  })

  it('changes no row\'s order or parent, and deletes none', async () => {
    const { context, dressed } = await aChapter()
    const before = allRows()
    const ids = new Set(before.map((row) => row.id))

    await preset(context, asked('final'), dressed.id)

    expect(allRows().filter((row) => ids.has(row.id)).map(shape)).toEqual(before.map(shape))
  })

  it('takes nothing from a row but whether it is shown, how strongly and whether it is shut', async () => {
    const { context, dressed } = await aChapter()
    const before = allRows()

    // What a body with more in it than the schema allows would carry, had it
    // got past the route: a new place, a new parent, a new name, a new job.
    const smuggled = { uid: 'dialogue', visible: false, position: 9, parentUid: 'original', label: 'Renamed', plate: 'art', paint: true }

    await preset(context, [smuggled as PresetDraft], dressed.id)

    const ids = new Set(before.map((row) => row.id))

    expect(allRows().filter((row) => ids.has(row.id)).map(shape)).toEqual(before.map(shape))
    expect((await looks(context, dressed.id)).dialogue?.visible).toBe(false)
  })

  it('adds no row to a page that already has a stack, whole or not', async () => {
    const { context, dressed, plain, partial } = await aChapter()
    const uids = async (pageId: number) => (await stack(context, pageId)).map((row) => row.uid).sort()
    const was = [await uids(dressed.id), await uids(plain.id), await uids(partial.id)]

    await preset(context, asked('clean'), dressed.id)

    expect([await uids(dressed.id), await uids(plain.id), await uids(partial.id)]).toEqual(was)
    expect(was[2]).toEqual(['dialogue'])
  })

  /**
   * The one row a preset may add, and only here: a page with no rows *is*
   * `DEFAULT_STACK` — the browser shows exactly that for it — so writing those
   * rows down changes nothing about what the page is made of. Without it, a
   * chapter read through and then set to Clean was Clean only on the pages
   * somebody had painted.
   */
  it('gives a page with no stack at all the default one, and dresses it', async () => {
    const { context, bare } = await aChapter()

    expect(await stack(context, bare.id)).toEqual([])

    await preset(context, asked('clean'), bare.id)

    const rows = await stack(context, bare.id)
    const byId = new Map(rows.map((row) => [row.id, row.uid]))

    expect(new Set(rows.map((row) => row.uid))).toEqual(standardUids())
    expect(Object.fromEntries(rows.map((row) => [row.uid, row.parentId === null ? null : byId.get(row.parentId)])))
      .toEqual(Object.fromEntries(standardRows().map((row) => [row.uid, row.parentUid ?? null])))
    expect(await looks(context, bare.id)).toEqual(dressedAs('clean', founded()))
  })

  it('writes nothing, and founds nothing, when the request names no standard row', async () => {
    const { context, dressed, bare } = await aChapter()
    const before = allRows()

    await preset(context, [{ uid: SHEET.uid, visible: false }], dressed.id)

    expect(allRows()).toEqual(before)
    expect(await stack(context, bare.id)).toEqual([])
  })

  it('reaches no other workspace, though its rows carry the same uids', async () => {
    const { context, other, dressed } = await aChapter()
    const theirs = () => allRows().filter((row) => row.workspace_id === other.workspaceId)
    const before = theirs()

    await preset(context, asked('clean'), dressed.id)

    expect(before.length).toBe(standardRows().length)
    expect(theirs()).toEqual(before)
  })
})

describe('a page owns its stack', () => {
  it('founds a page that has never been dressed with the default stack', async () => {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.png', name: '01', position: 0, hash: 'sha-01' }])

    await ensurePlate(context, 'mask', page!.id)

    const rows = await stack(context, page!.id)
    const byId = new Map(rows.map((row) => [row.id, row.uid]))

    expect(Object.fromEntries(rows.map((row) => [row.uid, row.parentId === null ? null : byId.get(row.parentId)])))
      .toEqual(Object.fromEntries(standardRows().map((row) => [row.uid, row.parentUid ?? null])))
  })

  it('keeps two pages\' stacks independent', async () => {
    const context = await aWorkspace()
    const [one, two] = await syncPages(context, [
      { path: '01.png', name: '01', position: 0, hash: 'sha-01' },
      { path: '02.png', name: '02', position: 1, hash: 'sha-02' },
    ])

    await sync(context, [...standardRows(), SHEET], one!.id)
    await sync(context, standardRows(), two!.id)

    const twoBefore = allRows().filter((row) => row.page_id === two!.id)

    // Page one hides its dialogue and drops its sheet; page two hears nothing of it.
    await sync(context, standardRows().map((row) => (row.uid === 'dialogue' ? { ...row, visible: false } : row)), one!.id)

    expect((await stack(context, one!.id)).map((row) => row.uid)).not.toContain(SHEET.uid)
    expect(allRows().filter((row) => row.page_id === two!.id)).toEqual(twoBefore)
  })

  it('writes nothing to a page in another workspace', async () => {
    const { context: stranger } = await aChapter()
    const owner = await aWorkspace()
    const [theirs] = await syncPages(owner, [{ path: '01.png', name: '01', position: 0, hash: 'sha-owned' }])

    await sync(owner, standardRows(), theirs!.id)

    const before = allRows()

    expect(await sync(stranger, [...standardRows(), SHEET], theirs!.id)).toEqual([])
    expect(allRows()).toEqual(before)
  })
})

/**
 * The paint a page carries, filed the way `paint.surfaceFor` files it: one
 * surface on the Cleaned plate and one on the reader's sheet, a mark on each.
 */
async function paintOn (context: Context, pageId: number) {
  const layer = (uid: string) => allRows().find((row) => row.page_id === pageId && row.uid === uid)!.id as number

  const [plate, sheet] = await db.insert(surfaces).values([
    { pageId, layerId: layer('clean'), key: 'bg' },
    { pageId, layerId: layer(SHEET.uid), key: SHEET.uid },
  ]).returning()

  const mark = { seq: 0, clientId: 'a-tab', tool: 'brush' as const, params: { size: 12 }, points: [0, 0, 1, 1], x: 0, y: 0, w: 1, h: 1 }

  const [onPlate, onSheet] = await db.insert(strokes).values([
    { ...mark, surfaceId: plate!.id },
    { ...mark, surfaceId: sheet!.id },
  ]).returning()

  return { plate: plate!.id, sheet: sheet!.id, onPlate: onPlate!.id, onSheet: onSheet!.id }
}

const surfaceIds = () => client.prepare('SELECT id FROM surfaces ORDER BY id').all().map((row) => row.id)
const strokeIds = () => client.prepare('SELECT id FROM strokes ORDER BY id').all().map((row) => row.id)

/** Two painted pages, each with the standard stack and a sheet of its own. */
async function twoPaintedPages () {
  const context = await aWorkspace()
  const [one, two] = await syncPages(context, [
    { path: '01.png', name: '01', position: 0, hash: 'sha-01' },
    { path: '02.png', name: '02', position: 1, hash: 'sha-02' },
  ])

  await sync(context, [...standardRows(), SHEET], one!.id)
  await sync(context, [...standardRows(), SHEET], two!.id)

  return { context, one: one!, two: two!, paintOne: await paintOn(context, one!.id), paintTwo: await paintOn(context, two!.id) }
}

describe('what a delete takes with it — the 2026-08-01 incident', () => {
  it('deleting a layer takes its surfaces', async () => {
    const { context, one, paintOne } = await twoPaintedPages()

    // The browser stops mentioning the sheet: somebody removed it.
    await sync(context, standardRows(), one.id)

    expect(surfaceIds()).not.toContain(paintOne.sheet)
  })

  it('deleting a surface takes its strokes', async () => {
    const { paintOne } = await twoPaintedPages()

    await db.delete(surfaces).where(eq(surfaces.id, paintOne.plate))

    expect(strokeIds()).not.toContain(paintOne.onPlate)
  })

  it('deleting a layer therefore takes the strokes under it', async () => {
    const { context, one, paintOne } = await twoPaintedPages()

    await sync(context, standardRows(), one.id)

    expect(strokeIds()).not.toContain(paintOne.onSheet)
  })

  it('deleting a page takes its layers and everything filed beneath them', async () => {
    const { context, one, paintOne } = await twoPaintedPages()

    await removePage(context, one.id)

    expect(allRows().filter((row) => row.page_id === one.id)).toEqual([])
    expect(surfaceIds()).not.toContain(paintOne.plate)
    expect(strokeIds()).not.toContain(paintOne.onPlate)
  })

  it('leaves another page\'s paint untouched', async () => {
    const { context, one, paintOne, paintTwo } = await twoPaintedPages()

    await sync(context, standardRows(), one.id)

    // Page two's sheet shares the uid of the one that went, and keeps
    // everything; page one keeps the retouching on the plate that stayed.
    expect(surfaceIds()).toEqual(expect.arrayContaining([paintOne.plate, paintTwo.plate, paintTwo.sheet]))
    expect(strokeIds()).toEqual(expect.arrayContaining([paintOne.onPlate, paintTwo.onPlate, paintTwo.onSheet]))
  })
})

/**
 * A placed image survives the round trip, which is the whole reason
 * `layers.image` is a column.
 *
 * A stack is written up and read back *whole* — `useLayerSync.build`
 * reconstructs the tree from these columns and assigns it over whatever the tab
 * was holding. So a row whose reference the server cannot keep does not merely
 * fail to sync: it comes back as an ordinary empty row and takes the reference
 * with it, on the next reload of a shared workspace, silently. The bytes are
 * still on the reader's disk and nothing can name them any more.
 *
 * Which is the same failure the block cache was written for, one table over.
 *
 * What is stored is the reference and never the picture — a hash, a type, a
 * name and a size. That is what makes this column allowed to exist at all: the
 * pixels stay in the browser's own filesystem, keyed by that hash, exactly as a
 * scan does.
 */
const CLEAN: PlacedImage = {
  hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ext: 'png',
  name: '006_clean.png',
  width: 1754,
  height: 2480,
}

const row = (extra: Partial<LayerDraft> = {}): LayerDraft => ({
  uid: 'image:a1b2c3d4',
  position: 0,
  label: '006_clean',
  visible: true,
  opacity: 100,
  ...extra,
})

beforeEach(reset)

describe('a placed image on a stack row', () => {
  const aPage = async () => {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '06.jpg', name: '06', position: 0, hash: 'sha-06' }])

    return { context, page: page! }
  }

  it('comes back exactly as it went up', async () => {
    const { context, page } = await aPage()

    await sync(context, [row({ image: CLEAN })], page.id)

    const [held] = await stack(context, page.id)

    expect(held!.image).toEqual(CLEAN)
  })

  it('survives the stack being written again, which is every settle', async () => {
    const { context, page } = await aPage()

    await sync(context, [row({ image: CLEAN })], page.id)
    await sync(context, [row({ image: CLEAN, label: 'renamed' })], page.id)

    const [held] = await stack(context, page.id)

    expect(held!.label).toBe('renamed')
    expect(held!.image).toEqual(CLEAN)
  })

  /**
   * The row is an upsert keyed on `uid`, so this is a reader clearing the
   * picture off a layer rather than a write that forgot to mention it.
   */
  it('is cleared when a row comes back without one', async () => {
    const { context, page } = await aPage()

    await sync(context, [row({ image: CLEAN })], page.id)
    await sync(context, [row()], page.id)

    const [held] = await stack(context, page.id)

    expect(held!.image).toBeNull()
  })

  it('leaves an ordinary row with no picture on it', async () => {
    const { context, page } = await aPage()

    await sync(context, [row({ uid: 'dialogue', plate: 'dialogue', label: 'Dialogue' })], page.id)

    const [held] = await stack(context, page.id)

    expect(held!.image).toBeNull()
  })

  /** Two pages, two stacks — a picture placed on one is not on the other. */
  it('stays on the page it was placed on', async () => {
    const context = await aWorkspace()
    const pages = await syncPages(context, [
      { path: '06.jpg', name: '06', position: 0, hash: 'sha-06' },
      { path: '07.jpg', name: '07', position: 1, hash: 'sha-07' },
    ])

    await sync(context, [row({ image: CLEAN })], pages[0]!.id)
    await sync(context, [row({ uid: 'dialogue', plate: 'dialogue', label: 'Dialogue' })], pages[1]!.id)

    expect((await stack(context, pages[0]!.id))[0]!.image).toEqual(CLEAN)
    expect((await stack(context, pages[1]!.id)).map((one) => one.image)).toEqual([null])
  })
})

/**
 * Founding a page's stack is a write about that page, so the page has to be
 * this workspace's.
 *
 * `ensurePlate` took the page id from the request body on trust. An editor of
 * any workspace could name another workspace's page and found a stack on it
 * under their own workspace — and since `(page_id, uid)` is unique, the page's
 * real owner then could not found theirs: every visit to that page failed.
 */
describe('founding a stack', () => {
  const aPage = async () => {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '07.jpg', name: '07', position: 0, hash: 'sha-07' }])

    return { context, page: page! }
  }

  it('founds the plate on a page of this workspace', async () => {
    const { context, page } = await aPage()

    const layer = await ensurePlate(context, 'clean', page.id)

    expect(layer.pageId).toBe(page.id)
  })

  it('refuses a page in another workspace, and leaves it foundable by its own', async () => {
    const { context, page } = await aPage()
    const stranger = await aWorkspace()

    await expect(ensurePlate(stranger, 'clean', page.id)).rejects.toMatchObject({ statusCode: 404 })

    const layer = await ensurePlate(context, 'clean', page.id)

    expect(layer.pageId).toBe(page.id)
  })
})
