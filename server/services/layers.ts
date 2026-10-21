/**
 * The layer stack of a page: what rows there are, in what order, and which of
 * them draw.
 *
 * **Of a page.** It used to be of the workspace — one stack for the chapter —
 * and the trouble was not that it was shared but that it could not be anything
 * else: a sheet added to sketch over one awkward panel turned up on all three
 * hundred pages, with nothing to say otherwise.
 *
 * What was good about the old arrangement is still wanted, though. Nobody
 * wants to hide the mask on every page one at a time, and the five plates
 * should look the same throughout a chapter. So that became a *gesture*
 * instead of a shape: `sync` will write the stack it is given to every page of
 * the workspace when the browser asks, and the switch in the layers panel is
 * what asks. Sameness is now something somebody keeps saying rather than
 * something the rows cannot help.
 *
 * Where the pixels of a row land, per page, is `paint.ts`.
 */
import { and, eq, inArray } from 'drizzle-orm'

import { must, notify, pageIn } from './access'

import type { Adjustment } from '#shared/utils/adjust'
import type { PlacedImage, PlateId, StackLayer } from '#shared/utils/layers'
import type { Context } from './access'
import type { Layer } from '~~/server/database'

import { editWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { DEFAULT_STACK, standardUids } from '#shared/utils/layers'
import { db, layers } from '~~/server/database'

/**
 * The whole stack, flat, in paint order.
 *
 * Flat rather than nested: the tree is `parentId` and `position`, and building
 * it is a two-line fold the caller can do against whatever shape its own
 * interface wants. Handing back a tree here would pick that shape for them.
 */
export async function stack (context: Context, pageId: number): Promise<Layer[]> {
  await must(context, viewWorkspace, context)

  return db.query.layers.findMany({
    // The workspace as well as the page, though the page alone would identify
    // the rows: it is the context's own claim, and matching on it means a page
    // id from another chapter returns nothing rather than that chapter's stack.
    where: { workspaceId: context.workspaceId, pageId },
    orderBy: { position: 'asc' },
  })
}

/**
 * The row of the stack a plate paints into, made if the workspace has none.
 *
 * Paint needs a layer id before the first stroke, and a fresh workspace has no
 * rows at all — nothing seeds the stack server-side. Rather than making every
 * client check-then-create (two calls and a race), this is the one idempotent
 * ask: the plate's row, whoever gets there first making it.
 */
/**
 * Give a page the stack every page starts with, if it has none.
 *
 * `DEFAULT_STACK` is shared code — the browser derives its panel from it, and
 * the five plates a translated page is made of are not the reader's to invent —
 * so founding a stack here writes exactly what the canvas would have shown.
 *
 * It exists because `ensurePlate` used to write a single orphan row. A stroke
 * needs a `layerId` before anything has synced a stack, so painting on a fresh
 * page left it holding one row called "Cleaned plate" and nothing else — which
 * is not a partial stack, it is a stack that is wrong. The browser then read
 * those rows back as authoritative and replaced a full panel with one layer.
 * Founding the whole thing means "the page has layers" and "the page has a
 * stack" are the same statement.
 *
 * Per page now rather than per workspace, which is the same guarantee one level
 * down: painting on a page nobody has drawn on gives it its own five plates
 * rather than nothing. *Painting* — it used to be turning to it, which founded
 * a stack on every page anybody looked at; see `useLayerSync.pull`, which now
 * takes a page with no rows as the default stack it would have been given.
 */
async function found (context: Context, pageId: number): Promise<void> {
  foundBare(context, [pageId])
}

/**
 * `DEFAULT_STACK`, written onto whichever of these pages have no rows at all.
 *
 * The check is inside the transaction with the writes, and that is the whole
 * of why this is one function rather than a read and then a write: on a
 * synchronous driver nothing lands between the two, so two requests founding
 * the same page cannot both find it bare — the second would fail the unique
 * index on `(page_id, uid)` and take its request down with it.
 */
function foundBare (context: Context, pageIds: number[]): number[] {
  if (!pageIds.length) return []

  // Flattened depth-first, parents before children, so a child always has its
  // parent's id to hand.
  const rows: { uid: string, parent: string | null, layer: StackLayer, position: number }[] = []

  const walk = (stack: StackLayer[], parent: string | null) => {
    stack.forEach((layer, position) => {
      rows.push({ uid: layer.id, parent, layer, position })
      walk(layer.children ?? [], layer.id)
    })
  }

  walk(DEFAULT_STACK, null)

  return db.transaction((tx) => {
    const dressed = new Set(tx
      .selectDistinct({ pageId: layers.pageId })
      .from(layers)
      .where(and(eq(layers.workspaceId, context.workspaceId), inArray(layers.pageId, pageIds)))
      .all()
      .map((row) => row.pageId))

    const bare = pageIds.filter((pageId) => !dressed.has(pageId))

    for (const pageId of bare) {
      const ids = new Map<string, number>()

      for (const row of rows) {
        const [made] = tx
          .insert(layers)
          .values({
            workspaceId: context.workspaceId,
            pageId,
            uid: row.uid,
            parentId: row.parent ? ids.get(row.parent) ?? null : null,
            position: row.position,
            label: row.layer.label,
            hint: row.layer.hint ?? null,
            plate: row.layer.plate ?? null,
            visible: row.layer.visible,
            opacity: row.layer.opacity,
            locked: row.layer.locked ?? false,
            fixed: row.layer.fixed ?? false,
          })
          .returning()
          .all()

        if (made) ids.set(row.uid, made.id)
      }
    }

    return bare
  })
}

export async function ensurePlate (context: Context, plate: PlateId, pageId: number): Promise<Layer> {
  await must(context, editWorkspace, context)
  // The page is the request body's claim, not the context's — see `pageIn`.
  await pageIn(context, pageId)

  // The whole stack, not just this plate — see `found`. A row on its own is a
  // stack that is wrong, and the browser believes what it reads.
  await found(context, pageId)

  const existing = await db.query.layers.findFirst({
    where: { workspaceId: context.workspaceId, pageId, plate },
  })

  if (existing) return existing

  // The stack's own name for a plate is the plate — see `DEFAULT_STACK`, whose
  // five plate rows are `dialogue`, `sfx`, `mask`, `clean` and `art`. Setting
  // it here is what makes a row made on demand and the same row arriving in a
  // stack sync one row rather than two.

  // The names the client's default stack uses, so a row made on demand here and
  // the row the panel is already showing are the same row by both their names.
  const labels: Record<PlateId, string> = {
    dialogue: 'Dialogue',
    sfx: 'Sound effects',
    mask: 'Mask',
    clean: 'Cleaned plate',
    art: 'Original art',
  }

  const [layer] = await db
    .insert(layers)
    .values({ workspaceId: context.workspaceId, pageId, uid: plate, label: labels[plate], plate, position: 0 })
    .returning()

  return layer!
}

/** One row of the stack as a browser holds it, flattened — see `sync`. */
export interface LayerDraft {
  /** `StackLayer.id`, and the row's identity here too. */
  uid: string
  /** The uid of the group it sits in, or null at the top of the stack. */
  parentUid?: string | null
  position: number
  label: string
  hint?: string | null
  plate?: PlateId | null
  visible: boolean
  opacity: number
  locked?: boolean
  paint?: boolean
  fixed?: boolean
  clipped?: boolean
  adjust?: Adjustment | null
  /** A picture placed on the page — the reference only. See `layers.image`. */
  image?: PlacedImage | null
}

/**
 * Bring a page's stored stack into line with a browser's.
 *
 * An upsert keyed on `uid`, and never a delete-and-rewrite, because
 * `surfaces.layer_id` cascades: rewriting the stack would take every stroke
 * filed under every row with it. So a row that is still there is updated in
 * place, a row that is new is inserted, and only a row the browser no longer
 * mentions is deleted — which is a layer somebody actually removed, and taking
 * its surfaces with it is then the right thing rather than an accident.
 *
 * Two passes over the rows, because a group and its children arrive together
 * and a child cannot name its parent until the parent has an id. The first pass
 * writes every row with `parentId` left null; the second fills the parents in
 * once every uid is known. A tree cannot be inserted in one pass in any order —
 * the flattening is depth-first, so a parent does precede its children, but a
 * *move* can make a row the child of a group that is written later.
 *
 * ## One page, always
 *
 * This never reaches another page. A stack belongs to the page it describes,
 * and the only thing that speaks for the whole chapter is `preset`, which can
 * touch nothing but the standard plates. That division is deliberate: the
 * statement below deletes rows the browser stopped mentioning, and a version of
 * it that ran against every page would delete a sheet only page seven had —
 * along with every stroke on it, by the cascade — on every ordinary save.
 */
export async function sync (
  context: Context,
  drafts: LayerDraft[],
  pageId: number,
): Promise<Layer[]> {
  await must(context, editWorkspace, context)

  /*
   * The pages this save is about — this one, or all of them.
   *
   * Read rather than assumed even in the single-page case, so that a page id
   * belonging to another chapter selects nothing and writes nothing. The
   * context has already proved the *workspace*; this is what ties the page to
   * it, and without it the id in the request body would be taken on trust.
   */
  const pages = await db.query.pages.findMany({
    where: { workspaceId: context.workspaceId },
    columns: { id: true },
  })

  const targets = pages.filter((page) => page.id === pageId).map((page) => page.id)

  if (!targets.length) return []

  const existing = await db.query.layers.findMany({ where: { workspaceId: context.workspaceId } })
  const wanted = new Set(drafts.map((draft) => draft.uid))

  db.transaction((tx) => {
    for (const page of targets) {
      // This page's rows only. A uid is unique per page, not per workspace, so
      // every page has its own row called `dialogue` and they must not be
      // mistaken for one another.
      const held = new Map(
        existing.filter((layer) => layer.pageId === page).map((layer) => [layer.uid, layer]),
      )

      for (const draft of drafts) {
        const values = {
          position: draft.position,
          label: draft.label,
          hint: draft.hint ?? null,
          plate: draft.plate ?? null,
          visible: draft.visible,
          opacity: draft.opacity,
          locked: draft.locked ?? false,
          paint: draft.paint ?? false,
          fixed: draft.fixed ?? false,
          clipped: draft.clipped ?? false,
          adjust: draft.adjust ?? null,
          image: draft.image ?? null,
        }

        const match = held.get(draft.uid)

        if (match) {
          tx.update(layers).set(values).where(eq(layers.id, match.id)).run()

          continue
        }

        const [made] = tx
          .insert(layers)
          .values({ ...values, workspaceId: context.workspaceId, pageId: page, uid: draft.uid })
          .returning()
          .all()

        if (made) held.set(draft.uid, made)
      }

      // Now that every row exists and has an id, say who is inside what —
      // resolved within this page, for the reason `held` is built per page.
      for (const draft of drafts) {
        const row = held.get(draft.uid)

        if (!row) continue

        const parent = draft.parentUid ? held.get(draft.parentUid)?.id ?? null : null

        tx.update(layers).set({ parentId: parent }).where(eq(layers.id, row.id)).run()
      }

      // Whatever the browser stopped mentioning. Deliberate: a layer removed is
      // a layer removed, and its surfaces go with it by the cascade above.
      for (const layer of held.values()) {
        if (!wanted.has(layer.uid)) tx.delete(layers).where(eq(layers.id, layer.id)).run()
      }
    }
  })

  notify(context, { scope: 'layers' })

  return stack(context, pageId)
}

/** One standard row, as a preset asks for it — see `LayerPreset`. */
export interface PresetDraft {
  uid: string
  visible: boolean
  opacity?: number
  locked?: boolean
}

/**
 * Set the standard plates the same way on every page of the chapter.
 *
 * The one thing in this file that speaks for more than one page, and it is
 * allowed to because of how narrow it is: it writes `visible`, `opacity` and
 * `locked` on rows that already exist, and nothing else. It cannot insert,
 * cannot delete, cannot re-parent and cannot reorder — so there is no way for
 * it to cost anybody a layer or a stroke, which is exactly what a chapter-wide
 * write has to be able to promise.
 *
 * `standardUids` is enforced here rather than trusted from the request. The
 * browser sends a preset from `LAYER_PRESETS` and those only ever name standard
 * rows, but "the client would not do that" is not a rule — a sheet named in the
 * body would otherwise be rearranged on every page it happened to share a name
 * with, and page-owned sheets are the whole reason the stack moved to the page.
 *
 * Choosing a stage is not an edit to anybody's work, so it is not undoable and
 * does not need to be: press another preset.
 *
 * ## A page with no stack is given one first
 *
 * The only rows a preset may *add*, and only on a page that has none at all.
 * A stack used to be founded the moment somebody turned to a page, so "every
 * page somebody has looked at has rows" was true and this could reach them all
 * by updating rows. Nothing is founded by looking any more (see `found`), so a
 * chapter read through and then set to Clean would have been Clean on the
 * pages somebody had painted and nowhere else. A page with no rows *is*
 * `DEFAULT_STACK` — the browser shows exactly that for it — so writing those
 * rows down changes nothing about what the page is made of; it gives the stage
 * something to be written on. A page that has a stack, whole or not, is not
 * added to: a row it lacks stays lacking.
 */
export async function preset (
  context: Context,
  drafts: PresetDraft[],
  pageId: number,
): Promise<Layer[]> {
  await must(context, editWorkspace, context)

  const allowed = standardUids()
  const wanted = drafts.filter((draft) => allowed.has(draft.uid))

  if (!wanted.length) return stack(context, pageId)

  const pages = await db.query.pages.findMany({ where: { workspaceId: context.workspaceId }, columns: { id: true } })

  foundBare(context, pages.map((page) => page.id))

  db.transaction((tx) => {
    for (const draft of wanted) {
      /*
       * The lock is left alone when the preset does not mention one, which is
       * how the scan keeps its own. `art` is `fixed` — its lock is not the
       * reader's to open and therefore not a preset's either — so no stage
       * names it, and this is the line that honours that.
       */
      const values: { visible: boolean, opacity?: number, locked?: boolean } = { visible: draft.visible }

      if (draft.opacity !== undefined) values.opacity = draft.opacity
      if (draft.locked !== undefined) values.locked = draft.locked

      tx
        .update(layers)
        .set(values)
        .where(and(eq(layers.workspaceId, context.workspaceId), eq(layers.uid, draft.uid)))
        .run()
    }
  })

  notify(context, { scope: 'layers' })

  return stack(context, pageId)
}
