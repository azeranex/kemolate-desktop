import { balloonIn, clearAround, roomGain } from './balloon'

import type { Balloon, Room } from './balloon'
import type { RoomBox } from './blocks'
import type { DetectedText } from './detectors'
import type { Region } from './manga'
import type { Sheet } from '~/utils/paper'

/**
 * The room inside each block's balloon — what `blocks.room` holds, measured.
 *
 * `balloonIn` does the measuring and says at length how; this is the part that
 * decides which blocks get to be measured at all, and every rule here is a way
 * of declining rather than guessing. A block with no room is lettered into its
 * own box, exactly as every block was before rooms existed, so a refusal costs
 * a translation some space and a wrong room costs it its balloon. That is the
 * asymmetry each rule leans on:
 *
 * - **Balloon text first.** Lettering on artwork (`sfx`, which is what the
 *   detector's `text_free` becomes) usually has no outline to measure; a fill
 *   around it grows through whatever the drawing is — the OCR lab showed a
 *   caption over a building "held" at 38% of its window. But the detector also
 *   files white lettering on a *black* balloon as free text, and draws no
 *   balloon around it (ECLIPSE p10's `和我做愛！` in a black circle, p11's
 *   `親一下吧～`). So free text gets one fill of its own, unfenced and wider
 *   (`FREE_REACH`), held to the strict unfenced leak test — a closed shape
 *   passes it, open artwork runs to the window's edges and does not — and
 *   counted only where the shape is dark (`DARK`), since that is the one kind
 *   of balloon the detector misses.
 * - **Upright only.** The room is an upright rectangle. A tilted phone message
 *   has a tilted bubble, and an upright rectangle inside it is a smaller, worse
 *   frame than the block's own turned box.
 * - **Inside a balloon the detector drew.** The detector's `bubble` class is the
 *   fence that stops a fill escaping through a hairline in the outline — the
 *   fix for the bleeding on the bench — and a block with no fence around it is
 *   one the detector did not think was in a balloon at all.
 * - **One block to a balloon.** Two blocks in one balloon would each be handed
 *   the same room, and two translations lettered over each other are worse than
 *   two narrow ones. Both are declined; joining them into one block (the
 *   Blocks panel's merge) and measuring again is the way to the room.
 * - **More room than the block, or none.** A fill cut short by the lettering
 *   comes back smaller than the box it started from, and the box is then the
 *   better frame by definition.
 * - **Clear paper, where there is no balloon at all.** Borderless dialogue set
 *   straight onto a panel's white ground has nothing for a fill to stop at —
 *   the detector draws no balloon round it, or files it as free text. What it
 *   has is the clear paper round it, measured by pushing the box outward until
 *   it meets ink (`clearAround`), capped at `CLEAR_REACH` so a line in an empty
 *   panel is not handed the panel. Tried last, after everything a balloon
 *   could give, and only counted where it is real extra room (`CLEAR_GAIN`).
 * - **Never over somebody else's lettering.** A room that covers another
 *   block's box would letter one translation over another's source — two black
 *   balloons that touch fill into each other, and a free-text fill has no fence
 *   at all. Declined, whatever the fill looked like.
 *
 * Pure: the sheet, the blocks and the fences in, a room or null per block out,
 * in the order the blocks came.
 */

/** The fields of a block this reads — a `BlockDraft` has them all. */
export interface Measured {
  kind: string
  cx: number
  cy: number
  w: number
  h: number
  angle?: number
  skewX?: number
  skewY?: number
  quad?: number[] | null
  /** Kept out of the page — see `skipped`. */
  hidden?: boolean
}

/**
 * Whether a block is not lettering at all as far as rooms go: hidden, or filed
 * as rubbish. Such a block is neither measured nor counted — a hidden duplicate
 * of a line in the same balloon made the visible one "share" its balloon and
 * lose its room, and a hidden or rubbish box stood in as lettering a room could
 * not cover.
 */
const skipped = (block: Measured) => Boolean(block.hidden) || block.kind === 'garbage'

/**
 * The balloons the detector drew, once each.
 *
 * Every text region carries the balloon it was paired with (`DetectedText.bubble`),
 * so a balloon holding two regions arrives twice; it is one fence, and it must
 * be counted as one for "one block to a balloon" to mean anything.
 */
export function fencesOf (regions: DetectedText[]): Region[] {
  const seen = new Map<string, Region>()

  for (const region of regions) {
    const fence = region.bubble

    if (fence) seen.set(`${fence.x},${fence.y},${fence.w},${fence.h}`, fence)
  }

  return [...seen.values()]
}

/**
 * Which balloon holds a point — the index of the smallest fence it is inside, or
 * -1. The smallest, because balloons touch and their boxes overlap, and the one
 * that holds the lettering is the tighter. Shared by the rooms and by the join
 * (`balloonJudge`), so the two cannot disagree about which balloon a block is in.
 */
export function fenceAround (x: number, y: number, fences: Region[]): number {
  let best = -1

  for (const [index, fence] of fences.entries()) {
    if (x < fence.x || x > fence.x + fence.w || y < fence.y || y > fence.y + fence.h) continue
    if (best < 0 || fence.w * fence.h < fences[best]!.w * fences[best]!.h) best = index
  }

  return best
}

/** Why a block has the room it has, or has none — each of the header's rules by name. */
export type RoomReason =
  | 'room'
  | 'found'
  | 'clear'
  | 'skipped'
  | 'crowded'
  | 'not-balloon'
  | 'tilted'
  | 'no-fence'
  | 'shared'
  | 'no-paper'
  | 'escaped'
  | 'smaller'

/**
 * How far an unfenced fill around free text may reach, as a share of the block
 * on each side — wider than `balloonIn`'s own guess, because the balloons it is
 * for are black shapes several times the lettering's size, and a window that
 * stops short of their edge reads as a leak however closed the shape is.
 *
 * A known miss, and not one a wider window fixes: ECLIPSE p10's `和我做愛！`,
 * a black circle with a tail and a head drawn over it. Its fill holds — no side
 * reached, 18% of the window — but at 0.61 solid it is indistinguishable from
 * the fills recorded escaping into a panel's pale ground (0–1 sides, 11–25%,
 * 0.45–0.68; `balloon.test.ts`). Reaching off the longer side instead was
 * tried: it did not find that circle and lost a narration box it had found.
 */
const FREE_REACH = 3

/**
 * How dark a free-text fill must be, as mean luminance nought to 255, to be
 * taken for a balloon the detector did not draw.
 *
 * The detector's blind spot is specifically light lettering on a dark shape —
 * it files it as free text and draws no balloon. On light paper the absence of
 * a detected balloon is evidence there is none, and a closed light area round
 * free text is usually the panel itself: istani p2's `嗯…`, loose in a panel's
 * corner, filled the corner and would have been lettered at nearly six times
 * its size. Black and near-black balloons sit far below this; paper, however
 * toned, well above.
 */
const DARK = 96

/** Whether a fill is dark — its mean luminance, sampled over its interior. */
function dark (sheet: Sheet, balloon: Balloon): boolean {
  const { window: win, mask } = balloon
  let total = 0
  let count = 0

  for (let y = 0; y < win.h; y += 2) {
    for (let x = 0; x < win.w; x += 2) {
      if (!mask[y * win.w + x]) continue

      const at = ((win.y + y) * sheet.w + win.x + x) * 4

      total += 0.299 * sheet.data[at]! + 0.587 * sheet.data[at + 1]! + 0.114 * sheet.data[at + 2]!
      count++
    }
  }

  return count > 0 && total / count < DARK
}

/**
 * How far clear paper may add to each side of a borderless block, as a share of
 * the block's *longer* side — on a vertical Japanese column, whose width is a
 * character and whose height is the sentence, the height is what says how much
 * room a translation of it needs.
 */
const CLEAR_REACH = 0.75

/** How much more room than the block clear paper must give to be worth taking. */
const CLEAR_GAIN = 1.1

/**
 * The share of the lettering's height each clear-paper try keeps — the last is
 * the least of the column a room may stand on. Art that crowds a column usually
 * crowds one end of it (page-010's curve across the bottom of
 * `今そっちにお客が行ったよ`), so each shorter band is tried at the top, middle
 * and bottom of the column, not only its middle.
 */
const CLEAR_BANDS = [1, 0.85, 0.7, 0.6] as const

/** Of another block's box, how much a room may cover before it is crowding it. */
const CROWDING = 0.25

/**
 * Desktop: below this `solidity` a balloon is round enough to be lettered as
 * an oval (`ovalIn`). An ellipse fills 0.79 of its bounding box; a caption
 * box, a rectangle with the corners barely rounded, 0.95 and over — and its
 * largest rectangle is already the whole of it.
 */
const ROUNDISH = 0.93

/** How much of an oval's frame its lines can actually use — the ellipse's own share of it. */
const OVAL_SHARE = Math.PI / 4

/** One block's measurement, in full — what the OCR lab draws, and `roomsFor` keeps the room of. */
export interface RoomVerdict {
  room: RoomBox | null
  reason: RoomReason
  /** The balloon the detector drew around the block, in page pixels, where there was one. */
  fence?: Region
  /** What the fill found, where one ran — in the sheet's own pixels, like `balloonIn`'s. */
  balloon?: Balloon
  /** The room against the block, by area — see `roomGain`. Where a fill ran. */
  gain?: number
  /**
   * Desktop: the largest rectangle, where `room` is the balloon's oval — what a
   * round room falls back to when the oval would crowd a neighbour.
   */
  square?: RoomBox
}

/**
 * Each block's verdict: its room, or the rule that declined it — see the header.
 *
 * `fences` are in the page's own pixels, as the detector gives them; `pageWidth`
 * is the scan's width in those pixels, which is also what every block's
 * coordinates are normalised by, so one number converts both.
 *
 * The reasons and the fill come back as well as the room because the OCR lab
 * draws them: a bench that showed only the rooms kept would hide exactly the
 * balloons worth looking at, the leaks and the near misses.
 */
export function roomVerdicts (sheet: Sheet, blocks: Measured[], fences: Region[], pageWidth: number): RoomVerdict[] {
  // The sheet is the page at a fixed width, so one scale serves both axes.
  const scale = pageWidth ? sheet.w / pageWidth : 0

  const fenceOf = blocks.map((block) => {
    if (block.kind !== 'bubble' || skipped(block) || !pageWidth) return -1
    if (block.angle || block.skewX || block.skewY || block.quad?.some((v) => v !== 0)) return -1

    return fenceAround(block.cx * pageWidth, block.cy * pageWidth, fences)
  })

  const shared = new Set(fenceOf.filter((fence, at) => fence >= 0 && fenceOf.indexOf(fence) !== at))

  const seedOf = (block: Measured) => ({
    x: (block.cx - block.w / 2) * pageWidth * scale,
    y: (block.cy - block.h / 2) * pageWidth * scale,
    w: block.w * pageWidth * scale,
    h: block.h * pageWidth * scale,
  })

  // Back to the block's own space: normalised by the page's width, which is
  // the sheet's width, on both axes.
  const boxOf = (room: Room): RoomBox => ({
    cx: (room.x + room.w / 2) / sheet.w,
    cy: (room.y + room.h / 2) / sheet.w,
    w: room.w / sheet.w,
    h: room.h / sheet.w,
  })

  const roomOf = (balloon: Balloon): RoomBox => boxOf(balloon.room)

  /*
   * Desktop: the room a balloon gives, and what it gains on the block — the
   * oval where the balloon is round and its oval holds at least what the
   * largest rectangle does (by the area the lines can use), the rectangle
   * otherwise. See `ovalIn`.
   */
  const bestOf = (balloon: Balloon, seed: Room): { room: RoomBox, gain: number, square?: RoomBox } => {
    const oval = balloon.oval
    const usable = oval ? oval.w * oval.h * OVAL_SHARE : 0

    if (oval && balloon.solidity < ROUNDISH && usable >= balloon.room.w * balloon.room.h) {
      return {
        room: { ...boxOf(oval), round: true },
        gain: roomGain({ ...oval, w: oval.w, h: oval.h * OVAL_SHARE }, seed),
        square: roomOf(balloon),
      }
    }

    return { room: roomOf(balloon), gain: roomGain(balloon.room, seed) }
  }

  // The last resort for a block with no balloon — see `clearAround`. Tried on
  // bands of the lettering at several heights, at its top, middle and bottom,
  // spreading sideways first, and the widest room wins: a vertical column's translation is set across,
  // and art that crowds one end of the column should cost the room its height
  // there rather than its width everywhere. Never under `CLEAR_KEEP` of the
  // column's height, and always worth `CLEAR_GAIN` against the block itself.
  const clearOf = (block: Measured): RoomVerdict | null => {
    const seed = seedOf(block)
    const reach = Math.round(Math.max(seed.w, seed.h) * CLEAR_REACH)
    let best: { room: Room, gain: number } | null = null

    for (const keep of CLEAR_BANDS) {
      // A full-height band has one place to be; a shorter one has three.
      for (const along of keep === 1 ? [0] : [0, 0.5, 1]) {
        const band = { x: seed.x, y: seed.y + seed.h * (1 - keep) * along, w: seed.w, h: seed.h * keep }
        const room = clearAround(sheet, band, reach, true)

        if (!room) continue

        const gain = roomGain(room, seed)

        if (gain < CLEAR_GAIN) continue
        if (!best || room.w > best.room.w || (room.w === best.room.w && gain > best.gain)) best = { room, gain }
      }
    }

    if (!best) return null

    const { room, gain } = best

    return {
      room: { cx: (room.x + room.w / 2) / sheet.w, cy: (room.y + room.h / 2) / sheet.w, w: room.w / sheet.w, h: room.h / sheet.w },
      reason: 'clear',
      gain,
    }
  }

  /*
   * One unfenced fill, for the black balloons the detector does not draw — see
   * the header. Anything but a closed dark shape is declined, and the caller
   * falls through to clear paper.
   */
  const darkOf = (block: Measured): RoomVerdict | null => {
    const seed = seedOf(block)
    const balloon = balloonIn(sheet, seed, null, FREE_REACH)

    if (!balloon || balloon.escaped || !dark(sheet, balloon)) return null

    const { room, gain, square } = bestOf(balloon, seed)

    return gain < 1 ? null : { room, reason: 'found', balloon, gain, ...(square ? { square } : {}) }
  }

  const verdicts = blocks.map((block, at): RoomVerdict => {
    if (skipped(block)) return { room: null, reason: 'skipped' }

    const turned = Boolean(block.angle || block.skewX || block.skewY || block.quad?.some((v) => v !== 0))

    if (block.kind !== 'bubble') {
      // Free text: the dark-balloon try, then clear paper. Anything else is
      // declined as lettering on art, as it always was.
      if (block.kind !== 'sfx' || turned || !pageWidth) return { room: null, reason: 'not-balloon' }

      return darkOf(block) ?? clearOf(block) ?? { room: null, reason: 'not-balloon' }
    }

    if (turned) return { room: null, reason: 'tilted' }

    const index = fenceOf[at]!

    // Balloon text with no balloon drawn round it gets the dark try as well.
    // White-on-black speech used to arrive filed as free text and was caught
    // by the branch above; `speechLike` now files a sentence as balloon text
    // whatever the detector said, and without this it would land here and
    // lose the one rule that finds its balloon.
    if (index < 0) return (pageWidth ? darkOf(block) : null) ?? clearOf(block) ?? { room: null, reason: 'no-fence' }

    const fence = fences[index]!

    if (shared.has(index)) return { room: null, reason: 'shared', fence }

    const seed = seedOf(block)
    const balloon = balloonIn(sheet, seed, {
      x: fence.x * scale,
      y: fence.y * scale,
      w: fence.w * scale,
      h: fence.h * scale,
    })

    if (!balloon) return { room: null, reason: 'no-paper', fence }

    const { room, gain, square } = bestOf(balloon, seed)

    if (balloon.escaped) return { room: null, reason: 'escaped', fence, balloon, gain }
    if (gain < 1) return { room: null, reason: 'smaller', fence, balloon, gain }

    return { room, reason: 'room', fence, balloon, gain, ...(square ? { square } : {}) }
  })

  // Last, over every room at once: none may cover another block's lettering.
  return verdicts.map((verdict, at) => {
    const crowds = (room: RoomBox) => blocks.some((other, index) => {
      if (index === at || skipped(other)) return false

      const across = Math.min(room.cx + room.w / 2, other.cx + other.w / 2) - Math.max(room.cx - room.w / 2, other.cx - other.w / 2)
      const down = Math.min(room.cy + room.h / 2, other.cy + other.h / 2) - Math.max(room.cy - room.h / 2, other.cy - other.h / 2)

      return across > 0 && down > 0 && across * down > CROWDING * other.w * other.h
    })

    const room = verdict.room

    if (!room || !crowds(room)) return verdict

    // Desktop: an oval that crowds a neighbour gives way to the rectangle, which
    // is smaller, before the balloon gives up its room altogether.
    if (verdict.square && !crowds(verdict.square)) {
      const { square: _rectangle, ...rest } = verdict

      return { ...rest, room: verdict.square }
    }

    return { ...verdict, room: null, reason: 'crowded' as const }
  })
}

/** Each block's room, or null where it gets none — `roomVerdicts`, the rooms only. */
export function roomsFor (sheet: Sheet, blocks: Measured[], fences: Region[], pageWidth: number): (RoomBox | null)[] {
  return roomVerdicts(sheet, blocks, fences, pageWidth).map((verdict) => verdict.room)
}
