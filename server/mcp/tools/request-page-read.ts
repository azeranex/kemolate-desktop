/**
 * Have the page read by the machine that is holding it.
 *
 * **Prefer this to reading a page yourself.** kemolate has a comic text
 * detector and a recogniser that run locally in the reader's browser, on the
 * file already on their disk, and they are better at finding lettering than a
 * vision model looking at a downscaled page — measurably so at the part that
 * matters most, which is the *shape* of each box. A model estimating boxes
 * traces the columns of source text, and an English line set into a
 * five-character-wide vertical strip is a page somebody has to re-letter by
 * hand. It also costs a page image per page to arrive at that.
 *
 * So the division of labour is: this finds and reads the lettering, and the
 * agent translates it. `save_page_blocks` is still there for the pages the
 * pipeline cannot manage and for a balloon it missed.
 *
 * See `server/utils/reading.ts` for why exactly one browser is asked, and why
 * giving up waiting does not cancel anything.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { MAX_WAIT, requestRead, WAIT } from '~~/server/utils/reading'

export default defineMcpTool({
  name: 'request_page_read',
  description: [
    'Read pages using kemolate\'s own OCR — the detector and recogniser running in the',
    'reader\'s browser, on the machine that holds the scans.',
    'PREFER THIS over looking at a page yourself: it costs no image, and its boxes are',
    'shaped for lettering, where a box you estimate from a picture traces the source text',
    'and makes the translation run vertically down a narrow strip.',
    'Pass every page you want read in one call — the browser loads its models once and works',
    'through them, so a chapter is one call rather than forty.',
    'Needs the chapter open in kemolate. Reading takes ~20s a page and the first spends a minute',
    'downloading a model, so a batch usually answers "working" — the blocks are saved regardless;',
    'poll `list_pages` with needs "reading" to see them land.',
    'Afterwards check the characters with `review_page_reading`.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageIds: z.array(z.number().int().positive()).min(1).max(60)
      .describe('The pages to read, from `list_pages`. Batch them — one call reads the lot.'),
    waitSeconds: z.number().int().min(5).max(MAX_WAIT / 1000).optional()
      .describe(`How long to wait before answering "working" and letting it finish on its own. Default ${WAIT / 1000}.`),
  },
  handler: async ({ workspaceId, pageIds, waitSeconds }) => {
    const context = await mcpContext(workspaceId)

    const wanted = []

    for (const pageId of pageIds) {
      const page = await mcpPage(context, pageId)

      // A page nobody has hashed cannot be named to a browser, so it is left
      // out rather than failing the batch — one unhashed page in forty should
      // not stop the other thirty-nine being read.
      if (page.hash) wanted.push({ hash: page.hash, pageId: page.id })
    }

    if (!wanted.length) {
      throw createError({
        statusCode: 409,
        statusMessage: 'None of those pages have been hashed yet, so no browser can be asked for them. Open the chapter in kemolate once.',
      })
    }

    const outcome = await requestRead(
      context.workspace.publicId,
      wanted,
      context.workspace.name,
      waitSeconds ? waitSeconds * 1000 : undefined,
    )

    if (outcome.status === 'refused') {
      throw createError({ statusCode: 409, statusMessage: outcome.reason })
    }

    const asked = wanted.map((page) => page.pageId)

    if (outcome.status === 'working') {
      return mcpJson({
        pages: asked,
        status: 'working',
        note: 'Still reading — the browser works through the batch and saves each page as it finishes, whether or not anybody is waiting. Poll `list_pages` with needs "reading" to watch them land.',
      })
    }

    // Read back rather than trusting the counts the browser reported: the rows
    // are what every later tool works from, and the agent's next move is to
    // check and translate them.
    const read = []

    for (const pageId of asked) {
      const rows = await blocks.onPage(context, pageId)

      read.push({
        pageId,
        blocks: rows.map((block) => ({
          blockId: block.id,
          kind: block.kind,
          position: block.position,
          source: block.source,
        })),
      })
    }

    return mcpJson({
      status: 'read',
      pagesRead: outcome.read,
      ...(outcome.read < asked.length
        ? { note: `Only ${outcome.read} of ${asked.length} pages were held by that browser; the rest are still unread.` }
        : {}),
      pages: read,
      next: 'The boxes are the pipeline\'s and worth trusting; the characters are worth checking. `review_page_reading` shows every block beside a close crop of itself in one call, and `correct_blocks` fixes what is wrong.',
    })
  },
})
