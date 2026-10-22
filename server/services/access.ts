/**
 * Which workspace a call is about — desktop.
 *
 * Every other service takes this rather than a workspace id, as in the web
 * build, so they can be carried verbatim. What the web build's `Context` also
 * carried — who is asking, their role, the swarm connection a request came from
 * — is about accounts and sharing, which the desktop app does not have:
 *
 * - `actor` is always null. Every service that records who did something writes
 *   `context.actor?.id ?? null`, so author and user columns are null — there is
 *   one person, and the schema keeps those columns without a foreign key.
 * - `role` is always `owner`: the reader can do anything to their own work.
 * - `must` allows every ability (see `#shared/utils/abilities`).
 * - `notify` tells the window only about a change an agent made over MCP
 *   (`origin: 'agent'`, set by `mcpContext`). In the web build it told every
 *   other browser in the workspace's swarm; here there is one window, and its
 *   own writes already bring their answer back to it.
 *
 * `pageIn` is the web build's, verbatim: a page id from another workspace is
 * still refused, which keeps a slip in the window from writing into the wrong
 * chapter.
 */
import type { Ability, Access } from '#shared/utils/abilities'
import type { Workspace } from '~~/server/database'

import { db } from '~~/server/database'
import { announce, type SwarmChange } from '~~/server/utils/swarm'

export interface Context extends Access {
  workspace: Workspace
  actor: { id: number } | null
  origin?: string | null
}

/** A workspace by the id in its address, or null where there is none. */
export async function contextFor (publicId: string): Promise<Context | null> {
  const workspace = await db.query.workspaces.findFirst({ where: { publicId } })

  if (!workspace) return null

  return { workspace, workspaceId: workspace.id, actor: null, role: 'owner', origin: null }
}

/** Allowed — see the header. Kept so the services can name what they need. */
export async function must (_context: Context, _ability: Ability, ..._args: unknown[]): Promise<void> {}

/** The window, about what an agent changed — see the header. */
export function notify (context: Context, change: SwarmChange): void {
  if (context.origin === 'agent') announce(context.workspace.publicId, change)
}

/**
 * A 404 unless the page is this workspace's.
 *
 * A page id is just a number, and `must` only ever looks at the context — so
 * without this, somebody with edit rights on their own workspace could name a
 * page from another and have the check pass. It answers with the 404 a
 * stranger gets, because a row you cannot touch should not be confirmed to
 * exist by the way it refuses you.
 */
export async function pageIn (context: Context, pageId: number): Promise<void> {
  const page = await db.query.pages.findFirst({ where: { id: pageId }, columns: { workspaceId: true } })

  if (!page || page.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such page.' })
  }
}
