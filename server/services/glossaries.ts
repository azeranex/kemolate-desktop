/**
 * Terms fixed in advance, so a name is the same name on every page.
 *
 * Translator rather than editor: a glossary is about the words, and the person
 * who decides what a character is called is not necessarily the one allowed to
 * paint over the artwork.
 *
 * ## What the model puts back
 *
 * Most rows here are not typed by anybody. Every page prompt ends by asking the
 * model which of the terms it just met are worth keeping identical later, and
 * `merge` is where those answers land — see `useTranslate`. That loop is the
 * whole point of the table: page one settles on a spelling, page forty is told
 * about it before it is asked anything, and a volume comes out with one name
 * per character instead of four.
 *
 * It is also why nothing here trusts what it is given. The rules below were all
 * paid for once in the earlier build:
 *
 * - **First translation wins.** A term already on the list is never rewritten
 *   by a later page. Consistency is the entire product; a page that reads a
 *   name wrong must not be able to overwrite a page that read it right.
 * - **A ceiling.** The list goes into every prompt, so an unbounded one is an
 *   unbounded bill, and a model handed two hundred terms starts ignoring them.
 * - **Everything is clipped.** A "term" is a name or a catchphrase. Anything
 *   arriving longer than that is a model having misunderstood the question.
 */
import { eq } from 'drizzle-orm'

import { must, notify } from './access'
import { record } from './logs'

import type { Term } from '#shared/utils/prompt'
import type { Context } from './access'
import type { Glossary, GlossaryTerm } from '~~/server/database'

import { translateWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { foldTerms, MAX_TERM_LENGTH, MAX_TERMS } from '#shared/utils/glossary'
import { db, glossaries, glossaryTerms } from '~~/server/database'

// The rules a glossary grows by are shared with a local workspace's, which keeps
// its list in the browser — see `shared/utils/glossary.ts`.
export { MAX_TERMS }

const MAX_LENGTH = MAX_TERM_LENGTH

/** Every glossary in the workspace, with its terms. */
export async function list (context: Context) {
  await must(context, viewWorkspace, context)

  return db.query.glossaries.findMany({
    where: { workspaceId: context.workspaceId },
    with: { terms: { orderBy: { source: 'asc' } } },
  })
}

/**
 * The workspace's glossary for one language, made if it has none.
 *
 * Most workspaces will only ever have one, and making the caller check for it
 * before every term they add is a check they will forget.
 *
 * A row whose `locale` is null belongs to nobody's language and is left where
 * it is — see the column. Matching one would hand a Spanish run whatever was
 * written before the column existed.
 */
export async function primary (context: Context, locale: string): Promise<Glossary> {
  await must(context, viewWorkspace, context)

  const existing = await db.query.glossaries.findFirst({
    where: { workspaceId: context.workspaceId, locale },
  })

  if (existing) return existing

  /*
   * Insert-or-yield, not insert. Two pages of one chapter are routinely
   * translated at once, and both merges arrive here having found nothing —
   * the read above ran across an `await` and the other request's insert can
   * land in the gap. A plain insert then made *two* glossaries for the
   * language, the chapter's terms split between them by whichever `findFirst`
   * happened to answer, and first-translation-wins quietly stopped holding
   * because each half enforced it alone. The unique index on (workspace,
   * locale) turns the loser's insert into a no-op, and the re-read below picks
   * up the row the winner made — the same answer either would have given by
   * itself.
   */
  const [made] = await db
    .insert(glossaries)
    .values({ workspaceId: context.workspaceId, locale })
    .onConflictDoNothing({ target: [glossaries.workspaceId, glossaries.locale] })
    .returning()

  if (made) return made

  const won = await db.query.glossaries.findFirst({
    where: { workspaceId: context.workspaceId, locale },
  })

  if (!won) throw createError({ statusCode: 500, statusMessage: 'The glossary could not be made.' })

  return won
}

/**
 * What this chapter has settled on, in one language, ready for a prompt.
 *
 * Nothing at all rather than an error for a workspace with no glossary yet,
 * which is every workspace until its first page is translated: an empty list is
 * the true answer and it costs no writes to give it.
 */
export async function terms (context: Context, locale: string): Promise<Term[]> {
  await must(context, viewWorkspace, context)

  const found = await db.query.glossaries.findFirst({
    where: { workspaceId: context.workspaceId, locale },
    with: { terms: { orderBy: { source: 'asc' } } },
  })

  return (found?.terms ?? []).map((row) => ({ source: row.source, target: row.target }))
}

/**
 * The same list with its row ids, for the panel that lets you prune it.
 *
 * Apart from `terms` because the two callers want different things and one of
 * them is a prompt: an id means nothing to a model and would be four tokens per
 * term of noise in a block that is already prepended to every page.
 */
export async function rows (context: Context, locale: string) {
  await must(context, viewWorkspace, context)

  const found = await db.query.glossaries.findFirst({
    where: { workspaceId: context.workspaceId, locale },
    with: { terms: { orderBy: { source: 'asc' } } },
  })

  return (found?.terms ?? []).map((row) => ({
    id: row.id,
    source: row.source,
    target: row.target,
  }))
}

/**
 * Every language's glossary, as terms — what a workspace taking all of itself
 * somewhere else needs: moving back to local, or a project file. `rows` answers
 * one language at a time, and both of those used to carry only the language
 * being worked in, leaving the rest behind with the server's record.
 *
 * A glossary whose `locale` is null belongs to no language anybody can ask for
 * (see `primary`) and is left out.
 */
export async function everyLocale (context: Context): Promise<{ locale: string, terms: { source: string, target: string }[] }[]> {
  const found = await list(context)

  return found.flatMap((glossary) => (glossary.locale && glossary.terms.length
    ? [{ locale: glossary.locale, terms: glossary.terms.map(({ source, target }) => ({ source, target })) }]
    : []))
}

/**
 * Add a term by hand, or rewrite the one already filed under that source.
 *
 * By **locale** rather than by glossary id, which is the change that made this
 * callable at all: it took a `glossaryId` for as long as nothing called it, and
 * a browser has no idea what a glossary id is — the language is the only handle
 * it holds. Resolving it here also means the first hand-written term makes the
 * glossary, exactly as the first learned one does.
 *
 * This is the one door that **overwrites**, and it is deliberately the opposite
 * of `merge`'s first-translation-wins. That rule protects a bad first answer
 * exactly as well as a good one, and until this existed the only remedy was to
 * delete the row and hope the next page proposed better. A person who has typed
 * the right rendering is not guessing, and should not have to.
 */
export async function put (
  context: Context,
  locale: string,
  term: { source: string, target: string },
): Promise<GlossaryTerm> {
  await must(context, translateWorkspace, context)

  const source = String(term.source ?? '').trim().slice(0, MAX_LENGTH)
  const target = String(term.target ?? '').trim().slice(0, MAX_LENGTH)

  if (!source || !target) {
    throw createError({ statusCode: 400, statusMessage: 'A term needs both halves.' })
  }

  const current = await terms(context, locale)

  // The ceiling holds for a hand-written term as much as a learned one: the
  // list is prepended to every page of the run either way, so the reason for
  // the limit does not care who typed it. Rewriting one already on the list is
  // not growth and is always allowed.
  if (current.length >= MAX_TERMS && !current.some((held) => held.source === source)) {
    throw createError({
      statusCode: 409,
      statusMessage: `This glossary is full at ${MAX_TERMS} terms - remove one first.`,
    })
  }

  const glossary = await primary(context, locale)

  const [row] = await db
    .insert(glossaryTerms)
    .values({ source, target, glossaryId: glossary.id })
    .onConflictDoUpdate({
      target: [glossaryTerms.glossaryId, glossaryTerms.source],
      set: { target },
    })
    .returning()

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'glossary.term.set',
    subject: 'glossary_terms',
    subjectId: row?.id,
    detail: { source, target },
  })

  notify(context, { scope: 'glossary', locale })

  return row!
}

/**
 * Change a term that is already on the list, in place.
 *
 * Apart from `put`, and the difference is the *source* half. `put` is an upsert
 * keyed on the source, so retyping a source there does not correct a row — it
 * adds a second one and leaves the misspelling behind, still going out with
 * every page. Editing by id is what makes a source correctable at all.
 *
 * The ownership check is the one `remove` needed: an ability only ever looks at
 * the context, and a term id is just a number.
 */
export async function edit (
  context: Context,
  termId: number,
  patch: { source?: string, target?: string },
): Promise<GlossaryTerm> {
  await must(context, translateWorkspace, context)

  const term = await db.query.glossaryTerms.findFirst({
    where: { id: termId },
    with: { glossary: { columns: { workspaceId: true, locale: true } } },
  })

  if (!term || term.glossary.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such term.' })
  }

  const source = patch.source === undefined
    ? term.source
    : String(patch.source).trim().slice(0, MAX_LENGTH)

  const target = patch.target === undefined
    ? term.target
    : String(patch.target).trim().slice(0, MAX_LENGTH)

  if (!source || !target) {
    throw createError({ statusCode: 400, statusMessage: 'A term needs both halves.' })
  }

  // The name goes in `data`, not `statusMessage`. That one is written into
  // the HTTP status line, so h3 strips it to ASCII — and a glossary's terms
  // are the least ASCII strings in the app. `"桜町" is already on the list`
  // reached the panel as `"" is already on the list`, which is worse than
  // saying nothing: it names no term and reads like a bug.
  const alreadyListed = () => createError({
    statusCode: 409,
    statusMessage: 'That term is already on the list.',
    data: { message: `"${source}" is already on the list.` },
  })

  // Renaming onto a source the list already holds would break the unique index,
  // and the error a database gives for that is not one to show anybody.
  if (source !== term.source) {
    const clash = await db.query.glossaryTerms.findFirst({
      where: { glossaryId: term.glossaryId, source },
    })

    if (clash) throw alreadyListed()
  }

  let row: GlossaryTerm | undefined

  try {
    const updated = await db
      .update(glossaryTerms)
      .set({ source, target })
      .where(eq(glossaryTerms.id, termId))
      .returning()

    row = updated[0]
  } catch (thrown) {
    // The check above ran across an `await`, so two collaborators renaming
    // different terms onto the same source at once can both pass it — and the
    // loser then hits the unique index raw, surfacing as a 500 where the
    // sequential case got a sentence. Same collision, same answer.
    if (thrown instanceof Error && thrown.message.includes('UNIQUE')) throw alreadyListed()

    throw thrown
  }

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'glossary.term.set',
    subject: 'glossary_terms',
    subjectId: termId,
    detail: { was: term.source, source, target },
  })

  notify(context, { scope: 'glossary', locale: term.glossary.locale ?? '' })

  return row!
}

/**
 * Fold what a page taught us into the list, and hand back the list as it now
 * stands.
 *
 * The whole list rather than what was added, because the caller is a browser
 * mid-run that is about to put the next page through and wants the newest
 * version to send with it — and because "what was added" is a question the
 * caller cannot use for anything.
 *
 * `onConflictDoNothing` rather than an upsert, which is *first translation
 * wins* said in SQL: the unique index on (glossary, source) is what makes a
 * second page proposing a different spelling for a settled name a no-op rather
 * than a rewrite. Two browsers translating different pages of the same chapter
 * at once therefore race harmlessly — whichever insert lands first is the one
 * the chapter keeps, which is the same answer either would have given alone.
 *
 * Not logged, unlike `put`. A run learns a term or two a page, and a hundred
 * `glossary.term.set` rows would bury the log that a second person reads to
 * understand what has been happening in the chapter. What a term *is* is
 * readable from the glossary itself; only a hand-made change is news.
 */
export async function merge (
  context: Context,
  locale: string,
  learned: { src?: unknown, tr?: unknown }[],
): Promise<Term[]> {
  await must(context, translateWorkspace, context)

  const current = await terms(context, locale)

  // First translation wins, nothing that translates to itself, and no further
  // than the cap — `foldTerms`, the same rule a local workspace follows.
  const rows = foldTerms(current, learned)

  if (!rows.length) return current

  // Only now, so a run that learned nothing — which is most pages, once a
  // chapter is under way — does not create a glossary row for a chapter that
  // never needed one.
  const glossary = await primary(context, locale)

  await db
    .insert(glossaryTerms)
    .values(rows.map((row) => ({ ...row, glossaryId: glossary.id })))
    .onConflictDoNothing({ target: [glossaryTerms.glossaryId, glossaryTerms.source] })

  // Only when something was actually learned, which is the rule the earlier
  // build arrived at the hard way: announcing every merge would have every page
  // that heard it re-read, and a re-read that learns a term announces again.
  notify(context, { scope: 'glossary', locale })

  return terms(context, locale)
}

/**
 * Forget one term.
 *
 * The `glossaryId` half of the condition is load-bearing and was missing while
 * nothing called this: an ability only ever looks at the *context*, so a
 * translator on their own workspace could have deleted a term out of somebody
 * else's by naming its id. A term id is just a number. The same guard
 * `blocksIn` makes in `translations`, for the same reason.
 */
export async function remove (context: Context, termId: number): Promise<void> {
  await must(context, translateWorkspace, context)

  // Read before deleting rather than deleting and asking what was hit: the
  // notice needs the language, and that is a fact about the *glossary* the term
  // sat in, which is gone by the time a `returning()` could be inspected.
  const term = await db.query.glossaryTerms.findFirst({
    where: { id: termId },
    with: { glossary: { columns: { workspaceId: true, locale: true } } },
  })

  // A term that is not this workspace's is a term that does not exist, as far
  // as this caller is concerned — the same 404 a stranger gets, so a row you
  // may not touch is not confirmed to exist by the way it refuses you.
  if (!term || term.glossary.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such term.' })
  }

  await db.delete(glossaryTerms).where(eq(glossaryTerms.id, termId))

  notify(context, { scope: 'glossary', locale: term.glossary.locale ?? '' })
}

/**
 * Empty one language's glossary.
 *
 * The glossary row itself stays. It holds nothing but a name and a language,
 * and keeping it means the next term learned does not have to make one — while
 * deleting it would cascade the terms a second time for no gain.
 */
export async function clear (context: Context, locale: string): Promise<void> {
  await must(context, translateWorkspace, context)

  const found = await db.query.glossaries.findFirst({
    where: { workspaceId: context.workspaceId, locale },
  })

  if (!found) return

  await db.delete(glossaryTerms).where(eq(glossaryTerms.glossaryId, found.id))

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'glossary.cleared',
    subject: 'glossaries',
    subjectId: found.id,
    detail: { locale },
  })

  notify(context, { scope: 'glossary', locale })
}
