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
 * - **larger-than-the-page**: an automatic line set well over it, in a balloon
 *   the artist drew big with ordinary-sized lettering in it — filled because
 *   nothing holds it. Not where the original's own characters are big
 *   (`measuredEmphasis`): that is a shout, and loud is right. Never a sound
 *   effect, which is meant to be as big as it is.
 *
 * - **stranded-word**, **lone-last-word**, **rewrapped**: where the lines break,
 *   from `drawn` — the lines as the window drew them (`server/utils/breaks.ts`).
 *   No picture: the words say it.
 *
 * A line held to the chapter's **standard** size is not "small" however much
 * room is left round it: one size for every ordinary line is the point of a
 * standard, and the air round a short line is part of how a lettered book looks.
 */
import { z } from 'zod'

import type { BreakFlag } from '~~/server/utils/breaks'

import { blocks } from '~~/server/services'
import { breakFlags } from '~~/server/utils/breaks'
import { requestFits } from '~~/server/utils/fits'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { requestRenders } from '~~/server/utils/relay'

/** A chosen size under this share of what its frame would hold is small for its balloon. */
const SMALL_FOR_ROOM = 0.75

/** An automatic line under this share of the page's ordinary size is small for the page. */
const SMALL_FOR_PAGE = 0.7

/** An automatic line over this multiple of the page's ordinary size, with ordinary lettering in the original, is large for it. */
const LARGE_FOR_PAGE = 1.3

/** How many lettered crops one call returns at most — each is a render out of the window. */
const MAX_IMAGES = 12

/** Room round a frame in its crop, as for `review_page_reading`. */
const MARGIN = 0.12
const FLOOR = 0.01

type Flag = 'does-not-fit' | 'squeezed' | 'small-for-its-balloon' | 'smaller-than-the-page' | 'larger-than-the-page' | BreakFlag

/** Flags about where lines break: judged from `drawn`, so their balloons need no picture. */
const BREAKS = new Set<Flag>(['stranded-word', 'lone-last-word', 'rewrapped'])

export default defineMcpTool({
  name: 'review_lettering',
  description: [
    'Check how a page is lettered: each translated line\'s size, what decided it (fitted, the chapter\'s standard, or chosen),',
    'the size its frame would allow (`capacity`), how loud the original lettered it (`measuredEmphasis`, over 1 for a shout), and flags for lines',
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
      if (!line.over && line.set === 'auto' && median && row?.kind !== 'sfx' && (line.measuredEmphasis ?? 1) <= 1 && line.size > median * LARGE_FOR_PAGE) flags.push('larger-than-the-page')
      // Desktop: where the lines break, from the lines as drawn — see `server/utils/breaks.ts`.
      if (!line.over && line.drawn) flags.push(...breakFlags(line.drawn, line.rewrapped))

      return {
        blockId: line.blockId,
        text: said?.text ?? '',
        size: line.size,
        set: line.set,
        capacity: line.capacity,
        // Desktop: how loud it is set over the standard, and how loud the original was lettered — 1 is ordinary.
        ...((line.emphasis ?? 1) !== 1 ? { emphasis: line.emphasis } : {}),
        ...((line.measuredEmphasis ?? 1) !== 1 ? { measuredEmphasis: line.measuredEmphasis } : {}),
        ...(line.emphasisChosen ? { emphasisChosen: true } : {}),
        flags,
        // The lines as Kemolate draws them; a typed break is a newline in `text`.
        ...(line.drawn ? { drawn: line.drawn } : {}),
        // Where it is set: its own frame where a letterer (or agent) placed one, else its room, else its box.
        frame: said && said.cx !== null
          ? { cx: said.cx, cy: said.cy, w: said.w, h: said.h }
          : row?.room ?? (row ? { cx: row.cx, cy: row.cy, w: row.w, h: row.h } : null),
        ...(row?.room ? { room: row.room } : {}),
        ...(said?.pinned ? { pinned: true } : {}),
      }
    })

    // A line flagged only for its breaks shows them in `drawn`; its picture would add nothing.
    const shown = (images === 'none' ? [] : images === 'all' ? lines : lines.filter((line) => line.flags.some((flag) => !BREAKS.has(flag))))
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

    // Lines that break badly are re-broken by hand: a newline in the translation is a break Kemolate keeps.
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
              : 'Nothing flagged. Ask the user to look — size and fit are measured, but tone and placement are theirs to judge.') + rebreak + noStandard,
          }),
        },
        ...crops.map((crop) => ({ type: 'image' as const, data: crop.bytes.toString('base64'), mimeType: crop.type })),
      ],
    }
  },
})
