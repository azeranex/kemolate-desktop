import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../../harness'

import { replace } from '~~/server/services/blocks'
import { save as saveCast } from '~~/server/services/cast'
import { merge as learnTerms } from '~~/server/services/glossaries'
import { sync as syncPages } from '~~/server/services/pages'
import { MCP_ACTOR } from '~~/server/utils/mcp'

/**
 * What an agent is actually handed for a batch of pages — the tool's own reply,
 * end to end, against a real schema.
 *
 * **Needs the database harness.**
 *
 * The bill this is about: every page of a batch used to carry the whole page
 * prompt — the instructions, the reply's shape, the two paragraphs asking what
 * the page taught, and the chapter's glossary and cast — so twenty pages were
 * the same standing text twenty times over, with the lines a fifth of the
 * reply. Now the standing half is `instructions`, said once, and each page's
 * `prompt` is its lines and its count.
 *
 * Seam: the tool's `handler`, called as the MCP toolkit calls it. Two of
 * Nitro's auto-imports are stood in for — `defineMcpTool`, which only hands the
 * definition back, and `useEvent`, which is how `mcpContext` finds the token's
 * owner — and nothing else about the tool is: the pages, blocks, glossary and
 * cast are real rows, and `batchFor` builds the reply the way it does in
 * production.
 */

type Handler = (input: {
  workspaceId: string
  pageIds: number[]
  mode: 'text' | 'image'
  locale?: string
  force: boolean
  blockId?: number
}) => Promise<{ content: { type: string, text?: string }[] }>

const globals = globalThis as { defineMcpTool?: (tool: unknown) => unknown, useEvent?: () => unknown }

globals.defineMcpTool ??= (tool) => tool

// After the stand-in, because the tool calls `defineMcpTool` as it loads.
const { handler } = (await import('~~/server/mcp/tools/prepare-page-translation')).default as unknown as { handler: Handler }

/** Whoever the next call's token belongs to — see `mcpActor`. */
let caller: unknown = null

const before = globals.useEvent

beforeEach(() => {
  reset()
  globals.useEvent = () => ({ context: { [MCP_ACTOR]: caller } })
})

afterEach(() => {
  globals.useEvent = before
})

/** How many times `needle` appears in `hay`. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('prepare_page_translation', () => {
  it('says what every page shares once, and gives each page only its own lines', async () => {
    const context = await aWorkspace()

    // Desktop: a checked token leaves nobody in particular (`McpActor`); the context has no actor.
    caller = { id: null }

    const pages = await syncPages(context, ['01.jpg', '02.jpg', '03.jpg'].map((path, position) =>
      ({ path, name: path, position, hash: `sha-${path}` })))

    for (const [at, page] of pages.entries()) {
      await replace(context, page.id, [
        { source: `宗介、${at + 1}ページ目`, cx: 0.2, cy: 0.2, w: 0.1, h: 0.1 },
        { source: 'どうして……', cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 },
        { source: '山田さん！', cx: 0.8, cy: 0.8, w: 0.1, h: 0.1 },
      ])
    }

    await learnTerms(context, 'en', [{ src: '宗介', tr: 'Sousuke' }, { src: '日蝕', tr: 'Eclipse' }])
    await saveCast(context, [{ source: '山田', names: { en: 'Yamada' }, gender: 'female', tags: ['classmate'] }], 'Keep it formal.')

    const { content } = await handler({
      workspaceId: context.workspace.publicId,
      pageIds: pages.map((page) => page.id),
      mode: 'text',
      locale: 'en',
      force: false,
    })

    const text = content[0]!.text!
    const reply = JSON.parse(text) as { instructions: string, pages: { prompt: string, expects: number }[] }

    // The chapter's standing knowledge, and the standing instructions, once.
    for (const said of [
      '宗介 → Sousuke',
      '日蝕 → Eclipse',
      '山田 → Yamada (female; classmate)',
      'Keep it formal.',
      'list only recurring series-specific terms',
      'Silently fix obvious OCR errors',
    ]) {
      expect(count(text, said)).toBe(1)
    }

    expect(reply.instructions).toContain('宗介 → Sousuke')

    // And each page's own lines, with its own count, on that page only.
    for (const [at, page] of reply.pages.entries()) {
      expect(page.prompt).toContain(`1. 宗介、${at + 1}ページ目`)
      expect(page.prompt).toContain('with exactly 3 translations')
      expect(page.prompt).not.toContain('Sousuke')
      expect(page.expects).toBe(3)
    }
  })
})
