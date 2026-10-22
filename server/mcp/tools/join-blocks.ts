/**
 * Join blocks into one balloon — desktop only.
 *
 * The window's Join (`useBlockMerge.merge`), for an agent: a detector routinely
 * reads one balloon as two or three blocks, one per column or line, and each is
 * then translated as a sentence of its own. Joined, the balloon is one block —
 * one source, one translation, one lettering — with the parts kept inside it as
 * its columns, so `split_block` gives them back exactly as they were.
 *
 * Built as the window builds it: the members are the chosen blocks' columns
 * where they are balloons and the blocks themselves where not; the source is
 * theirs joined on the one rule (`tidyText` — nothing between the columns of a
 * vertical CJK balloon, a space between Latin lines); the box is the union of
 * theirs; the confidence the least. And put where the first chosen block was in
 * the reading order, as the window puts it — the service writes a new balloon
 * last on the page, which the window then moves; an agent has no window to.
 *
 * What it costs is what the window's Join costs, and is said in the answer: a
 * balloon among the chosen is dissolved, and its translation with it. A plain
 * block keeps its translation in its row, unshown while it is a column.
 *
 * And cleaned: the new balloon is a box no repair was made for, so the window
 * is asked to clean it (`cleanAfter`), and the answer says how that went.
 */
import { z } from 'zod'

import { tidyText } from '#shared/utils/ocr'
import { blocks } from '~~/server/services'
import { cleanAfter } from '~~/server/utils/cleaning'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'join_blocks',
  description: [
    'Join two or more blocks on a page into one balloon — for a balloon the reading split into several blocks (one per column or line),',
    'so it is translated and lettered as one sentence. Name the blocks IN READING ORDER: their source text is joined in that order.',
    'The parts are kept inside the balloon, and `split_block` gives them back. The new balloon starts untranslated, and a balloon among',
    'the ones joined loses its translation — translate the new one afterwards (`prepare_page_translation`). The balloon is cleaned in Kemolate as it is made (`cleaning` in the answer). Look before joining:',
    '`get_page_image` with a `region` round the blocks shows whether they really are one balloon.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page the blocks are on, from `list_pages`.'),
    blockIds: z.array(z.number().int().positive()).min(2).max(50)
      .describe('The blocks to join, in the order they read.'),
    kind: z.enum(['bubble', 'caption', 'sfx', 'garbage']).optional()
      .describe('What the balloon is. Defaults to the first block\'s kind.'),
    source: z.string().max(4000).optional()
      .describe('The balloon\'s text in the original, if the joined parts read wrong. Defaults to the parts\' text joined in order.'),
  },
  handler: async ({ workspaceId, pageId, blockIds, kind, source }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)
    const onPage = await blocks.onPage(context, page.id)

    if (new Set(blockIds).size !== blockIds.length) {
      throw createError({ statusCode: 400, statusMessage: 'Name each block once.' })
    }

    const chosen = blockIds.map((id) => onPage.find((block) => block.id === id))
    const stray = blockIds.filter((_, at) => !chosen[at])

    if (stray.length) {
      throw createError({
        statusCode: 404,
        statusMessage: `Not blocks on page ${page.id}: ${stray.join(', ')}. A column of a joined balloon is joined by its balloon's id.`,
      })
    }

    const picked = chosen as NonNullable<(typeof chosen)[number]>[]
    const members = picked.flatMap((block) => (block.children.length ? block.children : [block]))

    // The union of the members' boxes, upright — what the window measures for a balloon (`around`).
    const left = Math.min(...members.map((block) => block.cx - block.w / 2))
    const right = Math.max(...members.map((block) => block.cx + block.w / 2))
    const top = Math.min(...members.map((block) => block.cy - block.h / 2))
    const bottom = Math.max(...members.map((block) => block.cy + block.h / 2))

    const lost = picked
      .filter((block) => block.children.length)
      .flatMap((block) => block.translations.filter((line) => line.text.trim()).map((line) => ({ blockId: block.id, locale: line.locale, text: line.text })))

    // The balloon's measured inside, where its parts were measured in the same
    // balloon — as columns of one balloon are. Parts in different balloons, or
    // none measured, leave it to be measured again (Detect › Measure balloons).
    const rooms = members.map((block) => block.room).filter((room): room is NonNullable<typeof room> => Boolean(room))
    const same = (a: typeof rooms[number], b: typeof rooms[number]) =>
      Math.abs(a.cx - b.cx) < 0.01 && Math.abs(a.cy - b.cy) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01
    const room = rooms.length && rooms.every((one) => same(one, rooms[0]!)) ? rooms[0]! : null

    const made = await blocks.compound(context, page.id, blockIds, {
      room,
      kind: kind ?? picked[0]!.kind,
      cx: (left + right) / 2,
      cy: (top + bottom) / 2,
      w: right - left,
      h: bottom - top,
      source: source ?? tidyText(members.map((block) => block.source).join('\n')),
      confidence: Math.min(...members.map((block) => block.confidence)),
    })

    // Where the first chosen block read, as the window puts a balloon it joins.
    const balloon = await blocks.update(context, made.id, { position: picked[0]!.position })

    // The balloon is a box no repair covers yet — cleaned now, by the window (`server/utils/cleaning.ts`).
    const cleaning = await cleanAfter(context.workspace.publicId, page.hash, [balloon.id])

    return mcpJson({
      pageId: page.id,
      blockId: balloon.id,
      kind: balloon.kind,
      source: balloon.source,
      box: { cx: balloon.cx, cy: balloon.cy, w: balloon.w, h: balloon.h },
      parts: members.map((block) => block.id),
      // Its lettering's room: the parts' shared balloon, or none — then it is set in its box.
      room: balloon.room ?? null,
      ...(lost.length ? { translationsRemoved: lost } : {}),
      cleaning,
      note: balloon.room
        ? 'The balloon is untranslated. Translate it with `prepare_page_translation`; it is lettered in the balloon its parts were measured in (`room`).'
        : 'The balloon is untranslated. Translate it with `prepare_page_translation`. Its parts were not measured in one balloon, so it is lettered in its box — give it a `frame` with `set_lettering_style`, or ask the user to run Detect › Measure balloons.',
    })
  },
})
