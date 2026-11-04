/**
 * Several lines in one balloon — desktop.
 *
 * A balloon that holds two or three separate utterances (a shout, then a
 * mutter; three sentences of one accusation set as staggered groups of columns)
 * is read as that many blocks, each with its own narrow room round its own
 * Japanese columns. Those rooms touch or overlap — `rooms.ts` declines to give
 * two blocks one balloon, so what they get is clear paper, measured block by
 * block — and English, wider than the columns it replaces, ran across into its
 * neighbour: "MOMENTARE PLOTTING", "TAKE QUIET." (2026-10-23, a real page). Each
 * also filled its own room, so one voice came out at 14, 17 and 14 px.
 *
 * A letterer shares the balloon out instead, and this does it two ways:
 *
 * - **A balloon measured whole** (`room.shared`, from `sharedRooms` in
 *   `ocr/rooms.ts`): one room inside the fill for all its lines, set as bands
 *   of it in the order they read, top to bottom, each as tall as its share of
 *   the words (with a floor, so "Quiet." is not a sliver), a gap between.
 * - **Otherwise**, rooms that overlap: each line kept in its own room — measured
 *   round its own original, inside the balloon where the original sat — and cut
 *   back from the others where they overlapped (`trimmed`). Bands of the
 *   rectangle round separate rooms were tried first and covered a jagged
 *   balloon's points and notches: words ran onto the speed lines and off a
 *   slanted edge, and "Why...!?" was jammed into the balloon's tip (2026-10-23).
 *
 * **Derived, never stored.** A band is not a frame anybody dragged (`letter`),
 * so it is worked out from the rooms each time they change and read through
 * `letterBoxOf` — the board, the fit, the panel and export all see the same one,
 * and a frame somebody does drag on a block wins over its band. Nothing in the
 * cleaning path reads it, as nothing there reads `letterBoxOf`.
 *
 * **One size for the balloon.** Each band is fitted to itself first, and then
 * every line in the group is set at the smallest of those (`useLetteringFit`,
 * `groupOf`): one voice in one balloon is one size, where filling each band gave
 * "Why...!?" 32 px over "What on earth have I done!?" at 23 (2026-10-23).
 *
 * Only translated dialogue and captions with a room and no frame of their own:
 * a block still showing its reading is set where it was read, and a sound effect
 * is drawn where it is drawn.
 */
import type { Block, PageBox } from '~/composables/useComic'

/** Rooms overlapping by under this share of the smaller one are neighbours, not one balloon. */
const OVERLAP = 0.04

/** The gap between two bands, as a share of the shared area's height. */
const GAP = 0.04

/**
 * The inset for a balloon measured whole (`room.shared`, `sharedRooms` in
 * `ocr/rooms.ts`): its room is already the largest rectangle inside the fill,
 * held off the outline, so it needs only a hair.
 */
const SHARED_INSET = 0.02

/** The least share of the shared area a band gets, however short its line. */
const FLOOR = 0.2

const area = (box: PageBox) => box.w * box.h

function overlap (a: PageBox, b: PageBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)

  return w > 0 && h > 0 ? w * h : 0
}

/** Whether a block takes part: translated dialogue or caption, shown, with a room and no frame of its own. */
const banded = (block: Block) =>
  !block.hidden && !block.letter && Boolean(block.room) && Boolean(block.translation.trim())
  && (block.type === 'bubble' || block.type === 'caption')

/** A band, and which group of lines shares its balloon — the first member's id. */
export type Band = PageBox & { group: string }

/**
 * Rooms overlapping, each kept where it is and cut back from the other along the
 * narrower overlap — the middle of it, less a hair either side. Each line stays
 * in the room measured round its own original, which sits inside the balloon
 * where the original did; only the strip they both claimed is shared out.
 */
function trimmed (rooms: PageBox[]): PageBox[] {
  const out = rooms.map((room) => ({ ...room }))

  for (let a = 0; a < out.length; a++) {
    for (let b = a + 1; b < out.length; b++) {
      const one = out[a]!
      const other = out[b]!
      const across = Math.min(one.x + one.w, other.x + other.w) - Math.max(one.x, other.x)
      const down = Math.min(one.y + one.h, other.y + other.h) - Math.max(one.y, other.y)

      if (across <= 0 || down <= 0) continue

      if (across <= down) {
        const cut = Math.max(one.x, other.x) + across / 2
        const [left, right] = one.x + one.w / 2 <= other.x + other.w / 2 ? [one, other] : [other, one]
        const hair = across * GAP

        left.w = cut - hair - left.x
        right.w = right.x + right.w - (cut + hair)
        right.x = cut + hair
      } else {
        const cut = Math.max(one.y, other.y) + down / 2
        const [upper, lower] = one.y + one.h / 2 <= other.y + other.h / 2 ? [one, other] : [other, one]
        const hair = down * GAP

        upper.h = cut - hair - upper.y
        lower.h = lower.y + lower.h - (cut + hair)
        lower.y = cut + hair
      }
    }
  }

  return out
}

/**
 * The frames of a page's lines that share a balloon, by block id — pure.
 * Blocks whose rooms overlap are grouped (transitively). A group whose balloon
 * was measured whole (`room.shared`) is set in bands of that room, in the order
 * the blocks are listed, which is the reading order; any other group keeps each
 * line in its own room, cut back from the others where they overlapped
 * (`trimmed`) — a rectangle round separate rooms covers a jagged balloon's
 * points and notches, and words set there ran onto the art (2026-10-23).
 */

export function bandsFor (blocks: readonly Block[]): Map<string, Band> {
  const taking = blocks.filter(banded)
  const group = taking.map((_, index) => index)
  const root = (index: number): number => (group[index] === index ? index : (group[index] = root(group[index]!)))

  for (let a = 0; a < taking.length; a++) {
    for (let b = a + 1; b < taking.length; b++) {
      const one = taking[a]!.room!
      const other = taking[b]!.room!

      if (overlap(one, other) > Math.min(area(one), area(other)) * OVERLAP) group[root(b)] = root(a)
    }
  }

  const groups = new Map<number, Block[]>()

  taking.forEach((block, index) => {
    const at = root(index)

    groups.set(at, [...(groups.get(at) ?? []), block])
  })

  const bands = new Map<string, Band>()

  for (const members of groups.values()) {
    if (members.length < 2) continue

    if (!members.every((block) => block.room!.shared)) {
      trimmed(members.map((block) => block.room!)).forEach((room, index) => {
        bands.set(members[index]!.id, { ...room, group: members[0]!.id })
      })

      continue
    }

    const outerLeft = Math.min(...members.map((block) => block.room!.x))
    const outerTop = Math.min(...members.map((block) => block.room!.y))
    const outerRight = Math.max(...members.map((block) => block.room!.x + block.room!.w))
    const outerBottom = Math.max(...members.map((block) => block.room!.y + block.room!.h))
    const inset = SHARED_INSET
    const inX = (outerRight - outerLeft) * inset
    const inY = (outerBottom - outerTop) * inset
    const [left, top, right, bottom] = [outerLeft + inX, outerTop + inY, outerRight - inX, outerBottom - inY]

    const height = bottom - top
    const gaps = height * GAP * (members.length - 1)
    const words = members.map((block) => Math.max(1, [...block.translation.trim()].length))
    const total = words.reduce((sum, one) => sum + one, 0)
    // Each band's share: its words', raised to the floor, the rest scaled to fit.
    const raw = words.map((one) => Math.max(FLOOR, one / total))
    const scale = 1 / raw.reduce((sum, one) => sum + one, 0)

    let y = top

    members.forEach((block, index) => {
      const h = (height - gaps) * raw[index]! * scale

      bands.set(block.id, { x: left, y, w: right - left, h, group: members[0]!.id })
      y += h + height * GAP
    })
  }

  return bands
}

/*
 * The bands of every page, read by `letterBoxOf` with no page to hand. Kept by
 * block id, and a version that moves whenever they change, read with them so a
 * render or a fit that asked is asked again.
 */
const current = new Map<string, Band>()
const version = ref(0)

/** A block's band, if it shares a balloon — see the header. */
export function bandOf (block: Pick<Block, 'id'>): PageBox | undefined {
  // Read, so whatever asks depends on the bands.
  const _seen = version.value
  const band = current.get(block.id)

  // The box alone: a band is handed on as a frame, and a frame carries nothing else.
  return band && { x: band.x, y: band.y, w: band.w, h: band.h }
}

/** Which group of lines a block shares its balloon with, if any — see "One size for the balloon". */
export function groupOf (block: Pick<Block, 'id'>): string | undefined {
  const _seen = version.value

  return current.get(block.id)?.group
}

/** Lay out one page's bands, taking down the ones it no longer has. */
export function layBands (blocks: readonly Block[]): void {
  const next = bandsFor(blocks)
  let moved = false

  for (const block of blocks) {
    const was = current.get(block.id)
    const now = next.get(block.id)

    if (now && (!was || was.x !== now.x || was.y !== now.y || was.w !== now.w || was.h !== now.h || was.group !== now.group)) {
      current.set(block.id, now)
      moved = true
    } else if (!now && was) {
      current.delete(block.id)
      moved = true
    }
  }

  if (moved) version.value++
}
