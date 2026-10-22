/**
 * Write down what was read off a page.
 *
 * The far half of the OCR loop: `get_page_image` shows the agent the scan, this
 * files what it found. Editor rights, not translator — a block is a claim about
 * the artwork, and drawing one is the same kind of act as cleaning under it.
 *
 * ## Replace and append are different asks and both are needed
 *
 * `replace` is what a *reading* is: these blocks describe the same scan the old
 * ones described, so keeping both would leave every balloon doubled. It is the
 * right mode after looking at a page.
 *
 * `append` adds without disturbing, for a balloon the reading missed. It is the
 * right mode when the page already has blocks that somebody has corrected,
 * because `replace` deletes them and takes their translations with them by
 * cascade.
 *
 * Both go through the services, which is what makes the page-belongs-to-this-
 * workspace check and the transaction somebody else's problem.
 *
 * ## The coordinates
 *
 * Said three times in this file and once in the server instructions, because it
 * is the one thing a model reliably gets wrong: **both axes are divided by the
 * page's width**. `cy` and `h` therefore run past 1 on a page taller than it is
 * wide, and that is correct rather than a bug to clamp. `list_pages` gives the
 * pixel size to divide by.
 */
import { z } from 'zod'

import { blockDraftSchema } from '#shared/schemas/workspace'
import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'save_page_blocks',
  description: [
    'File the text blocks you read off a page.',
    'Coordinates are an oriented box normalised by the page WIDTH on BOTH axes:',
    'divide every pixel measurement, x and y alike, by the page width from `list_pages`.',
    'So `cy` and `h` are greater than 1 near the bottom of a tall page — that is correct.',
    'Use mode "replace" after reading a whole page; it discards the blocks that were there,',
    'and their translations with them. Use "append" to add a balloon a reading missed.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page\'s id, from `list_pages`.'),
    mode: z.enum(['replace', 'append']).default('append')
      .describe('"replace" discards every block on the page first, along with its translations. "append" keeps them.'),
    blocks: z.array(blockDraftSchema).min(1).max(500)
      .describe('The blocks, in reading order. `source` is the text as it appears on the page, untranslated.'),
  },
  handler: async ({ workspaceId, pageId, mode, blocks: drafts }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)

    const written = mode === 'replace'
      ? await blocks.replace(context, page.id, drafts)
      : await blocks.append(context, page.id, drafts)

    return mcpJson({
      pageId: page.id,
      mode,
      written: written.length,
      blocks: written.map((block) => ({
        blockId: block.id,
        position: block.position,
        kind: block.kind,
        source: block.source,
      })),
    })
  },
})
