/**
 * Split a block — desktop only. Two operations behind one name, because to an
 * agent they are one question ("this is not one balloon"):
 *
 * - **A joined balloon** is taken apart (`blocks.release`, the window's Split):
 *   its columns come back as blocks of their own, in its place in the reading
 *   order, each with its own box and source. Send no `parts`.
 * - **Any other block** is cut into the `parts` given (`blocks.split`, the
 *   desktop's own): a detector's box round two balloons, or a balloon and the
 *   caption beside it. Each part is a box and the text it holds, in reading
 *   order; they take the block's place.
 *
 * Either way the block's own translation goes — a part says less than the
 * whole did — and the answer quotes it, so it can be re-translated or carried
 * over by hand. And either way the new blocks are cleaned by the window
 * (`cleanAfter`): a cut takes the block's repair with it, and a released part
 * gets its own back.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { cleanAfter } from '~~/server/utils/cleaning'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

const part = z.object({
  cx: z.number().min(-10).max(10).describe('Centre across, as a fraction of the page WIDTH.'),
  cy: z.number().min(-10).max(10).describe('Centre down, also as a fraction of the page WIDTH — may exceed 1 on a tall page.'),
  w: z.number().min(0.001).max(10).describe('Width, as a fraction of the page width.'),
  h: z.number().min(0.001).max(10).describe('Height, as a fraction of the page width.'),
  angle: z.number().min(-360).max(360).optional().describe('Degrees clockwise, for lettering at a slant.'),
  source: z.string().max(4000).describe('What this part says in the original.'),
  kind: z.enum(['bubble', 'caption', 'sfx', 'garbage']).optional().describe('What this part is. Defaults to the block\'s kind.'),
})

export default defineMcpTool({
  name: 'split_block',
  description: [
    'Split a block that is not one balloon. A JOINED balloon (one with parts) is taken apart into its parts — send no `parts`.',
    'Any other block is cut into the `parts` you give, in reading order: each a box (page-WIDTH units, as every block) and the text it holds —',
    'for a reading that drew one box round two balloons, or a balloon and a caption. Look first: `get_page_image` with the block\'s `blockId`.',
    'The block\'s translation is removed (it is quoted back); translate the parts afterwards with `prepare_page_translation`. The parts are cleaned in Kemolate as they are made (`cleaning` in the answer).',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page the block is on, from `list_pages`.'),
    blockId: z.number().int().positive().describe('The block to split.'),
    parts: z.array(part).min(2).max(20).optional()
      .describe('For a block that is not a joined balloon: what to cut it into, in reading order. Omit to take a joined balloon apart.'),
  },
  handler: async ({ workspaceId, pageId, blockId, parts }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)
    const block = (await blocks.onPage(context, page.id)).find((candidate) => candidate.id === blockId)

    if (!block) {
      throw createError({ statusCode: 404, statusMessage: `Block ${blockId} is not a block on page ${page.id} — a column of a joined balloon is split by its balloon's id.` })
    }

    const removed = block.translations
      .filter((line) => line.text.trim())
      .map((line) => ({ locale: line.locale, text: line.text }))

    if (block.children.length) {
      if (parts) {
        throw createError({ statusCode: 400, statusMessage: 'That block is a joined balloon: send no `parts`, and it is taken apart into the ones it was joined from.' })
      }

      const freed = await blocks.release(context, block.id)
      // Their own repairs, put back — from the cache where they were cleaned before they were joined.
      const cleaning = await cleanAfter(context.workspace.publicId, page.hash, freed.map((row) => row.id))

      return mcpJson({
        pageId: page.id,
        released: block.id,
        blocks: freed.map((row) => ({ blockId: row.id, kind: row.kind, source: row.source, box: { cx: row.cx, cy: row.cy, w: row.w, h: row.h } })),
        ...(removed.length ? { translationsRemoved: removed } : {}),
        cleaning,
        note: 'The parts keep any translation they had before they were joined; `read_page` shows them.',
      })
    }

    if (!parts) {
      throw createError({ statusCode: 400, statusMessage: 'That block is not a joined balloon: send `parts`, the boxes and text to cut it into.' })
    }

    /*
     * A cut divides what the reading found; it does not reach past it. Each
     * part's box is what its repair is cut from, and a part guessed a little
     * high painted out the balloon's outline and tail above the lettering in
     * testing (2026-10-23). So every part stays inside the block's box, with
     * a hair of slack for rounding.
     */
    const slack = Math.max(block.w, block.h) * 0.03
    const outside = parts.findIndex((one) =>
      one.cx - one.w / 2 < block.cx - block.w / 2 - slack || one.cx + one.w / 2 > block.cx + block.w / 2 + slack
      || one.cy - one.h / 2 < block.cy - block.h / 2 - slack || one.cy + one.h / 2 > block.cy + block.h / 2 + slack)

    if (outside >= 0) {
      const box = (n: number) => Math.round(n * 1000) / 1000

      throw createError({
        statusCode: 400,
        statusMessage: `Part ${outside + 1} reaches outside block ${block.id}, whose box runs x ${box(block.cx - block.w / 2)}–${box(block.cx + block.w / 2)}, ` +
          `y ${box(block.cy - block.h / 2)}–${box(block.cy + block.h / 2)}. A part is cleaned over its box, so keep every part inside the block's.`,
      })
    }

    const made = await blocks.split(context, block.id, parts.map(({ kind, angle, ...rest }) => ({
      ...rest,
      kind: kind ?? block.kind,
      angle: angle ?? 0,
      confidence: block.confidence,
    })))

    // The block's repair went with it — the parts are cleaned now, by the window.
    const cleaning = await cleanAfter(context.workspace.publicId, page.hash, made.map((row) => row.id))

    return mcpJson({
      pageId: page.id,
      split: block.id,
      blocks: made.map((row) => ({ blockId: row.id, kind: row.kind, source: row.source, box: { cx: row.cx, cy: row.cy, w: row.w, h: row.h } })),
      ...(removed.length ? { translationsRemoved: removed } : {}),
      cleaning,
      note: 'The parts are untranslated; translate them with `prepare_page_translation`. Their lettering is set in their own boxes until given a `frame` (`set_lettering_style`).',
    })
  },
})
