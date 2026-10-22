/**
 * The pages of a chapter, in reading order, and how far each one has got.
 *
 * The two counts are the reason this is more than `pages.list`. An agent
 * working through a chapter needs to know which pages have been read and which
 * have been written, and without them the only way to find out is to call
 * `read_page` on all forty.
 *
 * `width` and `height` are here because every box in this API is normalised by
 * the page's **width** — so an agent that means to say "this balloon is at
 * pixel 300, 900" cannot do the arithmetic without them. They are null until
 * some browser has drawn the page.
 */
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm'
import { z } from 'zod'

import { blocks, db, translations } from '~~/server/database'
import { pages } from '~~/server/services'
import { reachable } from '~~/server/utils/errand'
import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'list_pages',
  description: [
    'The pages of a chapter in reading order, with the pixel size of each and',
    'how many text blocks have been found and translated on it.',
    'Block coordinates elsewhere in this API are normalised by the page WIDTH on both axes.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    locale: z.string().trim().min(2).max(16).optional()
      .describe('Which language the translated count is about. Defaults to the chapter\'s target language.'),
    needs: z.enum(['reading', 'translation', 'anything']).optional()
      .describe('Only pages with work left: "reading" for pages with no blocks, "translation" for pages with blocks that are not all translated, "anything" for either. Use this to pick up a chapter where you left off instead of walking every page.'),
  },
  handler: async ({ workspaceId, locale, needs }) => {
    const context = await mcpContext(workspaceId)

    const rows = await pages.list(context)

    const target = locale ?? context.workspace.targetLocale
    const ids = rows.map((row) => row.id)

    // Top-level blocks only, matching what `blocks.onPage` returns: a balloon
    // somebody joined is one thing, not four. Counting the children as well
    // would report a page as having twice the lettering it has.
    const [found, written] = ids.length
      ? await Promise.all([
          db
            .select({ pageId: blocks.pageId, n: count() })
            .from(blocks)
            .where(and(inArray(blocks.pageId, ids), isNull(blocks.parentId)))
            .groupBy(blocks.pageId),
          db
            .select({ pageId: blocks.pageId, n: count() })
            .from(translations)
            .innerJoin(blocks, eq(translations.blockId, blocks.id))
            .where(and(
              inArray(blocks.pageId, ids),
              eq(translations.locale, target),
              // An empty translation row is a line somebody cleared, not a line
              // that has been carried over.
              ne(translations.text, ''),
            ))
            .groupBy(blocks.pageId),
        ])
      : [[], []]

    const blockCount = new Map(found.map((row) => [row.pageId, row.n]))
    const doneCount = new Map(written.map((row) => [row.pageId, row.n]))

    const listed = rows.map((row) => ({
      pageId: row.id,
      name: row.name,
      path: row.path,
      position: row.position,
      width: row.width,
      height: row.height,
      /** Null until a browser has hashed it. Without one, no image can be shown. */
      hash: row.hash,
      blocks: blockCount.get(row.id) ?? 0,
      translated: doneCount.get(row.id) ?? 0,
      /**
       * Whether a browser is holding this page *right now*.
       *
       * The server keeps no scan, so `get_page_image`, `prepare_page_translation`
       * in image mode and `request_page_read` all depend on somebody having the
       * chapter open. Saying so here is what turns "the image tool keeps
       * refusing" into something a caller can plan around: do the text-only work
       * now, and come back for the pictures when a tab is open.
       */
      reachable: reachable(context.workspace.publicId, row.hash),
    }))

    /*
     * A page with no blocks needs reading; a page whose blocks are not all
     * carried over needs translating. Note that a page with no blocks does not
     * need *translating* — there is nothing on it to translate yet, and
     * reporting it as both would have a run try to translate a page it has not
     * read.
     */
    const wanting = (page: (typeof listed)[number]) => ({
      reading: page.blocks === 0,
      translation: page.blocks > 0 && page.translated < page.blocks,
      anything: page.blocks === 0 || page.translated < page.blocks,
    })

    // Not `pages` — that name belongs to the service this handler calls, and
    // shadowing it here is how the whole file lost its types.
    const wanted = needs ? listed.filter((page) => wanting(page)[needs]) : listed

    const live = wanted.filter((page) => page.reachable).length

    return mcpJson({
      locale: target,
      /** How many were left out by `needs`, so a filter is never silent. */
      ...(needs ? { needs, hidden: listed.length - wanted.length } : {}),
      /**
       * Said once for the list as well as per page, because the answer a caller
       * usually wants is "can I do image work on this chapter at all", and
       * counting `reachable` over forty rows to find out is work it should not
       * have to do.
       */
      images: live
        ? { reachable: live, of: wanted.length }
        : { reachable: 0, of: wanted.length, why: `Nobody has “${context.workspace.name}” open in kemolate, so no page image can be relayed. Text tools all work regardless.` },
      pages: wanted,
    })
  },
})
