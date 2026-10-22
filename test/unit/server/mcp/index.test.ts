import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { replace } from '~~/server/services/blocks'
import { sync as syncPages } from '~~/server/services/pages'
import { MCP_ACTOR } from '~~/server/utils/mcp'
import { installMcpGlobals } from '~~/server/utils/mcpToolkit'
import { hold, swarmState } from '~~/server/utils/swarm'

/**
 * The MCP server as a client meets it — desktop.
 *
 * **Needs the database harness.**
 *
 * The tools are the web build's and are tested where it tests them; what is the
 * desktop's own is `server/mcp/index.ts`, which registers them with the SDK in
 * place of the toolkit, and the toolkit's two rules it has to restate: a caller
 * with no token is shown a server with nothing on it, and a tool's refusal comes
 * back as a result carrying its status rather than as a protocol error.
 *
 * Seam: a real SDK client over the SDK's in-memory transport, and the request's
 * event stood in through `useEvent` as `electron/mcp.ts` runs one.
 */

installMcpGlobals()

// After the globals, because every tool calls `defineMcpTool` as it loads.
const { serverFor } = await import('~~/server/mcp')

const globals = globalThis as { useEvent?: () => unknown }
const before = globals.useEvent

let event: { context: Record<string, unknown> } = { context: {} }

beforeEach(() => {
  reset()
  swarmState.swarms.clear()
  swarmState.sockets.clear()
  swarmState.active = null
  globals.useEvent = () => event
})

afterEach(() => {
  globals.useEvent = before
})

/** A client connected to the server this event would be answered by. */
async function connect (withToken: boolean) {
  event = { context: withToken ? { [MCP_ACTOR]: { id: null } } : {} }

  const [near, far] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })

  await serverFor(event).connect(far)
  await client.connect(near)

  return client
}

const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text)

describe('the MCP server', () => {
  it('offers nothing to a caller without the token, but still shakes hands', async () => {
    const client = await connect(false)

    expect(client.getInstructions()).toContain('normalised by the page WIDTH')
    expect((await client.listTools()).tools).toEqual([])
    expect((await client.listPrompts()).prompts).toEqual([])
  })

  it('offers every tool and the prompt to a caller with the token', async () => {
    const client = await connect(true)

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort()

    expect(names).toEqual([
      'correct_blocks',
      'get_active_workspace',
      'get_cast',
      'get_glossary',
      'get_page_image',
      'get_workspace',
      'list_pages',
      'list_workspaces',
      'prepare_page_translation',
      'read_page',
      'request_page_read',
      'review_page_reading',
      'save_page_blocks',
      'save_page_translations',
      'sort_page_blocks',
      'update_workspace',
    ])
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(['translate_chapter'])
  })

  it('is the tool list the Claude Desktop bundle shows at install', async () => {
    const client = await connect(true)
    const offered = (await client.listTools()).tools.map((tool) => tool.name).sort()
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../mcpb/manifest.json', import.meta.url)), 'utf8')) as { tools: { name: string }[] }

    // Static in the manifest, live on the server: a tool added to one is added to the other.
    expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(offered)
  })

  it('lists the workspaces in the database, with their page counts', async () => {
    const context = await aWorkspace({ name: 'Chapter one' })

    await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-1' }])

    const client = await connect(true)
    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_workspaces', arguments: {} })))

    expect(listed.workspaces).toEqual([expect.objectContaining({
      workspaceId: context.workspace.publicId,
      name: 'Chapter one',
      role: 'owner',
      pages: 1,
    })])
  })

  it('reports a refusal as a result with its status, not a protocol error', async () => {
    const client = await connect(true)
    const result = await client.callTool({ name: 'get_workspace', arguments: { workspaceId: 'nope' } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('[404] No such workspace.')
  })

  it('tells the window what an agent changed, and not what the window did itself', async () => {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-1' }])
    const sent: string[] = []

    hold(context.workspace.publicId, [], (_publicId, frame) => sent.push(frame))

    // The window's own write — its context has no `agent` origin.
    await replace(context, page!.id, [{ kind: 'bubble', source: 'あ', cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 }])

    expect(sent).toEqual([])

    const client = await connect(true)

    await client.callTool({
      name: 'save_page_blocks',
      arguments: {
        workspaceId: context.workspace.publicId,
        pageId: page!.id,
        mode: 'append',
        blocks: [{ kind: 'bubble', source: 'い', cx: 0.5, cy: 0.8, w: 0.1, h: 0.1 }],
      },
    })

    expect(sent.map((frame) => JSON.parse(frame))).toEqual([{ type: 'changed', change: { scope: 'blocks', pageId: page!.id } }])
  })

  it('says nobody holds a page when the window has no chapter open', async () => {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-1' }])

    const client = await connect(true)
    const result = await client.callTool({
      name: 'get_page_image',
      arguments: { workspaceId: context.workspace.publicId, pageId: page!.id },
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/^\[409\]/)
  })
})

describe('the open chapter', () => {
  /** A chapter of two pages, open in the window on its second. */
  async function opened () {
    const context = await aWorkspace({ name: 'Open one' })
    const [first, second] = await syncPages(context, ['01.jpg', '02.jpg'].map((path, position) =>
      ({ path, name: path, position, hash: `sha-${path}` })))

    await replace(context, second!.id, [{ kind: 'bubble', source: 'あ', cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 }])

    hold(context.workspace.publicId, [], () => {}, second!.id)

    return { context, first: first!, second: second! }
  }

  it('is said to be nothing when the window has no chapter open', async () => {
    const client = await connect(true)
    const open = JSON.parse(textOf(await client.callTool({ name: 'get_active_workspace', arguments: {} })))

    expect(open).toMatchObject({ open: false })
  })

  it('names the chapter and the page on screen', async () => {
    const { context, second } = await opened()
    const client = await connect(true)
    const open = JSON.parse(textOf(await client.callTool({ name: 'get_active_workspace', arguments: {} })))

    expect(open).toMatchObject({
      open: true,
      workspaceId: context.workspace.publicId,
      name: 'Open one',
      page: { pageId: second.id, name: '02.jpg', blocks: 1 },
    })
  })

  it('is what a tool works on when it is not told which', async () => {
    const { second } = await opened()
    const client = await connect(true)

    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_pages', arguments: {} })))

    expect(listed.pages.map((page: { name: string }) => page.name)).toEqual(['01.jpg', '02.jpg'])

    // A one-page tool takes the page on screen.
    const fixed = await client.callTool({ name: 'correct_blocks', arguments: { corrections: [{ blockId: 999_999, source: 'x' }] } })

    expect(textOf(fixed)).toBe(`[404] Not blocks on page ${second.id}: 999999.`)
  })

  it('keeps an id that was given', async () => {
    const { first } = await opened()
    const other = await aWorkspace({ name: 'Other' })
    const client = await connect(true)

    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_pages', arguments: { workspaceId: other.workspace.publicId } })))

    expect(listed.pages).toEqual([])

    const fixed = await client.callTool({ name: 'correct_blocks', arguments: { pageId: first.id, corrections: [{ blockId: 999_999, source: 'x' }] } })

    expect(textOf(fixed)).toBe(`[404] Not blocks on page ${first.id}: 999999.`)
  })

  it('does not lend its page to another chapter', async () => {
    await opened()
    const other = await aWorkspace()
    const client = await connect(true)

    const fixed = await client.callTool({
      name: 'correct_blocks',
      arguments: { workspaceId: other.workspace.publicId, corrections: [{ blockId: 1, source: 'x' }] },
    })

    expect(fixed.isError).toBe(true)
    expect(textOf(fixed)).toMatch(/^\[400\] Name a `pageId`/)
  })

  it('is asked for by name when nothing is open', async () => {
    const client = await connect(true)
    const result = await client.callTool({ name: 'list_pages', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/^\[409\] No chapter is open in Kemolate/)
  })
})
