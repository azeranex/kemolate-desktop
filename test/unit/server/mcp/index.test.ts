import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { contextFor } from '~~/server/services/access'
import { replace } from '~~/server/services/blocks'
import { sync as syncPages } from '~~/server/services/pages'
import { putOnPage } from '~~/server/services/translations'
import { finish } from '~~/server/utils/errand'
import { MCP_ACTOR } from '~~/server/utils/mcp'
import { installMcpGlobals } from '~~/server/utils/mcpToolkit'
import { deliver } from '~~/server/utils/relay'
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

/** The workspace's row, read back. */
const getWorkspace = async (publicId: string) => (await contextFor(publicId))?.workspace

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
      'get_guide',
      'get_page_image',
      'get_workspace',
      'list_pages',
      'list_workspaces',
      'prepare_page_translation',
      'read_page',
      'request_page_read',
      'review_lettering',
      'review_page_reading',
      'save_page_blocks',
      'save_page_translations',
      'set_lettering_standard',
      'set_lettering_style',
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

  it('hands out the Kemolate skill as its guide, and the skill names only tools it has', async () => {
    const client = await connect(true)
    const offered = new Set((await client.listTools()).tools.map((tool) => tool.name))
    const guide = textOf(await client.callTool({ name: 'get_guide', arguments: {} }))
    const skill = readFileSync(fileURLToPath(new URL('../../../../plugins/kemolate/skills/kemolate/SKILL.md', import.meta.url)), 'utf8')

    // The skill's body, without the front matter that is for choosing a skill.
    expect(guide.startsWith('# Working in Kemolate through MCP')).toBe(true)
    expect(skill).toContain(guide)

    // Every tool the guide tells an agent to call is one this server has — so a
    // tool renamed or removed cannot leave the skill telling agents to call it.
    const named = new Set([...guide.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]!))
    const unknown = [...named].filter((name) => /^(get|list|read|request|review|correct|save|sort|prepare|update|set)_/.test(name) && !offered.has(name))

    expect(unknown).toEqual([])
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

describe('set_lettering_style', () => {
  /** A page of three balloons: two translated by a person (so pinned), one not yet. */
  async function lettered () {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-01' }])
    const rows = await replace(context, page!.id, ['あ', 'い', 'う'].map((source, at) =>
      ({ kind: 'bubble' as const, source, cx: 0.2 + at * 0.3, cy: 0.5, w: 0.1, h: 0.1 })))

    await putOnPage(context, page!.id, 'en', [
      { blockId: rows[0]!.id, text: 'Hello', style: { italic: true } },
      { blockId: rows[1]!.id, text: 'There' },
    ])

    return { context, page: page!, ids: rows.map((row) => row.id) }
  }

  const call = async (args: Record<string, unknown>) => (await connect(true)).callTool({ name: 'set_lettering_style', arguments: args })

  /** Each line, as `read_page` reports it. */
  async function linesOf (workspaceId: string, pageId: number) {
    const read = JSON.parse(textOf(await (await connect(true)).callTool({ name: 'read_page', arguments: { workspaceId, pageIds: [pageId] } })))

    return read.pages[0].blocks.map((block: { translations: Record<string, unknown> }) => block.translations.en ?? null)
  }

  it('sets the style alone — the wording and the pin stand', async () => {
    const { context, page, ids } = await lettered()
    const result = JSON.parse(textOf(await call({
      workspaceId: context.workspace.publicId,
      pageId: page.id,
      blockIds: [ids[0], ids[1]],
      style: { size: 40, bold: true, font: 'retro' },
    })))

    expect(result.restyled.map((row: { blockId: number }) => row.blockId)).toEqual([ids[0], ids[1]])

    const [first, second] = await linesOf(context.workspace.publicId, page.id)

    // Merged into what was there: the italic kept.
    expect(first).toMatchObject({ text: 'Hello', pinned: true, engine: 'human', style: { italic: true, size: 40, bold: true, font: 'retro' } })
    expect(second).toMatchObject({ text: 'There', pinned: true, style: { size: 40, bold: true, font: 'retro' } })
  })

  it('puts a field sent as null back to automatic, and `reset` puts them all back', async () => {
    const { context, page, ids } = await lettered()
    const at = { workspaceId: context.workspace.publicId, pageId: page.id, blockIds: [ids[0]] }

    await call({ ...at, style: { size: 40, italic: null } })
    expect((await linesOf(context.workspace.publicId, page.id))[0].style).toEqual({ size: 40 })

    await call({ ...at, reset: true })
    expect((await linesOf(context.workspace.publicId, page.id))[0]).not.toHaveProperty('style')
  })

  it('restyles every translated line on the page when no block is named', async () => {
    const { context, page } = await lettered()
    const result = JSON.parse(textOf(await call({ workspaceId: context.workspace.publicId, pageId: page.id, style: { align: 'left' } })))

    expect(result.restyled).toHaveLength(2)
    expect(result).not.toHaveProperty('untranslated')
  })

  it('reports a named block with no line, and changes nothing about it', async () => {
    const { context, page, ids } = await lettered()
    const result = JSON.parse(textOf(await call({ workspaceId: context.workspace.publicId, pageId: page.id, blockIds: [ids[2]], style: { size: 30 } })))

    expect(result).toMatchObject({ restyled: [], untranslated: [ids[2]] })
  })

  it('refuses what the Lettering panel could not store', async () => {
    const { context, page, ids } = await lettered()
    const result = await call({ workspaceId: context.workspace.publicId, pageId: page.id, blockIds: [ids[0]], style: { color: 'red' } })

    expect(result.isError).toBe(true)
    expect((await linesOf(context.workspace.publicId, page.id))[0].style).toEqual({ italic: true })
  })

  it('tells the open window, so it re-letters', async () => {
    const { context, page, ids } = await lettered()
    const sent: string[] = []

    hold(context.workspace.publicId, [], (_publicId, frame) => sent.push(frame))

    await call({ workspaceId: context.workspace.publicId, pageId: page.id, blockIds: [ids[0]], style: { size: 50 } })

    expect(sent.map((frame) => JSON.parse(frame))).toEqual([{ type: 'changed', change: { scope: 'translations', pageId: page.id, locale: 'en' } }])
  })
})

describe('set_lettering_style with a frame', () => {
  async function lettered () {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-01' }])
    const rows = await replace(context, page!.id, [
      // A tall Japanese column in a balloon the reading measured a round room for.
      { kind: 'bubble' as const, source: 'あ', cx: 0.2, cy: 0.5, w: 0.05, h: 0.2, room: { cx: 0.2, cy: 0.5, w: 0.14, h: 0.24, round: true } },
      { kind: 'bubble' as const, source: 'い', cx: 0.7, cy: 0.5, w: 0.05, h: 0.2 },
    ])

    await putOnPage(context, page!.id, 'en', [
      { blockId: rows[0]!.id, text: 'For now', style: { italic: true } },
      { blockId: rows[1]!.id, text: 'There' },
    ])

    return { context, page: page!, ids: rows.map((row) => row.id) }
  }

  const call = async (args: Record<string, unknown>) => (await connect(true)).callTool({ name: 'set_lettering_style', arguments: args })

  async function blocksOf (workspaceId: string, pageId: number) {
    return JSON.parse(textOf(await (await connect(true)).callTool({ name: 'read_page', arguments: { workspaceId, pageIds: [pageId] } }))).pages[0].blocks
  }

  it('shows the room a reading measured, round or not', async () => {
    const { context, page } = await lettered()
    const [first, second] = await blocksOf(context.workspace.publicId, page.id)

    expect(first.room).toEqual({ cx: 0.2, cy: 0.5, w: 0.14, h: 0.24, round: true })
    expect(second).not.toHaveProperty('room')
  })

  it('sets a frame without touching the style, and hands it back', async () => {
    const { context, page, ids } = await lettered()
    const at = { workspaceId: context.workspace.publicId, pageId: page.id, blockIds: [ids[0]] }

    const set = JSON.parse(textOf(await call({ ...at, frame: { cx: 0.21, cy: 0.5, w: 0.18, h: 0.26 } })))

    expect(set.restyled[0].frame).toEqual({ cx: 0.21, cy: 0.5, w: 0.18, h: 0.26 })

    let [first] = await blocksOf(context.workspace.publicId, page.id)

    expect(first.translations.en).toMatchObject({ text: 'For now', pinned: true, style: { italic: true }, frame: { cx: 0.21, cy: 0.5, w: 0.18, h: 0.26 } })

    await call({ ...at, frame: null })
    ;[first] = await blocksOf(context.workspace.publicId, page.id)

    expect(first.translations.en).not.toHaveProperty('frame')
    expect(first.translations.en.style).toEqual({ italic: true })
  })

  it('sets a frame and a shape together', async () => {
    const { context, page, ids } = await lettered()

    await call({ workspaceId: context.workspace.publicId, pageId: page.id, blockIds: [ids[1]], frame: { cx: 0.7, cy: 0.5, w: 0.2, h: 0.3 }, style: { shape: 'oval', size: null } })

    const [, second] = await blocksOf(context.workspace.publicId, page.id)

    expect(second.translations.en).toMatchObject({ style: { shape: 'oval' }, frame: { cx: 0.7, cy: 0.5, w: 0.2, h: 0.3 } })
  })

  it('refuses one frame for two balloons', async () => {
    const { context, page, ids } = await lettered()
    const result = await call({ workspaceId: context.workspace.publicId, pageId: page.id, blockIds: ids, frame: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.2 } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/^\[400\] A frame is one balloon/)
  })
})

describe('review_lettering', () => {
  /** A page of four translated balloons, open in a stand-in window that answers as the real one would. */
  async function lettered (lines: { size: number, set: 'auto' | 'standard' | 'chosen', capacity: number | null, over?: boolean, tight?: boolean, hyphens?: boolean, measuredEmphasis?: number, drawn?: string[], rewrapped?: boolean }[], standard: number | null = null) {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-01' }])
    const rows = await replace(context, page!.id, lines.map((_, at) =>
      ({ kind: 'bubble' as const, source: 'あ', cx: 0.2 + at * 0.2, cy: 0.5, w: 0.1, h: 0.2 })))

    await putOnPage(context, page!.id, 'en', rows.map((row, at) => ({ blockId: row.id, text: `Line ${at + 1}` })))

    const asked: { type: string, lettered?: boolean }[] = []

    // The window: measures when asked, and hands back a "picture" for each lettered crop.
    hold(context.workspace.publicId, ['sha-01'], (publicId, frame) => {
      const ask = JSON.parse(frame) as { type: string, request: string, lettered?: boolean }

      asked.push(ask)

      queueMicrotask(() => {
        if (ask.type === 'fits') {
          finish(ask.request, publicId, {
            ok: true,
            standard,
            lines: lines.map((line, at) => ({ blockId: rows[at]!.id, over: false, tight: false, hyphens: false, ...line })),
          })
        } else if (ask.type === 'render') {
          deliver(ask.request, publicId, Buffer.from([0xFF, 0xD8, 0xFF]), 'image/jpeg')
        }
      })
    }, page!.id)

    return { context, page: page!, ids: rows.map((row) => row.id), asked }
  }

  const review = async (args: Record<string, unknown> = {}) => (await connect(true)).callTool({ name: 'review_lettering', arguments: args })
  const report = (result: Awaited<ReturnType<typeof review>>) => JSON.parse(textOf(result))

  it('flags a line that does not fit, one squeezed, and one small for the page — and shows those, as lettered', async () => {
    const { ids, asked } = await lettered([
      { size: 40, set: 'auto', capacity: 40 },
      { size: 42, set: 'auto', capacity: 42 },
      { size: 20, set: 'auto', capacity: 20, over: true },
      { size: 24, set: 'auto', capacity: 24 },
    ])
    const result = await review()
    const out = report(result)
    const flags = Object.fromEntries(out.lines.map((line: { blockId: number, flags: string[] }) => [line.blockId, line.flags]))

    expect(flags[ids[0]!]).toEqual([])
    expect(flags[ids[2]!]).toEqual(['does-not-fit'])
    expect(flags[ids[3]!]).toEqual(['smaller-than-the-page'])
    expect(out.images).toEqual([ids[2], ids[3]])
    expect(out.lines[0].text).toBe('Line 1')

    // The crops were asked for lettered, one per flagged line, after the measuring.
    expect(asked.map((ask) => ask.type)).toEqual(['fits', 'render', 'render'])
    expect(asked.filter((ask) => ask.type === 'render').every((ask) => ask.lettered)).toBe(true)
    expect((result.content as { type: string }[]).filter((part) => part.type === 'image')).toHaveLength(2)
  })

  it('never calls a line held to the standard small, however much room it has', async () => {
    const { asked } = await lettered([
      { size: 30, set: 'standard', capacity: 60 },
      { size: 30, set: 'standard', capacity: 45, tight: true },
    ], 30)
    const out = report(await review())

    expect(out.standard).toBe(30)
    expect(out.lines.map((line: { flags: string[] }) => line.flags)).toEqual([[], ['squeezed']])
    expect(asked.filter((ask) => ask.type === 'render')).toHaveLength(1)
  })

  it('calls a chosen size small when its frame would hold far more', async () => {
    await lettered([{ size: 20, set: 'chosen', capacity: 50 }, { size: 40, set: 'auto', capacity: 40 }])

    const out = report(await review({ images: 'none' }))

    expect(out.lines[0].flags).toEqual(['small-for-its-balloon'])
    expect(out.images).toEqual([])
  })

  it('calls a line filling a big balloon large for the page — unless the original shouts it', async () => {
    const { ids } = await lettered([
      { size: 40, set: 'auto', capacity: 40 },
      { size: 42, set: 'auto', capacity: 42 },
      { size: 41, set: 'auto', capacity: 41 },
      { size: 70, set: 'auto', capacity: 70 },
      { size: 72, set: 'auto', capacity: 72, measuredEmphasis: 1.6 },
    ])
    const out = report(await review({ images: 'none' }))
    const flags = Object.fromEntries(out.lines.map((line: { blockId: number, flags: string[] }) => [line.blockId, line.flags]))

    expect(flags[ids[3]!]).toEqual(['larger-than-the-page'])
    expect(flags[ids[4]!]).toEqual([])
    expect(out.lines[4].measuredEmphasis).toBe(1.6)
    // No standard: every balloon is filled, and the answer is one.
    expect(out.next).toContain('set_lettering_standard')
  })

  it('does not suggest a standard to a chapter that has one', async () => {
    await lettered([{ size: 30, set: 'standard', capacity: 60 }, { size: 45, set: 'standard', capacity: 60 }], 30)

    expect(report(await review({ images: 'none' })).next).not.toContain('set_lettering_standard')
  })

  it('reports the lines as drawn, flags bad breaks, and shows no picture for a break alone', async () => {
    const { ids, asked } = await lettered([
      { size: 28, set: 'standard', capacity: 30, drawn: ['FIRST, LET', 'ME SHOW', 'YOU', 'AROUND THE'] },
      { size: 28, set: 'standard', capacity: 30, drawn: ['HM? OH,', 'YEAH, IT', 'IS.'] },
      { size: 28, set: 'standard', capacity: 30, drawn: ['HM?', 'OH, YEAH,', 'IT IS.'], rewrapped: true },
      { size: 28, set: 'standard', capacity: 30, drawn: ['WAIT, IS', 'THIS ONE', 'OF THOSE'] },
    ], 28)
    const out = report(await review())

    expect(out.lines.map((line: { flags: string[] }) => line.flags)).toEqual([['stranded-word'], ['lone-last-word'], ['rewrapped'], []])
    expect(out.lines[0].drawn).toEqual(['FIRST, LET', 'ME SHOW', 'YOU', 'AROUND THE'])
    expect(out.next).toContain('newlines')
    // The words say it: no crop for a balloon flagged only for its breaks.
    expect(out.images).toEqual([])
    expect(asked.map((ask) => ask.type)).toEqual(['fits'])
    expect(ids).toHaveLength(4)
  })

  it('says why when the window cannot measure', async () => {
    const context = await aWorkspace()
    const [page] = await syncPages(context, [{ path: '01.jpg', name: '01.jpg', position: 0, hash: 'sha-01' }])

    hold(context.workspace.publicId, ['sha-01'], (publicId, frame) => {
      const ask = JSON.parse(frame) as { request: string }

      queueMicrotask(() => finish(ask.request, publicId, { ok: false, error: 'Kemolate has another chapter open.' }))
    }, page!.id)

    const result = await review()

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('[409] Kemolate has another chapter open.')
  })
})

describe('set_lettering_standard', () => {
  const call = async (args: Record<string, unknown>) => (await connect(true)).callTool({ name: 'set_lettering_standard', arguments: args })

  it('keeps the size in the workspace record, and turns it off with null', async () => {
    const context = await aWorkspace()
    const workspaceId = context.workspace.publicId

    expect(JSON.parse(textOf(await call({ workspaceId, size: 34 })))).toMatchObject({ standard: 34, was: null })

    const read = await getWorkspace(context.workspace.publicId)

    expect(read?.letteringStandard).toBe(34)
    expect(JSON.parse(textOf(await call({ workspaceId, size: null })))).toMatchObject({ standard: null, was: 34 })
  })

  it('tells the open window, so it re-fits', async () => {
    const context = await aWorkspace()
    const sent: string[] = []

    hold(context.workspace.publicId, [], (_publicId, frame) => sent.push(frame))

    await call({ workspaceId: context.workspace.publicId, size: 30 })

    expect(sent.map((frame) => JSON.parse(frame))).toEqual([{ type: 'changed', change: { scope: 'workspace' } }])
  })

  it('refuses a size that is not one', async () => {
    const context = await aWorkspace()

    expect((await call({ workspaceId: context.workspace.publicId, size: 0 })).isError).toBe(true)
  })
})
