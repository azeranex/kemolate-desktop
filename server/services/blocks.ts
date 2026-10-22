/**
 * Blocks: the boxes of text found on a page, and what they say in the original.
 *
 * What they should say instead is `translations`. The split is deliberate — see
 * the schema — and it is why nothing here writes a target string.
 */
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'

import { must, notify, pageIn } from './access'
import { record } from './logs'

import type { Context } from './access'
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import type { Block, NewBlock } from '~~/server/database'

import { editWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { centredReadingOrder } from '#shared/utils/ocr'
import { blocks, db } from '~~/server/database'

/**
 * The block, proved to be this workspace's — `pageIn` one step further along.
 *
 * `update` and `remove` are handed a block id rather than a page id, and an id
 * is just a number: without this, edit rights on your own workspace would let
 * you move or delete a block on somebody else's page, because the ability check
 * only ever looks at the context.
 *
 * Hands back the page the block sits on, which the guard has already had to
 * fetch. A change notice names a page — that is the unit a browser re-reads —
 * and the alternative was every caller asking the same question a second time
 * to say which page it had just changed.
 */
async function blockIn (context: Context, blockId: number): Promise<number> {
  const block = await db.query.blocks.findFirst({
    where: { id: blockId },
    columns: { pageId: true },
    with: { page: { columns: { workspaceId: true } } },
  })

  if (!block || block.page.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such block.' })
  }

  return block.pageId
}

/**
 * Everything on a page, in reading order, with what each has been translated to.
 *
 * Top-level blocks only, each carrying its children — a balloon somebody joined
 * comes back as one block with its columns inside it rather than as four things
 * that a caller has to know how to reassemble. See `blocks.parentId`: this is
 * the shape that makes a compound behave like an object everywhere, because
 * there is no second list in which its parts appear separately.
 *
 * The children are ordered by their own `position`, which inside a balloon is
 * the order it reads — right to left for columns.
 */
export async function onPage (context: Context, pageId: number) {
  await must(context, viewWorkspace, context)
  await pageIn(context, pageId)

  return db.query.blocks.findMany({
    where: { pageId, parentId: { isNull: true } },
    orderBy: { position: 'asc' },
    with: {
      translations: true,
      children: { orderBy: { position: 'asc' }, with: { translations: true } },
    },
  })
}

/**
 * Every page's blocks in the chapter, by page row — `onPage` for all of them.
 *
 * What a browser opening a chapter reads, in one request rather than one per
 * page. The per-page read went out one page at a time, and on a fifty-page
 * chapter that was six seconds of queue — then the same again, because the
 * pages a workspace shows before its folder is reopened are replaced by the
 * real ones a moment later and each set is restored in turn.
 *
 * Same shape per page as `onPage`, and the same ordering, so a caller can take
 * either answer without knowing which it got. Pages with nothing on them are
 * left out; a missing key means "no blocks", which is also what an empty list
 * would have said.
 */
export async function inChapter (context: Context): Promise<Record<number, Awaited<ReturnType<typeof onPage>>>> {
  await must(context, viewWorkspace, context)

  const pages = await db.query.pages.findMany({
    where: { workspaceId: context.workspaceId },
    columns: { id: true },
  })

  if (!pages.length) return {}

  const rows = await db.query.blocks.findMany({
    where: { pageId: { in: pages.map((page) => page.id) }, parentId: { isNull: true } },
    orderBy: { position: 'asc' },
    with: {
      translations: true,
      children: { orderBy: { position: 'asc' }, with: { translations: true } },
    },
  })

  const found: Record<number, typeof rows> = {}

  for (const row of rows) (found[row.pageId] ??= []).push(row)

  return found
}

/**
 * Put blocks on a page, after whatever it already holds — ones the reader drew,
 * or ones a reading never got rows for.
 *
 * Editor rather than translator: a block is a claim about the artwork, and
 * drawing one is the same kind of act as cleaning under it.
 *
 * This is what `put` became, rather than a second insert path beside it. `put`
 * took the page id *inside* a `NewBlock`, so the only check it could make was
 * the ability — and an ability only ever looks at the context, which meant edit
 * rights on your own workspace were enough to write a block onto a stranger's
 * page. Nothing called it, so that was a hole nobody had walked through rather
 * than a bug anybody had seen; taking `pageId` as its own argument is what makes
 * `pageIn` possible, and having one insert path is what stops the guard being
 * left off again.
 *
 * Appending rather than replacing is the whole difference from `replace`. A
 * hand-drawn block, or the rows a page needs because its original reading
 * happened while there was no workspace to write to, is not a claim about the
 * blocks already there — and `replace`'s delete would throw away work nobody
 * asked to lose. An array rather than one at a time because a page can arrive
 * needing several rows at once, and one request beats a burst of N; N of one is
 * the ordinary single block.
 *
 * `parentId` stays null. Joining blocks into a balloon is `compound`'s job, and
 * a caller who could name a parent here could point a new block at one on
 * somebody else's page — the same hole `pageIn` closes, one table along.
 */
export async function append (
  context: Context,
  pageId: number,
  drafts: Omit<NewBlock, 'pageId' | 'position' | 'parentId'>[],
): Promise<Block[]> {
  await must(context, editWorkspace, context)
  await pageIn(context, pageId)

  if (!drafts.length) return []

  /*
   * One transaction, for the reason `replace` is one: a half-written append is
   * a page holding some of a balloon, and a peer syncing at that moment copies
   * it in that state.
   *
   * The highest existing position is read *inside* it and not counted. A count
   * is wrong on any page that has had a block deleted — five blocks whose last
   * position is seven would put the new row at five, on top of one already
   * there, and two blocks at the same place in reading order are then ordered
   * by whatever the database feels like. Top-level only (`parentId` null),
   * because a child's `position` counts within its balloon and is a different
   * ruler entirely. Reading it in the same transaction is also what stops two
   * browsers appending at once from both seeing the same maximum.
   */
  const written = db.transaction((tx) => {
    const [highest] = tx
      .select({ position: max(blocks.position) })
      .from(blocks)
      .where(and(eq(blocks.pageId, pageId), isNull(blocks.parentId)))
      .all()

    const after = highest?.position ?? -1

    return tx
      .insert(blocks)
      .values(drafts.map((draft, index) => ({ ...draft, pageId, position: after + 1 + index })))
      .returning()
      .all()
  })

  // One entry for the request, not one per block, following `pages.add`: the
  // log is what somebody arriving late reads, a single gesture that added
  // twelve blocks is one thing that happened, and N entries would let one
  // append push everything else out of the fifty `recent` returns.
  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'blocks.added',
    subject: 'pages',
    subjectId: pageId,
    detail: { count: written.length },
  })

  notify(context, { scope: 'blocks', pageId })

  return written
}

/**
 * Everything a reading found on one page, in place of whatever was there.
 *
 * Replacing rather than merging, because that is what reading a page *is*:
 * the blocks describe the same scan the old ones described, so keeping both
 * would leave every balloon doubled. It is the server half of the rule
 * `setBlocks` follows in the browser, and it holds even when the two disagree
 * about how many there should be.
 *
 * One transaction, so a page is never left with the old blocks deleted and
 * the new ones not yet written — a reader looking at that moment would see a
 * page that had lost its lettering, and a peer syncing it would copy that.
 *
 * The position is the index: reading order is the order the engine handed
 * them over, which the detector has already sorted top-to-bottom.
 */
export async function replace (
  context: Context,
  pageId: number,
  drafts: Omit<NewBlock, 'pageId' | 'position'>[],
): Promise<Block[]> {
  await must(context, editWorkspace, context)
  await pageIn(context, pageId)

  const written = db.transaction((tx) => {
    tx.delete(blocks).where(eq(blocks.pageId, pageId)).run()

    if (!drafts.length) return []

    return tx
      .insert(blocks)
      .values(drafts.map((draft, position) => ({ ...draft, pageId, position })))
      .returning()
      .all()
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'blocks.read',
    subject: 'pages',
    subjectId: pageId,
  })

  notify(context, { scope: 'blocks', pageId })

  return written
}

/**
 * What may be changed about a block once it exists, in the order a statement
 * names the columns — see `write`, which is why this is a list and not only a
 * type.
 */
const PATCHABLE = [
  'kind', 'cx', 'cy', 'w', 'h', 'angle', 'skewX', 'skewY', 'quad', 'room', 'source', 'hidden', 'position',
] as const

type Patchable = typeof PATCHABLE[number]

/** What may be changed about a block once it exists. */
export type BlockPatch = Partial<Pick<Block, Patchable>>

/**
 * Made the first time it is asked for, then kept.
 *
 * Not at import: a statement is compiled against the tables as they stand, and
 * a database the migrations have not reached yet — a fresh install, or the test
 * harness before its first `reset` — has none to compile against.
 */
function prepared<Statement> (make: () => Statement): () => Statement {
  let made: Statement | undefined

  return () => (made ??= make())
}

/**
 * One UPDATE per set of columns a patch names, compiled once and kept.
 *
 * Building and compiling a statement costs about ten times what running it does
 * — the review measured 72 µs against 5.6 µs for the same update reused, and
 * the test harness 123 against 14 — and a page's worth of patches is one
 * statement forty times over, because `useBlockSync` sends every column of every
 * block every time (see `toPatch`). So each shape is compiled the first time it
 * arrives and reused after.
 *
 * Keyed by the columns rather than one statement naming all thirteen, because
 * a patch that says nothing about a column must leave it alone and a statement
 * cannot leave alone a column it names. `coalesce` would, if absent were the
 * only way a patch could say nothing — but `quad` and `room` are cleared by
 * writing null, which is the one value `coalesce` cannot tell from absence.
 *
 * `updated_at` is SQLite's to write here, not the column's `$onUpdate`. Drizzle
 * calls that function while it *builds* a statement, so a statement built once
 * would stamp every later write with the moment it was compiled.
 *
 * Bounded, because the shapes are the caller's to choose and thirteen columns
 * make eight thousand of them. In practice there are a handful: the whole block
 * (`useBlockSync`), a room (`useOcr.measureOne`), and whichever fields an agent
 * corrects (`correct_blocks`). The oldest shape goes first; it is compiled
 * again if it ever comes back.
 */
const statements = new Map<string, ReturnType<typeof compile>>()

const STATEMENTS = 32

function compile (columns: readonly Patchable[]) {
  const set: SQLiteUpdateSetSource<typeof blocks> = { updatedAt: sql`(unixepoch())` }

  for (const column of columns) set[column] = sql.placeholder(column)

  return db.update(blocks).set(set).where(eq(blocks.id, sql.placeholder('id'))).returning().prepare()
}

/** A row as it stands, for a patch that names nothing to change. */
const current = prepared(() => db.select().from(blocks).where(eq(blocks.id, sql.placeholder('id'))).prepare())

/**
 * One patch on to one row, and the row as it now stands — undefined if there is
 * no such row. The one place a block's columns are changed after it exists, so
 * `update` and `updateOnPage` cannot come to write a patch differently.
 *
 * Synchronous, like everything `node:sqlite` does, which is what lets a caller
 * run it inside a transaction: a statement compiled on `db` runs on the one
 * connection there is, and the transaction is that connection's.
 *
 * A patch naming no column writes nothing and hands the row back as it is.
 * Handed to drizzle's builder, it was a 500 — "No values to set".
 */
function write (id: number, patch: BlockPatch): Block | undefined {
  const columns = PATCHABLE.filter((column) => patch[column] !== undefined)

  if (!columns.length) return current().get({ id })

  const shape = columns.join()
  let statement = statements.get(shape)

  if (!statement) {
    if (statements.size >= STATEMENTS) statements.delete(statements.keys().next().value!)

    statement = compile(columns)
    statements.set(shape, statement)
  }

  return statement.get({ ...Object.fromEntries(columns.map((column) => [column, patch[column]])), id })
}

export async function update (context: Context, blockId: number, patch: BlockPatch): Promise<Block> {
  await must(context, editWorkspace, context)

  const pageId = await blockIn(context, blockId)

  const block = write(blockId, patch)

  // Gone between the guard and the write — deleted by a request that was
  // handled in between. The guard's answer, a moment late.
  if (!block) throw createError({ statusCode: 404, statusMessage: 'No such block.' })

  notify(context, { scope: 'blocks', pageId })

  return block
}

/** Which of the named rows sit on the page — the guard `updateOnPage` asks inside its transaction. */
const rowsOnPage = prepared(() => db
  .select({ id: blocks.id })
  .from(blocks)
  .where(and(
    eq(blocks.pageId, sql.placeholder('pageId')),
    // The ids as one JSON array rather than a placeholder each, so the
    // statement is the same whatever the page's size and is compiled once.
    sql`${blocks.id} in (select value from json_each(${sql.placeholder('ids')}))`,
  ))
  .prepare())

/**
 * Several of a page's blocks changed at once — `update`, a page at a time.
 *
 * What a settle of `useBlockSync` sends, and what a room measured across a page
 * should. One request per block was three to five hundred of them for a
 * chapter's worth of edits, each resolving the workspace again, asking the
 * block's page again and raising a change notice of its own; this is one of
 * each per page.
 *
 * Every row is proved to be on *this* page before anything is written, and the
 * page to be this workspace's: `pageIn` is the workspace half, and a row on the
 * page is therefore in the workspace. That is stricter than `update`, whose
 * guard asks only for the workspace, and it is what a caller naming a page is
 * owed — a batch mixing two pages' blocks would change a page it did not name.
 * The refusal is a 404 either way, the same one a row that does not exist at
 * all gets, so asking about another workspace's ids confirms nothing about
 * them. `data.missing` names the rows it was refused over, which is how the
 * sync tells a block somebody else deleted from a request that failed — see
 * `useBlockSync.patchPage`.
 *
 * All of it or none of it, in one transaction. The check runs inside it, so no
 * request handled in between can delete a row after it was found; and a write
 * that fails part-way — a constraint, a full disk — takes the ones before it
 * back with it. Half a page of moves applied is a page nobody arranged, and a
 * peer re-reading it at that moment would copy it.
 *
 * The rows come back as they now stand, in the order they were named, which is
 * what the caller agrees its blocks to. No log entry, as `update` has none:
 * moving a block is not something the log records.
 */
export async function updateOnPage (
  context: Context,
  pageId: number,
  patches: (BlockPatch & { id: number })[],
): Promise<Block[]> {
  await must(context, editWorkspace, context)
  await pageIn(context, pageId)

  if (!patches.length) return []

  const written = db.transaction(() => {
    const ids = patches.map((patch) => patch.id)
    const here = new Set(rowsOnPage().all({ pageId, ids: JSON.stringify(ids) }).map((row) => row.id))
    const missing = ids.filter((id) => !here.has(id))

    if (missing.length) {
      throw createError({ statusCode: 404, statusMessage: 'Not blocks on that page.', data: { missing } })
    }

    return patches.map(({ id, ...patch }) => {
      const row = write(id, patch)

      // Proved present a moment ago, in this transaction; only a bug gets here.
      if (!row) throw createError({ statusCode: 500, statusMessage: 'A block vanished mid-write.' })

      return row
    })
  })

  notify(context, { scope: 'blocks', pageId })

  return written
}

/**
 * Take a block off the page.
 *
 * Its translations and the surface that cleans it go with it, by cascade. That
 * is right — they describe a box that no longer exists — but it means this is
 * destructive in a way `hidden` is not, and most of the interface should be
 * reaching for `hidden` instead.
 */
export async function remove (context: Context, blockId: number): Promise<void> {
  await must(context, editWorkspace, context)

  const pageId = await blockIn(context, blockId)

  await db.delete(blocks).where(eq(blocks.id, blockId))

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'block.removed',
    subject: 'blocks',
    subjectId: blockId,
  })

  notify(context, { scope: 'blocks', pageId })
}

/**
 * Join blocks into one — Illustrator's compound path, made.
 *
 * A new block is written and the chosen ones are pointed at it. From then on
 * the parent is the object: it holds the kind, the translation and the
 * lettering, and `onPage` returns it with its children inside rather than
 * returning four things. The children keep their own boxes and their own
 * `source`, which is the per-column reading and the thing `release` gives back.
 *
 * `children` arrive in the order they read — the browser worked that out from
 * geometry the server cannot see — and are stored with `position` counting from
 * nought *within the balloon*. That is a different question from the parent's
 * own `position`, which orders balloons on the page.
 *
 * A balloon may be among them, and is dissolved rather than nested: its columns
 * join the new one directly and its own row goes, taking its translation with
 * it. See the comment on `flattened` for why that is the honest answer and not
 * a shortcut.
 *
 * The parent's box is the union its caller measured. Written rather than
 * derived here because the columns cannot be null, and never authored by hand:
 * whoever moves the children recomputes it, exactly as a compound path has no
 * geometry beyond its subpaths.
 */
export async function compound (
  context: Context,
  pageId: number,
  children: number[],
  parent: Omit<NewBlock, 'pageId' | 'position' | 'parentId'>,
): Promise<Block> {
  await must(context, editWorkspace, context)
  await pageIn(context, pageId)

  const unique = [...new Set(children)]

  if (unique.length !== children.length || unique.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'A balloon is made of two or more different blocks.' })
  }

  const found = await db.query.blocks.findMany({
    where: { id: { in: unique } },
    columns: { id: true, pageId: true, parentId: true },
    with: { children: { columns: { id: true }, orderBy: { position: 'asc' } } },
  })

  if (found.length !== unique.length || found.some((block) => block.pageId !== pageId)) {
    throw createError({ statusCode: 404, statusMessage: 'Those blocks are not all on that page.' })
  }

  if (found.some((block) => block.parentId)) {
    throw createError({ statusCode: 409, statusMessage: 'One of those blocks is already part of a balloon.' })
  }

  const by = new Map(found.map((block) => [block.id, block]))

  /*
   * A balloon among the chosen is *dissolved*, not nested.
   *
   * A balloon inside a balloon is still not a thing a page has — every reader
   * of this would have to walk a tree of unknown depth for no gain — and this
   * used to be a flat refusal. It was the wrong answer to the right rule.
   * Joining two balloons into one is not nesting: what is wanted is a single
   * balloon holding all their columns, which is exactly one level deep. The
   * refusal only ever forced the caller to split both by hand and join the
   * pieces, arriving at the same row this could have written in one go — and
   * auto mode, which makes balloons by the pageful, made that a daily tax.
   *
   * So a chosen block contributes its columns where it has them and itself
   * where it does not, in the order the caller asked for, and the emptied
   * parents are deleted below.
   */
  const flattened = children.flatMap((id) => {
    const block = by.get(id)!

    return block.children.length ? block.children.map((child) => child.id) : [block.id]
  })

  // The parents being dissolved. Their rows go, and with them — by the cascade
  // on `translations.blockId` and `surfaces.blockId` — whatever they were
  // translated to and however they were lettered. That is deliberate and it is
  // the one destructive thing here: the joined source is a different sentence
  // from either half, so a translation of a half is not a translation of the
  // whole, and keeping one would put words on the page that were never a
  // reading of what it now says. The new balloon starts untranslated.
  const dissolving = found.filter((block) => block.children.length).map((block) => block.id)

  if (flattened.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'A balloon is made of two or more different blocks.' })
  }

  // One transaction: a parent with no children reads as an empty balloon that
  // nothing would ever clean up, and children pointing at a parent that was
  // never written would vanish from the page entirely.
  const made = db.transaction((tx) => {
    const after = tx
      .select({ position: blocks.position })
      .from(blocks)
      .where(eq(blocks.pageId, pageId))
      .all()
      .reduce((most, row) => Math.max(most, row.position), -1)

    const [row] = tx
      .insert(blocks)
      .values({ ...parent, pageId, position: after + 1 })
      .returning()
      .all()

    if (!row) throw createError({ statusCode: 500, statusMessage: 'The balloon could not be made.' })

    flattened.forEach((id, position) => {
      tx.update(blocks).set({ parentId: row.id, position }).where(eq(blocks.id, id)).run()
    })

    // Only now, and the order is the whole of why this is safe: `parent_id`
    // cascades, so deleting a dissolved balloon while its columns still pointed
    // at it would take them off the page with it. They point at the new parent
    // by the line above, so what is left to delete is a row with no children —
    // which is the same care `release` takes, for the same reason.
    if (dissolving.length) tx.delete(blocks).where(inArray(blocks.id, dissolving)).run()

    return row
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'blocks.compound',
    subject: 'blocks',
    subjectId: made.id,
  })

  notify(context, { scope: 'blocks', pageId })

  return made
}

/**
 * Take a balloon apart — the compound path, released.
 *
 * The children are let go first and only then is the parent deleted, because
 * `parent_id` cascades: deleting it while they still pointed at it would take
 * them with it, which is the one outcome this whole shape exists to prevent.
 *
 * What comes back is the children, already at the parent's place in the reading
 * order so the page does not rearrange itself around the release.
 */
export async function release (context: Context, blockId: number): Promise<Block[]> {
  await must(context, editWorkspace, context)
  await blockIn(context, blockId)

  const parent = await db.query.blocks.findFirst({
    where: { id: blockId },
    with: { children: { orderBy: { position: 'asc' } } },
  })

  if (!parent?.children.length) {
    throw createError({ statusCode: 400, statusMessage: 'That block is not a balloon.' })
  }

  const freed = db.transaction((tx) => {
    const rows = parent.children.map((child, index) => tx
      .update(blocks)
      .set({ parentId: null, position: parent.position + index })
      .where(eq(blocks.id, child.id))
      .returning()
      .all()[0]!)

    tx.delete(blocks).where(eq(blocks.id, blockId)).run()

    return rows
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'blocks.released',
    subject: 'pages',
    subjectId: parent.pageId,
  })

  notify(context, { scope: 'blocks', pageId: parent.pageId })

  return freed
}

/**
 * Put a page's blocks in the order somebody reads them.
 *
 * `useOcr` orders a reading as it takes it, so a page read since that change
 * arrives correct and never needs this. What it is for is the pages read
 * *before* it — and for the case there is no browser to press the panel's Sort
 * button in, which is every caller reaching this install over MCP.
 *
 * The geometry is `shared/utils/ocr.ts`'s and deliberately not restated here:
 * one page must not be able to come out in two different orders depending on
 * which door the request arrived through. Top-level blocks only, because a
 * child's `position` counts within its balloon and is a different ruler
 * entirely — the columns inside a compound are in the order they read and
 * nothing here should disturb them.
 *
 * One transaction, so a page is never left half renumbered: two rows sharing a
 * position are then ordered by whatever the database feels like, and a peer
 * syncing at that moment copies the muddle.
 */
export async function reorder (
  context: Context,
  pageId: number,
  direction: 'rtl' | 'ltr' = 'rtl',
): Promise<Block[]> {
  await must(context, editWorkspace, context)
  await pageIn(context, pageId)

  const current = await db.query.blocks.findMany({
    where: { pageId, parentId: { isNull: true } },
    orderBy: { position: 'asc' },
  })

  if (current.length < 2) return current

  const sorted = centredReadingOrder(current, direction)

  // Nothing to do is worth detecting rather than writing: this is offered to
  // agents, which will call it on every page of a chapter, and a no-op that
  // still wrote forty rows would announce forty changes to every open tab.
  if (sorted.every((block, position) => block.position === position)) return current

  db.transaction((tx) => {
    sorted.forEach((block, position) => {
      tx.update(blocks).set({ position }).where(eq(blocks.id, block.id)).run()
    })
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'blocks.sorted',
    subject: 'pages',
    subjectId: pageId,
    detail: { count: sorted.length, direction },
  })

  notify(context, { scope: 'blocks', pageId })

  return sorted.map((block, position) => ({ ...block, position }))
}

/**
 * Desktop: one block cut into several, in its place in the reading order.
 *
 * What a detector gets wrong the other way from `compound`: one box round two
 * balloons, or round a balloon and the caption beside it. The window has no cut
 * either — a person deletes the block and draws two — and an agent working over
 * MCP has neither a pointer nor a pen, so this is the cut, said once.
 *
 * The parts take the block's place: written at its `position`, and every
 * top-level block after it moved down to make room, so the page reads in the
 * order it did. The block itself goes, and with it — by the cascades on
 * `translations.blockId` and `surfaces.blockId` — its translations and its
 * cleaning, as `compound` costs a dissolved balloon its own: each part says less
 * than the whole did, so the whole's wording is no part's.
 *
 * Not a balloon (that is `release`), and not a column of one (release the
 * balloon first): a part belongs to the page, never to a balloon it was cut from.
 */
export async function split (
  context: Context,
  blockId: number,
  parts: Omit<NewBlock, 'pageId' | 'position' | 'parentId'>[],
): Promise<Block[]> {
  await must(context, editWorkspace, context)

  const pageId = await blockIn(context, blockId)

  const block = await db.query.blocks.findFirst({
    where: { id: blockId },
    with: { children: { columns: { id: true } } },
  })

  if (!block) throw createError({ statusCode: 404, statusMessage: 'No such block.' })

  if (block.parentId) {
    throw createError({ statusCode: 409, statusMessage: 'That block is a column of a joined balloon — take the balloon apart first.' })
  }

  if (block.children.length) {
    throw createError({ statusCode: 409, statusMessage: 'That block is a joined balloon — take it apart, rather than cutting it.' })
  }

  if (parts.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'A block is cut into two or more parts.' })
  }

  // One transaction: a page with the block gone and its parts not yet written
  // has lost a balloon, and one with both has it twice.
  const made = db.transaction((tx) => {
    tx.update(blocks)
      .set({ position: sql`${blocks.position} + ${parts.length - 1}` })
      .where(and(eq(blocks.pageId, pageId), isNull(blocks.parentId), sql`${blocks.position} > ${block.position}`))
      .run()

    tx.delete(blocks).where(eq(blocks.id, blockId)).run()

    return tx
      .insert(blocks)
      .values(parts.map((part, index) => ({ ...part, pageId, position: block.position + index })))
      .returning()
      .all()
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'blocks.split',
    subject: 'pages',
    subjectId: pageId,
    detail: { block: blockId, parts: made.length },
  })

  notify(context, { scope: 'blocks', pageId })

  return made
}
