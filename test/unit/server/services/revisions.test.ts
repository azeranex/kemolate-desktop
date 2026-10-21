import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { db, translations as translationRows } from '~~/server/database'
import { replace } from '~~/server/services/blocks'
import { sync as syncPages } from '~~/server/services/pages'
import { everyRevision, putOnPage, restoreRevisions, revisions } from '~~/server/services/translations'

/**
 * Carrying a line's history out of one install and into another.
 *
 * **Needs the database harness.**
 *
 * The two halves of what a project file does with `translation_revisions`, and
 * they are tested together because the only thing that matters about either is
 * that they compose: an export nobody can import is a file that lies about what
 * it contains.
 *
 * Four decisions carry the weight, and each is one a later reader might
 * reasonably undo:
 *
 * 1. **No row ids cross.** The export names pages by `uid` and blocks by
 *    `position`, and the head by an *index* rather than by the revision id it
 *    is stored under. An id means nothing in the workspace the file is opened
 *    in — that is the failure `useBlockCache.localise` is about, one table over.
 * 2. **Restoring only ever fills an empty history.** It runs late and may run
 *    twice, so anything that appended would duplicate a chapter's history on
 *    the second pass; and a line that has since acquired revisions is a line
 *    somebody has worked on, whose present beats the file's past.
 * 3. **Authorship does not travel.** A user id from another install is a
 *    different person here, or nobody. Nobody is the truth.
 * 4. **The dates do.** A history whose entries all share one timestamp is not a
 *    history.
 *
 * Seam: `everyRevision` and `restoreRevisions`, against each other.
 */

const aPage = async (context: Awaited<ReturnType<typeof aWorkspace>>, path = '06.jpg') => {
  const [page] = await syncPages(context, [{ path, name: path, position: 0, hash: `sha-${path}` }])

  return page!
}

const aBlock = async (context: Awaited<ReturnType<typeof aWorkspace>>, pageId: number, source = 'こんにちは') => {
  const [block] = await replace(context, pageId, [{ source, cx: 0.5, cy: 0.5, w: 0.2, h: 0.1 }])

  return block!
}

beforeEach(reset)

describe('everyRevision', () => {
  it('names the page by uid and the block by the row the exporter already holds', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Hello' }], { engine: 'ai-text', model: 'x' })
    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Hi there' }], { engine: 'ai-text', model: 'x' })

    const held = await everyRevision(context)

    expect(held).toHaveLength(1)
    expect(held[0]!.uid).toBe(page.uid)
    expect(held[0]!.blocks[0]!.blockId).toBe(block.id)
  })

  /*
   * The block id is how the exporter finds which of *its* blocks each history
   * belongs to, and it stops there — the manifest is keyed by the block's index
   * in the page. A revision id would not survive the journey at all, which is
   * why the head is an index; see the test below.
   */
  it('carries no revision id, since the file is opened somewhere else', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Hello' }], { engine: 'ai-text' })

    const [line] = (await everyRevision(context))[0]!.blocks[0]!.lines

    expect(line!.revisions.every((row) => !('id' in row))).toBe(true)
  })

  it('finds the block whatever its position on the page', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [first, second] = await replace(context, page.id, [
      { source: 'one', cx: 0.2, cy: 0.2, w: 0.1, h: 0.1 },
      { source: 'two', cx: 0.6, cy: 0.6, w: 0.1, h: 0.1 },
    ])

    await putOnPage(context, page.id, 'en', [{ blockId: second!.id, text: 'Two' }], { engine: 'ai-text' })

    const held = await everyRevision(context)

    expect(held[0]!.blocks).toHaveLength(1)
    expect(held[0]!.blocks[0]!.blockId).toBe(second!.id)
    expect(held[0]!.blocks[0]!.position).toBe(second!.position)
    expect(first!.position).not.toBe(second!.position)
  })

  it('says which wording is on the page, as an index', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'First' }], { engine: 'ai-text' })
    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Second' }], { engine: 'ai-text' })

    const [line] = (await everyRevision(context))[0]!.blocks[0]!.lines

    expect(line!.revisions.map((row) => row.text)).toEqual(['First', 'Second'])
    expect(line!.revisions[line!.head]!.text).toBe('Second')
  })

  it('leaves out a chapter that has been read but never revised', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)

    await aBlock(context, page.id)

    expect(await everyRevision(context)).toEqual([])
  })
})

describe('restoreRevisions', () => {
  /** A fresh workspace with one translated line and no history behind it. */
  const somewhereElse = async (text = 'Hello') => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    // Written straight to the table, so the line exists with no revisions —
    // which is exactly the state an imported page is in once its translations
    // have synced and before its history has been put back.
    await db.insert(translationRows).values({ blockId: block.id, locale: 'en', text })

    return { context, page, block }
  }

  const history = [
    { text: 'First go', engine: 'ai-text', model: 'm', batch: 'run-1', at: 1_700_000_000_000 },
    { text: 'Better', engine: 'human', model: null, batch: null, at: 1_700_000_100_000 },
  ]

  it('puts a history back on a line that has none', async () => {
    const { context, block } = await somewhereElse()

    const done = await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: true, head: 1, revisions: history },
    ])

    expect(done).toEqual({ filled: 1, skipped: 0 })

    const held = await revisions(context, block.id, 'en')

    expect(held.revisions.map((row) => row.text)).toEqual(['Better', 'First go'])
    expect(held.pinned).toBe(true)
  })

  it('puts the head back on the page, not merely in the list', async () => {
    const { context, block } = await somewhereElse('whatever was there')

    await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: false, head: 0, revisions: history },
    ])

    const held = await revisions(context, block.id, 'en')

    expect(held.revisions.find((row) => row.head)?.text).toBe('First go')

    const row = await db.query.translations.findFirst({ where: { blockId: block.id, locale: 'en' } })

    expect(row!.text).toBe('First go')
  })

  it('keeps the dates, because the dates are the history', async () => {
    const { context, block } = await somewhereElse()

    await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: false, head: 1, revisions: history },
    ])

    const held = await revisions(context, block.id, 'en')
    const at = held.revisions.map((row) => row.at.getTime()).sort()

    expect(at).toEqual([1_700_000_000_000, 1_700_000_100_000])
  })

  it('keeps what produced each wording', async () => {
    const { context, block } = await somewhereElse()

    await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: false, head: 1, revisions: history },
    ])

    const held = await revisions(context, block.id, 'en')
    const first = held.revisions.find((row) => row.text === 'First go')

    expect(first).toMatchObject({ engine: 'ai-text', model: 'm', batch: 'run-1' })
  })

  it('attributes nothing to anybody, since the ids are another install\'s', async () => {
    const { context, block } = await somewhereElse()

    await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: false, head: 1, revisions: history },
    ])

    const held = await revisions(context, block.id, 'en')

    expect(held.revisions.every((row) => row.authorId === null)).toBe(true)
  })

  it('is safe to run twice, which it will be', async () => {
    const { context, block } = await somewhereElse()

    const entry = { blockId: block.id, locale: 'en', pinned: true, head: 1, revisions: history }

    await restoreRevisions(context, [entry])
    const again = await restoreRevisions(context, [entry])

    expect(again).toEqual({ filled: 0, skipped: 1 })
    expect((await revisions(context, block.id, 'en')).revisions).toHaveLength(2)
  })

  /*
   * The failure this whole guard had to be rewritten for, and it dropped every
   * history in every project file.
   *
   * A revision needs a translation row; the browser gets one by syncing the
   * imported page's translations; and `putOnPage` files a revision for every
   * write. So by the time a restore *can* run, the line already has exactly one
   * revision — holding the wording the file was about to restore as its head.
   * A guard refusing on "any rows at all" refused on every line, always.
   */
  it('replaces the single revision the translation sync just made of our own head', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    // Exactly what the import does: the head wording goes up through the
    // ordinary translations path, which files a revision of its own.
    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Better' }])

    expect((await revisions(context, block.id, 'en')).revisions).toHaveLength(1)

    const done = await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: true, head: 1, revisions: history },
    ])

    expect(done).toEqual({ filled: 1, skipped: 0 })

    const held = await revisions(context, block.id, 'en')

    expect(held.revisions.map((row) => row.text)).toEqual(['Better', 'First go'])
    expect(held.revisions.find((row) => row.head)?.text).toBe('Better')
  })

  it('does not replace it when the wording is somebody else\'s', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Something else entirely' }])

    const done = await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: true, head: 1, revisions: history },
    ])

    expect(done).toEqual({ filled: 0, skipped: 1 })
    expect((await revisions(context, block.id, 'en')).revisions.map((row) => row.text))
      .toEqual(['Something else entirely'])
  })

  it('leaves a line somebody has since worked on exactly alone', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Mine' }], { engine: 'human' })

    const done = await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: true, head: 1, revisions: history },
    ])

    expect(done).toEqual({ filled: 0, skipped: 1 })

    const held = await revisions(context, block.id, 'en')

    expect(held.revisions.map((row) => row.text)).toEqual(['Mine'])
  })

  it('skips a line whose translation has not been written yet', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    const done = await restoreRevisions(context, [
      { blockId: block.id, locale: 'en', pinned: false, head: 0, revisions: history },
    ])

    expect(done).toEqual({ filled: 0, skipped: 1 })
  })

  it('refuses a block from another workspace', async () => {
    const { block } = await somewhereElse()
    const elsewhere = await aWorkspace()

    await expect(restoreRevisions(elsewhere, [
      { blockId: block.id, locale: 'en', pinned: false, head: 0, revisions: history },
    ])).rejects.toThrow()
  })
})

describe('out and back', () => {
  it('survives the round trip with its order, its head and its engines', async () => {
    const from = await aWorkspace()
    const fromPage = await aPage(from)
    const fromBlock = await aBlock(from, fromPage.id)

    await putOnPage(from, fromPage.id, 'en', [{ blockId: fromBlock.id, text: 'Draft' }], { engine: 'ai-text', model: 'sonnet' })
    await putOnPage(from, fromPage.id, 'en', [{ blockId: fromBlock.id, text: 'Polished' }], { engine: 'human' })

    const exported = await everyRevision(from)
    const line = exported[0]!.blocks[0]!.lines[0]!

    // The other end: a workspace that has the same page and the same block, its
    // translation synced and its history not yet put back.
    const into = await aWorkspace()
    const intoPage = await aPage(into)
    const intoBlock = await aBlock(into, intoPage.id)

    await db.insert(translationRows).values({ blockId: intoBlock.id, locale: line.locale, text: 'Polished' })

    await restoreRevisions(into, [{
      blockId: intoBlock.id,
      locale: line.locale,
      pinned: line.pinned,
      head: line.head,
      revisions: line.revisions,
    }])

    const held = await revisions(into, intoBlock.id, 'en')

    // Newest first coming back out, which is the order the panel reads.
    expect(held.revisions.map((row) => row.text)).toEqual(['Polished', 'Draft'])
    expect(held.revisions.find((row) => row.head)?.text).toBe('Polished')
    expect(held.revisions.find((row) => row.text === 'Draft')?.model).toBe('sonnet')
    expect(intoPage.uid).not.toBe(fromPage.uid)
  })
})
