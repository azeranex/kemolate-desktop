/**
 * Kemolate in Claude Desktop — the server inside `kemolate.mcpb`.
 *
 * An MCP Bundle is a server Claude Desktop starts itself and speaks to over
 * stdio. Kemolate's server is the app's (`electron/mcp.ts`): HTTP on the
 * loopback, alive only while the app is open, holding the database and the
 * window the tools need. So this is not a second server but a bridge — stdio in,
 * Kemolate's `/mcp` out — and it carries nothing of Kemolate's but the
 * briefing. There is no token: Kemolate takes any caller on this machine's
 * loopback (`electron/mcp.ts`, which says why).
 *
 * ## Kemolate need not be open first
 *
 * Claude Desktop starts its extensions when it starts, and asks for the tool
 * list once. A bridge that passed `initialize` through would fail whenever
 * Kemolate was closed at that moment, and stay failed until somebody restarted
 * the extension. So the bridge answers the handshake itself, and every list or
 * call is asked of Kemolate when it is made. While Kemolate cannot be reached —
 * closed, its server off, or another program on its port — the bridge offers one tool,
 * `kemolate_status`, whose description and answer say what is wrong and what
 * to do, and it looks again every few seconds; when the real tools appear it
 * tells Claude Desktop the list changed.
 *
 * Kemolate's server is stateless (one request, one answer), so each list or call
 * is a request of its own over one client; a client that has failed is thrown
 * away and the next request makes another.
 *
 * Configured by the bundle's manifest (`mcpb/manifest.json`): the port, from
 * the extension's settings, as an environment variable.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

import { INSTRUCTIONS } from '../server/mcp/instructions'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const port = Number(process.env.KEMOLATE_MCP_PORT) || 38427
const url = new URL(`http://127.0.0.1:${port}/mcp`)

/** How often a bridge that cannot reach Kemolate looks again. */
const LOOK_AGAIN = 5_000

/** Why Kemolate's tools are not on offer, in words for whoever reads them. */
type Trouble = 'unreachable' | 'refused'

const SAID: Record<Trouble, string> = {
  unreachable: `Kemolate is not running, or its MCP server is off (looked for at ${url}). Open Kemolate and turn the server on in Settings › Agents; the tools appear here once it answers. If you changed its port there, change it in this extension's settings too.`,
  refused: `Something answered at ${url} but offered none of Kemolate's tools — an older Kemolate that wants a token, or another program on that port. Update Kemolate, or choose another port in its Settings › Agents and enter the same one in this extension's settings.`,
}

const STATUS_TOOL: Tool = {
  name: 'kemolate_status',
  description: 'Says why Kemolate\'s tools are not available yet, and what to do about it. Kemolate\'s own tools replace this one as soon as it can be reached.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
}

let client: Client | null = null

/** Connected to Kemolate, or null and the reason. */
async function kemolate (): Promise<Client | Trouble> {
  if (client) return client

  const fresh = new Client({ name: 'kemolate-mcpb', version: '1.0.0' })

  try {
    await fresh.connect(new StreamableHTTPClientTransport(url))
  } catch {
    return 'unreachable'
  }

  client = fresh

  return fresh
}

/** Forget a client that failed, so the next request makes another. */
function drop () {
  client?.close().catch(() => {})
  client = null
}

/** The tools on offer now, or the reason there are none. */
async function toolsNow (): Promise<Tool[] | Trouble> {
  const connected = await kemolate()

  if (typeof connected === 'string') return connected

  try {
    const { tools } = await connected.listTools()

    // Kemolate always offers its tools; a server offering none is not this one.
    return tools.length ? tools : 'refused'
  } catch {
    drop()

    return 'unreachable'
  }
}

const bridge = new Server(
  { name: 'kemolate', title: 'Kemolate', version: '1.0.0' },
  {
    capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
    instructions: INSTRUCTIONS,
  },
)

/** Whether the last list offered Kemolate's tools — what a change is measured against. */
let offering = false
let looking: ReturnType<typeof setInterval> | null = null

/** While Kemolate cannot be reached, look again now and then, and say when it can. */
function lookAgain () {
  if (looking) return

  looking = setInterval(async () => {
    const tools = await toolsNow()

    if (typeof tools === 'string') return

    clearInterval(looking!)
    looking = null
    offering = true
    await bridge.sendToolListChanged().catch(() => {})
    await bridge.sendPromptListChanged().catch(() => {})
  }, LOOK_AGAIN)

  looking.unref()
}

bridge.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await toolsNow()

  if (typeof tools === 'string') {
    offering = false
    lookAgain()

    return { tools: [{ ...STATUS_TOOL, description: `${STATUS_TOOL.description} Now: ${SAID[tools]}` }] }
  }

  offering = true

  return { tools }
})

bridge.setRequestHandler(CallToolRequestSchema, async (request) => {
  const connected = await kemolate()

  if (typeof connected === 'string') {
    lookAgain()

    return { content: [{ type: 'text', text: SAID[connected] }], isError: request.params.name !== STATUS_TOOL.name }
  }

  if (request.params.name === STATUS_TOOL.name) {
    const tools = await toolsNow()

    return { content: [{ type: 'text', text: typeof tools === 'string' ? SAID[tools] : `Kemolate is running and its ${tools.length} tools are available.` }] }
  }

  try {
    // Kemolate's answer as it gave it: a tool's own refusal is a result with
    // `isError`, not a failure of the bridge.
    return await connected.callTool(request.params)
  } catch (error) {
    // Kemolate answered, and said no: a protocol error is not Kemolate gone.
    if (error instanceof McpError) {
      return { content: [{ type: 'text', text: `${SAID.refused} (${error.message})` }], isError: true }
    }

    drop()

    // Kemolate went away mid-session; the list Claude Desktop holds is stale.
    if (offering) {
      offering = false
      lookAgain()
      await bridge.sendToolListChanged().catch(() => {})
    }

    return { content: [{ type: 'text', text: `${SAID.unreachable} (${error instanceof Error ? error.message : String(error)})` }], isError: true }
  }
})

bridge.setRequestHandler(ListPromptsRequestSchema, async () => {
  const connected = await kemolate()

  if (typeof connected === 'string') return { prompts: [] }

  try {
    return await connected.listPrompts()
  } catch {
    drop()

    return { prompts: [] }
  }
})

bridge.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const connected = await kemolate()

  if (typeof connected === 'string') throw new Error(SAID[connected])

  try {
    return await connected.getPrompt(request.params)
  } catch (error) {
    drop()
    throw error
  }
})

await bridge.connect(new StdioServerTransport())
