/**
 * Check a page's lettering: how every line came out, and a look at the ones
 * that need it. Desktop only.
 *
 * The lettering counterpart of `review_page_reading`, and for the same reason
 * one call: a review that has to ask about each line, then aim a picture at
 * each, is a review an agent does badly or not at all. Two things only the
 * window knows are fetched from it — how each line was fitted
 * (`server/utils/fits.ts`) and the page as lettered (`relay.ts`, `lettered`) —
 * and joined here with the lines' words.
 *
 * ## What is flagged, and what is not
 *
 * - **does-not-fit**: the line will not go even at the smallest size allowed,
 *   and is set there and clipped. Always worth a look.
 * - **squeezed**: set tighter, or a word broken, to go. Usually fine — said so
 *   an agent can see why a line looks different.
 * - **small-for-its-balloon**: a size somebody chose is well under what its
 *   frame would hold.
 * - **smaller-than-the-page**: an automatic line set well under the page's
 *   ordinary size — one long word, or a frame too small for its balloon.
 *
 * A line held to the chapter's **standard** size is not "small" however much
 * room is left round it: one size for every ordinary line is the point of a
 * standard, and the air round a short line is part of how a lettered book looks.
 */
import { z } from 'zod'

import { blocks } from '~~/server/services'
import { requestFits } from '~~/server/utils/fits'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { requestRenders } from '~~/server/utils/relay'

/** A chosen size under this share of what its frame would hold is small for its balloon. */
const SMALL_FOR_ROOM = 0.75

/** An automatic line under this share of the page's ordinary size is small for the page. */
const SMALL_FOR_PAGE = 0.7

/** How many lettered crops one call returns at most — each is a render out of the window. */
const MAX_IMAGES = 12

/** Room round a frame in its crop, as for `review_page_reading`. */
const MARGIN = 0.12
const FLOOR = 0.01

type Flag = 'does-not-fit' | 'squeezed' | 'small-for-its-balloon' | 'smaller-than-the-page'

export default defineMcpTool({
  name: 'review_lettering',
  description: [
    'Check how a page is lettered: each translated line\'s size, what decided it (fitted, the chapter\'s standard, or chosen),',
    'the size its frame would allow (`capacity`), and flags for lines that do not fit, were squeezed, or are small for their balloon',
    'or for the page — with a close crop of each flagged balloon AS LETTERED (not the scan).',
    'Use it after translating or restyling a page, and when the user says text looks wrong. Fix in this order:',
    'the frame and shape (`set_lettering_style`), then a shorter wording that keeps the meaning (see `get_guide`), and size last.',
    'Needs the chapter open in Kemolate; leave out the ids for the page on screen.',
  ].join(' '),
  annotations: { readOnlyHint: true, openWorldHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page to review, from `list_pages`.'),
    blockIds: z.array(z.number().int().positive()).max(200).optional()
      .describe('Only these blocks. Omit for every translated line on the page.'),
    images: z.enum(['flagged', 'all', 'none']).default('flagged')
      .describe(`Which balloons to show as lettered: the flagged ones (default), all of them, or none. At most ${MAX_IMAGES}.`),
  },
  handler: async ({ workspaceId, pageId, blockIds, images }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)

    if (!page.hash) {
      throw createError({ statusCode: 409, statusMessage: 'This page has not been hashed yet, so Kemolate cannot be asked about it. Open the chapter once.' })
    }

    const report = await requestFits(context.workspace.publicId, page.hash, context.workspace.name)

    if (!report.ok) throw createError({ statusCode: 409, statusMessage: report.error ?? 'Kemolate could not measure that page.' })

    const rows = new Map((await blocks.onPage(context, page.id)).map((row) => [row.id, row]))
    const target = context.workspace.targetLocale
    const wanted = (report.lines ?? []).filter((line) => !blockIds?.length || blockIds.includes(line.blockId))

    // The page's ordinary size: the middle of its automatic and standard lines.
    const ordinary = wanted.filter((line) => line.set !== 'chosen').map((line) => line.size).sort((a, b) => a - b)
    const median = ordinary.length ? ordinary[Math.floor(ordinary.length / 2)]! : null

    const lines = wanted.map((line) => {
      const row = rows.get(line.blockId)
      const said = row?.translations.find((one) => one.locale === target)
      const flags: Flag[] = []

      if (line.over) flags.push('does-not-fit')
      else if (line.tight || line.hyphens) flags.push('squeezed')

      if (!line.over && line.set === 'chosen' && line.capacity && line.size < line.capacity * SMALL_FOR_ROOM) flags.push('small-for-its-balloon')
      if (!line.over && line.set === 'auto' && median && line.size < median * SMALL_FOR_PAGE) flags.push('smaller-than-the-page')

      return {
        blockId: line.blockId,
        text: said?.text ?? '',
        size: line.size,
        set: line.set,
        capacity: line.capacity,
        flags,
        // Where it is set: its own frame where a letterer (or agent) placed one, else its room, else its box.
        frame: said && said.cx !== null
          ? { cx: said.cx, cy: said.cy, w: said.w, h: said.h }
          : row?.room ?? (row ? { cx: row.cx, cy: row.cy, w: row.w, h: row.h } : null),
        ...(row?.room ? { room: row.room } : {}),
        ...(said?.pinned ? { pinned: true } : {}),
      }
    })

    const shown = (images === 'none' ? [] : images === 'all' ? lines : lines.filter((line) => line.flags.length))
      .filter((line) => line.frame)
      .slice(0, MAX_IMAGES)

    const regions = shown.map(({ frame }) => {
      const box = frame as { cx: number, cy: number, w: number, h: number }
      const pad = Math.max(box.w, box.h) * MARGIN + FLOOR

      return { x: box.cx - box.w / 2 - pad, y: box.cy - box.h / 2 - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
    })

    const crops = regions.length
      ? await requestRenders(context.workspace.publicId, page.hash, context.workspace.name, regions, true)
      : []

    const flagged = lines.filter((line) => line.flags.length).length

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            pageId: page.id,
            locale: target,
            standard: report.standard ?? null,
            ordinarySize: median,
            flagged,
            note: shown.length
              ? `One image follows per line in \`images\`, in order — the balloon as lettered, not the scan. Sizes are the scan's pixels.`
              : 'Sizes are the scan\'s pixels.',
            images: shown.map((line) => line.blockId),
            lines,
            next: flagged
              ? 'Fix flagged lines in this order: give the line its balloon (`set_lettering_style` with `frame` and `shape: "oval"`); then, for a line still too long, propose a shorter wording that keeps its meaning and voice (`get_guide` says how) — save it only if the line is not pinned, otherwise ask; change the size last. Check again with this tool.'
              : 'Nothing flagged. Ask the user to look — size and fit are measured, but tone and placement are theirs to judge.',
          }),
        },
        ...crops.map((crop) => ({ type: 'image' as const, data: crop.bytes.toString('base64'), mimeType: crop.type })),
      ],
    }
  },
})
