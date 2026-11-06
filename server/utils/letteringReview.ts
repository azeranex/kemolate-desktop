/**
 * How each line on a page came out, judged — desktop. The half of
 * `review_lettering` that turns the window's measurements (`fits.ts`) into
 * flags, kept apart so `set_lettering_style` can answer with the same verdict
 * on the lines it just changed.
 *
 * It used to live in the review alone, so a restyle answered with the style it
 * stored and nothing about how that came out: every frame or size the in-app
 * assistant set was followed by a whole turn spent calling `review_lettering`
 * to find out, the conversation sent again to do it (2026-11-06). The flags and
 * what each means are described in `review-lettering.ts`.
 */
import { breakFlags } from './breaks'
import { shapeOf } from './mcp'

import type { BreakFlag } from './breaks'
import type { FitReport } from './fits'
import type { Shaped } from './mcp'
import type { blocks } from '~~/server/services'

/** A chosen size under this share of what its frame would hold is small for its balloon. */
const SMALL_FOR_ROOM = 0.75

/** An automatic line under this share of the page's ordinary size is small for the page. */
const SMALL_FOR_PAGE = 0.7

/** An automatic line over this multiple of the page's ordinary size, with ordinary lettering in the original, is large for it. */
const LARGE_FOR_PAGE = 1.3

export type Flag = 'does-not-fit' | 'squeezed' | 'small-for-its-balloon' | 'smaller-than-the-page' | 'larger-than-the-page' | 'collides' | BreakFlag

/** Flags about where lines break: judged from `drawn`, so their balloons need no picture. */
export const BREAKS = new Set<Flag>(['stranded-word', 'lone-last-word', 'rewrapped'])

type Row = Awaited<ReturnType<typeof blocks.onPage>>[number]

/**
 * Every measured line — or only `blockIds` — with its flags, and the page's
 * ordinary size. The ordinary size is the middle of the page's automatic and
 * standard lines among those asked about, as the review has always worked it.
 */
export function judgedLines (report: FitReport, rows: Map<number, Row>, target: string, blockIds?: number[]) {
  const wanted = (report.lines ?? []).filter((line) => !blockIds?.length || blockIds.includes(line.blockId))

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
    // Desktop: its words run into another line's — see `collisions` in `useLetteringErrands`.
    if (line.collides?.length) flags.push('collides')

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
      ...(line.collides?.length ? { collidesWith: line.collides } : {}),
      // Where it is set: its own frame where a letterer (or agent) placed one, else its room, else its box.
      // With its turn, lean and corners where it has them: the room is upright, a block or a frame may not be.
      frame: said && said.cx !== null
        ? shapeOf(said as Shaped)
        : row?.room ?? (row ? shapeOf(row) : null),
      ...(row?.room ? { room: row.room } : {}),
      ...(said?.pinned ? { pinned: true } : {}),
    }
  })

  return { lines, median }
}
