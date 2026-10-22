/**
 * Put a page's blocks back into reading order.
 *
 * A reading taken since `useOcr` learned to sort arrives ordered and never
 * needs this. It is for the pages read before that — where the detector's own
 * order stood, and a page could come back bottom-to-top — and for the fact that
 * an agent has no Sort button to press.
 *
 * Worth knowing what it is *not*: a page whose order somebody set by hand is a
 * page this will overwrite. The panel lets a letterer drag a row precisely
 * because the heuristic is sometimes wrong about a panel laid out against the
 * grid, and calling this afterwards throws that away. Which is why it is a tool
 * of its own rather than something `save_page_blocks` or `correct_blocks` does
 * on the side: reordering a page is a decision, and it should have to be made.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'sort_page_blocks',
  description: [
    'Reorder a page\'s blocks into reading order — down the page in bands, and across each band',
    'right-to-left or left-to-right depending on the chapter.',
    'Use it on a page whose block list is out of sequence; readings taken recently are already sorted.',
    'It overwrites any order a person set by hand, so do not call it on a page somebody has arranged.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageIds: z.array(z.number().int().positive()).min(1).max(50)
      .describe('The pages to reorder, from `list_pages`.'),
    direction: z.enum(['rtl', 'ltr']).optional()
      .describe('Which way each band reads. Defaults to the chapter\'s own reading direction.'),
  },
  handler: async ({ workspaceId, pageIds, direction }) => {
    const context = await mcpContext(workspaceId)

    const way = direction ?? context.workspace.direction

    const sorted = []

    for (const pageId of pageIds) {
      const page = await mcpPage(context, pageId)

      const rows = await blocks.reorder(context, page.id, way)

      sorted.push({
        pageId: page.id,
        blocks: rows.map((block) => ({
          blockId: block.id,
          position: block.position,
          source: block.source,
        })),
      })
    }

    return mcpJson({ direction: way, pages: sorted })
  },
})
