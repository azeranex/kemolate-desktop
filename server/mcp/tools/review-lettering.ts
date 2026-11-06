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
 *   Desktop: only automatic lines, so a murmur held under the standard by its
 *   measured emphasis is never flagged — small is what the original says.
 * - **larger-than-the-page**: an automatic line set well over it, in a balloon
 *   the artist drew big with ordinary-sized lettering in it — filled because
 *   nothing holds it. Not where the original's own characters are big
 *   (`measuredEmphasis`): that is a shout, and loud is right. Never a sound
 *   effect, which is meant to be as big as it is.
 *
 * - **collides**: its drawn words run into another line's (`collidesWith`) —
 *   several utterances in one balloon, each in a room cut round its own original.
 *   Desktop, from the window's ink (`collisions` in `useLetteringErrands`).
 * - **stranded-word**, **lone-last-word**, **rewrapped**: where the lines break,
 *   from `drawn` — the lines as the window drew them (`server/utils/breaks.ts`).
 *   No picture: the words say it.
 *
 * A line held to the chapter's **standard** size is not "small" however much
 * room is left round it: one size for every ordinary line is the point of a
 * standard, and the air round a short line is part of how a lettered book looks.
 */
import { z } from 'zod'

import type { Shaped } from '~~/server/utils/mcp'

import { blocks } from '~~/server/services'
import { requestFits } from '~~/server/utils/fits'
import { BREAKS, judgedLines } from '~~/server/utils/letteringReview'
import { extentOf, mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { requestRenders } from '~~/server/utils/relay'

/** How many lettered crops one call returns at most — each is a render out of the window. */
const MAX_IMAGES = 12

/** Room round a frame in its crop, as for `review_page_reading`. */
const MARGIN = 0.12
const FLOOR = 0.01

export default defineMcpTool({
  name: 'review_lettering',
  description: [
    'Check how a page is lettered: each translated line\'s size, what decided it (fitted, the chapter\'s standard, or chosen),',
    'the size its frame would allow (`capacity`), how loud the original lettered it (`measuredEmphasis`, over 1 for a shout, under 1 for a murmur), and flags for lines',
    'that do not fit, were squeezed, are small for their balloon, or are small or large for the page — with a close crop of each flagged balloon AS LETTERED (not the scan).',
    'Each line\'s `drawn` is its lines as drawn, and badly broken ones are flagged (a word stranded mid-balloon, a lone last word, a typed line wrapped again) — fixed by typing newlines into the translation.',
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
    const { lines, median } = judgedLines(report, rows, target, blockIds)

    // A line flagged only for its breaks shows them in `drawn`; its picture would add nothing.
    const shown = (images === 'none' ? [] : images === 'all' ? lines : lines.filter((line) => line.flags.some((flag) => !BREAKS.has(flag))))
      .filter((line) => line.frame)
      .slice(0, MAX_IMAGES)

    const regions = shown.map(({ frame }) => {
      // The upright rectangle it covers, so a turned frame is cropped whole.
      const box = extentOf(frame as Shaped, page.width)
      const pad = Math.max(box.w, box.h) * MARGIN + FLOOR

      return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
    })

    const crops = regions.length
      ? await requestRenders(context.workspace.publicId, page.hash, context.workspace.name, regions, true)
      : []

    const flagged = lines.filter((line) => line.flags.length).length

    // Lines that break badly are re-broken by hand: a newline in the translation is a break Kemolate keeps.
    // Lines lettered over each other: usually several utterances in one balloon, each in a room cut round its own original.
    const overlapping = lines.some((line) => line.flags.includes('collides'))
      ? ' Lines flagged `collides` are lettered over another (`collidesWith`) — usually several utterances in one balloon: give each a `frame` of its own band of the balloon (`set_lettering_style`, `frames` for all of them in one call). Joining them into one block (`join_blocks`) is the user\'s decision — ask, never do it unasked. `get_guide`, "Several lines in one balloon".'
      : ''

    const rebreak = lines.some((line) => line.flags.some((flag) => BREAKS.has(flag)))
      ? ' Read each line\'s `drawn` for its breaks: re-break one by writing newlines into its translation (one phrase to a line, short-long-short — `get_guide`, "Line breaks"), through `save_page_translations` for a machine line or as a proposal for a pinned one. Kemolate keeps typed breaks, setting the line a little smaller rather than wrapping one again; `rewrapped` means a typed line is still too long for its place.'
      : ''

    // A chapter with no standard fills every balloon, so its sizes follow its balloons — the root of most size flags.
    const noStandard = !report.standard && lines.filter((line) => line.set === 'auto').length >= 3
      ? ` This chapter has no standard size, so every balloon is filled and sizes follow the balloons, not the voices; \`set_lettering_standard\` (around ${median}px, the page's ordinary size) sets ordinary lines alike and lets shouts in the original stand out.`
      : ''

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
            next: (flagged
              ? 'Fix flagged lines in this order: give the line its balloon (`set_lettering_style` with `frame` and `shape: "oval"`); then, for a line still too long, propose a shorter wording that keeps its meaning and voice (`get_guide` says how) — save it only if the line is not pinned, otherwise ask; change the size last. A line too large for the page is fixed by a standard size, not by shrinking it alone. Check again with this tool.'
              : 'Nothing flagged. Ask the user to look — size and fit are measured, but tone and placement are theirs to judge.') + overlapping + rebreak + noStandard,
          }),
        },
        ...crops.map((crop) => ({ type: 'image' as const, data: crop.bytes.toString('base64'), mimeType: crop.type })),
      ],
    }
  },
})
