/**
 * The tools of the MCP server, for the window's own assistant — desktop only.
 *
 * The assistant (`useAssistant`, the Assistant panel) is an agent loop in the
 * window, on the reader's own key, and what it may do is exactly what an agent
 * reaching Kemolate over MCP may do: the same tools, answered by the same
 * server (`serverFor`). Not a copy of them, and not a second list — a tool
 * added under `server/mcp/tools/` is the assistant's the moment it is
 * registered there, with the same schema, the same refusals and the same
 * defaults. That is the whole of why this is an MCP client and not a dispatcher
 * of its own.
 *
 * ## In memory, and no port
 *
 * The client and the server talk over the SDK's `InMemoryTransport`, so none of
 * this needs the loopback server (`mcp.ts`), which stays off until the reader
 * turns it on. One server per call, as the loopback's is per request: every
 * tool is a question answered at once, and nothing is pushed.
 *
 * ## Whose chapter
 *
 * A call carries the tab it came from (the sender's webContents, never a value
 * the page names), and "the open chapter" means that tab's — see `defaulted`.
 * A conversation therefore stays on its chapter while the reader looks at
 * another tab.
 *
 * Image tools reach the window through an errand while that window's own call
 * here is still out. That is fine: IPC is asynchronous on both sides.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ipcMain } from 'electron'
import { z } from 'zod'

import { written } from './database'
import { mcpEvents } from './mcpEvent'

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { IpcMainInvokeEvent } from 'electron'

import { serverFor } from '~~/server/mcp'
import { MCP_ACTOR } from '~~/server/utils/mcp'

const callSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
})

/** A client connected to a fresh server for one tab, inside one MCP event, for the length of `use`. */
export async function withTools<T> (tab: string, use: (client: Client) => Promise<T>): Promise<T> {
  // Every caller here is the reader, as on the loopback — see `mcp.ts`.
  const event = { context: { [MCP_ACTOR]: { id: null } } }

  return mcpEvents.run(event, async () => {
    const server = serverFor(event, { tab })
    const client = new Client({ name: 'kemolate-assistant', version: '1.0.0' })
    const [near, far] = InMemoryTransport.createLinkedPair()

    try {
      await server.connect(far)
      await client.connect(near)

      return await use(client)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
}

/** What the assistant is offered: each tool's name, description, JSON schema and annotations, as `tools/list` gives them. */
export function listFor (tab: string): Promise<Tool[]> {
  return withTools(tab, async (client) => (await client.listTools()).tools)
}

/** One tool's answer, as MCP gives it: text and image parts, and whether it failed. */
export async function callFor (tab: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await withTools(tab, (client) => client.callTool({ name, arguments: args }))

  // A tool may have written; the next hourly backup has news to keep — as `mcp.ts` marks it.
  written()

  return result as CallToolResult
}

/** The two channels the Assistant panel uses — the app's own page only. Called once the database is open. */
export function serveAssistant (trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('assistant:tools', (event) => {
    if (!trusted(event)) throw new Error('Not the app.')

    return listFor(String(event.sender.id))
  })

  ipcMain.handle('assistant:call', (event, given: unknown) => {
    if (!trusted(event)) throw new Error('Not the app.')

    const call = callSchema.parse(given)

    return callFor(String(event.sender.id), call.name, call.arguments)
  })
}
