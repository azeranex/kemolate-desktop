/**
 * Show an agent what each block actually says, next to what the reading thinks
 * it says.
 *
 * The tool that came out of watching the loop run three times. Checking a
 * reading used to take four or five calls and a piece of arithmetic per
 * balloon: `read_page` for the text, `get_page_image` for the whole page, a
 * guess about which lines looked suspect, then `x = cx - w/2 - margin` worked
 * out by hand for each one and a `region` call to look. The guessing step is
 * the bad part — on one page a wrong reading was caught only because it
 * happened to fall inside a crop aimed at something else.
 *
 * All of that is mechanical and the server already holds every box. So: one
 * call, and back comes each block's source paired with a tight picture of that
 * block. Nothing to aim, nothing to guess, and the whole page checked at once.
 *
 * ## Why crops rather than the page
 *
 * A whole page bounded to `MAX_EDGE` cannot resolve small vertical lettering —
 * that is the entire reason `region` exists. A balloon a tenth of the page
 * across, cropped and enlarged, is several times sharper *and* smaller than the
 * page it came from. Nine of them together are usually less than one full page.
 *
 * ## What it deliberately does not do
 *
 * It does not judge. There is no "these three look wrong" field, and there was
 * nearly one: the tempting heuristics all fail on the real cases. A recogniser
 * trained on Japanese reading Chinese returns `説明星......` for `說我是……` and
 * `葉明白子暁?` for `聽明白了嗎？` — ordinary characters, plausible boxes,
 * confidence reported as 100. Nothing cheap tells those from a good reading.
 * Making the checking free is the answer; guessing on the agent's behalf would
 * only teach it to trust a flag that is wrong exactly when it matters.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { requestRenders } from '~~/server/utils/relay'

/**
 * How much page to leave around a block.
 *
 * A box drawn tight to the glyphs cuts the strokes that hang outside it, and a
 * crop with no air around it is hard to read and impossible to place — the same
 * eight per cent `readBlock` pads its own regions by, for the same reason,
 * with a floor so a one-character sound effect still gets some room.
 */
const MARGIN = 0.08
const FLOOR = 0.01

/**
 * A cap on one call.
 *
 * Each crop is an errand out to a browser and a picture in the reply. Twenty
 * balloons is a dense page; past that somebody is asking for a chapter, and
 * should ask for it a page at a time.
 */
const MAX_CROPS = 20

export default defineMcpTool({
  name: 'review_page_reading',
  description: [
    'Check a page\'s reading: returns every block\'s source text alongside a close crop of that',
    'block, so you can see what the page actually says without aiming any regions yourself.',
    'Use this after `request_page_read` instead of fetching the whole page and zooming by hand —',
    'a recogniser reading the wrong language returns plausible characters with full confidence,',
    'so the sources cannot be trusted from the text alone.',
    'Fix what is wrong with `correct_blocks`. Needs the chapter open in kemolate.',
  ].join(' '),
  annotations: { readOnlyHint: true, openWorldHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page\'s id, from `list_pages`.'),
    blockIds: z.array(z.number().int().positive()).max(MAX_CROPS).optional()
      .describe('Only these blocks. Omit for every block on the page.'),
  },
  handler: async ({ workspaceId, pageId, blockIds }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)

    if (!page.hash) {
      throw createError({
        statusCode: 409,
        statusMessage: 'This page has not been hashed yet, so it cannot be shown. Open the chapter in kemolate once.',
      })
    }

    const rows = await blocks.onPage(context, page.id)

    const wanted = blockIds?.length
      ? rows.filter((block) => blockIds.includes(block.id))
      : rows

    if (!wanted.length) {
      throw createError({
        statusCode: 404,
        statusMessage: blockIds?.length
          ? 'None of those blocks are on this page.'
          : 'This page has no blocks yet — read it first with `request_page_read`.',
      })
    }

    if (wanted.length > MAX_CROPS) {
      throw createError({
        statusCode: 400,
        statusMessage: `That page has ${wanted.length} blocks; ask for at most ${MAX_CROPS} at a time with \`blockIds\`.`,
      })
    }

    /*
     * The arithmetic this tool exists to stop anybody doing by hand. A block
     * holds a centre and a size; a region wants a corner and a size, with room
     * around it. Both are fractions of the page's *width* on both axes, so
     * there is no second conversion hiding here — see `Region`.
     */
    const regions = wanted.map((block) => {
      const pad = Math.max(block.w, block.h) * MARGIN + FLOOR

      return {
        x: block.cx - block.w / 2 - pad,
        y: block.cy - block.h / 2 - pad,
        w: block.w + pad * 2,
        h: block.h + pad * 2,
      }
    })

    const shots = await requestRenders(context.workspace.publicId, page.hash, context.workspace.name, regions)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            pageId: page.id,
            name: page.name,
            note: 'One image follows per block, in the order of `blocks` below. Compare each picture with its `source`, and correct what is wrong with `correct_blocks`.',
            blocks: wanted.map((block, index) => ({
              image: index + 1,
              blockId: block.id,
              kind: block.kind,
              position: block.position,
              source: block.source,
            })),
          }),
        },
        ...shots.map((shot) => ({
          type: 'image' as const,
          data: shot.bytes.toString('base64'),
          mimeType: shot.type,
        })),
      ],
    }
  },
})
