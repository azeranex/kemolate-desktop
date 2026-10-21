/**
 * What a block should say, how it is set, and every wording it has had.
 *
 * One row per block per language — this is an upsert and there is no `create` —
 * with the *history* of that row beside it in `translation_revisions`. The two
 * answer different questions and are read at wildly different rates: drawing a
 * page reads the head of every block on it, and the history is opened for one
 * block by somebody who has decided to look.
 *
 * The log is still the record of what happened in a workspace. It is not the
 * record of what a line used to say — a superseded wording is a thing you want
 * to *read back onto the page*, and a log entry cannot be switched to.
 */
import { and, desc, eq, inArray } from 'drizzle-orm'

import { must, notify } from './access'
import { boxOf, sameBox } from './frames'
import { record } from './logs'

import type { Context } from './access'
import type { TextStyle, Translation, TranslationRevision } from '~~/server/database'

import { translateWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { db, translationRevisions, translations } from '~~/server/database'

/**
 * What produced a wording. Absent means a person typed it.
 *
 * The browser knows this only at the moment of writing — afterwards a machine
 * draft and a typed line are the same string in the same box — which is why it
 * travels with the write rather than being inferred from the row later.
 */
export interface TranslationOrigin {
  /** 'ai-text', 'ai-image', 'google'. */
  engine: string
  model?: string | null
  /** The run, so a page's worth of lines can be taken back together. */
  batch?: string | null
}

/**
 * How long a person's typing keeps folding into one revision.
 *
 * `useTranslationSync` sends a page half a second after it stops changing, so a
 * typed sentence arrives as several writes and would otherwise be several
 * revisions — a history of every pause for breath, which is no history at all.
 * The same idea as `recordBlock`'s merge window on the undo stack, with a much
 * longer arm: an undo step is per gesture, and this is per sitting.
 *
 * Only a person's own consecutive edits fold. A machine never folds into
 * anything, and neither does another person's revision — both are somebody
 * else's answer and deserve their own line in the list.
 */
const COALESCE_MS = 5 * 60 * 1000

/** The newest revision of each of these lines, for the fold above. */
async function newestRevisions (ids: number[]): Promise<Map<number, TranslationRevision>> {
  if (!ids.length) return new Map()

  const rows = await db
    .select()
    .from(translationRevisions)
    .where(inArray(translationRevisions.translationId, ids))
    .orderBy(desc(translationRevisions.createdAt), desc(translationRevisions.id))

  const newest = new Map<number, TranslationRevision>()

  for (const row of rows) if (!newest.has(row.translationId)) newest.set(row.translationId, row)

  return newest
}

/**
 * Whether this write should amend the revision on top rather than add one —
 * and the id to amend if so.
 */
function coalesces (
  latest: TranslationRevision | undefined,
  origin: TranslationOrigin | null | undefined,
  author: number | null,
): number | null {
  if (origin || !latest) return null
  if (latest.engine !== 'human' || latest.authorId !== author) return null

  return Date.now() - latest.updatedAt.getTime() < COALESCE_MS ? latest.id : null
}

/**
 * The blocks, proved to be this workspace's — and, where a page is named, that
 * page's.
 *
 * The same guard `blockIn` is in the block service and closed for the same
 * reason: an ability only ever looks at the *context*, so without this,
 * translator rights on your own workspace would let you write words onto a
 * block on somebody else's page. A block id is just a number.
 *
 * It answers with the 404 a stranger gets rather than a 403, because a row you
 * may not touch should not be confirmed to exist by the way it refuses you.
 *
 * Hands back the pages those blocks sit on, which it has already had to fetch.
 * A change notice names a page — that is the unit a browser re-reads — and the
 * callers that take a block id rather than a page id would otherwise each ask
 * the same question a second time to say what they had just changed.
 */
async function blocksIn (context: Context, ids: number[], pageId?: number): Promise<number[]> {
  if (!ids.length) return []

  const rows = await db.query.blocks.findMany({
    where: { id: { in: ids } },
    columns: { id: true, pageId: true },
    with: { page: { columns: { workspaceId: true } } },
  })

  const mine = rows.filter((row) =>
    row.page.workspaceId === context.workspaceId && (pageId === undefined || row.pageId === pageId))

  if (mine.length !== ids.length) {
    throw createError({ statusCode: 404, statusMessage: 'No such block.' })
  }

  return [...new Set(mine.map((row) => row.pageId))]
}

/*
 * There was a single-line `put` here — an upsert taking one block's draft with
 * a caller-supplied engine. It is gone because nothing called it and it had
 * quietly fallen out of the rules this file now keeps: it recorded no revision
 * and neither respected nor set `pinned`, so wiring it back up would have been
 * the one door through which a wording could be destroyed and a pinned line
 * overwritten. `putOnPage` with a one-entry array is the same write done
 * properly, and the deliberate single-line acts have their own doors
 * (`chooseRevision`, `setStatus`).
 */

/** One line of a page, on its way to the row that holds it. */
export interface TranslationEntry {
  blockId: number
  text: string
  style?: TextStyle | null
  /**
   * Where the lettering sits, when it has been moved off the block.
   *
   * Absent and null say the same thing — it sits on the block, and for the two
   * skews, that it does not lean — for the reason `translationSyncSchema` sets
   * out at length. Nullable here rather than merely optional so a caller can say
   * it out loud when a letterer puts a balloon back.
   */
  cx?: number | null
  cy?: number | null
  w?: number | null
  h?: number | null
  angle?: number | null
  skewX?: number | null
  skewY?: number | null
  quad?: number[] | null
}

/**
 * Whether two stored styles say the same thing, whatever order they were
 * written in.
 *
 * Key order is the reason this is not `JSON.stringify`. A style is built up a
 * setting at a time in whichever order a letterer happened to press things, so
 * two browsers that agree on every value routinely disagree on the order they
 * serialise it in — and comparing the strings would call that a change, write
 * the row again, and take the authorship with it. Every value in a `Lettering`
 * is a primitive but a custom shape's `points`, so comparing them one by one —
and that one element by element — is the whole of the question.
 */
function sameStyle (a: TextStyle | null | undefined, b: TextStyle | null | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof TextStyle>

  for (const key of keys) {
    const l = left[key]
    const r = right[key]

    // `points` is the one value that is not a primitive — a custom shape's
    // polygon — and two copies of one polygon are never the same array.
    if (Array.isArray(l) && Array.isArray(r)) {
      if (l.length !== r.length || l.some((v, i) => v !== r[i])) return false
    } else if (l !== r) return false
  }

  return true
}

/**
 * What a page's blocks say, and how they are set — one language, written in one
 * go.
 *
 * This is the path the browser actually uses, and it takes a page rather than a
 * block because of what the browser is doing when it calls: it holds the whole
 * page and knows only that *something* on it changed. `put` remains the way to
 * write one line deliberately, with a provenance to go with it.
 *
 * ## Nothing is written twice
 *
 * A browser that has just read a page back sends every line on it straight
 * back, unchanged, at the first settle — there is no honest way for it to tell
 * a value it was handed a second ago from one somebody typed. So the rows are
 * read first and the entries that already say exactly what is stored are
 * dropped. That is not an optimisation:
 *
 * - `authorId` is "who put it there". Rewriting a row with the same words would
 *   quietly re-sign somebody else's line with the name of whoever last opened
 *   the page.
 * - the log would fill with `block.translated` entries whose before and after
 *   are the same string, on every page anyone so much as looked at.
 *
 * With that in place a page that has not changed costs one query and no writes,
 * which is what makes sending the whole page cheap enough to be the only rule.
 *
 * ## Who wrote it, and what the head is
 *
 * `origin` is how this path finally says something true about provenance. It
 * used to say nothing — `engine` was left at its default, so every AI
 * translation in the database was filed as `'human'` — because the browser
 * typed a machine draft into the same box a person types into and could not
 * tell them apart afterwards. It can tell them apart at the moment of writing,
 * which is here: a run passes its engine, its model and its batch, and a
 * keystroke passes nothing.
 *
 * From that one distinction the whole resolution rule follows:
 *
 * - **A person's edit pins the line.** Typing is an act of choosing, so it sets
 *   `pinned` and no later run displaces it. That is the guarantee the page
 *   button makes today, kept as a property of the data rather than as a filter
 *   in the browser.
 * - **A machine's run always records, and moves the head only if unpinned.**
 *   So a re-run against a page you have edited leaves your words on the page
 *   and still files its own, ready to be switched to.
 * - **`unpin` clears it**, and is what "Translate page again" sends first. That
 *   press is the explicit ask to be given the model's answer.
 *
 * ## A revision is wording, not lettering
 *
 * A revision is only recorded when the *text* changes. Moving a balloon or
 * changing its face is a change to this row and no change at all to what the
 * line says, and a history padded with thirty identical strings is a history
 * nobody will scroll.
 *
 * ## And a move is not an edit either
 *
 * The lettering's box (`cx`…`quad`) travels with the entry and is written by a
 * path of its own, deliberately outside every rule above. A balloon's position
 * is not a claim about what the line says, so a nudge:
 *
 * - **files no revision and moves no head.** It never touches `text`,
 *   `revisionId`, `engine` or `model`, so the fold window and `origin` are not
 *   in the conversation at all.
 * - **neither pins nor un-pins.** Dragging a balloon that a machine drafted must
 *   not quietly freeze its wording against the next run — the letterer chose a
 *   place, not a translation — and dragging one somebody typed must not give up
 *   the claim they made by typing it. So `pinned` is left exactly as found, and
 *   a pin cannot block the move.
 * - **does not re-sign the line.** `authorId` is "who put these words there";
 *   a typesetter fitting somebody else's translation has not written it.
 *
 * The one place a pin does reach the geometry is a *machine* run held off a
 * pinned line. That run is sending a browser's local copy of everything about
 * the row, and a browser holding a stale or empty copy would otherwise move the
 * one balloon it was explicitly forbidden to touch — the same reason the held
 * branch leaves `style` alone.
 */
export async function putOnPage (
  context: Context,
  pageId: number,
  locale: string,
  entries: TranslationEntry[],
  origin?: TranslationOrigin | null,
): Promise<Translation[]> {
  await must(context, translateWorkspace, context)

  const ids = [...new Set(entries.map((entry) => entry.blockId))]

  if (ids.length !== entries.length) {
    throw createError({ statusCode: 400, statusMessage: 'A block can only be translated once per request.' })
  }

  // Both halves of the guard at once: the blocks are this workspace's, *and*
  // they are on the page the caller named. Naming a page it may write to while
  // listing blocks from another would otherwise pass.
  await blocksIn(context, ids, pageId)

  if (!ids.length) return []

  const before = await db.query.translations.findMany({ where: { blockId: { in: ids }, locale } })
  const was = new Map(before.map((row) => [row.blockId, row]))

  const changed = entries.filter((entry) => {
    const row = was.get(entry.blockId)

    return !row || row.text !== entry.text || !sameStyle(row.style, entry.style) || !sameBox(row, entry)
  })

  if (!changed.length) return []

  const author = context.actor?.id ?? null
  const machine = Boolean(origin)

  // The newest revision of each line, so a run of keystrokes folds into one
  // entry instead of filing a revision every half second — see `coalesces`.
  const latest = await newestRevisions(before.map((row) => row.id))

  // One transaction, for the reason `blocks.replace` is one: a page left half
  // written is a page some of whose balloons say the new thing and some the
  // old, and a peer syncing at that moment copies it in that state.
  const written = db.transaction((tx) => changed.map((entry) => {
    /*
     * Read again, in here, where nothing can interleave. `was` above was
     * fetched across an `await`, and a keystroke can land in the gap: a run
     * trusting that earlier read would see the line as unpinned, write its
     * draft over words somebody had just chosen, and leave `pinned` standing —
     * a machine wording wearing a person's claim, which every later pass would
     * then refuse to move. The driver is synchronous, so inside this
     * transaction the answer cannot change under us; `was` remains only the
     * cheap pre-filter it always was.
     */
    const row = tx
      .select()
      .from(translations)
      .where(and(eq(translations.blockId, entry.blockId), eq(translations.locale, locale)))
      .all()[0]

    const wording = !row || row.text !== entry.text
    const lettered = !row || !sameStyle(row.style, entry.style)
    const moved = !row || !sameBox(row, entry)

    // The `changed` filter ran against the stale read, so ask again with the
    // fresh row: an entry that no longer differs must not be written, or it
    // would re-sign somebody else's line with this caller's name.
    if (row && !wording && !lettered && !moved) return row

    /*
     * A move and nothing else, which is the ordinary act of typesetting and is
     * dealt with here rather than below because none of what follows applies to
     * it — see "And a move is not an edit either" in this function's header.
     * Only the six columns are set, so `authorId`, `pinned`, `engine` and the
     * revision chain are all left standing, and a pinned line takes the nudge
     * like any other.
     *
     * The one exception is a machine run held off a pinned line: that geometry
     * is a browser's local copy riding along with a run that is not allowed to
     * touch this row, and writing it would move the very balloon the pin exists
     * to protect. Nothing is lost by refusing it — the wording is unchanged
     * here by definition, so there is no revision in question either.
     */
    if (row && !wording && !lettered) {
      if (machine && row.pinned === true) return row

      return tx
        .update(translations)
        .set(boxOf(entry))
        .where(eq(translations.id, row.id))
        .returning()
        .all()[0]!
    }

    /*
     * A machine may not move the head of a line somebody has chosen — nor
     * touch anything else about it. Style and the lettering's box included: a
     * run sends the browser's local copy of both along with its words, and a
     * browser holding a stale or empty one would otherwise null the lettering,
     * or shove the balloon, of the one line it was explicitly forbidden to
     * move. The row is left exactly as it stands; only
     * the revision is filed below — the point of the whole table is that the
     * answer is kept and can be switched to, not that it is thrown away.
     */
    const held = machine && row?.pinned === true

    if (held) {
      if (wording) {
        tx
          .insert(translationRevisions)
          .values({
            translationId: row!.id,
            text: entry.text,
            engine: origin?.engine ?? 'human',
            model: origin?.model ?? null,
            batch: origin?.batch ?? null,
            authorId: author,
          })
          .run()
      }

      return row!
    }

    /*
     * An old wording put back is not a new one.
     *
     * A person's write whose text is exactly a revision this line already has
     * is a reversion arriving by the sync — Undo, or the same words retyped —
     * and the sync cannot say so: it knows the block changed, not why. Filing
     * it as a fresh `human` wording relabelled the model's own words "Typed",
     * and inside the coalesce window it was worse — the fold *amended* the
     * typed revision into the restored text, deleting the wording being undone
     * from the very table that exists to keep every wording.
     *
     * So it is treated as `chooseRevision` treats the same act made in the
     * panel: the head takes the matched revision's engine and model and points
     * at it, the person's part is recorded in `pinned` and `authorId`, and no
     * revision is filed. The newest match wins where one text appears twice,
     * for the reason `revisions` reads newest-first. Machines are exempt — a
     * run that re-proposes an old wording is the model saying it again, and
     * carries its own origin either way.
     */
    const echo = !machine && wording && row
      ? tx
        .select()
        .from(translationRevisions)
        .where(and(
          eq(translationRevisions.translationId, row.id),
          eq(translationRevisions.text, entry.text),
        ))
        .orderBy(desc(translationRevisions.createdAt), desc(translationRevisions.id))
        .all()[0] ?? null
      : null

    const values = {
      text: entry.text,
      style: entry.style ?? null,
      // The box rides along with the words rather than being written twice.
      // Reaching here means this caller is allowed to move the row anyway — a
      // pinned line held against a machine has already returned above — and the
      // entry is one browser's account of the whole row, so splitting the write
      // in two would only leave a window where the balloon and its text
      // disagree.
      ...boxOf(entry),
      authorId: author,
      engine: echo ? echo.engine : (origin?.engine ?? 'human'),
      model: echo ? echo.model : (origin?.model ?? null),
      // Straight into the head write rather than patched on after, the way the
      // new-revision path has to below — the revision already exists.
      ...(echo ? { revisionId: echo.id } : {}),
      // Typing is choosing. A machine leaves it as it found it, so a line
      // pinned once stays pinned through every later pass.
      ...(machine ? {} : { pinned: true }),
    }

    const head = tx
      .insert(translations)
      .values({ blockId: entry.blockId, locale, ...values })
      .onConflictDoUpdate({ target: [translations.blockId, translations.locale], set: values })
      .returning()
      .all()[0]!

    // An echo's revision chain is already right — `values` pointed the head at
    // the matched revision — and letting it fall through would coalesce or file
    // exactly what the comment above says must not happen.
    if (!wording || echo) return head

    const fold = coalesces(latest.get(head.id), origin, author)

    const revision = fold
      ? tx
        .update(translationRevisions)
        .set({ text: entry.text })
        .where(eq(translationRevisions.id, fold))
        .returning()
        .all()[0]!
      : tx
        .insert(translationRevisions)
        .values({
          translationId: head.id,
          text: entry.text,
          engine: origin?.engine ?? 'human',
          model: origin?.model ?? null,
          batch: origin?.batch ?? null,
          authorId: author,
        })
        .returning()
        .all()[0]!

    // The head points at the revision it is showing.
    return tx
      .update(translations)
      .set({ revisionId: revision.id })
      .where(eq(translations.id, head.id))
      .returning()
      .all()[0]!
  }))

  // Everything except the lines that only moved. `blocks.translated` says
  // something was written, and a page of balloons dragged into place is not —
  // logging it as one would file entries whose `was` and `now` are the same
  // string on every drag, which is the noise the "nothing is written twice" rule
  // above exists to keep out of this table. A move is still worth telling the
  // room about, so the notify below is unconditional; it is just not worth a
  // line in the history. Style stays in, exactly as it was: how a line is set is
  // part of what this row says, and a face change was always logged.
  const said = changed.filter((entry) => {
    const row = was.get(entry.blockId)

    return !row || row.text !== entry.text || !sameStyle(row.style, entry.style)
  })

  // One entry for the request rather than one per line, following `blocks.append`:
  // a letterer setting eight balloons alike is one thing that happened, and N
  // entries would let it push everything else out of what `recent` returns. What
  // each line used to say goes in the detail, because that is the question this
  // table exists to answer and a batch is no excuse for losing it.
  if (said.length) {
    await record({
      workspaceId: context.workspaceId,
      userId: context.actor?.id ?? null,
      action: 'blocks.translated',
      subject: 'pages',
      subjectId: pageId,
      detail: {
        locale,
        count: said.length,
        changed: said.map((entry) => ({
          blockId: entry.blockId,
          was: was.get(entry.blockId)?.text ?? null,
          now: entry.text,
        })),
      },
    })
  }

  notify(context, { scope: 'translations', pageId, locale })

  return written
}

/** A revision as the panel lists it, with the head marked. */
export interface RevisionRow {
  id: number
  text: string
  engine: string
  model: string | null
  batch: string | null
  authorId: number | null
  at: Date
  /** Whether this is the wording currently on the page. */
  head: boolean
}

/**
 * Every wording this line has had, newest first, with the one on the page
 * marked.
 *
 * Also answers for a line with no history at all — one written before revisions
 * existed, or by a path that does not record them. Rather than an empty list,
 * which would read as "this line has never been touched", the head itself is
 * handed back as a single revision it plainly is.
 */
export async function revisions (
  context: Context,
  blockId: number,
  locale: string,
): Promise<{ pinned: boolean, revisions: RevisionRow[] }> {
  await must(context, viewWorkspace, context)
  await blocksIn(context, [blockId])

  const head = await db.query.translations.findFirst({ where: { blockId, locale } })

  if (!head) return { pinned: false, revisions: [] }

  const rows = await db
    .select()
    .from(translationRevisions)
    .where(eq(translationRevisions.translationId, head.id))
    .orderBy(desc(translationRevisions.createdAt), desc(translationRevisions.id))

  if (!rows.length) {
    return {
      pinned: head.pinned === true,
      revisions: [{
        id: 0,
        text: head.text,
        engine: head.engine,
        model: head.model,
        batch: null,
        authorId: head.authorId,
        at: head.updatedAt,
        head: true,
      }],
    }
  }

  return {
    pinned: head.pinned === true,
    revisions: rows.map((row) => ({
      id: row.id,
      text: row.text,
      engine: row.engine,
      model: row.model,
      batch: row.batch,
      authorId: row.authorId,
      at: row.updatedAt,
      // `revisionId` is the answer wherever there is one. Falling back to the
      // newest is for a head written before it was recorded, where "the newest
      // is what you are looking at" is true by construction.
      head: head.revisionId === null ? row.id === rows[0]!.id : head.revisionId === row.id,
    })),
  }
}

/**
 * Put one of a line's earlier wordings back on the page.
 *
 * Pins, always. Choosing between two answers is the most deliberate thing
 * anybody does to a line, so it would be perverse for the next run to overwrite
 * what somebody had just sat and compared.
 *
 * The style is untouched — see the header of `translation_revisions`. Switching
 * to a better translation must not undo ten minutes of fitting the balloon.
 */
export async function chooseRevision (
  context: Context,
  blockId: number,
  locale: string,
  revisionId: number,
): Promise<Translation> {
  await must(context, translateWorkspace, context)

  const [pageId] = await blocksIn(context, [blockId])
  const head = await db.query.translations.findFirst({ where: { blockId, locale } })

  if (!head) throw createError({ statusCode: 404, statusMessage: 'Nothing has been written here yet.' })

  const wanted = await db.query.translationRevisions.findFirst({
    where: { id: revisionId, translationId: head.id },
  })

  // Belongs to this line or it does not exist, as far as this caller is
  // concerned — a revision id from another block is not theirs to read.
  if (!wanted) throw createError({ statusCode: 404, statusMessage: 'No such revision.' })

  const [updated] = await db
    .update(translations)
    .set({
      text: wanted.text,
      engine: wanted.engine,
      model: wanted.model,
      revisionId: wanted.id,
      pinned: true,
      authorId: context.actor?.id ?? null,
    })
    .where(eq(translations.id, head.id))
    .returning()

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'translation.revision.chosen',
    subject: 'translations',
    subjectId: head.id,
    detail: { blockId, locale, revisionId, was: head.text, now: wanted.text },
  })

  if (pageId) notify(context, { scope: 'translations', pageId, locale })

  return updated!
}

/**
 * Throw away one of a line's wordings, on purpose.
 *
 * The one way a revision goes that is not a whole block or workspace going with
 * it, and the exception to "no wording is ever lost" is exactly that it is
 * asked for: a history full of a bad model's attempts is a list nobody can
 * compare anything in, and keeping everything was only ever meant to protect
 * against losing words *by accident*. The text still goes to the log, so a
 * wrong press can be read back by hand.
 *
 * **Never the wording on the page.** Removing the head would have to decide
 * what the balloon says instead — the next newest? the one before the run? —
 * and any answer is a change to the page made by a press that looked like
 * tidying a list. Choose another wording first, then remove this one; that is
 * two deliberate acts rather than one that does something unasked. A head
 * written before `revisionId` was recorded is the newest row, which is how
 * `revisions` marks it too.
 *
 * Nothing on the page changes, so the room is not told: no tab's drawing
 * depends on a revision that is not the head.
 */
export async function deleteRevision (
  context: Context,
  blockId: number,
  locale: string,
  revisionId: number,
): Promise<void> {
  await must(context, translateWorkspace, context)
  await blocksIn(context, [blockId])

  const head = await db.query.translations.findFirst({ where: { blockId, locale } })

  if (!head) throw createError({ statusCode: 404, statusMessage: 'Nothing has been written here yet.' })

  const wanted = await db.query.translationRevisions.findFirst({
    where: { id: revisionId, translationId: head.id },
  })

  // A revision id from another block is not theirs to read, let alone delete.
  if (!wanted) throw createError({ statusCode: 404, statusMessage: 'No such revision.' })

  const onPage = head.revisionId === null
    ? (await newestRevisions([head.id])).get(head.id)?.id === wanted.id
    : head.revisionId === wanted.id

  if (onPage) {
    throw createError({ statusCode: 409, statusMessage: 'That wording is on the page — choose another before removing it.' })
  }

  await db.delete(translationRevisions).where(eq(translationRevisions.id, wanted.id))

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'translation.revision.deleted',
    subject: 'translations',
    subjectId: head.id,
    detail: { blockId, locale, revisionId, text: wanted.text, engine: wanted.engine, model: wanted.model },
  })
}

/**
 * Let a line follow the newest wording again.
 *
 * The opposite of choosing, and of typing: it gives up the claim on this line
 * so the next run may move it. It does not change what the page says now — the
 * head stays exactly where it is until something writes a newer one, which is
 * the difference between un-pinning and reverting.
 */
export async function unpin (
  context: Context,
  blockIds: number[],
  locale: string,
): Promise<void> {
  await must(context, translateWorkspace, context)

  if (!blockIds.length) return

  const pageIds = await blocksIn(context, blockIds)

  await db
    .update(translations)
    .set({ pinned: false })
    .where(and(inArray(translations.blockId, blockIds), eq(translations.locale, locale)))

  // A write tells the room, even one that changes nothing on the page: the
  // pinned state is part of what the revision panel shows, and a tab that was
  // not told keeps offering to un-pin a line already given up.
  for (const pageId of pageIds) notify(context, { scope: 'translations', pageId, locale })
}

/**
 * Take back a whole run.
 *
 * One press writes a page of lines, and this is the undo for it. Every line
 * whose head the run actually moved goes back to where it stood before the
 * run — which is not one wording but a different one per line — and the run's
 * revisions are withdrawn everywhere, including from lines it was held off.
 *
 * A line with nothing older is left alone rather than emptied. The run did not
 * replace anything there, it was the first thing ever written, and blanking the
 * balloon would be inventing a state the page never had.
 */
export async function revertBatch (
  context: Context,
  pageId: number,
  locale: string,
  batch: string,
): Promise<number> {
  await must(context, translateWorkspace, context)

  const blocks = await db.query.blocks.findMany({
    where: { pageId },
    columns: { id: true },
    with: { page: { columns: { workspaceId: true } } },
  })

  const mine = blocks.filter((row) => row.page.workspaceId === context.workspaceId).map((row) => row.id)

  if (!mine.length) return 0

  const heads = await db.query.translations.findMany({
    where: { blockId: { in: mine }, locale },
  })

  if (!heads.length) return 0

  const rows = await db
    .select()
    .from(translationRevisions)
    .where(inArray(translationRevisions.translationId, heads.map((head) => head.id)))
    .orderBy(desc(translationRevisions.createdAt), desc(translationRevisions.id))

  const byLine = new Map<number, TranslationRevision[]>()

  for (const row of rows) {
    const list = byLine.get(row.translationId) ?? []

    list.push(row)
    byLine.set(row.translationId, list)
  }

  const undone = db.transaction((tx) => {
    let count = 0

    for (const head of heads) {
      const list = byLine.get(head.id) ?? []

      // Untouched by this run: nothing to take back.
      if (!list.some((row) => row.batch === batch)) continue

      /*
       * Only a head the run itself moved goes back. The naive rule — "restore
       * the newest revision not in the batch" — reads as the same thing and is
       * not: a head this run was *held off* (pinned, or since moved by a later
       * run) is showing somebody else's wording, and the newest non-batch
       * revision can be *newer* than the run being taken back. Reverting run A
       * after run B had filed held revisions would put B's machine draft over
       * a person's pinned words — the exact displacement pinning promises can
       * never happen. So the head must prove, via `revisionId`, that what it
       * shows came from this batch; a null `revisionId` predates revisions and
       * so cannot be the batch's either.
       */
      const current = head.revisionId === null
        ? undefined
        : list.find((row) => row.id === head.revisionId)

      const moved = current?.batch === batch

      if (moved) {
        // Where the line stood before the run: the newest revision that is not
        // the batch's *and* is older than the wording being taken back — not
        // merely the newest other one, for the reason above. Same ordering as
        // `newestRevisions`: time first, id as the tiebreak within a second.
        const older = list.find((row) => row.batch !== batch && (
          row.createdAt.getTime() < current!.createdAt.getTime()
          || (row.createdAt.getTime() === current!.createdAt.getTime() && row.id < current!.id)
        ))

        // Nothing older: the run was the first thing ever written here, and
        // blanking the balloon would invent a state the page never had. The
        // head keeps pointing at the batch's revision, so it must stay too.
        if (!older) continue

        tx
          .update(translations)
          .set({
            text: older.text,
            engine: older.engine,
            model: older.model,
            revisionId: older.id,
            // Back to whatever it was: a wording a person wrote is theirs again,
            // and one a machine wrote is still free to be moved by the next run.
            pinned: older.engine === 'human',
          })
          .where(eq(translations.id, head.id))
          .run()

        count += 1
      }

      // The run's own revisions go with it — including the ones filed below a
      // head it never moved. Keeping them would leave the list offering a
      // wording that the reader has just said they did not want, on every
      // line, for ever. Only the lines that actually moved are counted; a
      // held revision disappearing is not a change to the page.
      tx
        .delete(translationRevisions)
        .where(and(
          eq(translationRevisions.translationId, head.id),
          eq(translationRevisions.batch, batch),
        ))
        .run()
    }

    return count
  })

  if (undone) {
    await record({
      workspaceId: context.workspaceId,
      userId: context.actor?.id ?? null,
      action: 'translation.run.reverted',
      subject: 'pages',
      subjectId: pageId,
      detail: { locale, batch, count: undone },
    })

    notify(context, { scope: 'translations', pageId, locale })
  }

  return undone
}

/**
 * Move a line along — draft, review, final.
 *
 * Its own call rather than a field on `put`, because approving somebody else's
 * wording is a different act from writing your own and reads badly as an
 * argument to a function named for writing.
 */
export async function setStatus (
  context: Context,
  blockId: number,
  locale: string,
  status: 'draft' | 'review' | 'final',
): Promise<void> {
  await must(context, translateWorkspace, context)

  const [pageId] = await blocksIn(context, [blockId])

  await db
    .update(translations)
    .set({ status })
    .where(and(eq(translations.blockId, blockId), eq(translations.locale, locale)))

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: `translation.${status}`,
    detail: { blockId, locale },
  })

  if (pageId) notify(context, { scope: 'translations', pageId, locale })
}

/**
 * Every wording every line in the chapter has ever had, in one answer.
 *
 * The bulk read a project file is written from, and `paint.everything`'s
 * sibling — with one deliberate difference. That one names surfaces by `key`
 * because a key means the same thing on every machine. A block has no such
 * name, so this answers with the **row id**, and the exporter's own blocks
 * already carry it (`block:41`, which `rowOf` reads back) — which makes the
 * join exact rather than inferred.
 *
 * That id must not reach the file, and does not: `useProjectFile` uses it to
 * find which of *its* blocks each history belongs to and writes the manifest
 * keyed by the block's index in the page. An id names a row in the workspace
 * being exported from, which is precisely the workspace the file will not be
 * opened in — see `useBlockCache.localise` for what that costs.
 *
 * `position` rides along because it is what a reader debugging this will look
 * for first, and it costs a column.
 *
 * The *head* is an index into the list rather than the revision id it is stored
 * under, and that one is about the file: "the third wording" survives the
 * journey where "revision 412" cannot.
 *
 * Blocks with no history are left out rather than sent as empty lists: a
 * chapter that has been read but never revised should answer with nothing, not
 * with a statement about every balloon in it.
 */
export async function everyRevision (context: Context) {
  await must(context, viewWorkspace, context)

  const pages = await db.query.pages.findMany({
    where: { workspaceId: context.workspaceId },
    columns: { id: true, uid: true },
    with: {
      blocks: {
        columns: { id: true, position: true },
        with: {
          translations: {
            columns: { id: true, locale: true, pinned: true, revisionId: true },
            with: {
              revisions: {
                orderBy: { createdAt: 'asc', id: 'asc' },
                columns: {
                  id: true,
                  text: true,
                  engine: true,
                  model: true,
                  batch: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      },
    },
  })

  return pages
    .map((page) => ({
      uid: page.uid,
      blocks: page.blocks
        .map((block) => ({
          blockId: block.id,
          position: block.position,
          lines: block.translations
            .filter((line) => line.revisions.length)
            .map((line) => ({
              locale: line.locale,
              pinned: line.pinned === true,
              /*
               * Which of them is on the page, as an *index* rather than as the
               * row id it is here. The id is meaningless at the other end, and
               * "the third wording" survives the journey where "revision 412"
               * cannot.
               *
               * `-1` where the head predates `revisionId` being recorded, which
               * the restorer reads as "the newest" — the same fallback
               * `revisions` above makes, and true by construction for a head
               * written before the column existed.
               */
              head: line.revisionId === null
                ? line.revisions.length - 1
                : line.revisions.findIndex((row) => row.id === line.revisionId),
              revisions: line.revisions.map((row) => ({
                text: row.text,
                engine: row.engine,
                model: row.model,
                batch: row.batch,
                at: row.createdAt.getTime(),
              })),
            })),
        }))
        .filter((block) => block.lines.length),
    }))
    .filter((page) => page.blocks.length)
}

/** One wording on its way back in — see `restoreRevisions`. */
export interface RevisionDraft {
  text: string
  engine: string
  model?: string | null
  batch?: string | null
  /** When it was written, in milliseconds. */
  at?: number | null
}

export interface RevisionRestore {
  blockId: number
  locale: string
  pinned: boolean
  /** Which of them the page should show, as an index. */
  head: number
  revisions: RevisionDraft[]
}

/**
 * Put a line's history back, for a chapter arriving from a project file.
 *
 * ## What counts as an empty history, which is not "no rows"
 *
 * The rule is that restoring never overwrites work: a line that has been
 * revised here since is a line whose present beats the file's past, and it is
 * skipped. Restoring also runs late and may run twice, so anything that merged
 * or appended would duplicate a chapter's history on a second pass.
 *
 * The subtlety — and it is the whole reason this is not a one-line guard — is
 * that by the time this can run, **the line always has exactly one revision
 * already, and it is ours**. A revision needs a translation row; the browser
 * gets one by syncing the imported page's translations; and `putOnPage` files a
 * revision for every write it makes. So the sync that creates the prerequisite
 * also creates a single revision holding the very wording the file was about to
 * restore as its head. A guard that refused on "any rows at all" therefore
 * refused on every line, always, and the history in every project file was
 * silently dropped — which is exactly what it did.
 *
 * So the echo is recognised rather than tripped over: one revision, whose text
 * is the head the file is restoring, is this import's own and is replaced.
 * Anything else — two or more wordings, or one saying something different — is
 * somebody's work and is left alone.
 *
 * Idempotent, therefore, and safe to call whenever the prerequisites are met: a
 * second pass sees the full restored history, which is neither empty nor an
 * echo, and skips.
 *
 * ## Authorship does not travel
 *
 * `authorId` is deliberately null on everything written here. The ids in a
 * project file are users of the install it was exported from; the same number
 * on this server is a different person, or nobody. Attributing somebody's
 * translation to a stranger is a worse answer than attributing it to no one,
 * and no one is the truth: this server has never seen who wrote these.
 *
 * ## What it does move
 *
 * `createdAt` is taken from the file rather than stamped now, because a history
 * whose entries all share one timestamp is not a history — the order and the
 * dates are most of what makes it worth reading. `pinned` and the head are
 * restored together, since a pinned line whose head was lost would show the
 * newest wording under somebody's claim to a different one.
 */
export async function restoreRevisions (
  context: Context,
  entries: RevisionRestore[],
): Promise<{ filled: number, skipped: number }> {
  await must(context, translateWorkspace, context)

  if (!entries.length) return { filled: 0, skipped: 0 }

  await blocksIn(context, [...new Set(entries.map((entry) => entry.blockId))])

  let filled = 0
  let skipped = 0

  for (const entry of entries) {
    if (!entry.revisions.length) continue

    const head = await db.query.translations.findFirst({
      where: { blockId: entry.blockId, locale: entry.locale },
      columns: { id: true },
    })

    // No head means the translation itself has not been written yet, which is
    // the caller's business rather than an error: the browser flushes these
    // after a page's translations have gone up, and a line nobody translated
    // has no history to put back.
    if (!head) {
      skipped++

      continue
    }

    const already = await db
      .select({ id: translationRevisions.id, text: translationRevisions.text })
      .from(translationRevisions)
      .where(eq(translationRevisions.translationId, head.id))

    // The wording the file says is on the page, which is what the sync will
    // have just filed if this is our own echo. Out of range reads as the
    // newest, the same fallback the write below makes.
    const wanted = entry.revisions[entry.head] ?? entry.revisions[entry.revisions.length - 1]

    const echo = already.length === 1 && already[0]!.text === wanted!.text

    if (already.length && !echo) {
      skipped++

      continue
    }

    // One transaction per line: the head has to point at a revision that
    // exists, and a half-written history whose `revisionId` names a row that
    // was never inserted is a line the Text panel cannot draw.
    db.transaction((tx) => {
      // The echo goes first, inside the transaction, so there is never a moment
      // at which the line has no history at all — and so that a failure leaves
      // the one revision it had rather than none.
      if (echo) {
        tx.delete(translationRevisions).where(eq(translationRevisions.id, already[0]!.id)).run()
      }

      const written = tx
        .insert(translationRevisions)
        .values(entry.revisions.map((row) => ({
          translationId: head.id,
          text: row.text,
          engine: row.engine,
          model: row.model ?? null,
          batch: row.batch ?? null,
          authorId: null,
          /*
           * Both columns, because `revisions` above answers with `updatedAt`
           * and that is the date the Text panel prints beside each wording.
           * Setting only `createdAt` left a restored history looking as though
           * every word of it had been written this afternoon — which is exactly
           * the information the history exists to carry, lost in the one place
           * anybody reads it.
           */
          ...(row.at ? { createdAt: new Date(row.at), updatedAt: new Date(row.at) } : {}),
        })))
        .returning()
        .all()

      // Out of range reads as the newest, which is what an unrecorded head
      // means everywhere else in this file.
      const chosen = written[entry.head] ?? written[written.length - 1]

      tx
        .update(translations)
        .set({ revisionId: chosen!.id, text: chosen!.text, pinned: entry.pinned })
        .where(eq(translations.id, head.id))
        .run()
    })

    filled++
  }

  return { filled, skipped }
}
