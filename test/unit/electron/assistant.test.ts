import { beforeEach, describe, expect, it, vi } from 'vitest'

import { aWorkspace, reset } from '../server/harness'

import { replace } from '~~/server/services/blocks'
import { sync as syncPages } from '~~/server/services/pages'
import { installMcpGlobals } from '~~/server/utils/mcpToolkit'
import { focusTab, holdIn, swarmState } from '~~/server/utils/swarm'

/**
 * The MCP server's tools as the window's own assistant reaches them — desktop.
 *
 * **Needs the database harness.**
 *
 * What is under test is `electron/assistant.ts`: that it offers what an outside
 * agent is offered (the same list, not a second one), that a call runs inside
 * an MCP event so a tool finds its caller, and that "the open chapter" means
 * the tab the call came from rather than the tab on screen.
 *
 * Seam: the two exported functions the IPC handlers call, with `electron` and
 * the backup marker stood in.
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))
vi.mock('~~/electron/database', () => ({ written: () => {} }))

installMcpGlobals()

// After the globals, because every tool calls `defineMcpTool` as it loads.
const { callFor, listFor } = await import('~~/electron/assistant')

beforeEach(() => {
  reset()
  swarmState.swarms.clear()
  swarmState.sockets.clear()
  swarmState.tabs.clear()
  swarmState.focused = null
  swarmState.opener = null
  swarmState.active = null
})

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text

/** A chapter of one page with one block, open in `tab`. */
async function openIn (tab: string, name: string) {
  const context = await aWorkspace({ name })
  const [page] = await syncPages(context, [{ path: `${name}.jpg`, name: `${name}.jpg`, position: 0, hash: `sha-${name}` }])

  await replace(context, page!.id, [{ kind: 'bubble', source: name, cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 }])
  holdIn(tab, context.workspace.publicId, [], () => {}, page!.id)

  return { context, page: page! }
}

describe('the assistant\'s tools', () => {
  it('are the MCP server\'s, with their schemas and annotations', async () => {
    const tools = await listFor('1')

    expect(tools.map((tool) => tool.name)).toContain('review_page_reading')
    expect(tools).toHaveLength(24)

    for (const tool of tools) expect(tool.inputSchema.type).toBe('object')

    expect(tools.find((tool) => tool.name === 'join_blocks')?.annotations?.destructiveHint).toBe(true)
  })

  it('work on the chapter of the tab that asked, not the tab on screen', async () => {
    await openIn('7', 'mine')
    await openIn('8', 'theirs')
    focusTab('8')

    const listed = JSON.parse(textOf(await callFor('7', 'list_pages', {})))

    expect(listed.pages.map((page: { name: string }) => page.name)).toEqual(['mine.jpg'])
  })

  it('take the asking tab\'s page on screen for a one-page tool', async () => {
    const { page } = await openIn('7', 'mine')

    await openIn('8', 'theirs')
    focusTab('8')

    const fixed = await callFor('7', 'correct_blocks', { corrections: [{ blockId: 999_999, source: 'x' }] })

    expect(fixed.isError).toBe(true)
    expect(textOf(fixed)).toBe(`[404] Not blocks on page ${page.id}: 999999.`)
  })

  it('say so when the asking tab has no chapter open', async () => {
    await openIn('8', 'theirs')
    focusTab('8')

    const listed = await callFor('7', 'list_pages', {})

    expect(listed.isError).toBe(true)
    expect(textOf(listed)).toMatch(/^\[409\] No chapter is open/)
  })
})
