import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { db, workspaces } from '~~/server/database'
import { contextFor } from '~~/server/services/access'
import { replace } from '~~/server/services/blocks'
import { list as castList } from '~~/server/services/cast'
import { terms } from '~~/server/services/glossaries'
import { sync as syncPages } from '~~/server/services/pages'
import { putOnPage, revisions } from '~~/server/services/translations'
import { briefFor, saveAnswers } from '~~/server/utils/brief'

/**
 * A brief handed out, answered, and filed — the MCP translation loop end to
 * end, through the two halves that have to agree about it.
 *
 * **Needs the database harness.**
 *
 * `prepare_page_translation` numbers a page's lines and says which of them it is
 * asking about; `save_page_translations` is handed the answer as a bare ordered
 * list and has to put each string on the block it was written for. Everything
 * that went wrong here went wrong *between* the two, which is why neither is
 * tested alone:
 *
 * - the save re-derived the numbering as if every brief had been "again", so a
 *   brief that filled gaps had its context lines written too — finished lines
 *   rewritten, a revision filed against each, where kemolate's own engines read
 *   those answers and throw them away;
 * - a brief about one line asks the model for exactly one answer, and the save
 *   demanded one per numbered line, so the only well-behaved reply was refused;
 * - with the chapter's whole-page setting off the two numbered different lists,
 *   so the token never matched and every positional save was a 409;
 * - and a refusal on the seventh page of a call left six pages written and the
 *   glossary unmerged — a run half filed, and the half that teaches the next
 *   page thrown away.
 *
 * Seam: `briefFor` and `saveAnswers`, the functions the two tools are thin
 * wrappers around — the brief is what an agent is really handed, and the save
 * is what it really calls.
 */

type Ctx = Awaited<ReturnType<typeof aWorkspace>>

const aPage = async (context: Ctx, path = '06.jpg') => {
  const [page] = await syncPages(context, [{ path, name: path, position: 0, hash: `sha-${path}` }])

  return page!
}

/** Two pages, in one sync — a second sync naming none of the first is refused. */
const twoPages = async (context: Ctx) => {
  const [first, second] = await syncPages(context, ['01.jpg', '02.jpg'].map((path, position) =>
    ({ path, name: path, position, hash: `sha-${path}` })))

  return [first!, second!] as const
}

/** Three balloons of Japanese, in reading order. */
const threeLines = async (context: Ctx, pageId: number) => replace(context, pageId, [
  { source: 'こんにちは', cx: 0.2, cy: 0.2, w: 0.1, h: 0.1 },
  { source: 'どうして……', cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 },
  { source: 'さようなら', cx: 0.8, cy: 0.8, w: 0.1, h: 0.1 },
])

/** A line a machine has already finished — unpinned, so a machine could move it. */
const finished = (context: Ctx, pageId: number, blockId: number, text: string) =>
  putOnPage(context, pageId, 'en', [{ blockId, text }], { engine: 'ai-text', model: 'm', batch: 'earlier' })

/** What the line says now, or null where nothing has been written. */
const said = async (blockId: number) =>
  (await db.query.translations.findFirst({ where: { blockId, locale: 'en' } }))?.text ?? null

const brief = (context: Ctx, page: Awaited<ReturnType<typeof aPage>>, ask: { force?: boolean, blockId?: number } = {}) =>
  briefFor(context, page, 'en', { force: ask.force ?? false, blockId: ask.blockId, hasImage: false })

const nothingLearned = { glossary: [], cast: [] }

beforeEach(reset)

describe('a positional save', () => {
  it('writes only the lines the brief asked about, and leaves finished work alone', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a, b, c] = await threeLines(context, page.id)

    await finished(context, page.id, a!.id, 'Hello')

    const job = await brief(context, page)

    // The whole page is numbered, because the model reads it as one scene…
    expect(job.lines.map((line) => line.asked)).toEqual([false, true, true])

    await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['Hi!', 'Why...', 'Goodbye'] }],
      ...nothingLearned,
    })

    // …but only the gaps are filled. The answer for the finished line is read
    // and set aside, as the browser sets it aside.
    expect(await said(a!.id)).toBe('Hello')
    expect(await said(b!.id)).toBe('Why...')
    expect(await said(c!.id)).toBe('Goodbye')

    // Not even a revision: the line was context, not a question.
    expect((await revisions(context, a!.id, 'en')).revisions.map((row) => row.text)).toEqual(['Hello'])
  })

  it('takes the single answer a one-line brief asks for', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a, b, c] = await threeLines(context, page.id)

    await finished(context, page.id, a!.id, 'Hello')
    await finished(context, page.id, b!.id, 'Why...')

    const job = await brief(context, page)

    // The prompt says so in as many words — the save has to agree with it.
    expect(job.prompt).toMatch(/exactly one translation/)

    await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['Goodbye'] }],
      ...nothingLearned,
    })

    expect(await said(c!.id)).toBe('Goodbye')
    expect(await said(a!.id)).toBe('Hello')
    expect(await said(b!.id)).toBe('Why...')
  })

  it('takes the single answer for a block asked about by name', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a, b, c] = await threeLines(context, page.id)

    await finished(context, page.id, b!.id, 'Why...')

    const job = await brief(context, page, { blockId: b!.id })

    await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['How could—'] }],
      ...nothingLearned,
    })

    expect(await said(b!.id)).toBe('How could—')
    expect(await said(a!.id)).toBeNull()
    expect(await said(c!.id)).toBeNull()
  })

  it('matches its own brief when the chapter is not prompted a page at a time', async () => {
    const owner = await aWorkspace()

    await db.update(workspaces).set({ wholePage: false }).where(eq(workspaces.id, owner.workspaceId))

    const context = (await contextFor(owner.workspace.publicId))!
    const page = await aPage(context)
    const [a, b, c] = await threeLines(context, page.id)

    await finished(context, page.id, a!.id, 'Hello')

    const job = await brief(context, page)

    // Only the gaps are numbered here, so the answer is two lines long.
    expect(job.lines.map((line) => line.blockId)).toEqual([b!.id, c!.id])

    await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['Why...', 'Goodbye'] }],
      ...nothingLearned,
    })

    expect(await said(b!.id)).toBe('Why...')
    expect(await said(c!.id)).toBe('Goodbye')
  })

  /*
   * The one answer belongs to the line the brief asked about, not to whatever
   * the page's only gap happens to be by the time the answer lands. Here a
   * second gap opens in between, and the reply is still one line long — as the
   * prompt told it to be.
   */
  it('places a one-line answer on its line even if the page moved on meanwhile', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a, b, c] = await threeLines(context, page.id)

    await finished(context, page.id, a!.id, 'Hello')
    await finished(context, page.id, b!.id, 'Why...')

    const job = await brief(context, page)

    await finished(context, page.id, a!.id, '')

    await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['Goodbye'] }],
      ...nothingLearned,
    })

    expect(await said(c!.id)).toBe('Goodbye')
    expect(await said(a!.id)).toBe('')
  })

  it('leaves a line whose answer came back empty as a gap, and says so', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a, b, c] = await threeLines(context, page.id)

    await finished(context, page.id, a!.id, 'Hello')

    const job = await brief(context, page)

    const reply = await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['Hi!', '  ', 'Goodbye'] }],
      ...nothingLearned,
    })

    expect(await said(b!.id)).toBeNull()
    expect(await said(c!.id)).toBe('Goodbye')
    expect(reply.pages[0]).toMatchObject({ written: 1, setAside: 1, unanswered: [b!.id] })
  })

  /*
   * The guarantee the whole revision table is built around, arriving by the
   * MCP door: "again" from an agent does not un-pin anything, so a typed line
   * keeps its words and the agent's are filed beside them.
   */
  it('holds a typed line against "again", and files the agent\'s wording beside it', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a] = await threeLines(context, page.id)

    // Typed: no origin, so the line is pinned.
    await putOnPage(context, page.id, 'en', [{ blockId: a!.id, text: 'Hey there' }])

    const job = await brief(context, page, { force: true })

    const reply = await saveAnswers(context, {
      pages: [{ pageId: page.id, job: job.job, translations: ['Hi!', 'Why...', 'Goodbye'] }],
      ...nothingLearned,
    })

    expect(await said(a!.id)).toBe('Hey there')
    expect(reply.pages[0]!.heldByHuman).toEqual([a!.id])
    expect((await revisions(context, a!.id, 'en')).revisions.map((row) => row.text)).toContain('Hi!')
  })

  /*
   * "Again" and "fill the gaps" number the same lines on a whole-page chapter
   * and ask different questions about them. A token that could not tell them
   * apart was the save guessing which one it was answering — and it always
   * guessed "again".
   */
  it('names the ask in the token, so "again" still writes over finished lines', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [a] = await threeLines(context, page.id)

    await finished(context, page.id, a!.id, 'Hello')

    const gaps = await brief(context, page)
    const again = await brief(context, page, { force: true })

    expect(again.job).not.toBe(gaps.job)

    await saveAnswers(context, {
      pages: [{ pageId: page.id, job: again.job, translations: ['Hi!', 'Why...', 'Goodbye'] }],
      ...nothingLearned,
    })

    expect(await said(a!.id)).toBe('Hi!')
  })
})

describe('a save of several pages', () => {
  it('writes nothing, and teaches nothing, when one page of it is refused', async () => {
    const context = await aWorkspace()
    const [first, second] = await twoPages(context)
    const [a] = await threeLines(context, first.id)

    await threeLines(context, second.id)

    const one = await brief(context, first)
    const two = await brief(context, second)

    // The second page is read again between the brief and the answer, so its
    // numbering no longer means what it meant.
    await threeLines(context, second.id)

    await expect(saveAnswers(context, {
      pages: [
        { pageId: first.id, job: one.job, translations: ['Hello', 'Why...', 'Goodbye'] },
        { pageId: second.id, job: two.job, translations: ['Hello', 'Why...', 'Goodbye'] },
      ],
      glossary: [{ src: '宗介', tr: 'Sousuke' }],
      cast: [{ name: '宗介', tr: 'Sousuke', gender: 'male' }],
    })).rejects.toMatchObject({ statusCode: 409 })

    // Not the first page either — a run is filed whole or not at all.
    expect(await said(a!.id)).toBeNull()
    expect(await terms(context, 'en')).toEqual([])
    expect((await castList(context)).members).toEqual([])
  })

  it('refuses a miscounted page before writing any other', async () => {
    const context = await aWorkspace()
    const [first, second] = await twoPages(context)
    const [a] = await threeLines(context, first.id)

    await threeLines(context, second.id)

    const one = await brief(context, first)
    const two = await brief(context, second)

    await expect(saveAnswers(context, {
      pages: [
        { pageId: first.id, job: one.job, translations: ['Hello', 'Why...', 'Goodbye'] },
        { pageId: second.id, job: two.job, translations: ['Hello', 'Why...'] },
      ],
      ...nothingLearned,
    })).rejects.toMatchObject({ statusCode: 400 })

    expect(await said(a!.id)).toBeNull()
  })

  it('files a run that validates as one batch, and learns from it', async () => {
    const context = await aWorkspace()
    const [first, second] = await twoPages(context)
    const [a] = await threeLines(context, first.id)
    const [d] = await threeLines(context, second.id)

    const one = await brief(context, first)
    const two = await brief(context, second)

    const reply = await saveAnswers(context, {
      pages: [
        { pageId: first.id, job: one.job, translations: ['Hello', 'Why...', 'Goodbye'] },
        { pageId: second.id, job: two.job, translations: ['Hi', 'How...', 'Bye'] },
      ],
      glossary: [{ src: '宗介', tr: 'Sousuke' }],
      cast: [],
    })

    expect(await said(a!.id)).toBe('Hello')
    expect(await said(d!.id)).toBe('Hi')
    expect(reply.glossary).toMatchObject({ offered: 1, learned: 1 })

    const batches = new Set([
      ...(await revisions(context, a!.id, 'en')).revisions.map((row) => row.batch),
      ...(await revisions(context, d!.id, 'en')).revisions.map((row) => row.batch),
    ])

    expect([...batches]).toEqual([reply.batch])
  })
})
