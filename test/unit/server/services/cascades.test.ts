import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import type { Context } from '~~/server/services/access'

import {
  blocks,
  castMembers,
  client,
  db,
  glossaries,
  glossaryTerms,
  layers,
  logs,
  pages,
  repairs,
  strokes,
  surfaces,
  translationRevisions,
  translations,
} from '~~/server/database'
import { remove as removeBlock } from '~~/server/services/blocks'
import { remove as removePage } from '~~/server/services/pages'
import { remove as removeWorkspace } from '~~/server/services/workspaces'

/**
 * What a delete takes with it — exactly, in every table, and nothing more.
 *
 * **Needs the database harness.**
 *
 * The three deletes a reader can reach — a page, a balloon, a whole workspace
 * — each take their rows by cascade, and the foreign keys are pinned one by
 * one in `test/unit/server/database/foreign-keys.test.ts`. What that cannot
 * say is how the chain plays out: which rows a page actually drags with it
 * three tables down, and that the chain stops where it should. The tests in
 * `pages.test.ts` and `workspaces.test.ts` count the tables their authors
 * thought of. These count all of them.
 *
 * ## A census, not a checklist
 *
 * Every row of every table in the schema is listed by rowid before the delete
 * and after it, and what went is compared with what was expected to — whole,
 * so a row that should have stayed and did not is named as plainly as one
 * that should have gone and did not. The tables are read from `sqlite_master`
 * rather than listed, and the fixture puts at least one row in each, so a
 * table added later is part of the claim without anybody remembering it; the
 * first case below fails until the fixture says what a delete should do to it.
 *
 * Desktop: the same census over the desktop's tables — there are no people,
 * keys or invitations, and a workspace has nobody in it but its owner.
 *
 * The fixture is written straight to the tables, for the reason
 * `workspaces.test.ts` gives: what is pinned is which rows hang off which, not
 * the rules of the services that normally write them.
 */

type Ids = Record<string, number[]>

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)

/** Every row in every table, by rowid — the whole database, not the tables somebody thought to list. */
function census (): Ids {
  const tables = client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'test_migrations' ORDER BY name`)
    .all()
    .map((row) => row.name as string)

  return Object.fromEntries(tables.map((table) => [
    table,
    client.prepare(`SELECT rowid AS id FROM "${table}" ORDER BY rowid`).all().map((row) => row.id as number),
  ]))
}

/** What went between two censuses, by table. Tables that lost nothing are left out. */
function lost (before: Ids, after: Ids): Ids {
  const gone: Ids = {}

  for (const [table, ids] of Object.entries(before)) {
    const left = new Set(after[table] ?? [])
    const missing = ids.filter((id) => !left.has(id))

    if (missing.length) gone[table] = missing
  }

  return gone
}

/** Two sets of rows as one — what a workspace delete takes is every page's and its own. */
function merged (...all: Ids[]): Ids {
  const out: Ids = {}

  for (const ids of all) {
    for (const [table, rows] of Object.entries(ids)) out[table] = sorted([...(out[table] ?? []), ...rows])
  }

  return out
}

/**
 * One page with everything a page can carry, and where it all is.
 *
 * A balloon with two columns and a loose block beside it; a translation with
 * a history on each; a group in the stack with a sheet inside it; two surfaces
 * on that sheet — one filed under the balloon, one the page's own retouching —
 * with a mark on each; and a repair for the balloon and one for the page.
 *
 * `balloon` is the part of it a balloon's delete should take: itself, its
 * columns, its words, the surface cleaning it and the mark on that, and its
 * repair — and none of the page's own or the loose block's.
 */
async function workOn (context: Context, path: string) {
  const workspaceId = context.workspaceId

  const [page] = await db.insert(pages).values({
    workspaceId,
    uid: crypto.randomUUID(),
    path,
    name: path,
    position: 0,
    hash: `sha-${context.workspace.publicId}-${path}`,
  }).returning()

  const pageId = page!.id
  const box = { cx: 0.5, cy: 0.5, w: 0.2, h: 0.1 }

  const [parent] = await db.insert(blocks).values({ pageId, ...box, position: 0, source: '見てよ' }).returning()
  const columns = await db.insert(blocks).values([
    { pageId, parentId: parent!.id, ...box, position: 0, source: '見て' },
    { pageId, parentId: parent!.id, ...box, position: 1, source: 'よ' },
  ]).returning()
  const [loose] = await db.insert(blocks).values({ pageId, ...box, position: 1, source: 'ドン' }).returning()

  const [said, shouted] = await db.insert(translations).values([
    { blockId: parent!.id, locale: 'en', text: 'Look!' },
    { blockId: loose!.id, locale: 'en', text: 'BOOM' },
  ]).returning()

  const [before, bang] = await db.insert(translationRevisions).values([
    { translationId: said!.id, text: 'Look at that', engine: 'ai-text' },
    { translationId: shouted!.id, text: 'BAM', engine: 'ai-text' },
  ]).returning()

  const [group] = await db.insert(layers).values({ workspaceId, pageId, uid: 'cleanup', label: 'Cleanup', position: 0 }).returning()
  const [sheet] = await db.insert(layers).values({
    workspaceId,
    pageId,
    parentId: group!.id,
    uid: 'clean',
    label: 'Cleaned plate',
    plate: 'clean',
    position: 0,
  }).returning()

  const [cleaning, retouching] = await db.insert(surfaces).values([
    { pageId, layerId: sheet!.id, blockId: parent!.id, key: `block-${parent!.id}` },
    { pageId, layerId: sheet!.id, key: 'bg' },
  ]).returning()

  const mark = { seq: 0, clientId: 'a-tab', tool: 'brush' as const, params: { size: 12 }, points: [0, 0, 1, 1], x: 0, y: 0, w: 1, h: 1 }
  const [cleaned, retouched] = await db.insert(strokes).values([
    { ...mark, surfaceId: cleaning!.id },
    { ...mark, surfaceId: retouching!.id },
  ]).returning()

  const rect = { x: 10, y: 10, w: 40, h: 20 }
  const [repaired, patched] = await db.insert(repairs).values([
    { pageId, blockId: parent!.id, key: `patch-${parent!.id}`, hash: 'a1'.repeat(32), from: rect, box: rect },
    { pageId, key: `patch-page-${pageId}`, hash: 'b2'.repeat(32), from: rect, box: rect },
  ]).returning()

  const rows: Ids = {
    pages: [pageId],
    blocks: sorted([parent!.id, ...columns.map((column) => column.id), loose!.id]),
    translations: sorted([said!.id, shouted!.id]),
    translation_revisions: sorted([before!.id, bang!.id]),
    layers: sorted([group!.id, sheet!.id]),
    surfaces: sorted([cleaning!.id, retouching!.id]),
    strokes: sorted([cleaned!.id, retouched!.id]),
    repairs: sorted([repaired!.id, patched!.id]),
  }

  const balloon: Ids = {
    blocks: sorted([parent!.id, ...columns.map((column) => column.id)]),
    translations: [said!.id],
    translation_revisions: [before!.id],
    surfaces: [cleaning!.id],
    strokes: [cleaned!.id],
    repairs: [repaired!.id],
  }

  return { pageId, parentId: parent!.id, rows, balloon }
}

/** What belongs to the workspace rather than to any page of it. */
async function workspaceThings (context: Context): Promise<Ids> {
  const workspaceId = context.workspaceId

  const [glossary] = await db.insert(glossaries).values({ workspaceId, locale: 'en' }).returning()
  const [term] = await db.insert(glossaryTerms).values({ glossaryId: glossary!.id, source: '先輩', target: 'senpai' }).returning()
  const [member] = await db.insert(castMembers).values({ workspaceId, source: '春', names: { en: 'Haru' }, gender: 'female' }).returning()
  const [entry] = await db.insert(logs).values({ workspaceId, userId: null, action: 'workspace.created' }).returning()

  return {
    glossaries: [glossary!.id],
    glossary_terms: [term!.id],
    cast_members: [member!.id],
    logs: [entry!.id],
  }
}

/**
 * Two workspaces, each with two pages of work and a record of their own; a
 * second person in the first; and everything each person keeps outside any
 * workspace. Every table in the schema ends up holding something, so a delete
 * that reached too far has something to take.
 */
async function aDatabase () {
  const owner = await aWorkspace()
  const other = await aWorkspace()

  const doomed = await workOn(owner, '01.png')
  const beside = await workOn(owner, '02.png')
  const elsewhere = await workOn(other, '01.png')

  const ownWork = await workspaceThings(owner)

  await workspaceThings(other)

  return { owner, other, doomed, beside, elsewhere, ownWork }
}

beforeEach(reset)

describe('the census', () => {
  it('finds rows in every table the schema has, so "nothing more" is a claim about all of them', async () => {
    await aDatabase()

    const empty = Object.entries(census()).filter(([, ids]) => !ids.length).map(([table]) => table)

    expect(empty).toEqual([])
  })
})

describe('deleting a page', () => {
  it('takes exactly what was filed under it, in every table, and nothing else', async () => {
    const { owner, doomed } = await aDatabase()
    const before = census()

    await removePage(owner, doomed.pageId)

    // The page beside it, the other workspace, the glossary, the people and
    // their keys are all in `before` and all absent from this.
    expect(lost(before, census())).toEqual(doomed.rows)
  })
})

describe('deleting a balloon', () => {
  it('takes its columns, its words, its cleaning and its repair — and nothing of the page\'s', async () => {
    const { owner, doomed } = await aDatabase()
    const before = census()

    await removeBlock(owner, doomed.parentId)

    expect(lost(before, census())).toEqual(doomed.balloon)
  })
})

describe('deleting a workspace', () => {
  it('takes exactly its own rows, in every table, and nothing else', async () => {
    const { owner, doomed, beside, ownWork } = await aDatabase()

    const before = census()

    await removeWorkspace(owner)

    expect(lost(before, census())).toEqual(merged(
      doomed.rows,
      beside.rows,
      ownWork,
      { workspaces: [owner.workspaceId] },
    ))
  })
})
