/**
 * Fix what a block is understood to say.
 *
 * The third leg of the reading loop, and without it the other two do not close.
 * `request_page_read` gets the boxes right and the characters *mostly* right —
 * a recogniser trained on Japanese reading Traditional Chinese will hand back
 * `漫畫畫中` for `漫畫中` — and `get_page_image` with a region shows an agent
 * exactly which character went wrong. Neither of the writing tools could then
 * put it right: `append` would add a second block on top of the first, and
 * `replace` would throw away the whole page's reading to change one word.
 *
 * So: a patch, one block at a time, the same one the Text panel's source field
 * sends. Editor rather than translator, because the source is a claim about the
 * artwork — the same reasoning `save_page_blocks` carries.
 *
 * ## The source, not the translation
 *
 * Correcting a reading and changing what a line should say are different acts
 * with different consequences, and this is the first. The source is what the
 * prompt is built from, so one wrong character quietly buys a wrong translation
 * on every later attempt at that line — which is exactly why the Text panel
 * stopped being read-only about it. What the line should say instead is
 * `save_page_translations`.
 *
 * `confidence` is deliberately not patchable, following `blockPatchSchema`: it
 * is how sure the *engine* was about a reading that has now been replaced, and
 * nothing done to a block afterwards makes a past reading more or less certain.
 * A corrected line can therefore still show a low percentage, and that is true
 * rather than stale.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'correct_blocks',
  description: [
    'Fix the source text a reading got wrong, one block at a time, without disturbing the rest of the page.',
    'Use this after `request_page_read` when a character came back garbled —',
    '`get_page_image` with a `region` around the block will show you what the page actually says.',
    'This corrects what the page is understood to SAY in the original; to change what it should say',
    'in another language, use `save_page_translations`.',
    'Can also fix a box that is the wrong shape (`cx`/`cy`/`w`/`h`), mark a block as rubbish',
    '(`kind: "garbage"`), or hide it so it is never translated.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page these blocks are on, from `list_pages`.'),
    corrections: z
      .array(z.object({
        blockId: z.number().int().positive(),
        source: z.string().max(4000).optional().describe('What the page actually says, in the original language.'),
        kind: z.enum(['bubble', 'caption', 'sfx', 'garbage']).optional()
          .describe('"garbage" for something that is not lettering at all — it is kept but never translated or lettered.'),
        hidden: z.boolean().optional().describe('Keep the block out of the page without deleting it.'),
        /*
         * The box, for the reading that found the right words in the wrong
         * place. A detector routinely returns a box round one column of a
         * two-column bubble, and the lettering then sets into a sliver — this
         * was reportable and unfixable until now. Same units as everywhere
         * else: normalised by the page WIDTH on both axes.
         */
        cx: z.number().min(-10).max(10).optional().describe('Centre across, as a fraction of the page width.'),
        cy: z.number().min(-10).max(10).optional().describe('Centre down, also as a fraction of the page WIDTH — may exceed 1 on a tall page.'),
        w: z.number().min(0).max(10).optional().describe('Width, as a fraction of the page width.'),
        h: z.number().min(0).max(10).optional().describe('Height, as a fraction of the page width.'),
        angle: z.number().min(-360).max(360).optional().describe('Degrees clockwise, for lettering that runs at a slant.'),
      }).refine(
        (patch) => Object.keys(patch).some((key) => key !== 'blockId'),
        'Say what to change about the block.',
      ))
      .min(1)
      .max(100)
      .describe('One entry per block you are correcting.'),
  },
  handler: async ({ workspaceId, pageId, corrections }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)

    /*
     * Proved page-by-page before anything is written, rather than trusting the
     * ids. `blocks.update` takes a block id and checks it belongs to the
     * workspace — but not that it belongs to the page named here, and a caller
     * that mixed two pages' blocks into one call would get a change it did not
     * ask for on a page it did not name.
     */
    const onPage = new Set((await blocks.onPage(context, page.id)).flatMap(
      (block) => [block.id, ...block.children.map((child) => child.id)],
    ))

    const stray = corrections.filter((fix) => !onPage.has(fix.blockId))

    if (stray.length) {
      throw createError({
        statusCode: 404,
        statusMessage: `Not blocks on page ${page.id}: ${stray.map((fix) => fix.blockId).join(', ')}.`,
      })
    }

    const fixed = []

    for (const { blockId, ...patch } of corrections) {
      const block = await blocks.update(context, blockId, patch)

      fixed.push({
        blockId: block.id,
        kind: block.kind,
        source: block.source,
        hidden: block.hidden,
        box: { cx: block.cx, cy: block.cy, w: block.w, h: block.h, angle: block.angle },
      })
    }

    return mcpJson({ pageId: page.id, corrected: fixed.length, blocks: fixed })
  },
})
