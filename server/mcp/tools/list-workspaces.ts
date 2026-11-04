/**
 * Every chapter the token's owner can open.
 *
 * The entry point: nothing else here can be called without a workspace id, and
 * a `publicId` is a uuid no model is going to guess.
 *
 * Desktop: through `listAll` — every workspace in the database is the one
 * person's. The web build's `listFor` reads the contributors table, which
 * there is not here; `role` comes back `owner`, as the window's list has it.
 */
import { count, inArray } from 'drizzle-orm'

import { db, pages } from '~~/server/database'
import { workspaces } from '~~/server/services'
import { mcpEnabled, requireMcpActor } from '~~/server/utils/mcp'
import { openChapters } from '~~/server/utils/swarm'

export default defineMcpTool({
  name: 'list_workspaces',
  description: [
    'List the comic chapters this machine has, most recently touched first.',
    'Every other tool takes the `workspaceId` from here.',
    '`open` says which are open in Kemolate — "on screen", or "in a tab" behind it — and so can have their pages shown and read.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  handler: async () => {
    requireMcpActor(useEvent()!)

    const rows = await workspaces.listAll()

    // One grouped count rather than a query per workspace: a reader with thirty
    // chapters would otherwise pay thirty round trips to draw one list.
    const tally = rows.length
      ? await db
          .select({ workspaceId: pages.workspaceId, pages: count() })
          .from(pages)
          .where(inArray(pages.workspaceId, rows.map((row) => row.id)))
          .groupBy(pages.workspaceId)
      : []

    const counted = new Map(tally.map((row) => [row.workspaceId, row.pages]))

    // Desktop: which are open in a tab, so their images can be asked for — see `openChapters`.
    const open = new Map(openChapters().map((chapter) => [chapter.publicId, chapter]))

    return mcpJson({
      workspaces: rows.map((row) => ({
        workspaceId: row.publicId,
        name: row.name,
        role: row.role,
        direction: row.direction,
        sourceLocale: row.sourceLocale,
        targetLocale: row.targetLocale,
        pages: counted.get(row.id) ?? 0,
        updatedAt: row.updatedAt,
        ...(open.has(row.publicId) ? { open: open.get(row.publicId)!.focused ? 'on screen' : 'in a tab' } : {}),
      })),
    })
  },
})
