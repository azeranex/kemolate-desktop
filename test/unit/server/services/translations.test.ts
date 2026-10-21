import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { aWorkspace, reset } from '../harness'

import type { TranslationRevision } from '~~/server/database'
import type { TranslationOrigin } from '~~/server/services/translations'

import { client, db } from '~~/server/database'
import { replace } from '~~/server/services/blocks'
import { sync as syncPages } from '~~/server/services/pages'
import { chooseRevision, deleteRevision, putOnPage, revertBatch, revisions, unpin } from '~~/server/services/translations'

/**
 * The rules that protect a translator's words.
 *
 * **Needs the database harness** — `translations.ts` imports `db`, so none of
 * this can run until a temp SQLite file with the migrations applied can be
 * stood up and torn down per suite.
 *
 * This is the seam where the most expensive mistakes live. Every rule below is
 * currently enforced by code and argued in prose, and checked by nothing: the
 * review on 2026-08-03 found four separate defects in this one function, and
 * each was found by reading rather than by a failure. The revisions table
 * exists so that no wording is ever lost; these are the tests that say so.
 *
 * Seam: `putOnPage`, `revertBatch`, `unpin` — the service's public calls, not
 * their internals. A test that reaches for `boxOf` or the transaction body is
 * testing the implementation and will break on the next refactor.
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

/**
 * A wording keeps its author — `chooseRevision` already says so, and this is
 * the same rule arriving by the sync instead of by the panel.
 *
 * Written for a hole somebody fell into: pressing Undo after typing over a
 * model's line reverts the block locally, and the sync sends that text with no
 * origin — it has no way to know it is a reversion. Filed as a fresh `human`
 * write, the model's own words came back labelled "Typed", and a quick undo
 * inside the coalesce window was worse: it *amended* the typed revision into
 * the restored text, so the wording being undone vanished from the history the
 * table exists to keep.
 *
 * Seam: `putOnPage` with no origin, against `revisions` — what the panel shows.
 */
describe('putOnPage — an old wording put back is not a new one', () => {
  it('credits an undo to the engine that wrote the words, and files no new revision', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'th', [{ blockId: block.id, text: 'ปาฏิหาริย์แท้ๆ' }], { engine: 'ai-text', model: 'claude-sonnet-5' })
    await putOnPage(context, page.id, 'th', [{ blockId: block.id, text: 'ปาฏิหาริย์โดยแท้' }])

    // The undo: the model's exact words come back through the sync, origin-less.
    const [head] = await putOnPage(context, page.id, 'th', [{ blockId: block.id, text: 'ปาฏิหาริย์แท้ๆ' }])

    expect(head!.engine).toBe('ai-text')
    expect(head!.model).toBe('claude-sonnet-5')
    // Still held: putting a wording back is as deliberate as typing one.
    expect(head!.pinned).toBe(true)

    const { revisions: held } = await revisions(context, block.id, 'th')

    // Two wordings, not three — and the typed one survives the undo, which is
    // the coalesce-window half of the bug: a quick undo used to amend it away.
    expect(held).toHaveLength(2)
    expect(held.map((revision) => revision.text)).toContain('ปาฏิหาริย์โดยแท้')

    // The head points at the model's revision, so the panel's tick sits on it.
    expect(held.find((revision) => revision.head)?.engine).toBe('ai-text')
  })
})

type Context = Awaited<ReturnType<typeof aWorkspace>>

/** A machine run as a Translate press sends one: its engine, its model, and the batch that names the whole press. */
const run = (batch: string): TranslationOrigin => ({ engine: 'ai-text', model: 'claude-sonnet-5', batch })

/**
 * Several blocks on one page, read at once. `aBlock` replaces whatever the page
 * holds — that is what a reading does — so calling it twice would leave one.
 */
async function blocksOn (context: Context, pageId: number, count: number) {
  return replace(context, pageId, Array.from({ length: count }, (_, index) => ({
    source: `台詞${index}`,
    cx: 0.5,
    cy: 0.1 + index * 0.2,
    w: 0.2,
    h: 0.1,
  })))
}

/** A line as the database holds it: its head, and every wording it has had, oldest first. */
async function line (blockId: number, locale = 'th') {
  const head = await db.query.translations.findFirst({ where: { blockId, locale } })
  const history = head
    ? await db.query.translationRevisions.findMany({ where: { translationId: head.id }, orderBy: { id: 'asc' } })
    : []

  return { head: head!, history }
}

/** What each wording says, what made it, and in which run — the part these rules are about. */
const said = (history: TranslationRevision[]) => history.map((row) => [row.text, row.engine, row.batch])

/** The wording the head says it is showing. */
const shown = ({ head, history }: Awaited<ReturnType<typeof line>>) => history.find((row) => row.id === head.revisionId)

/**
 * Whether somebody has claimed the line — read the way every reader reads it.
 *
 * `pinned` is nullable (see the schema: a nullable add was the one shape SQLite
 * would make in place), so a line nothing but a machine has touched holds null
 * rather than false. The rule is `=== true`, never truthiness.
 */
const claimed = (head: { pinned: boolean | null }) => head.pinned === true

/** One line's words, as a caller hands them over. */
const words = (blockId: number, text: string, extra: object = {}) => ({ blockId, text, ...extra })

/** A line to work on, and its page — the shape nearly every case starts from. */
async function aLine () {
  const context = await aWorkspace()
  const page = await aPage(context)
  const block = await aBlock(context, page.id)

  return { context, page, block }
}

describe('putOnPage — a person\'s choice wins', () => {
  it('files a revision for a machine run but leaves a pinned head alone', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])
    await putOnPage(context, page.id, 'th', [words(block.id, 'ของเครื่อง')], run('b1'))

    const held = await line(block.id)

    expect(held.head).toMatchObject({ text: 'ของฉันเอง', engine: 'human', pinned: true })
    expect(said(held.history)).toEqual([['ของฉันเอง', 'human', null], ['ของเครื่อง', 'ai-text', 'b1']])
    expect(shown(held)?.text).toBe('ของฉันเอง')
  })

  it('writes nothing at all to a pinned row — not text, not style, not geometry', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง', { style: { size: 42, bold: true }, cx: 0.4, cy: 0.3, w: 0.25, h: 0.2 })])

    const { head: before } = await line(block.id)

    // A run carrying a browser's stale copy of everything about the row: other
    // words, no lettering, and the balloon somewhere else entirely.
    await putOnPage(context, page.id, 'th', [words(block.id, 'ของเครื่อง', { style: null, cx: 0.9, cy: 0.9, w: 0.1, h: 0.1 })], run('b1'))

    expect((await line(block.id)).head).toEqual(before)
  })

  it('pins a line the moment somebody types it', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])

    // Desktop: nobody to sign it — `authorId` is null for the one person there is.
    expect((await line(block.id)).head).toMatchObject({ pinned: true, engine: 'human', authorId: null })
  })

  it('lets a run replace a typed line only after it has been un-pinned', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])
    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่างแรก')], run('b1'))

    expect((await line(block.id)).head.text).toBe('ของฉันเอง')

    // "Translate page again": un-pin first, because that press is the ask.
    await unpin(context, [block.id], 'th')
    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่างสอง')], run('b2'))

    const moved = await line(block.id)

    expect(moved.head).toMatchObject({ text: 'ร่างสอง', engine: 'ai-text', model: 'claude-sonnet-5' })
    expect(claimed(moved.head)).toBe(false)
    expect(said(moved.history)).toEqual([['ของฉันเอง', 'human', null], ['ร่างแรก', 'ai-text', 'b1'], ['ร่างสอง', 'ai-text', 'b2']])
    expect(shown(moved)?.text).toBe('ร่างสอง')
  })

  it('files a run under its own engine rather than as a person', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง')], run('b1'))

    const drafted = await line(block.id)

    expect(drafted.head).toMatchObject({ engine: 'ai-text', model: 'claude-sonnet-5' })
    expect(claimed(drafted.head)).toBe(false)
    expect(drafted.history.map((row) => [row.engine, row.model, row.batch])).toEqual([['ai-text', 'claude-sonnet-5', 'b1']])
  })

  /**
   * A keystroke landing in the gap between a run's first read of the page and
   * its transaction. The first read says "unpinned"; by the time the run
   * writes, somebody has typed the line and pinned it. Trusting the first read
   * wrote the draft over their words and left `pinned` standing — a machine
   * wording wearing a person's claim, which no later pass would move.
   *
   * The gap is made rather than waited for: the run's read of the line comes
   * back, and before the run is handed it the person's write goes through, by
   * the same service a keystroke reaches.
   */
  it('keeps the pin decision taken inside the transaction, not before it', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่างเดิม')], run('b0'))

    const read = db.query.translations.findMany.bind(db.query.translations)

    const gap = vi.spyOn(db.query.translations, 'findMany').mockImplementationOnce(((config: Parameters<typeof read>[0]) =>
      Promise.resolve(read(config)).then(async (rows) => {
        await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])

        return rows
      })) as never)

    onTestFinished(() => gap.mockRestore())

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่างใหม่')], run('b1'))

    const after = await line(block.id)

    expect(gap).toHaveBeenCalled()
    expect(after.head).toMatchObject({ text: 'ของฉันเอง', engine: 'human', pinned: true })
    // Held off, and still kept: the run's answer is in the list to switch to.
    expect(said(after.history)).toEqual([['ร่างเดิม', 'ai-text', 'b0'], ['ของฉันเอง', 'human', null], ['ร่างใหม่', 'ai-text', 'b1']])
  })
})

describe('putOnPage — the revision log', () => {
  it('folds consecutive edits by one person into a single revision', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'สวัส')])
    await putOnPage(context, page.id, 'th', [words(block.id, 'สวัสดี')])

    const typed = await line(block.id)

    expect(said(typed.history)).toEqual([['สวัสดี', 'human', null]])
    expect(shown(typed)?.text).toBe('สวัสดี')
  })

  it('starts a new revision once the fold window has passed', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'สวัส')])

    // Six minutes ago, as far as the fold can tell — its window is five.
    client.prepare('UPDATE translation_revisions SET updated_at = updated_at - 360').run()

    await putOnPage(context, page.id, 'th', [words(block.id, 'สวัสดี')])

    expect(said((await line(block.id)).history)).toEqual([['สวัส', 'human', null], ['สวัสดี', 'human', null]])
  })

  it('gives every line of one press the same batch', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const lines = await blocksOn(context, page.id, 3)

    await putOnPage(context, page.id, 'th', lines.map((block, index) => words(block.id, `ร่าง${index}`)), run('b1'))

    for (const block of lines) expect((await line(block.id)).history.map((row) => row.batch)).toEqual(['b1'])
  })

  it('points the head at the revision it is showing', async () => {
    const { context, page, block } = await aLine()

    const steps = [
      () => putOnPage(context, page.id, 'th', [words(block.id, 'ก')], run('b1')),
      () => putOnPage(context, page.id, 'th', [words(block.id, 'ข')]),
      () => putOnPage(context, page.id, 'th', [words(block.id, 'ค')], run('b2')),
      () => unpin(context, [block.id], 'th'),
      () => putOnPage(context, page.id, 'th', [words(block.id, 'ง')], run('b3')),
    ]

    for (const step of steps) {
      await step()

      const now = await line(block.id)

      expect(shown(now)?.text).toBe(now.head.text)
    }
  })

  it('records a revision even when the head could not move', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])
    await putOnPage(context, page.id, 'th', [words(block.id, 'หนึ่ง')], run('b1'))
    await putOnPage(context, page.id, 'th', [words(block.id, 'สอง')], run('b2'))

    const held = await line(block.id)

    expect(held.head.text).toBe('ของฉันเอง')
    expect(said(held.history)).toEqual([['ของฉันเอง', 'human', null], ['หนึ่ง', 'ai-text', 'b1'], ['สอง', 'ai-text', 'b2']])
  })
})

describe('putOnPage — a move is not an edit', () => {
  const BOX = { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 }
  const MOVED = { cx: 0.6, cy: 0.45, w: 0.3, h: 0.2 }

  const translated = () => Number(client.prepare('SELECT count(*) AS n FROM logs WHERE action = \'blocks.translated\'').get()!.n)

  it('writes only the frame columns when nothing but the box changed', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', BOX)], run('b1'))

    const { head: before } = await line(block.id)

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', MOVED)])

    const { head: after } = await line(block.id)

    expect(after).toEqual({ ...before, ...MOVED, updatedAt: after.updatedAt })
  })

  it('leaves a pinned line pinned, and takes the nudge anyway', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง', BOX)])
    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง', MOVED)])

    expect((await line(block.id)).head).toMatchObject({ ...MOVED, pinned: true })
  })

  it('leaves an unpinned line unpinned', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', BOX)], run('b1'))
    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', MOVED)])

    const { head } = await line(block.id)

    expect(head).toMatchObject(MOVED)
    expect(claimed(head)).toBe(false)
  })

  it('files no revision for a move', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', BOX)], run('b1'))

    const { history: before } = await line(block.id)

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', MOVED)])

    expect((await line(block.id)).history).toEqual(before)
  })

  it('refuses a machine run\'s geometry for a line it is held off', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง', BOX)])

    const { head: before } = await line(block.id)

    // The same words — so only the box differs — riding along with a run.
    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง', MOVED)], run('b1'))

    expect((await line(block.id)).head).toEqual(before)
  })

  it('keeps a pure move out of the workspace log', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', BOX)], run('b1'))

    const logged = translated()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง', MOVED)])

    expect(translated()).toBe(logged)

    // And the log is listening: a change of words is an entry.
    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่างใหม่', MOVED)])

    expect(translated()).toBe(logged + 1)
  })
})

/**
 * Taking back one run, and only that run.
 *
 * A run writes a page of lines and `revertBatch` is its undo, so what it may
 * touch is exactly what the run touched: the heads the run itself moved, and
 * the run's own revisions. Every case builds a page where something *else*
 * also happened — an earlier run, a later one, somebody typing — because a
 * revert that took those too would pass every test that only looked at the
 * run's own lines.
 */
describe('revertBatch', () => {
  it('reverts only heads whose current wording came from that batch', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [moved, untouched, typed] = await blocksOn(context, page.id, 3)

    await putOnPage(context, page.id, 'th', [words(moved!.id, 'x0'), words(untouched!.id, 'y0'), words(typed!.id, 'z0')], run('b0'))
    await putOnPage(context, page.id, 'th', [words(typed!.id, 'ของฉันเอง')])
    await putOnPage(context, page.id, 'th', [words(moved!.id, 'x1'), words(typed!.id, 'z1')], run('b1'))

    await revertBatch(context, page.id, 'th', 'b1')

    const back = (await line(moved!.id)).head

    // A machine's wording again, so free for the next run to move.
    expect(back).toMatchObject({ text: 'x0', engine: 'ai-text' })
    expect(claimed(back)).toBe(false)
    expect((await line(untouched!.id)).head.text).toBe('y0')
    expect((await line(typed!.id)).head).toMatchObject({ text: 'ของฉันเอง', pinned: true })
  })

  it('restores the newest revision older than the one being taken back', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'x0')], run('b0'))
    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])
    await unpin(context, [block.id], 'th')
    await putOnPage(context, page.id, 'th', [words(block.id, 'x1')], run('b1'))

    await revertBatch(context, page.id, 'th', 'b1')

    const back = await line(block.id)

    // The typed wording, not the older draft beneath it — and a person's
    // wording is theirs again, so it is pinned.
    expect(back.head).toMatchObject({ text: 'ของฉันเอง', engine: 'human', pinned: true })
    expect(shown(back)?.text).toBe('ของฉันเอง')
  })

  /**
   * The rule `revertBatch` spells out: "the newest revision not in the batch"
   * reads the same and is not. Somebody picks run one's wording, which pins it;
   * run two is held off and files its draft *after* it; taking run one back
   * must go to what stood before run one, not forward to run two's draft.
   */
  it('goes back to what stood before the run, not forward to a later run\'s held draft', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'x0')], run('b0'))
    await putOnPage(context, page.id, 'th', [words(block.id, 'x1')], run('b1'))

    const picked = (await line(block.id)).history.find((row) => row.batch === 'b1')!

    await chooseRevision(context, block.id, 'th', picked.id)
    await putOnPage(context, page.id, 'th', [words(block.id, 'x2')], run('b2'))

    expect(await revertBatch(context, page.id, 'th', 'b1')).toBe(1)
    expect((await line(block.id)).head.text).toBe('x0')
  })

  it('leaves a line whose head has moved on since the run', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [overtaken, overwritten] = await blocksOn(context, page.id, 2)

    await putOnPage(context, page.id, 'th', [words(overtaken!.id, 'x0'), words(overwritten!.id, 'y0')], run('b0'))
    await putOnPage(context, page.id, 'th', [words(overtaken!.id, 'x1'), words(overwritten!.id, 'y1')], run('b1'))
    await putOnPage(context, page.id, 'th', [words(overtaken!.id, 'x2')], run('b2'))
    await putOnPage(context, page.id, 'th', [words(overwritten!.id, 'ของฉันเอง')])

    expect(await revertBatch(context, page.id, 'th', 'b1')).toBe(0)

    expect((await line(overtaken!.id)).head.text).toBe('x2')
    expect((await line(overwritten!.id)).head.text).toBe('ของฉันเอง')
  })

  it('leaves a line with nothing older rather than emptying it', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'x1')], run('b1'))

    const before = await line(block.id)

    expect(await revertBatch(context, page.id, 'th', 'b1')).toBe(0)

    // The run was the first thing ever written here. The head keeps pointing
    // at its revision, so that stays too.
    expect(await line(block.id)).toEqual(before)
  })

  it('withdraws the batch\'s revisions everywhere, including from lines it was held off', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [held, moved] = await blocksOn(context, page.id, 2)

    await putOnPage(context, page.id, 'th', [words(held!.id, 'ของฉันเอง')])
    await putOnPage(context, page.id, 'th', [words(moved!.id, 'y0')], run('b0'))
    await putOnPage(context, page.id, 'th', [words(held!.id, 'x1'), words(moved!.id, 'y1')], run('b1'))

    await revertBatch(context, page.id, 'th', 'b1')

    expect(said((await line(held!.id)).history)).toEqual([['ของฉันเอง', 'human', null]])
    expect(said((await line(moved!.id)).history)).toEqual([['y0', 'ai-text', 'b0']])
  })

  it('counts only the lines it actually moved', async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const [first, second, held, fresh] = await blocksOn(context, page.id, 4)

    await putOnPage(context, page.id, 'th', [words(first!.id, 'a0'), words(second!.id, 'b0')], run('b0'))
    await putOnPage(context, page.id, 'th', [words(held!.id, 'ของฉันเอง')])
    await putOnPage(context, page.id, 'th', [
      words(first!.id, 'a1'),
      words(second!.id, 'b1'),
      words(held!.id, 'c1'),
      words(fresh!.id, 'd1'),
    ], run('b1'))

    // Two moved and have somewhere to go back to; one was held off; one has
    // nothing older and stays as it is.
    expect(await revertBatch(context, page.id, 'th', 'b1')).toBe(2)
  })

  it('takes back nothing of another run, another page, another language or another workspace', async () => {
    const context = await aWorkspace()
    const [page, next] = await syncPages(context, [
      { path: '06.jpg', name: '06.jpg', position: 0, hash: 'sha-06.jpg' },
      { path: '07.jpg', name: '07.jpg', position: 1, hash: 'sha-07.jpg' },
    ])
    const [target, bystander] = await blocksOn(context, page!.id, 2)
    const [onNext] = await blocksOn(context, next!.id, 1)

    // One press can span pages — `save_page_translations` files a whole MCP
    // run under one batch — and a line can be carried into two languages.
    await putOnPage(context, page!.id, 'th', [words(target!.id, 'x0'), words(bystander!.id, 'w0')], run('b0'))
    await putOnPage(context, next!.id, 'th', [words(onNext!.id, 'v0')], run('b0'))
    await putOnPage(context, page!.id, 'en', [words(target!.id, 'en0')], run('b0'))
    await putOnPage(context, page!.id, 'th', [words(target!.id, 'x1')], run('b1'))
    await putOnPage(context, next!.id, 'th', [words(onNext!.id, 'v1')], run('b1'))
    await putOnPage(context, page!.id, 'en', [words(target!.id, 'en1')], run('b1'))
    await putOnPage(context, page!.id, 'th', [words(bystander!.id, 'w2')], run('b2'))

    const heads = () => client.prepare('SELECT * FROM translations ORDER BY id').all()
    const history = () => client.prepare('SELECT * FROM translation_revisions ORDER BY id').all()

    // A stranger naming the page and the batch reaches nothing.
    const stranger = await aWorkspace()
    const untouched = { heads: heads(), history: history() }

    expect(await revertBatch(stranger, page!.id, 'th', 'b1')).toBe(0)
    expect({ heads: heads(), history: history() }).toEqual(untouched)

    const { head: targeted } = await line(target!.id)
    const taken = (await line(target!.id)).history.find((row) => row.batch === 'b1')!

    expect(await revertBatch(context, page!.id, 'th', 'b1')).toBe(1)

    // Every head but the one line, and every revision but that line's b1, exactly as they were.
    expect(heads().filter((row) => row.id !== targeted.id)).toEqual(untouched.heads.filter((row) => row.id !== targeted.id))
    expect(history()).toEqual(untouched.history.filter((row) => row.id !== taken.id))
    expect((await line(target!.id)).head.text).toBe('x0')
  })
})

describe('unpin', () => {
  it('gives up the claim so the next run may move the line', async () => {
    const { context, page, block } = await aLine()

    await putOnPage(context, page.id, 'th', [words(block.id, 'ของฉันเอง')])

    const { head: before } = await line(block.id)

    await unpin(context, [block.id], 'th')

    const { head: after } = await line(block.id)

    // Nothing on the page changes: un-pinning is not reverting.
    expect(after).toEqual({ ...before, pinned: false, updatedAt: after.updatedAt })

    await putOnPage(context, page.id, 'th', [words(block.id, 'ร่าง')], run('b1'))

    expect((await line(block.id)).head.text).toBe('ร่าง')
  })
})

/**
 * Throwing a wording away, which is the one deliberate exception to "no wording
 * is ever lost" — and the rule that keeps it from being a way to change the page.
 *
 * Seam: `deleteRevision` against `revisions`, which is what the panel lists.
 */
describe('deleteRevision', () => {
  const twoWordings = async () => {
    const context = await aWorkspace()
    const page = await aPage(context)
    const block = await aBlock(context, page.id)

    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Hello' }], { engine: 'ai-text', model: 'a', batch: 'b1' })
    await putOnPage(context, page.id, 'en', [{ blockId: block.id, text: 'Hi there' }], { engine: 'ai-text', model: 'b', batch: 'b2' })

    const { revisions: held } = await revisions(context, block.id, 'en')

    return { context, page, block, head: held.find((one) => one.head)!, older: held.find((one) => !one.head)! }
  }

  it('removes an earlier wording and leaves the page as it was', async () => {
    const { context, block, head, older } = await twoWordings()

    await deleteRevision(context, block.id, 'en', older.id)

    const after = await revisions(context, block.id, 'en')

    expect(after.revisions.map((one) => one.text)).toEqual(['Hi there'])
    expect(after.revisions[0]!.id).toBe(head.id)
    expect(after.revisions[0]!.head).toBe(true)
  })

  it('refuses the wording on the page', async () => {
    const { context, block, head } = await twoWordings()

    await expect(deleteRevision(context, block.id, 'en', head.id)).rejects.toMatchObject({ statusCode: 409 })
    expect((await revisions(context, block.id, 'en')).revisions).toHaveLength(2)
  })

  it('refuses the wording on the page after an older one was chosen', async () => {
    const { context, block, head, older } = await twoWordings()

    await chooseRevision(context, block.id, 'en', older.id)

    await expect(deleteRevision(context, block.id, 'en', older.id)).rejects.toMatchObject({ statusCode: 409 })

    // And the newest, no longer on the page, may now go.
    await deleteRevision(context, block.id, 'en', head.id)

    expect((await revisions(context, block.id, 'en')).revisions.map((one) => one.text)).toEqual(['Hello'])
  })

  it('does not reach another line\'s history', async () => {
    const { context, page, older } = await twoWordings()
    const other = await aBlock(context, page.id, 'さようなら')

    await putOnPage(context, page.id, 'en', [{ blockId: other.id, text: 'Goodbye' }])

    await expect(deleteRevision(context, other.id, 'en', older.id)).rejects.toMatchObject({ statusCode: 404 })
  })
})
