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
  workspaces,
} from '~~/server/database'
import { claim, listAll, remove, update } from '~~/server/services/workspaces'

/**
 * Workspaces — desktop: making one, listing them, changing one, and deleting it
 * with everything filed under it.
 *
 * The web build's tests of this service are mostly about people — the owner's
 * row, contributors, who may delete and when — and the desktop has none (see
 * `server/services/workspaces.ts`). What carries over is the part a reader's work
 * depends on: a claim is made once however it is asked, and a delete takes the
 * whole chapter and nothing of anybody else's.
 */

const TABLES = {
  pages: 'pages',
  blocks: 'blocks',
  translations: 'translations',
  revisions: 'translation_revisions',
  layers: 'layers',
  surfaces: 'surfaces',
  strokes: 'strokes',
  repairs: 'repairs',
  glossaries: 'glossaries',
  terms: 'glossary_terms',
  cast: 'cast_members',
  log: 'logs',
} as const

type Rows = Record<keyof typeof TABLES, number>

const names = Object.keys(TABLES) as (keyof typeof TABLES)[]
const every = (count: number) => Object.fromEntries(names.map((name) => [name, count])) as Rows

/** One of everything a workspace can hold, written straight to the tables — the web build's fixture. */
async function aWholeChapter (context: Context): Promise<Rows> {
  const workspaceId = context.workspaceId
  const tag = context.workspace.publicId

  const [page] = await db.insert(pages).values({ workspaceId, uid: crypto.randomUUID(), path: '01.png', name: '01', position: 0, hash: `sha-${tag}` }).returning()
  const [block] = await db.insert(blocks).values({ pageId: page!.id, cx: 0.5, cy: 0.5, w: 0.2, h: 0.1, position: 0, source: '見て' }).returning()
  const [translation] = await db.insert(translations).values({ blockId: block!.id, locale: 'en', text: 'Look' }).returning()
  const [revision] = await db.insert(translationRevisions).values({ translationId: translation!.id, text: 'Look at that', engine: 'ai-text' }).returning()
  const [layer] = await db.insert(layers).values({ workspaceId, pageId: page!.id, uid: 'clean', label: 'Clean', plate: 'clean', position: 0 }).returning()
  const [surface] = await db.insert(surfaces).values({ pageId: page!.id, layerId: layer!.id, key: 'bg' }).returning()
  const [stroke] = await db.insert(strokes).values({ surfaceId: surface!.id, seq: 0, clientId: 'a-tab', tool: 'brush', params: { size: 12 }, points: [0, 0, 1, 1], x: 0, y: 0, w: 1, h: 1 }).returning()
  const [repair] = await db.insert(repairs).values({ pageId: page!.id, blockId: block!.id, key: `patch-${tag}`, hash: '9f'.repeat(32), from: { x: 10, y: 10, w: 40, h: 20 }, box: { x: 6, y: 6, w: 48, h: 28 } }).returning()
  const [glossary] = await db.insert(glossaries).values({ workspaceId, locale: 'en' }).returning()
  const [term] = await db.insert(glossaryTerms).values({ glossaryId: glossary!.id, source: '先輩', target: 'senpai' }).returning()
  const [member] = await db.insert(castMembers).values({ workspaceId, source: '春', names: { en: 'Haru' }, gender: 'female' }).returning()
  const [entry] = await db.insert(logs).values({ workspaceId, userId: null, action: 'workspace.created' }).returning()

  return {
    pages: page!.id,
    blocks: block!.id,
    translations: translation!.id,
    revisions: revision!.id,
    layers: layer!.id,
    surfaces: surface!.id,
    strokes: stroke!.id,
    repairs: repair!.id,
    glossaries: glossary!.id,
    terms: term!.id,
    cast: member!.id,
    log: entry!.id,
  }
}

/** Which of these rows are still there, one count per table. */
function whatSurvives (of: Rows): Rows {
  return Object.fromEntries(names.map((name) => [
    name,
    Number(client.prepare(`SELECT count(*) AS n FROM "${TABLES[name]}" WHERE id = ?`).get(of[name])?.n),
  ])) as Rows
}

const draft = (publicId: string, name = 'Chapter one') => ({ publicId, name })

beforeEach(reset)

describe('remove', () => {
  it('takes the workspace and everything filed under it', async () => {
    const context = await aWorkspace()
    const rows = await aWholeChapter(context)

    expect(whatSurvives(rows)).toEqual(every(1))

    await remove(context)

    expect(whatSurvives(rows)).toEqual(every(0))
    expect(await db.query.workspaces.findFirst({ where: { id: context.workspaceId } })).toBeUndefined()
  })

  it('leaves every other workspace untouched', async () => {
    const doomed = await aWorkspace()
    const kept = await aWorkspace()

    await aWholeChapter(doomed)

    const theirs = await aWholeChapter(kept)

    await remove(doomed)

    expect(whatSurvives(theirs)).toEqual(every(1))
  })
})

describe('claim', () => {
  it('makes a workspace with no owner — there is one person', async () => {
    const made = await claim(draft('w-made'))

    expect(made).toMatchObject({ publicId: 'w-made', name: 'Chapter one' })
    expect(made).not.toHaveProperty('ownerId')
  })

  it('answers the existing one rather than making a second', async () => {
    const first = await claim(draft('w-again'))
    const second = await claim(draft('w-again'))

    expect(second.id).toBe(first.id)
    expect(await db.select().from(workspaces)).toHaveLength(1)
  })

  it('answers two claims at once with one workspace', async () => {
    const [a, b] = await Promise.all([claim(draft('w-race')), claim(draft('w-race'))])

    expect(a.id).toBe(b.id)
    expect(await db.select().from(workspaces)).toHaveLength(1)
  })

  it('does not overwrite a name somebody already set', async () => {
    const first = await claim(draft('w-named', 'The name I chose'))

    await claim(draft('w-named', '6 pages'))

    expect((await db.query.workspaces.findFirst({ where: { id: first.id } }))!.name).toBe('The name I chose')
  })
})

describe('update', () => {
  it('changes what it is asked to and nothing else', async () => {
    const context = await aWorkspace({ name: 'Before' })

    const after = await update(context, { name: 'After', direction: 'ltr' })

    expect(after).toMatchObject({ name: 'After', direction: 'ltr', targetLocale: context.workspace.targetLocale })
  })
})

describe('listAll', () => {
  it('lists every workspace, the most recently changed first, each its owner\'s', async () => {
    const older = await aWorkspace({ name: 'Older' })
    const newer = await aWorkspace({ name: 'Newer' })

    // Seconds apart on the clock the column keeps.
    client.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(1000, older.workspaceId)
    client.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(2000, newer.workspaceId)

    const listed = await listAll()

    expect(listed.map((each) => each.name)).toEqual(['Newer', 'Older'])
    expect(listed.every((each) => each.role === 'owner')).toBe(true)
  })
})
