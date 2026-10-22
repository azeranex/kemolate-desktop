/**
 * Show a page to the agent.
 *
 * The one tool here that reaches outside the database, and the only place in
 * kemolate where a picture of a scan passes through the server. Read
 * `server/utils/relay.ts` before changing anything about it — the short version
 * is that the server holds no page and cannot fetch one: it asks a browser that
 * is in this workspace right now and holding this scan, gets back a bounded
 * JPEG made for the asking, hands it over and drops it.
 *
 * Which means the honest failure is "nobody has the chapter open", and it is
 * common. The message says what to do about it, because the person who can fix
 * it is sitting in front of kemolate.
 *
 * ## The region is the reason this tool is worth having twice
 *
 * A whole page bounded to sixteen hundred pixels cannot resolve small vertical
 * lettering — the first agent to use this had to build a crop pipeline of its
 * own to read a page of Chinese. Given a `region` the browser cuts the
 * rectangle out before scaling and *enlarges* it, so one balloon comes back
 * several times sharper than the whole page could ever be. The rectangle is in
 * the same width-normalised units as a block's box, so checking block 5 means
 * passing block 5's box with a little margin.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { requestRender } from '~~/server/utils/relay'

export default defineMcpTool({
  name: 'get_page_image',
  description: [
    'The scan of one page, as a JPEG, for reading lettering or judging tone.',
    'Pass `blockId` to zoom straight to one block, or `region` for an arbitrary rectangle — either is',
    'cropped before scaling, so a balloon comes back several times sharper than the whole page can be.',
    'To check a whole page\'s reading, use `review_page_reading` instead: one call, every block, no aiming.',
    'Relayed live from a reader\'s open browser tab (the server keeps no copy of any page), so it',
    'fails if nobody has the chapter open in kemolate.',
    'To translate a page, call `prepare_page_translation` with mode "image" instead — it returns the',
    'brief and the page together, so you do not pay for the image twice.',
  ].join(' '),
  annotations: { readOnlyHint: true, openWorldHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page\'s id, from `list_pages`.'),
    blockId: z.number().int().positive().optional()
      .describe('Zoom to this block, with a margin. Saves working the rectangle out yourself; ignored if `region` is given.'),
    region: z
      .object({
        x: z.number().min(-1).max(10).describe('Left edge, as a fraction of the page WIDTH.'),
        y: z.number().min(-1).max(10).describe('Top edge, also as a fraction of the page WIDTH — the same units a block box uses, so it may exceed 1 on a tall page.'),
        w: z.number().min(0.001).max(10).describe('Width, as a fraction of the page width.'),
        h: z.number().min(0.001).max(10).describe('Height, as a fraction of the page width.'),
      })
      .optional()
      .describe('A rectangle to zoom into. From a block: x = cx - w/2 - margin, y = cy - h/2 - margin. Omit for the whole page.'),
  },
  handler: async ({ workspaceId, pageId, blockId, region }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)

    /*
     * A block is a centre and a size; a region is a corner and a size with room
     * around it. Doing that conversion here rather than making every caller do
     * it is the difference between "show me block 776" and four multiplications
     * an agent gets subtly wrong — which it did, more than once, before this.
     */
    if (!region && blockId !== undefined) {
      const found = (await blocks.onPage(context, page.id))
        .flatMap((block) => [block, ...block.children])
        .find((block) => block.id === blockId)

      if (!found) {
        throw createError({ statusCode: 404, statusMessage: 'No such block on this page.' })
      }

      const pad = Math.max(found.w, found.h) * 0.08 + 0.01

      region = {
        x: found.cx - found.w / 2 - pad,
        y: found.cy - found.h / 2 - pad,
        w: found.w + pad * 2,
        h: found.h + pad * 2,
      }
    }

    if (!page.hash) {
      throw createError({
        statusCode: 409,
        statusMessage: 'This page has not been hashed yet, so it cannot be asked for. Open the chapter in kemolate once.',
      })
    }

    const { bytes, type } = await requestRender(context.workspace.publicId, page.hash, context.workspace.name, region)

    return imageResult(bytes.toString('base64'), type)
  },
})
