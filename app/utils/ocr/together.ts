import { balloonIn } from './balloon'
import { fenceAround } from './rooms'

import type { Balloon } from './balloon'
import type { Region } from './manga'
import type { Block } from '~/composables/useComic'
import type { Sheet } from '~/utils/paper'

/**
 * Whether two blocks are in the same balloon, asked of the page rather than of
 * their boxes.
 *
 * `balloonGroups` joins by geometry: two boxes beside each other, the gap small
 * against the thickness of the lettering. That was written for a detector that
 * hands a balloon back in columns, and the comic detector — the default since
 * 2026-09-30 — hands it back whole. Two of *its* boxes beside each other are two
 * balloons, and the thickness the gap is measured against is a whole balloon's
 * width, so balloons that touch pass easily: page 11 of the test chapter had two
 * speakers' balloons, 0.087 of the page apart against an allowance of 0.088,
 * joined into one sentence that read fluently and was not what the page said.
 * That is the silent failure `balloons.ts` warns about, made by the auto run.
 *
 * So the page is asked first, two ways, the surer first:
 *
 * - **The balloons the detector drew** (`fences`) — kept from the reading, in
 *   page pixels. Two blocks in one drawn balloon are one balloon's lettering
 *   whatever the gap; two in different drawn balloons are two, whatever the
 *   gap. The point tested is each block's middle, by the rule the rooms use
 *   (`fenceAround`), so a block's balloon is the same balloon to both.
 * - **The outline in the pixels**, where either block has no drawn balloon —
 *   a page read in an earlier session (the fences are not stored), a reader
 *   that draws none (PP-OCR), or a balloon the detector missed. Each block's
 *   balloon is filled (`balloonIn`, the rooms' own fill, unbounded); a fill that
 *   holds and has the other block's middle inside it is one balloon, a fill
 *   that holds without it is two. An outline between two touching balloons is
 *   exactly what a fill stops at.
 *
 * Where neither can say — no fences, and both fills ran out into the art, as
 * borderless lettering's do — the answer is "don't know", and the caller falls
 * back on geometry as before.
 */
export type Together = 'same' | 'apart' | null

export interface BalloonJudgeInput {
  /** The page at a fixed width, as `readScanSheet` reads it. Null where the scan is not to hand. */
  sheet: Sheet | null
  /** The balloons the detector drew when this page was read, in page pixels; null where unknown. */
  fences: Region[] | null
  /** The scan's size in pixels — what the fences are in, and what a block's percentages are of. */
  width: number
  height: number
}

/**
 * How far the fill may look, on every side, as a share of the block's *longer*
 * side — `balloonIn`'s own reach, measured off the length rather than per axis,
 * so a column's window is wide enough for the balloon it is a column of.
 */
const FIELD = 1.6

/** A block turned or bent: its box is not the upright rectangle a fill is seeded from. */
const turned = (block: Block) => Boolean(block.angle || block.skewX || block.skewY || block.quad?.some((v) => v !== 0))

/**
 * The judge for one page. Each block's fill is made once, on first asking, and
 * kept for the page — a page of ten blocks is at most ten fills of a 640-wide
 * sheet, whatever number of pairs are asked about.
 */
export function balloonJudge ({ sheet, fences, width, height }: BalloonJudgeInput): (a: Block, b: Block) => Together {
  const middle = (block: Block) => ({
    x: ((block.x + block.w / 2) / 100) * width,
    y: ((block.y + block.h / 2) / 100) * height,
  })

  const fenceOf = (block: Block) => (fences?.length ? fenceAround(middle(block).x, middle(block).y, fences) : -1)

  const scale = sheet && width ? sheet.w / width : 0
  const fills = new Map<Block, Balloon | null>()

  /** The block's balloon in the pixels, or null where no fill could be made or it got out. */
  const fillOf = (block: Block): Balloon | null => {
    if (fills.has(block)) return fills.get(block)!

    let found: Balloon | null = null

    if (sheet && scale && !turned(block)) {
      const seed = {
        x: (block.x / 100) * width * scale,
        y: (block.y / 100) * height * scale,
        w: (block.w / 100) * width * scale,
        h: (block.h / 100) * height * scale,
      }

      // A square window off the longer side, so a column's reaches across its
      // balloon to the neighbours being asked about — see `field` in `balloonIn`.
      const reach = Math.max(seed.w, seed.h) * FIELD
      const field = { x: seed.x - reach, y: seed.y - reach, w: seed.w + reach * 2, h: seed.h + reach * 2 }

      const balloon = seed.w >= 1 && seed.h >= 1 ? balloonIn(sheet, seed, null, undefined, field) : null

      found = balloon && !balloon.escaped ? balloon : null
    }

    fills.set(block, found)

    return found
  }

  /** Whether a held fill has this block's middle inside it. */
  const holds = (balloon: Balloon, block: Block) => {
    const { x, y } = middle(block)
    const px = Math.round(x * scale) - balloon.window.x
    const py = Math.round(y * scale) - balloon.window.y

    if (px < 0 || py < 0 || px >= balloon.window.w || py >= balloon.window.h) return false

    return Boolean(balloon.mask[py * balloon.window.w + px])
  }

  return (a, b) => {
    const fa = fenceOf(a)
    const fb = fenceOf(b)

    if (fa >= 0 && fb >= 0) return fa === fb ? 'same' : 'apart'

    const fillA = fillOf(a)
    const fillB = fillOf(b)

    if ((fillA && holds(fillA, b)) || (fillB && holds(fillB, a))) return 'same'
    if (fillA || fillB) return 'apart'

    return null
  }
}
