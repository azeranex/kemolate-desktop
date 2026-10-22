/**
 * Everything found on one page: where the lettering is, what it says, and what
 * it has been carried over to.
 *
 * Through `blocks.onPage`, so a balloon somebody joined out of three columns
 * comes back as one block with its parts inside it rather than as three things
 * the caller has to know how to reassemble. Translate the parent; the children
 * are there so an agent can see how the source was laid out.
 *
 * `pinned` is reported on every line, and it is the field that stops an agent
 * arguing with itself. A pinned line is one a person typed, and writing over it
 * files the new wording in the history without moving the line — so an agent
 * that did not know would translate it, read it back unchanged, and try again.
 */
import { z } from 'zod'

import type { Translation } from '~~/server/database'

import { blocks } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

/** One block's translations, keyed by language, with only what a caller can use. */
function saidIn (rows: Translation[]) {
  return Object.fromEntries(rows.map((row) => [row.locale, {
    text: row.text,
    engine: row.engine,
    model: row.model,
    status: row.status,
    // Nullable in the column because it was added to a table that already had
    // rows; null and false are the same answer — nobody has claimed this line.
    pinned: row.pinned === true,
    // Desktop: how the line is lettered and where, for `set_lettering_style` to
    // change — only where something is set, so an automatic line costs nothing.
    // `frame` is the lettering's own box, where a letterer moved it off the block.
    ...(row.style && Object.keys(row.style).length ? { style: row.style } : {}),
    ...(row.cx !== null ? { frame: { cx: row.cx, cy: row.cy, w: row.w, h: row.h } } : {}),
  }]))
}

export default defineMcpTool({
  name: 'read_page',
  description: [
    'Every text block on one or more pages, in reading order, with what each says in the',
    'original and every translation it already has. Ask for a batch of pages in one call.',
    'Boxes are normalised by the page WIDTH on both axes, so `cy` and `h` can exceed 1 on a tall page.',
    'A block whose `pinned` is true for a language was written by a person and will not be moved by a machine.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageIds: z.array(z.number().int().positive()).min(1).max(20)
      .describe('The pages to read, from `list_pages`. Ask for several at once rather than one per call — a chapter is dozens of pages and each block is a line or two of text.'),
  },
  handler: async ({ workspaceId, pageIds }) => {
    const context = await mcpContext(workspaceId)

    const read = async (pageId: number) => {
      const page = await mcpPage(context, pageId)

      const rows = await blocks.onPage(context, page.id)

      return onePage(page, rows)
    }

    // Sequential rather than `Promise.all`: SQLite is one connection and twenty
    // parallel reads through it queue anyway, while a burst makes the query log
    // impossible to follow when one of them goes wrong.
    const pages = []

    for (const pageId of pageIds) pages.push(await read(pageId))

    return mcpJson({
      sourceLocale: context.workspace.sourceLocale,
      targetLocale: context.workspace.targetLocale,
      pages,
    })
  },
})

/** One page's worth, in the shape a caller can act on. */
function onePage (
  page: { id: number, name: string, width: number | null, height: number | null },
  rows: Awaited<ReturnType<typeof blocks.onPage>>,
) {
  return {
    pageId: page.id,
    name: page.name,
    width: page.width,
    height: page.height,
    blocks: rows.map((block) => ({
      blockId: block.id,
      kind: block.kind,
      position: block.position,
      box: {
        cx: block.cx,
        cy: block.cy,
        w: block.w,
        h: block.h,
        angle: block.angle,
        skewX: block.skewX,
        skewY: block.skewY,
        quad: block.quad,
      },
      // Desktop: the room measured inside the block's balloon, which a line is set
      // in unless it has a `frame` of its own; absent, it is set in `box`.
      // `round` is a room that is the balloon's own oval, lettered as one.
      ...(block.room ? { room: block.room } : {}),
      source: block.source,
      confidence: block.confidence,
      /** Hidden and rubbish blocks are never translated — see `planPage`. */
      hidden: block.hidden,
      translations: saidIn(block.translations),
      // Only their own reading and their own boxes; a child holds no
      // translation, by design. Omitted entirely when there are none, so an
      // ordinary balloon is not thirty tokens of empty array.
      ...(block.children.length
        ? {
            parts: block.children.map((child) => ({
              blockId: child.id,
              position: child.position,
              box: { cx: child.cx, cy: child.cy, w: child.w, h: child.h, angle: child.angle },
              source: child.source,
            })),
          }
        : {}),
    })),
  }
}
