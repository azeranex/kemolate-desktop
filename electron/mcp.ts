/**
 * The MCP server, for an agent on this machine — the web build's `/mcp`, served
 * by the main process on the loopback interface.
 *
 * The web build's MCP endpoint lets an agent in somebody's editor work on a
 * chapter: list them, have pages read by the app's own OCR, check and correct
 * the reading, translate and file it. Its tools are carried here verbatim
 * (`server/mcp/`) and reach the same services the window does. What is the
 * desktop's own is this file: where it listens, who may come in, and how a
 * request reaches the window for the two things only the window can do — show
 * a page and read one (`server/utils/swarm.ts`).
 *
 * ## Off until the reader turns it on
 *
 * A port anything on the machine can reach is not something an app should open
 * because it was installed. Settings › Agents turns it on (`SettingsMcp.vue`),
 * and it stays as left across launches (`mcp.json` in the profile).
 *
 * ## Who may come in
 *
 * - **Only this machine.** It listens on 127.0.0.1, never on all interfaces,
 *   and refuses a connection from any other address (`loopback`) besides.
 * - **Only a client, not a web page.** A request whose `Host` is not the
 *   loopback address it listens on is refused — the DNS-rebinding guard the
 *   transport spec asks for — and so is one carrying an `Origin`, which a
 *   browser adds and an MCP client does not. The web build's origin check
 *   (same-origin) does the same job there.
 * - **No token** (decided 2026-10-22, by the reader). The first version had
 *   one, made in Settings and kept as a digest as the web build keeps its access
 *   tokens; on a one-person machine it was a step that kept going wrong — made
 *   in one app, pasted into another — and protected the work only from programs
 *   that could already read the profile it is kept in. So a caller is whoever
 *   reaches the loopback, and every caller is the reader (`MCP_ACTOR`). What
 *   the token never covered stays: web pages are kept out by the two checks
 *   above, and the server is off until switched on.
 *
 * ## Claude Desktop
 *
 * Claude Desktop starts its servers itself and speaks to them over stdio, so it
 * reaches this one through a bundle (`kemolate.mcpb`, built from `mcpb/`): a
 * bridge it runs, which forwards to this server. The installer carries the bundle beside the
 * app, and Settings' **Add to Claude Desktop** opens it, which Claude Desktop
 * answers with its own install dialog.
 *
 * ## One request, one server
 *
 * Stateless, as the web build's is (`sessions` off): every tool answers in one
 * request, and nothing is pushed. Each request runs inside its own event
 * (`useEvent`, an `AsyncLocalStorage`), which is how a tool finds that its
 * caller came in — the role Nitro's request context plays there.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { app, ipcMain, shell } from 'electron'
import { z } from 'zod'

import { written } from './database'

import type { McpStatus } from './preload'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { serverFor } from '~~/server/mcp'
import { MCP_ACTOR } from '~~/server/utils/mcp'
import { hold } from '~~/server/utils/swarm'

/**
 * Where it listens unless told otherwise. Unassigned, high enough to need no
 * rights, and below the ranges Windows and the software on it reserve: on the
 * machine this was written on nothing could bind anywhere in 45000–48999, though
 * no exclusion was listed for it.
 */
export const DEFAULT_PORT = 38427

/**
 * The most a request may carry. `save_page_blocks` at its 500 blocks is well
 * under a megabyte; this is room, not a target — it refuses what cannot be a call.
 */
const MAX_BODY = 8 * 1024 * 1024

interface Settings {
  enabled: boolean
  port: number
}

const settingsSchema = z.object({
  enabled: z.boolean().catch(false),
  port: z.number().int().min(1024).max(65535).catch(DEFAULT_PORT),
})

const file = () => path.join(app.getPath('userData'), 'mcp.json')

function load (): Settings {
  try {
    if (existsSync(file())) return settingsSchema.parse(JSON.parse(readFileSync(file(), 'utf8')))
  } catch (error) {
    console.warn('[mcp] settings unreadable, starting from the defaults', error)
  }

  return { enabled: false, port: DEFAULT_PORT }
}

/** Written beside and moved into place, so a crash mid-write leaves the old file whole. */
function store (next: Settings) {
  const temporary = `${file()}.tmp`

  writeFileSync(temporary, JSON.stringify(next, null, 2))
  renameSync(temporary, file())
}

let settings: Settings | null = null
let server: Server | null = null
/** Why the server is not listening when it should be — a port taken, say. */
let failure: string | null = null

const current = () => (settings ??= load())

/**
 * Whether the connection came from this machine. The server listens on
 * 127.0.0.1 alone, so nothing else should arrive; checked all the same, since
 * with no token this is the whole of who may come in — see the header.
 */
function loopback (request: IncomingMessage): boolean {
  const from = request.socket.remoteAddress ?? ''

  return from === '127.0.0.1' || from === '::1' || from === '::ffff:127.0.0.1'
}

/** The loopback names this server may be addressed by, on its own port — see the header. */
function ownHost (request: IncomingMessage, port: number): boolean {
  const host = request.headers.host?.toLowerCase()

  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

/**
 * The Claude Desktop bundle: beside the installed app (`extraResources`), or
 * where `pnpm build:mcpb` leaves it in a development run.
 */
const bundleFile = () => app.isPackaged
  ? path.join(process.resourcesPath, 'kemolate.mcpb')
  : path.join(app.getAppPath(), 'out/mcpb/kemolate.mcpb')

const events = new AsyncLocalStorage<{ context: Record<string, unknown> }>()

// The request an MCP call arrived in, where `installServerGlobals` left none:
// how `mcpContext` finds the caller. Undefined outside a call, as before.
Object.assign(globalThis, { useEvent: () => events.getStore() })

function refuse (response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function bodyOf (request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength

    if (size > MAX_BODY) throw new Error('too large')

    chunks.push(chunk as Buffer)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function serve (request: IncomingMessage, response: ServerResponse, port: number) {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)

  if (!loopback(request) || !ownHost(request, port) || request.headers.origin) {
    refuse(response, 403, 'Kemolate\'s MCP server answers clients on this machine, not web pages.')

    return
  }

  if (url.pathname !== '/mcp') {
    refuse(response, 404, 'Kemolate\'s MCP server is at /mcp.')

    return
  }

  // Stateless: no stream to open with GET and no session to end with DELETE.
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end()

    return
  }

  let body: unknown

  try {
    body = await bodyOf(request)
  } catch {
    refuse(response, 400, 'A request is one JSON-RPC message, under 8 MB.')

    return
  }

  // Every caller that got this far is the reader — see the header.
  const event = { context: { [MCP_ACTOR]: { id: null } } }

  await events.run(event, async () => {
    const mcp = serverFor(event)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })

    response.on('close', () => {
      transport.close().catch(() => {})
      mcp.close().catch(() => {})
    })

    await mcp.connect(transport)
    await transport.handleRequest(request, response, body)
  })

  // A tool may have written; the next hourly backup has news to keep — as `data.ts` marks it.
  written()
}

function stop (): Promise<void> {
  const closing = server

  server = null

  return new Promise((resolve) => {
    if (!closing) return resolve()

    closing.close(() => resolve())
    closing.closeAllConnections()
  })
}

/** Listening if it should be, on the port it should be, and not otherwise. */
async function apply (): Promise<void> {
  await stop()

  failure = null

  const { enabled, port } = current()

  if (!enabled) return

  const listening = createServer((request, response) => {
    serve(request, response, port).catch((error) => {
      console.error('[mcp] request failed', error)

      if (!response.headersSent) refuse(response, 500, 'Kemolate could not answer that.')
      else response.end()
    })
  })

  await new Promise<void>((resolve) => {
    listening.once('error', (error: NodeJS.ErrnoException) => {
      failure = error.code === 'EADDRINUSE'
        ? `Port ${port} is in use, or reserved, on this computer. Choose another.`
        : error.message

      resolve()
    })

    listening.listen(port, '127.0.0.1', () => {
      server = listening
      resolve()
    })
  })
}

function status (): McpStatus {
  const { enabled, port } = current()

  return {
    enabled,
    port,
    listening: Boolean(server),
    error: failure,
    url: `http://127.0.0.1:${port}/mcp`,
    bundle: existsSync(bundleFile()),
  }
}

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
})

/**
 * Start it if it was left on, and the channels Settings uses — and the two the
 * workspace page uses to say what it holds. Every one is the app's own page
 * only. Called once the database is open: the tools reach the services.
 */
export async function serveMcp (trusted: (event: IpcMainInvokeEvent) => boolean, window: () => BrowserWindow | null): Promise<void> {
  // A tool's ask for a page goes to the window, tagged with the workspace it was
  // for, so a window that has just left that chapter can refuse it.
  const send = (publicId: string, frame: string) => {
    const win = window()

    if (win && !win.isDestroyed()) win.webContents.send('mcp:frame', publicId, frame)
  }

  const only = <A extends unknown[], R>(handler: (...args: A) => R) => (event: IpcMainInvokeEvent, ...args: A) => {
    if (!trusted(event)) throw new Error('Not the app.')

    return handler(...args)
  }

  const haveSchema = z.object({
    workspace: z.string().max(200).nullable(),
    hashes: z.array(z.string().max(200)).max(20_000),
    pageId: z.number().int().positive().nullable().default(null),
  })

  ipcMain.handle('mcp:have', only((given: unknown) => {
    const { workspace, hashes, pageId } = haveSchema.parse(given)

    hold(workspace, hashes, send, pageId)
  }))

  ipcMain.handle('mcp:status', only(() => status()))

  ipcMain.handle('mcp:set', only(async (patch: unknown) => {
    const next = { ...current(), ...patchSchema.parse(patch) }

    settings = next
    store(next)
    await apply()

    return status()
  }))

  // Claude Desktop's install dialog, by opening the bundle — see the header.
  // Answers why not, where the OS has nothing to open a `.mcpb` with.
  ipcMain.handle('mcp:add-to-claude', only(async () => {
    const file = bundleFile()

    if (!existsSync(file)) return 'The Claude Desktop bundle is missing from this copy of Kemolate.'

    const failed = await shell.openPath(file)

    return failed ? `Nothing on this computer opens ${path.basename(file)} — is Claude Desktop installed? (${failed})` : null
  }))

  ipcMain.handle('mcp:show-bundle', only(() => {
    shell.showItemInFolder(bundleFile())
  }))

  await apply()
}

/** The window is gone or going: it holds nothing, so nothing can be asked of it. */
export function windowLeft (): void {
  hold(null, [], () => {})
}

export function closeMcp (): Promise<void> {
  return stop()
}
