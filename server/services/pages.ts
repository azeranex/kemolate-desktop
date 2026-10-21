/**
 * The pages of a workspace — which scans, in what order.
 *
 * No image data passes through here. A page is a hash, a path and a position;
 * the file itself stays on the machines that opened it. See the note at the top
 * of the schema.
 */
import { eq } from 'drizzle-orm'

import { must, notify } from './access'
import { record } from './logs'

import type { Context } from './access'
import type { Page } from '~~/server/database'

import { editWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { db, pages } from '~~/server/database'

/** One page as a browser knows it, before the server has an id for it. */
export interface PageDraft {
  /**
   * The page's own name for itself, where the browser already has one.
   *
   * Absent the first time a folder is mentioned — pages read off a disk have
   * never been filed, and finding out which rows they are is the whole of what
   * `sync` does below. Present from then on, because the reply carries it back
   * and the browser keeps it. See `pages.uid`.
   *
   * A browser may also *mint* one, and that is not the same act. A page dropped
   * onto a chapter that is already open, or a blank page added by hand, is a
   * page in its own right rather than a copy of one already here — so the
   * browser names it on the spot and this arrives carrying a uid no workspace
   * has ever heard of. `rowFor` treats that as the claim it is.
   */
  uid?: string | null
  path: string
  name: string
  position: number
  hash?: string | null
  width?: number | null
  height?: number | null
  byteSize?: number | null
}

export async function list (context: Context): Promise<Page[]> {
  await must(context, viewWorkspace, context)

  return db.query.pages.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { position: 'asc' },
  })
}

/**
 * Bring the server's idea of the pages into line with a browser's.
 *
 * Additive, and deliberately so. A page that names itself is the row of that
 * name and nothing else; a page that does not is matched by `hash` first and by
 * `path` second — content before name, because a chapter gets renamed far more
 * often than it gets re-scanned, and the name is only evidence while nothing
 * better is available: a name that matches while the hashes disagree is not a
 * match at all (see `byName`). `rowFor` is where that order and its one refusal
 * are set out. Matches have their position and name brought up to date;
 * anything unrecognised is added.
 *
 * What it will not do is remove. A page the browser did not mention is not
 * evidence that the page is gone: it is just as likely that this reader opened
 * a partial folder, or the chapter in a different format, or that a file failed
 * to read. Blocks, translations and paint hang off page rows, and deleting one
 * takes all of that with it by cascade — so the rule for retiring a page needs
 * to be decided deliberately, with a way back, rather than falling out of a
 * list that happened to be short.
 *
 * That leaves a folder somebody renamed wholesale looking like twice as many
 * pages until hashes are being computed. It is the honest failure of the two:
 * duplicate rows are visible and fixable, and silently detaching an evening's
 * work from its page is neither.
 */
export async function sync (context: Context, drafts: PageDraft[]): Promise<Page[]> {
  await must(context, editWorkspace, context)

  const existing = await db.query.pages.findMany({ where: { workspaceId: context.workspaceId } })

  const byUid = new Map(existing.map((page) => [page.uid, page]))
  const byPath = new Map(existing.map((page) => [page.path, page]))

  /**
   * Hashes that belong to exactly one page, and only those.
   *
   * A hash shared by two rows names neither of them. Counting first and keeping
   * only the singletons is what stops a duplicate being treated as an identity:
   * a chapter holding the same image twice matches those two pages by `uid` or
   * by path, and never by the bytes they have in common.
   */
  const seen = new Map<string, number>()

  for (const page of existing) {
    if (page.hash) seen.set(page.hash, (seen.get(page.hash) ?? 0) + 1)
  }

  const byHash = new Map(
    existing
      .filter((page) => page.hash && seen.get(page.hash) === 1)
      .map((page) => [page.hash, page]),
  )

  /**
   * Which row a draft is — and, for a draft that names itself, the refusal to
   * guess.
   *
   * A draft carrying a `uid` is the page saying who it is, and that answer is
   * taken whole: the row of that name, or **nothing at all**. It does not fall
   * through to the bytes or the path, and the missing fall-through is the rule
   * rather than an oversight. A page dropped onto an open chapter means "and
   * this one too", and matching it to a row that happens to hold the same
   * picture answers a question nobody asked — it turned a drop into a *re-link*,
   * which is a different act with a different gesture (see the page list, where
   * an absent page is offered a file by name).
   *
   * Only a uid-less draft is asking to be recognised, which is what a folder
   * just opened is doing. There the hash comes first, because it is the only
   * thing two people's folders reliably share — but only where it picks out one
   * page. The path is the last resort, for a page this browser has not hashed
   * yet.
   *
   * Drafts already claimed in this same request are struck out as they go: two
   * blank pages arriving together have one hash and one another's paths to
   * choose from, and without that the second would match the row the first had
   * just taken and the chapter would quietly lose a page.
   */
  const taken = new Set<number>()

  /**
   * The page filed under this name, unless the bytes say it is a different one.
   *
   * A name is only evidence about identity while nobody can do better. Once the
   * draft and the row both know their hashes and those hashes differ, the name
   * is the one thing they have in common and it is the thing that just changed
   * — somebody inserted a page at the front of the folder, and every file after
   * it is now called what its neighbour used to be called. Matching on the name
   * anyway is how a page's blocks, translations and paint came to sit on a row
   * describing a different drawing, silently and in the ordinary case.
   *
   * The cost is a page re-scanned at better quality under the same name: it
   * arrives with a hash nothing recognises and is filed as a new page rather
   * than as a new version of the old one. That is the trade this file already
   * argues for a short list — a duplicate is visible and fixable, and silently
   * detaching an evening's work from its page is neither.
   */
  function byName (draft: PageDraft) {
    const row = byPath.get(draft.path)

    if (!row) return undefined

    return draft.hash && row.hash && draft.hash !== row.hash ? undefined : row
  }

  function rowFor (draft: PageDraft) {
    const found = draft.uid
      ? byUid.get(draft.uid)
      : (draft.hash ? byHash.get(draft.hash) : undefined) ?? byName(draft)

    if (!found || taken.has(found.id)) return undefined

    taken.add(found.id)

    return found
  }

  const added: (PageDraft & { uid: string })[] = []

  /**
   * How much of what arrived the workspace already recognises.
   *
   * A list that overlaps the existing pages is somebody's copy of this chapter
   * and may be trusted to describe it. A list that overlaps *nothing* is a
   * different chapter entirely — opened by mistake while standing in this
   * workspace — and adding it wholesale is how one workspace came to hold two
   * chapters with two pages for every position.
   *
   * The client is supposed to have worked this out already and sent nothing.
   * This is the same rule enforced where it cannot be skipped, because the
   * client that gets it wrong is exactly the one that will not be asking.
   *
   * Asked only of the drafts that are *guessing* — the ones with no uid, which
   * are a folder held up with "work out what this is". A draft that names
   * itself is not guessing and is not evidence either way: it is one page
   * somebody deliberately put here, and a chapter whose every local page is
   * still absent has nothing for it to overlap with. Counting those in the
   * denominator refused the first file dropped onto a chapter opened on a
   * second computer — the one moment the reader is most obviously working on
   * the right chapter.
   */
  const guessing = drafts.filter((draft) => !draft.uid)

  const recognised = guessing.filter(
    (draft) => (draft.hash && byHash.has(draft.hash)) || byPath.has(draft.path),
  ).length

  /*
   * Desktop: or a page that carries a name this workspace handed out. That is
   * not a guess at all — it is the browser saying it holds this workspace's
   * chapter — and it is the one evidence a PDF's own pages could offer. A PDF
   * opens on its first page alone, which founds the workspace and is given a
   * uid; the rest stream in afterwards, new and uid-less, and none of them can
   * match a row that does not exist yet. Counting only the guessing drafts
   * read that as a foreign chapter and refused every one, so a 28-page PDF's
   * workspace kept one page row for good (found 2026-10-22). Still refused: a
   * list that names none of this workspace's pages and matches none of them.
   */
  const named = drafts.some((draft) => draft.uid && byUid.has(draft.uid))

  if (existing.length && guessing.length && !recognised && !named) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Those pages are not this workspace’s chapter — none of them match what it already holds.',
    })
  }

  /**
   * Whether any of this actually moved the chapter.
   *
   * Worth the comparison, because this runs far more often than it changes
   * anything: every claim calls it, and so does every pass that fills a hash in
   * behind the hashing burst. A notice raised unconditionally would be one per
   * page per open — and, worse, the browsers it reached would re-read the list,
   * re-align their pages, and have something new to push about. A chapter that
   * has not moved says nothing, and the loop has nowhere to start.
   */
  let touched = false

  /** What each matched row is to become, decided before anything is written. */
  const updates: {
    id: number
    from: string
    values: {
      name: string
      path: string
      position: number
      hash: string | null
      width: number | null
      height: number | null
      byteSize: number | null
    }
  }[] = []

  for (const draft of drafts) {
    const match = rowFor(draft)

    if (!match) {
      // A page nobody has filed gets its name here rather than trusting the
      // browser to have picked an unused one — the id has to be unique within
      // the workspace, and only this side can see the whole of it.
      added.push({ ...draft, uid: draft.uid || crypto.randomUUID() })

      continue
    }

    const values = {
      name: draft.name,
      path: draft.path,
      position: draft.position,
      // Only ever filled in, never blanked: a browser that has not measured a
      // page yet should not erase what another one already knew about it.
      hash: draft.hash ?? match.hash,
      width: draft.width ?? match.width,
      height: draft.height ?? match.height,
      byteSize: draft.byteSize ?? match.byteSize,
    }

    if (Object.entries(values).some(([key, value]) => match[key as keyof typeof values] !== value)) {
      touched = true
    }

    updates.push({ id: match.id, from: match.path, values })
  }

  /**
   * Two scans, one name, and nothing here able to choose between them.
   *
   * The ordinary way to arrive at this is to re-scan a page and leave the file
   * where it was: the hashes disagree so it is not that page any more (see
   * `byName`), and the name it wants is not being vacated by anything else in
   * the list, so it cannot be filed as a new one either — `(workspace_id,
   * path)` is unique and means it.
   *
   * Refused rather than reported by the database. Without this the request dies
   * inside the transaction and the browser is handed a 500 with a SQL string
   * in it, for a situation the reader can fix in five seconds if told which
   * name is contested. The alternative — overwriting the page that is there —
   * is the very rebinding `byName` exists to stop, and a better scan and a
   * renumber that lost a file look identical from here.
   */
  const vacated = new Set(updates.filter((update) => update.values.path !== update.from).map((update) => update.from))

  for (const draft of added) {
    if (!byPath.has(draft.path) || vacated.has(draft.path)) continue

    throw createError({
      statusCode: 409,
      statusMessage: `“${draft.path}” is already a page of this chapter, and a different scan. Rename the file, or remove the page it would replace.`,
    })
  }

  /**
   * All of it or none of it, in one transaction.
   *
   * A sync is a single claim about what the chapter is, and it used to be
   * written a row at a time with nothing holding the row-at-a-time together. A
   * list that could not be satisfied — two drafts wanting one name, a page
   * moving onto a name somebody else holds — left the pages it had already
   * reached renamed and threw on the one it could not, so the browser was told
   * the sync failed and then retried against a chapter that had half-moved
   * underneath it. Failing and changing nothing is a state both sides can
   * reason about; half a rename is not.
   *
   * ## Why the renames go round twice
   *
   * `(workspace_id, path)` is unique, and a renumber asks the pages to shift
   * along a name each: `01.png` has to become `02.png` while `02.png` is still
   * called that. No order of one-row-at-a-time writes satisfies that — the
   * chapter shifting the other way fails on the first row instead of the last,
   * and two pages swapping names is a cycle, which no order fixes at all. It
   * used to work only when the browser happened to list the vacating page
   * first, which is not something a browser can be asked to get right.
   *
   * So every row that is changing its name is moved out of the way first, onto
   * a placeholder nothing else can want, and only then onto the name it is
   * going to. Two writes for a renamed page and none for the rest. Nothing
   * outside the transaction ever sees a placeholder, and a row that fails on
   * the way to its final name takes the whole request back with it — including
   * its own placeholder.
   */
  if (updates.length || added.length) {
    db.transaction((tx) => {
      // Unique per request as well as per row: two syncs racing must not both
      // decide to park a page under the same made-up name.
      const parking = crypto.randomUUID()

      for (const update of updates) {
        if (update.values.path === update.from) continue

        tx.update(pages).set({ path: `~moving/${parking}/${update.id}` }).where(eq(pages.id, update.id)).run()
      }

      for (const update of updates) {
        tx.update(pages).set(update.values).where(eq(pages.id, update.id)).run()
      }

      if (added.length) {
        tx.insert(pages).values(added.map((draft) => ({ ...draft, workspaceId: context.workspaceId }))).run()
      }
    })
  }

  if (added.length) {
    await record({
      workspaceId: context.workspaceId,
      userId: context.actor?.id ?? null,
      action: 'pages.added',
      detail: { count: added.length },
    })
  }

  if (touched || added.length) notify(context, { scope: 'pages' })

  return list(context)
}

/**
 * Take a page out of the chapter.
 *
 * Everything hanging off it goes with it — blocks, their children, their
 * translations, the cleanup surfaces — by cascade, which is what those foreign
 * keys were for. Nothing here has to list them, and nothing is left pointing at
 * a page that is gone.
 *
 * What does *not* go is the file. A scan lives on somebody's disk and in their
 * browser's own storage, and this is a claim about what the chapter contains
 * rather than a claim about their folder. The thumbnail and the cached blocks
 * are filed under the scan's hash rather than under the page, so re-adding the
 * same file finds its reading again — which is the behaviour anybody who
 * removed a page by accident would want.
 *
 * The pages after it close up. Leaving a hole would be harmless until somebody
 * reordered by index and found a gap where a page used to be.
 */
export async function remove (context: Context, pageId: number): Promise<void> {
  await must(context, editWorkspace, context)

  const page = await db.query.pages.findFirst({
    where: { id: pageId },
    columns: { id: true, workspaceId: true, position: true },
  })

  // The 404 a stranger gets: a page you cannot touch should not be confirmed
  // to exist by the way it refuses you.
  if (!page || page.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such page.' })
  }

  db.transaction((tx) => {
    tx.delete(pages).where(eq(pages.id, pageId)).run()

    const left = tx
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.workspaceId, context.workspaceId))
      .orderBy(pages.position)
      .all()

    left.forEach((row, position) => {
      tx.update(pages).set({ position }).where(eq(pages.id, row.id)).run()
    })
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'page.removed',
    subject: 'pages',
    subjectId: pageId,
  })

  notify(context, { scope: 'pages' })
}
