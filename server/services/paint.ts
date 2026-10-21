/**
 * Retouching: the surfaces paint lands on, and the strokes themselves.
 *
 * The one service where the storage shape is the whole design. Strokes are
 * appended, never edited; undo is another append; and the flattened bitmap is a
 * cache that anybody may compute and nobody has to reconcile. See the note on
 * `strokes` in the schema for why it is a log rather than a picture.
 *
 * The consequence for this file is that there is no `updateStroke` and no
 * `deleteStroke`. If one appears, the merge story has quietly been thrown away.
 */
import { and, count, eq, gt, inArray, lte, max, notLike, sql } from 'drizzle-orm'

import { must, notify, pageIn } from './access'
import { ensurePlate } from './layers'

import type { PlateId } from '#shared/utils/layers'
import type { Context } from './access'
import type { NewStroke, Stroke, StrokeParams, Surface } from '~~/server/database'

import { editWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { db, strokes, surfaces } from '~~/server/database'

/**
 * That an id handed in by a route is actually in this workspace.
 *
 * Every public function here takes row ids, and an id is just a number — a
 * caller with edit rights on their *own* workspace could otherwise name a
 * surface or stroke from somebody else's and have the ability check pass,
 * because the ability only ever looks at the context. These guards are what
 * make "workspace" mean something at the paint layer, and they answer with the
 * same 404 a stranger gets everywhere else: a row you cannot touch should not
 * be confirmed to exist by the way it refuses you.
 */
async function surfaceIn (context: Context, surfaceId: number): Promise<Surface> {
  const surface = await db.query.surfaces.findFirst({
    where: { id: surfaceId },
    with: { page: { columns: { workspaceId: true } } },
  })

  if (!surface || surface.page.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such surface.' })
  }

  return surface
}

/**
 * The surface a mark belongs on, made if it is not there yet.
 *
 * `key` is `bg` for retouching that belongs to no block, or the block's own
 * key. Making it on demand rather than up front means a page costs nothing
 * until somebody paints on it, which for a two hundred page volume is the
 * difference between a row per balloon and none at all.
 */
export async function surfaceFor (
  context: Context,
  where: { pageId: number, layerId: number, key: string, blockId?: number | null },
): Promise<Surface> {
  await must(context, editWorkspace, context)

  // Each foreign id checked against the workspace before a row ties them
  // together — otherwise this insert is how a surface ends up pointing at one
  // workspace's page and another's layer, which no later guard can make sense
  // of.
  const page = await db.query.pages.findFirst({
    where: { id: where.pageId },
    columns: { workspaceId: true },
  })
  const layer = await db.query.layers.findFirst({
    where: { id: where.layerId },
    columns: { workspaceId: true },
  })

  if (page?.workspaceId !== context.workspaceId || layer?.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such page.' })
  }

  if (where.blockId != null) {
    const block = await db.query.blocks.findFirst({
      where: { id: where.blockId },
      with: { page: { columns: { workspaceId: true } } },
    })

    if (block?.page.workspaceId !== context.workspaceId) {
      throw createError({ statusCode: 404, statusMessage: 'No such block.' })
    }
  }

  const [surface] = await db
    .insert(surfaces)
    .values(where)
    .onConflictDoUpdate({
      // Nothing to change, but a conflict has to resolve to something for the
      // row to come back — and coming back is the point.
      target: [surfaces.pageId, surfaces.key],
      set: { layerId: where.layerId },
    })
    .returning()

  return surface!
}

export interface StrokeDraft {
  /** The client's own clock, not a timestamp — see the schema. */
  seq: number
  clientId: string
  tool: Stroke['tool']
  composite?: string | null
  params: StrokeParams
  /** Flat `x y` pairs in page pixels. */
  points: number[]
  x: number
  y: number
  w: number
  h: number
}

/**
 * Lay a mark down.
 *
 * Idempotent on `(surface, client, seq)`: a client that retries a frame it is
 * not sure landed must not paint twice, and over a flaky connection it will
 * retry. The unique index is what makes that safe, and `onConflictDoNothing`
 * is what makes it quiet.
 */
export async function append (
  context: Context,
  surfaceId: number,
  draft: StrokeDraft,
): Promise<Stroke | null> {
  await must(context, editWorkspace, context)

  // Kept rather than discarded: the notice below carries the page and the key,
  // and this guard has already had to fetch them.
  const surface = await surfaceIn(context, surfaceId)

  const values: NewStroke = { ...draft, surfaceId, authorId: context.actor?.id }

  const [stroke] = await db
    .insert(strokes)
    .values(values)
    .onConflictDoNothing({ target: [strokes.surfaceId, strokes.clientId, strokes.seq] })
    .returning()

  // Only when the mark is new. A retry of a frame the surface already had
  // changes nothing on it, and telling the room to re-read a log that has not
  // grown is a round trip per flaky connection — exactly the situation the
  // idempotency above exists to make cheap.
  if (stroke) notify(context, { scope: 'strokes', surfaceId, pageId: surface.pageId, key: surface.key })

  // Null means "already had it", which is a success as far as the caller is
  // concerned — the mark is on the page either way.
  return stroke ?? null
}

/** One surface's share of a batch — see `appendMany`. */
export interface SurfaceBatch {
  pageId: number
  /** `bg`, or a sheet's stack id — the surface's name on its page. */
  key: string
  /** The plate whose row files the surface, for the retouching. */
  plate?: PlateId | null
  /** Or the stack row's own uid, for a sheet somebody added. */
  layer?: string | null
  strokes: (StrokeDraft & { retracted?: boolean })[]
}

/**
 * What became of one surface's share.
 *
 * - `kept`: every stroke is on the server, and `strokes` is each of them as it
 *   is filed there — including one an earlier try already landed, which is
 *   what lets a retry end in "you can let go of your copy" rather than in a
 *   refusal that looks like a failure.
 * - `waiting`: the surface belongs to a sheet whose stack row has not arrived
 *   yet. Nothing was written; the browser holds on and asks again.
 * - `gone`: the page is not this workspace's, or not anybody's any more.
 */
export type SurfaceBatchAnswer =
  | { pageId: number, key: string, status: 'kept', surfaceId: number, strokes: Stroke[] }
  | { pageId: number, key: string, status: 'waiting' | 'gone' }

/**
 * Lay a run of marks down, on however many surfaces they belong to.
 *
 * This is what a paint canvas sends instead of one POST per stroke. The single
 * road cost a request per mark, and every one raised a notice that sent each
 * collaborator back to re-read the surface's whole log — K strokes, K requests
 * out and K whole-log reads in on every other tab. A run is one request and one
 * notice per surface it touched.
 *
 * ## The first stroke is what makes a surface
 *
 * A surface is named by page and key, and made here if it does not exist —
 * `surfaceFor` does the making, with the plate's row founded if the page has
 * no stack yet. It used to be made the moment a canvas *looked* at a page:
 * every page anybody turned to got a `bg` surface and a founded stack, and 162
 * of the 180 `bg` rows in the database on 2026-09-30 had never held a stroke.
 * A sheet whose stack row has not synced yet answers `waiting` rather than
 * inventing one: the row carries the sheet's name and place in the pile, which
 * only the stack sync knows.
 *
 * ## Still idempotent, and now it says so
 *
 * `(surface, client, seq)` is a stroke's identity and the unique index still
 * decides it — a batch resent after a response went missing writes nothing
 * twice. What changed is the answer to a duplicate: the stored row comes back,
 * like a new one, because "the server has it" is exactly what the browser needs
 * to hear before it lets go of its own copy.
 *
 * The one field a resend may change is `retracted`. A stroke undone while its
 * batch was in the air is still unacknowledged, still this browser's own, and
 * nobody else can have retracted it — nobody else has its id — so the browser's
 * latest word on it is the right one. Only a stroke whose flag actually moved is
 * rewritten (`setWhere`), so an unchanged retry is not a write at all.
 */
export async function appendMany (context: Context, batches: SurfaceBatch[]): Promise<SurfaceBatchAnswer[]> {
  await must(context, editWorkspace, context)

  // Every page named, checked against the workspace in one read — the batch's
  // equivalent of `pageIn`, answered per surface rather than by throwing, so a
  // page deleted under somebody's queue does not hold up the rest of it.
  const named = [...new Set(batches.map((batch) => batch.pageId))]
  const here = new Set((await db.query.pages.findMany({
    where: { workspaceId: context.workspaceId, id: { in: named } },
    columns: { id: true },
  })).map((page) => page.id))

  const known = here.size
    ? await db.query.surfaces.findMany({
        where: { pageId: { in: [...here] }, key: { in: [...new Set(batches.map((batch) => batch.key))] } },
      })
    : []

  const held = new Map(known.map((surface) => [`${surface.pageId}:${surface.key}`, surface]))

  const answers: SurfaceBatchAnswer[] = []
  const due: { batch: SurfaceBatch, surface: Surface, at: number }[] = []

  for (const batch of batches) {
    const where = { pageId: batch.pageId, key: batch.key }

    if (!here.has(batch.pageId)) {
      answers.push({ ...where, status: 'gone' })

      continue
    }

    const surface = held.get(`${batch.pageId}:${batch.key}`) ?? await make(context, batch)

    if (!surface) {
      answers.push({ ...where, status: 'waiting' })

      continue
    }

    held.set(`${batch.pageId}:${batch.key}`, surface)
    due.push({ batch, surface, at: answers.length })
    // Filled in below, once the strokes are down.
    answers.push({ ...where, status: 'waiting' })
  }

  // Every surface's strokes in one transaction: synchronous, so no other
  // request's write lands halfway through somebody's run.
  const written = db.transaction((tx) => due.map(({ batch, surface, at }) => {
    const values: NewStroke[] = batch.strokes.map((draft) => ({
      seq: draft.seq,
      clientId: draft.clientId,
      tool: draft.tool,
      composite: draft.composite ?? null,
      params: draft.params,
      points: draft.points,
      x: draft.x,
      y: draft.y,
      w: draft.w,
      h: draft.h,
      retracted: draft.retracted ?? false,
      surfaceId: surface.id,
      authorId: context.actor?.id,
    }))

    const moved = tx
      .insert(strokes)
      .values(values)
      .onConflictDoUpdate({
        target: [strokes.surfaceId, strokes.clientId, strokes.seq],
        set: { retracted: sql`excluded.retracted` },
        setWhere: sql`${strokes.retracted} <> excluded.retracted`,
      })
      .returning({ id: strokes.id })
      .all()

    // Read back rather than taken from `returning`, which leaves out a row the
    // conflict clause did not touch — and a retry's rows are exactly those.
    const asked = new Set(batch.strokes.map((draft) => `${draft.clientId}:${draft.seq}`))
    const rows = tx
      .select()
      .from(strokes)
      .where(and(
        eq(strokes.surfaceId, surface.id),
        inArray(strokes.clientId, [...new Set(batch.strokes.map((draft) => draft.clientId))]),
        inArray(strokes.seq, [...new Set(batch.strokes.map((draft) => draft.seq))]),
      ))
      .all()
      .filter((row) => asked.has(`${row.clientId}:${row.seq}`))

    return { surface, at, moved: moved.length > 0, rows }
  }))

  for (const { surface, at, moved, rows } of written) {
    answers[at] = { pageId: surface.pageId, key: surface.key, status: 'kept', surfaceId: surface.id, strokes: rows }

    // Once per surface, and only where something is new or taken back: a
    // retry that changed nothing is a round trip for nobody.
    if (moved) notify(context, { scope: 'strokes', surfaceId: surface.id, pageId: surface.pageId, key: surface.key })
  }

  return answers
}

/**
 * The surface a batch names, made — or null where it cannot be yet.
 *
 * A plate's row is `ensurePlate`'s to find or found. A sheet's is the stack's,
 * and only exists once the stack sync has written it; guessing one here would
 * put the sheet's marks on a row with the wrong name and no place in the pile.
 */
async function make (context: Context, batch: SurfaceBatch): Promise<Surface | null> {
  let layerId: number | null = null

  if (batch.layer) {
    const row = await db.query.layers.findFirst({
      where: { workspaceId: context.workspaceId, pageId: batch.pageId, uid: batch.layer },
      columns: { id: true },
    })

    layerId = row?.id ?? null
  } else if (batch.plate) {
    layerId = (await ensurePlate(context, batch.plate, batch.pageId)).id
  }

  if (!layerId) return null

  return surfaceFor(context, { pageId: batch.pageId, layerId, key: batch.key })
}

/**
 * Undo a mark — by marking it, not by removing it.
 *
 * A deleted row cannot be reconciled with a peer who never saw it go, and redo
 * would have nothing to bring back. Anyone may retract their own; an editor may
 * retract anybody's, which is what makes cleaning up after a collaborator
 * possible without handing out ownership.
 */
export async function retract (context: Context, strokeId: number, undo = true): Promise<void> {
  await must(context, editWorkspace, context)

  const stroke = await db.query.strokes.findFirst({
    where: { id: strokeId },
    with: { surface: { with: { page: { columns: { workspaceId: true } } } } },
  })

  if (!stroke || stroke.surface.page.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such stroke.' })
  }

  await db.update(strokes).set({ retracted: undo }).where(eq(strokes.id, strokeId))

  // The surface the mark was on, which is the unit a browser re-reads — and a
  // retraction is exactly the case `strokesSince` keeps returning retracted rows
  // for, so the peers holding the older state are told rather than left with a
  // mark whose removal they can never learn about.
  notify(context, {
    scope: 'strokes',
    surfaceId: stroke.surfaceId,
    pageId: stroke.surface.pageId,
    key: stroke.surface.key,
  })
}

/**
 * Every live mark on a surface that a client has not already seen.
 *
 * `since` is a `seq`, not a time, so a client that has been away asks for what
 * it is missing rather than for what happened recently — those are different
 * questions the moment two people are painting at once.
 *
 * Retracted marks come back too: a client holding the older state needs to be
 * told the retraction, and a client starting fresh can drop them on sight.
 */
export async function strokesSince (context: Context, surfaceId: number, since = 0) {
  await must(context, viewWorkspace, context)
  await surfaceIn(context, surfaceId)

  return db.query.strokes.findMany({
    where: { surfaceId, seq: { gt: since } },
    orderBy: { seq: 'asc', clientId: 'asc' },
  })
}

/** One surface of a page, as `onPage` answers for it. */
export interface PageSurface {
  id: number
  key: string
  layerId: number
  /** Every row, or with a cursor, every row past it — live and retracted both. */
  strokes: Stroke[]
  /**
   * With a cursor only: every row on the surface that is taken back, by id,
   * and how many rows it has all told.
   *
   * What makes an incremental read possible at all. A retraction does not add
   * a row, it flips one, so rows past a cursor can never say that a mark left —
   * the reason `strokesSince` has always been read from nought. The flipped ids
   * say it instead, whole, for a few bytes a row rather than the path; `total`
   * is how the browser checks that what it holds and what is here still agree,
   * and reads the page whole when they do not.
   */
  retracted?: number[]
  total?: number
}

/**
 * The paint on one page — every surface but the mask corrections, and the
 * marks on each — for the canvas that shows it.
 *
 * With the stack, one read where a page turn used to make four requests, two
 * of them writes: the stack, then `layers/ensure` and `surfaces` to *make* the
 * surface before it could be read, then its log. A page nobody has painted has
 * no surfaces, and says so here by answering with none.
 *
 * The mask corrections are left out because they have their own reader —
 * `useMaskEdits`, per balloon and chapter-wide — and are the part of a page's
 * surfaces that runs to hundreds.
 *
 * ## `horizon`, and reading past a cursor
 *
 * `after` asks only for rows newer than the browser already holds, which is
 * what a collaborator's notice wants: what they just painted, not the page's
 * whole history again. It works because a stroke's id only ever grows and a
 * stroke is never deleted — only its whole surface, by cascade — so "every
 * row past the newest I have" is complete for new marks. `retracted` covers
 * the one thing that changes in place.
 *
 * `horizon` is the newest row on the page when this was read. Everything at
 * or below it is in this answer or was in an earlier one; the browser's next
 * cursor is this, not the newest row it happens to hold, because rows it
 * learned of from its own batch may be newer than rows somebody else laid
 * between the two.
 *
 * All in one transaction, which on a synchronous driver is a snapshot: the
 * horizon, the surfaces and the rows are of one moment, and a stroke landing
 * between two of those reads cannot slip under a horizon it was not counted in.
 */
export async function onPage (context: Context, pageId: number, after = 0): Promise<{ horizon: number, surfaces: PageSurface[] }> {
  await must(context, viewWorkspace, context)
  await pageIn(context, pageId)

  return db.transaction((tx) => {
    const found = tx
      .select({ id: surfaces.id, key: surfaces.key, layerId: surfaces.layerId })
      .from(surfaces)
      .where(and(eq(surfaces.pageId, pageId), notLike(surfaces.key, 'mask-%')))
      .orderBy(surfaces.id)
      .all()

    if (!found.length) return { horizon: 0, surfaces: [] }

    const ids = found.map((surface) => surface.id)
    const [top] = tx.select({ horizon: max(strokes.id) }).from(strokes).where(inArray(strokes.surfaceId, ids)).all()
    const horizon = top?.horizon ?? 0

    const rows = tx
      .select()
      .from(strokes)
      .where(and(inArray(strokes.surfaceId, ids), gt(strokes.id, after), lte(strokes.id, horizon)))
      .orderBy(strokes.seq, strokes.clientId)
      .all()

    const by = new Map<number, Stroke[]>(ids.map((id) => [id, []]))

    for (const row of rows) by.get(row.surfaceId)?.push(row)

    if (!after) return { horizon, surfaces: found.map((surface) => ({ ...surface, strokes: by.get(surface.id) ?? [] })) }

    const flipped = tx
      .select({ id: strokes.id, surfaceId: strokes.surfaceId })
      .from(strokes)
      .where(and(inArray(strokes.surfaceId, ids), eq(strokes.retracted, true)))
      .all()

    const totals = new Map(tx
      .select({ surfaceId: strokes.surfaceId, total: count() })
      .from(strokes)
      .where(inArray(strokes.surfaceId, ids))
      .groupBy(strokes.surfaceId)
      .all()
      .map((row) => [row.surfaceId, row.total]))

    return {
      horizon,
      surfaces: found.map((surface) => ({
        ...surface,
        strokes: by.get(surface.id) ?? [],
        retracted: flipped.filter((row) => row.surfaceId === surface.id).map((row) => row.id),
        total: totals.get(surface.id) ?? 0,
      })),
    }
  })
}

/**
 * Every surface in the workspace and every live mark on it, in one answer.
 *
 * The read an export makes, and the only one here that is not about a single
 * surface. It exists because of where a stroke ends up once a workspace is
 * shared: `Paint` lays every mark in the browser's own log first, and
 * `usePaintSync` appends it here and *forgets the local copy* — so a browser
 * that has been collaborating holds almost none of the retouching it can see.
 * Gathering a project file out of the local cache alone would produce an
 * archive that looked complete and had lost the cleanup of every page anybody
 * else had touched.
 *
 * Retracted marks are left out, which is the one place this differs from
 * `strokesSince`. That function keeps them because a peer holding the older
 * state has to be *told* about an undo it never saw; a file being written now
 * has no older state to correct, and an undone stroke restored on import is a
 * mark somebody deliberately took back coming silently home.
 *
 * `key` comes back with each surface rather than the row id, because an id
 * means nothing in the workspace this gets imported into — the key is the name
 * the canvas uses, and it is the same name on every machine.
 */
export async function everything (context: Context, options: { masks?: boolean } = {}) {
  await must(context, viewWorkspace, context)

  const pages = await db.query.pages.findMany({
    where: { workspaceId: context.workspaceId },
    columns: { id: true, uid: true },
    with: {
      surfaces: {
        // Only the mask corrections, for the one caller that wants nothing else
        // — see the endpoint. It is every open now, and the retouching it would
        // otherwise carry along is the log that grows.
        ...(options.masks ? { where: { key: { like: 'mask-%' } } } : {}),
        columns: { key: true },
        with: {
          strokes: {
            where: { retracted: false },
            orderBy: { seq: 'asc', clientId: 'asc' },
            columns: {
              seq: true,
              clientId: true,
              tool: true,
              composite: true,
              params: true,
              points: true,
              x: true,
              y: true,
              w: true,
              h: true,
            },
          },
        },
      },
    },
  })

  // Pages with nothing painted on them are dropped rather than sent as empty
  // objects: a two hundred page volume with one cleaned balloon should answer
  // with one page, not with a hundred and ninety-nine statements that nothing
  // happened.
  return pages
    .map((page) => ({
      uid: page.uid,
      surfaces: page.surfaces.filter((surface) => surface.strokes.length),
    }))
    .filter((page) => page.surfaces.length)
}

/**
 * Fold the tail of the log into the bitmap and drop it.
 *
 * TODO — not written, and it needs two things that do not exist yet: something
 * that can rasterise a stroke server-side, and a stability watermark saying
 * which strokes no peer can still insert before.
 *
 * The rules it must obey are in the schema note on `strokes`, and the reason it
 * is dangerous is worth repeating here: baking is destructive. Bake a stroke
 * that a peer could still order before, and their mark lands on top of paint
 * that should have covered it — silently, and with no way back. Getting this
 * wrong loses work in a way nothing else in these services can.
 */
export async function bake (context: Context, _surfaceId: number): Promise<never> {
  await must(context, editWorkspace, context)

  throw createError({
    statusCode: 501,
    statusMessage: 'Baking is not implemented — it needs a rasteriser and a stability watermark.',
  })
}

/** How long the live log has grown, for whatever decides when to bake. */
export async function backlog (surfaceId: number): Promise<number> {
  const surface = await db.query.surfaces.findFirst({
    where: { id: surfaceId },
    columns: { bakedSeq: true },
  })

  const rows = await db
    .select({ id: strokes.id })
    .from(strokes)
    .where(and(eq(strokes.surfaceId, surfaceId), gt(strokes.seq, surface?.bakedSeq ?? 0)))

  return rows.length
}
