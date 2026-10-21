/**
 * Cleaned balloons kept for a cloud workspace — the service side of `repairs`.
 *
 * The browser makes a repair and keeps it in its own storage either way; this
 * is where a cloud workspace also keeps it, so the cleaning is there on another
 * machine, in another browser, and after this one's storage is cleared. The
 * table note in the schema says why a picture from a page is allowed here at
 * all, and CLAUDE.md says where the line now runs. What it does not change: the
 * page itself never comes up, and nothing here can fetch one.
 *
 * Three rules hold the rest together:
 *
 * - **Editor to keep, viewer to read.** Cleaning changes the page, which is
 *   `editWorkspace`; looking at a cleaned page is opening the workspace.
 * - **The file is named by its hash, and the hash proves nothing about access.**
 *   A repair is read through a workspace, and only when that workspace has a
 *   row naming it — so knowing a hash from one chapter is no way into another.
 * - **Only a PNG, only this big, only under a recipe's name** — the rules in
 *   `shared/utils/repairs.ts`, which the browser follows before it sends.
 */
import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { must, notify, pageIn } from './access'

import type { Rect } from '#shared/utils/raster'
import type { RepairRow } from '#shared/utils/repairs'
import type { Context } from './access'

import { editWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { isPng, MAX_REPAIR_BYTES, REPAIR_HASH, REPAIR_KEY } from '#shared/utils/repairs'
import { db, repairs } from '~~/server/database'
import { repairStore } from '~~/server/utils/repairStore'

/** Where the bytes live — desktop: a folder of the app's, see `server/utils/repairStore.ts`. */
const store = () => repairStore

const fileOf = (hash: string) => `${hash}.png`

/** The workspace's page ids, which every question here is scoped to. */
async function pagesOf (context: Context): Promise<number[]> {
  const rows = await db.query.pages.findMany({
    where: { workspaceId: context.workspaceId },
    columns: { id: true },
  })

  return rows.map((row) => row.id)
}

/** Every repair in the chapter, for a browser opening it. */
export async function list (context: Context): Promise<RepairRow[]> {
  await must(context, viewWorkspace, context)

  const ids = await pagesOf(context)

  if (!ids.length) return []

  const rows = await db.query.repairs.findMany({ where: { pageId: { in: ids } } })

  return rows.map((row) => ({
    key: row.key,
    hash: row.hash,
    pageId: row.pageId,
    blockId: row.blockId,
    from: row.from,
    box: row.box,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
  }))
}

export interface KeepRepair {
  pageId: number
  blockId: number | null
  key: string
  from: Rect
  box: Rect
}

/**
 * Keep one repair.
 *
 * Made again under the same recipe on the same page replaces the row rather
 * than adding one — the same inputs are the same repair — and the newest is the
 * one a block shows, so `createdAt` moves with it.
 */
export async function keep (context: Context, input: KeepRepair, bytes: Uint8Array): Promise<RepairRow> {
  await must(context, editWorkspace, context)
  await pageIn(context, input.pageId)

  if (!REPAIR_KEY.test(input.key)) throw createError({ statusCode: 400, statusMessage: 'Not a repair name.' })
  if (bytes.byteLength > MAX_REPAIR_BYTES) throw createError({ statusCode: 413, statusMessage: 'That repair is too large.' })
  if (!isPng(bytes)) throw createError({ statusCode: 415, statusMessage: 'A repair is a PNG.' })

  // The block, where one is named, has to be on that page — or a repair could
  // be filed against somebody else's block and shown over their artwork.
  if (input.blockId !== null) {
    const block = await db.query.blocks.findFirst({ where: { id: input.blockId }, columns: { pageId: true } })

    if (!block || block.pageId !== input.pageId) {
      throw createError({ statusCode: 404, statusMessage: 'No such block on that page.' })
    }
  }

  const hash = createHash('sha256').update(bytes).digest('hex')

  // Named by content, so the same picture made twice is one file. Written
  // every time rather than when missing, so its age says it is in use — the
  // sweep leaves a file written in the last `SWEEP_GRACE_MS` alone, and a file
  // an old row once named and a new one names again must not look abandoned
  // in the moment before this row lands.
  await store().setItemRaw(fileOf(hash), Buffer.from(bytes))

  const createdAt = new Date()

  const [row] = await db
    .insert(repairs)
    .values({ ...input, hash, createdAt })
    .onConflictDoUpdate({
      target: [repairs.pageId, repairs.key],
      set: { hash, blockId: input.blockId, from: input.from, box: input.box, createdAt },
    })
    .returning()

  notify(context, { scope: 'repairs', pageId: input.pageId })

  return {
    key: row!.key,
    hash: row!.hash,
    pageId: row!.pageId,
    blockId: row!.blockId,
    from: row!.from,
    box: row!.box,
    createdAt: Math.floor(row!.createdAt.getTime() / 1000),
  }
}

/**
 * The bytes of one repair — only if this workspace has a row naming it.
 *
 * The check is the whole point: files are named by hash and shared across the
 * install, so the hash alone must never be enough to read one.
 */
export async function read (context: Context, hash: string): Promise<Buffer> {
  await must(context, viewWorkspace, context)

  if (!REPAIR_HASH.test(hash)) throw createError({ statusCode: 404, statusMessage: 'No such repair.' })

  const ids = await pagesOf(context)
  const named = ids.length
    ? await db.query.repairs.findFirst({ where: { hash, pageId: { in: ids } }, columns: { id: true } })
    : null

  const bytes = named ? await store().getItemRaw<Buffer>(fileOf(hash)) : null

  if (!bytes) throw createError({ statusCode: 404, statusMessage: 'No such repair.' })

  return bytes
}

/**
 * Take a block's repairs back — a clean that found nothing left to paint out.
 *
 * Without this the server would go on offering the old repair as the block's
 * newest, and a reload would put back a patch of lettering somebody had just
 * corrected away. The files stay: another row, here or elsewhere, may name the
 * same bytes — and `sweep` takes the ones nothing names.
 */
export async function withdraw (context: Context, blockId: number): Promise<void> {
  await must(context, editWorkspace, context)

  const block = await db.query.blocks.findFirst({ where: { id: blockId }, columns: { pageId: true } })

  if (!block) return

  await pageIn(context, block.pageId)

  const gone = await db.delete(repairs).where(eq(repairs.blockId, blockId)).run()

  if (gone.changes) notify(context, { scope: 'repairs', pageId: block.pageId })
}

/**
 * How long a file is left alone after it was written, named or not.
 *
 * `keep` writes the file before the row that names it, so between the two a
 * file is named by nothing and a sweep would take it. Ten minutes is far past
 * that gap and far short of anything anybody would notice on disk.
 */
export const SWEEP_GRACE_MS = 10 * 60 * 1000

/**
 * Delete every repair file no row names any more. Returns how many went.
 *
 * Rows go for many reasons — a block read again, a page or a workspace
 * deleted, a balloon cleaned again under the same recipe, which moves the row
 * to the new picture — and every one of them cascades the rows, not the files,
 * because a file is shared by content and only the whole table can say
 * whether another row still names it. So nothing deletes a file at the moment
 * a row goes; this asks the whole table, now and then (`plugins/repairs.ts`).
 *
 * Not permission-checked: it touches no workspace's rows, and only removes
 * bytes no workspace can read — `read` serves a file only through a row.
 */
export async function sweep (now = Date.now(), alsoNamed: ReadonlySet<string> = new Set()): Promise<number> {
  const named = new Set((await db.selectDistinct({ hash: repairs.hash }).from(repairs)).map((row) => row.hash))

  // Desktop: the hashes a backup's rows name, so restoring one finds its pictures (`electron/database.ts`).
  for (const hash of alsoNamed) named.add(hash)
  let gone = 0

  for (const key of await store().getKeys()) {
    const hash = key.replace(/\.png$/, '')

    if (!REPAIR_HASH.test(hash) || named.has(hash)) continue

    let written = 0

    try {
      const meta = await store().getMeta(key)

      written = meta.mtime ? new Date(meta.mtime).getTime() : 0
    } catch {
      // Unreadable is unknown, and unknown is left alone.
    }

    if (!written || now - written < SWEEP_GRACE_MS) continue

    // Asked again, one file at a time: a row may have landed since the table
    // was read.
    if (await db.query.repairs.findFirst({ where: { hash }, columns: { id: true } })) continue

    await store().removeItem(key)
    gone++
  }

  return gone
}
