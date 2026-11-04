/**
 * Clean a page's original lettering off the art — desktop only.
 *
 * The Detect panel's Clean page, for an agent: after a translation the page
 * still shows the Japanese under the English, and an agent told cleaning was
 * the window's alone said so and stopped (2026-10-28). It is the window's
 * alone — the cleaner runs there — so this asks the window, as `join_blocks`
 * and `split_block` already do for the blocks they make (`cleanAfter`): the
 * window's own `cleanBlock` per block, a cached repair of the same box reused,
 * the model run only for what is new.
 *
 * Every block on the page by default, less those marked garbage or hidden —
 * the ones a press of Clean leaves alone too. Never a refusal: no chapter open,
 * no cleaner chosen, is said in `cleaning` with what the user should do.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { cleanAfter } from '~~/server/utils/cleaning'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'clean_page',
  description: [
    'Clean the original lettering off a page\'s art in Kemolate, so the translation is lettered on clean balloons — do it once a page is',
    'read, its blocks are right (joined, split, garbage marked) and, usually, translated. Every block on the page by default, or only `blockIds`.',
    'Blocks marked garbage or hidden are left alone. A block already cleaned reuses its repair. Kemolate must have the chapter open, with a',
    'cleaner chosen; `cleaning` in the answer says which blocks are clean and what to tell the user if it could not. Check with',
    '`get_page_image` and `lettered: true`.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page to clean, from `list_pages`.'),
    blockIds: z.array(z.number().int().positive()).min(1).max(200).optional()
      .describe('Only these blocks. Leave it out for the whole page.'),
  },
  handler: async ({ workspaceId, pageId, blockIds }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)
    const onPage = await blocks.onPage(context, page.id)

    if (blockIds) {
      const stray = blockIds.filter((id) => !onPage.some((block) => block.id === id))

      if (stray.length) {
        throw createError({
          statusCode: 404,
          statusMessage: `Not blocks on page ${page.id}: ${stray.join(', ')}. A column of a joined balloon is cleaned by its balloon's id.`,
        })
      }
    }

    const asked = blockIds ? onPage.filter((block) => blockIds.includes(block.id)) : onPage
    const left = asked.filter((block) => block.kind === 'garbage' || block.hidden)
    const taking = asked.filter((block) => block.kind !== 'garbage' && !block.hidden)

    if (!taking.length) {
      return mcpJson({ pageId: page.id, cleaning: { cleaned: [] }, note: 'Nothing on this page to clean: no blocks, or every one is marked garbage or hidden.' })
    }

    const cleaning = await cleanAfter(context.workspace.publicId, page.hash, taking.map((block) => block.id))

    return mcpJson({
      pageId: page.id,
      cleaning,
      ...(left.length ? { leftAlone: left.map((block) => ({ blockId: block.id, why: block.hidden ? 'hidden' : 'garbage' })) } : {}),
    })
  },
})
