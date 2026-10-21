/**
 * What happened in a workspace, in order.
 *
 * Written by the other services rather than by the routes, so an action is
 * recorded wherever it is triggered from — a request, a websocket frame, a
 * background job — and cannot be recorded in one path and forgotten in another.
 *
 * `record` deliberately takes no `Context` and asks no ability. It is called
 * *after* the thing it describes has already been allowed and done, so a second
 * check could only ever disagree with the first, and a log that refuses to
 * write is worse than one nobody read.
 */
import { must } from './access'

import type { Context } from './access'
import type { NewLog } from '~~/server/database'

import { viewWorkspace } from '#shared/utils/abilities'
import { db, logs } from '~~/server/database'

export async function record (entry: NewLog): Promise<void> {
  // Never allowed to be the reason an operation fails. The work is already
  // done by the time we are here; losing the note about it is a smaller harm
  // than unwinding the thing itself.
  await db.insert(logs).values(entry).catch((error: unknown) => {
    console.error('[kemolate] log entry dropped', entry.action, error)
  })
}

/** The recent history, newest first — what a contributor arriving late reads. */
export async function recent (context: Context, limit = 50) {
  await must(context, viewWorkspace, context)

  return db.query.logs.findMany({
    where: { workspaceId: context.workspaceId },
    // Desktop: no one to name — there are no users (see `schema.ts`).
    orderBy: { createdAt: 'desc' },
    limit,
  })
}
