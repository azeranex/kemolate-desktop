import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { everyLocale, merge } from '~~/server/services/glossaries'

/**
 * Agreeing on a spelling, and keeping one list to agree in.
 *
 * **Needs the database harness.**
 *
 * The glossary is the one part of the translation pipeline that lives on the
 * server, because agreeing on a spelling is exactly what a browser cannot do
 * alone. Two rules carry that: first-translation-wins, so a name settled on
 * page three is not revised on page nine, and one list per language, so the two
 * halves of a chapter cannot each enforce it separately.
 *
 * The second was broken until 2026-08-03 — `primary` was find-or-make across an
 * `await`, so two pages translated at once made two glossaries and the terms
 * split between them. That is the shape these tests exist to catch, and it is
 * not visible in any single-threaded reading of the function.
 *
 * Seam: `primary`, `merge`, `edit`, `terms`.
 */

describe('primary', () => {
  it.todo('makes one glossary for a workspace and a language')
  it.todo('hands two callers racing for the same language the same row')
  it.todo('keeps two languages of one workspace apart')
  it.todo('leaves the rows written before a language was recorded alone')
})

describe('merge — first translation wins', () => {
  it.todo('keeps the first answer when a later page proposes a different one')
  it.todo('fills a term that had no translation yet')
  it.todo('adds a term the list has not seen')
  it.todo('leaves a term somebody pinned exactly as they left it')
  it.todo('folds two spellings that differ only by case into one term')
})

describe('edit', () => {
  it.todo('renames a term')
  it.todo('refuses a rename onto a source the list already holds')
  it.todo('says which term clashed, in a sentence that survives a non-ASCII name')
  it.todo('answers two collaborators renaming onto one source the same way it answers one')
})

/*
 * Every language at once, for a workspace carrying all of itself somewhere else
 * — moving back to local, or a project file. Both used to carry only the
 * language being worked in, and moving back to local then deleted the rest with
 * the server's record.
 */
describe('everyLocale', () => {
  beforeEach(() => reset())

  it('answers with each language\'s terms, and nothing for a language with none', async () => {
    const context = await aWorkspace()

    await merge(context, 'en', [{ src: '宗介', tr: 'Sousuke' }])
    await merge(context, 'id', [{ src: '宗介', tr: 'Sosuke' }, { src: '千鳥', tr: 'Chidori' }])
    await merge(context, 'fr', [])

    const found = await everyLocale(context)

    expect(found.sort((a, b) => a.locale.localeCompare(b.locale))).toEqual([
      { locale: 'en', terms: [{ source: '宗介', target: 'Sousuke' }] },
      { locale: 'id', terms: [{ source: '千鳥', target: 'Chidori' }, { source: '宗介', target: 'Sosuke' }] },
    ])
  })
})
