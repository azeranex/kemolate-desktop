/**
 * Who an MCP tool is acting as, and which workspace it is acting on — desktop.
 *
 * The web build's file, for one person. There a tool's caller is the owner of
 * a personal access token, resolved by the handler's middleware, and the
 * workspace it names is checked against what that person may open. Here there
 * is one person, every workspace is theirs, and there is no token: a caller is
 * whatever reached the server on this machine's loopback (`electron/mcp.ts`,
 * which says why), and the actor it leaves is nobody in particular — as
 * `useUserSession` is in the window. The actor checks are kept, so the tools
 * read as the web build's do.
 *
 * What is kept, and why it still matters: the workspace id and the page id are
 * tool *arguments*, chosen by a language model, so both are checked rather than
 * trusted — a page id from another chapter is still a 404. Past that seam
 * everything is the ordinary path: the same `Context`, the same services the
 * window's requests reach through `electron/data.ts`.
 *
 * `useEvent` is the request an MCP call arrived in (`electron/mcp.ts` runs every
 * call inside one), as Nitro's was.
 */
import type { Context } from '~~/server/services'

import { db } from '~~/server/database'
import { contextFor } from '~~/server/services'
import { swarmState } from '~~/server/utils/swarm'

/** Where the server leaves the caller, once it has come in. */
export const MCP_ACTOR = 'mcpActor'

/**
 * The caller. Nobody in particular — one person uses this machine — but an
 * object rather than a flag, so the tools read as the web build's do.
 */
export interface McpActor {
  id: null
}

interface McpEvent {
  context: Record<string, unknown>
}

/** The caller, or null outside a request that came in. */
export function mcpActor (event: McpEvent): McpActor | null {
  return (event.context[MCP_ACTOR] as McpActor | undefined) ?? null
}

/**
 * Whether a tool is offered at all — the web build's rule (a client with no
 * token is shown a server with nothing on it, because refusing it during the
 * handshake gives it a transport error), kept though every caller that reaches
 * a tool here passes it. It hides; `requireMcpActor` inside each handler is
 * what closes.
 */
export const mcpEnabled = (event: McpEvent) => Boolean(mcpActor(event))

/** Refuse a caller that did not come in — see `mcpEnabled` for why both exist. */
export function requireMcpActor (event: McpEvent): McpActor {
  const actor = mcpActor(event)

  if (!actor) {
    throw createError({
      statusCode: 401,
      statusMessage: 'This request did not come in through Kemolate’s MCP server.',
    })
  }

  return actor
}

/**
 * The workspace a tool was pointed at. A 404 for one that is not there, as the
 * window's requests get.
 *
 * Its `origin` is `agent`, which is what makes `notify` tell the window: a
 * change an agent made is one the window has not seen, where the window's own
 * writes it has (`server/services/access.ts`).
 */
export async function mcpContext (workspaceId: string): Promise<Context> {
  const event = useEvent()

  if (!event) throw createError({ statusCode: 500, statusMessage: 'No request context.' })

  requireMcpActor(event)

  const context = await contextFor(workspaceId)

  if (!context) throw createError({ statusCode: 404, statusMessage: 'No such workspace.' })

  return { ...context, origin: 'agent' }
}

/**
 * The page named by a tool argument, proved to be this workspace's — the web
 * build's, verbatim. A page id is just a number.
 */
export async function mcpPage (context: Context, pageId: number) {
  const page = await db.query.pages.findFirst({ where: { id: pageId } })

  if (!page || page.workspaceId !== context.workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'No such page in this workspace.' })
  }

  return page
}

/**
 * The chapter open in the Kemolate window, and the page on screen — desktop
 * only (`SwarmState.active`). Null when the window is in no chapter, or the one
 * it names is gone from the database. The page is null until it has a row, and
 * is checked to be this chapter's, as `mcpPage` checks a page an agent names.
 */
export async function activeChapter () {
  const open = swarmState.active

  if (!open) return null

  const context = await contextFor(open.publicId)

  if (!context) return null

  const page = open.pageId ? await db.query.pages.findFirst({ where: { id: open.pageId } }) : null

  return {
    context: { ...context, origin: 'agent' } as Context,
    page: page && page.workspaceId === context.workspaceId ? page : null,
  }
}

/**
 * A tool's answer, as compact JSON — the web build's: pretty-printed it was 93%
 * more characters on a twenty-page `read_page`, paid in tokens by a reader who
 * is a model.
 */
export function mcpJson (result: unknown) {
  return jsonResult(result, false)
}
