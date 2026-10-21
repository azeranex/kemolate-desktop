import { describe, expect, it } from 'vitest'

import type { Measured } from '~/utils/ocr/rooms'
import type { Sheet } from '~/utils/paper'

import { fencesOf, roomsFor, roomVerdicts } from '~/utils/ocr/rooms'

/**
 * Which blocks are given a balloon's room, and in which space it comes back.
 *
 * The measuring is `balloonIn`'s and has its own tests; these are the rules
 * `roomsFor` lays over it, each a way of declining rather than guessing, on a
 * hand-built page for the reason `balloon.test.ts` gives — the function is pure.
 *
 * The page is 400 pixels wide and so is the sheet, so the scale between them is
 * one and a block at `cx: 0.5` sits at pixel 200. Positions are width-normalised
 * on both axes, as a block's are.
 */

function page (w: number, h: number): Sheet {
  return { data: new Uint8ClampedArray(w * h * 4).fill(255), w, h }
}

function ink (sheet: Sheet, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * sheet.w + x) * 4

      sheet.data[at] = 0
      sheet.data[at + 1] = 0
      sheet.data[at + 2] = 0
    }
  }
}

/** A closed square balloon, three pixels thick, with a narrow column of lettering in its middle. */
function balloonPage () {
  const sheet = page(400, 400)

  ink(sheet, 137, 137, 263, 140)
  ink(sheet, 137, 260, 263, 263)
  ink(sheet, 137, 137, 140, 263)
  ink(sheet, 260, 137, 263, 263)

  // One column of Japanese, as the reading found it: twenty wide, eighty tall.
  for (let y = 162; y < 238; y += 10) ink(sheet, 193, y, 207, y + 7)

  return sheet
}

const W = 400
const px = (v: number) => v / W

/** The column the reading found, as a block. */
const column: Measured = { kind: 'bubble', cx: px(200), cy: px(200), w: px(20), h: px(80) }

/** The balloon the detector drew around it, in page pixels. */
const fence = { x: 135, y: 135, w: 130, h: 130 }

describe('roomsFor', () => {
  it('gives a column of lettering the room inside its balloon', () => {
    const [room] = roomsFor(balloonPage(), [column], [fence], W)

    expect(room).not.toBeNull()

    // Wider and taller than the column it started from…
    expect(room!.w).toBeGreaterThan(column.w * 3)
    expect(room!.h).toBeGreaterThanOrEqual(column.h)

    // …and inside the outline, in the block's own width-normalised space.
    expect(room!.cx - room!.w / 2).toBeGreaterThanOrEqual(px(140))
    expect(room!.cx + room!.w / 2).toBeLessThanOrEqual(px(260))
    expect(room!.cy - room!.h / 2).toBeGreaterThanOrEqual(px(140))
    expect(room!.cy + room!.h / 2).toBeLessThanOrEqual(px(260))
  })

  it('gives free text on open paper the clear paper round it, capped', () => {
    // No outline to stop a fill, so no balloon — but borderless lettering set on
    // a panel's white ground has the paper round it, pushed out to `CLEAR_REACH`
    // (three quarters of the block's longer side) and no further.
    const open = page(400, 400)

    for (let y = 162; y < 238; y += 10) ink(open, 193, y, 207, y + 7)

    const [verdict] = roomVerdicts(open, [{ ...column, kind: 'sfx' }], [], W)

    expect(verdict!.reason).toBe('clear')
    expect(verdict!.room!.w).toBeGreaterThan(column.w * 3)
    expect(verdict!.room!.w).toBeLessThanOrEqual(column.w + 2 * column.h * 0.75)
  })

  it('trades a column\'s height for width where art crowds one end of it', () => {
    // page-010's `今そっちにお客が行ったよ`: clear to the right in the column's
    // upper half, a curve of artwork across its lower half. Full height, the
    // curve stops the room from widening at all; a band of the column is free
    // to, and a vertical line's translation is set across.
    const sheet = page(400, 400)

    for (let y = 162; y < 238; y += 10) ink(sheet, 193, y, 207, y + 7)
    ink(sheet, 212, 215, 300, 300)

    const [verdict] = roomVerdicts(sheet, [{ ...column, kind: 'sfx' }], [], W)
    const room = verdict!.room!

    expect(verdict!.reason).toBe('clear')
    expect(room.cx + room.w / 2).toBeGreaterThan(px(260))
    expect(room.h).toBeGreaterThanOrEqual(column.h * 0.6 - px(4))
    expect(room.cy + room.h / 2).toBeLessThanOrEqual(px(215))
  })

  it('stops clear paper at ink, screentone included', () => {
    // A tone panel beside the lettering: the room grows away from it, not into it.
    const sheet = page(400, 400)

    for (let y = 162; y < 238; y += 10) ink(sheet, 193, y, 207, y + 7)
    for (let y = 100; y < 300; y += 3) for (let x = 230; x < 330; x += 3) ink(sheet, x, y, x + 1, y + 1)

    const [verdict] = roomVerdicts(sheet, [{ ...column, kind: 'sfx' }], [], W)

    expect(verdict!.reason).toBe('clear')
    expect(verdict!.room!.cx + verdict!.room!.w / 2).toBeLessThanOrEqual(px(230))
  })

  it('finds a black balloon round free text the detector did not draw', () => {
    // White lettering on a black balloon is filed as free text and given no
    // fence (ECLIPSE p10, p11); a closed dark shape still holds a fill of its own.
    const sheet = page(400, 400)

    ink(sheet, 137, 137, 263, 263)

    for (let y = 162; y < 238; y += 10) {
      for (let row = y; row < y + 7; row++) {
        for (let x = 193; x < 207; x++) {
          const at = (row * sheet.w + x) * 4

          sheet.data[at] = 255
          sheet.data[at + 1] = 255
          sheet.data[at + 2] = 255
        }
      }
    }

    const [verdict] = roomVerdicts(sheet, [{ ...column, kind: 'sfx' }], [], W)

    expect(verdict!.reason).toBe('found')
    expect(verdict!.room!.w).toBeGreaterThan(column.w * 3)
  })

  it('takes a closed light area round free text as clear paper, not as a balloon', () => {
    // The panel's own empty corner (istani p2, `嗯…`): closed and solid, and not
    // a balloon — on light paper the detector would have drawn one — so it is
    // not `found`, and the fill's 5.8× is not what it gets. It is borderless
    // lettering, and what it gets is the clear paper round it, capped.
    const [verdict] = roomVerdicts(balloonPage(), [{ ...column, kind: 'sfx' }], [], W)

    expect(verdict!.reason).toBe('clear')
    expect(verdict!.room!.w).toBeLessThanOrEqual(column.w + 2 * column.h * 0.75)
  })

  it('does not let a hidden duplicate cost the visible block its balloon', () => {
    // A block hidden rather than deleted — a duplicate reading of the same
    // line — used to make the visible one "share" its balloon and lose its room.
    const [visible, hidden] = roomVerdicts(balloonPage(), [column, { ...column, hidden: true }], [fence], W)

    expect(visible!.reason).toBe('room')
    expect(hidden!.reason).toBe('skipped')
    expect(hidden!.room).toBeNull()
  })

  it('does not count hidden or rubbish boxes as lettering a room must not cover', () => {
    const beside = { kind: 'sfx', cx: px(160), cy: px(200), w: px(14), h: px(40) }

    for (const other of [{ ...beside, hidden: true }, { ...beside, kind: 'garbage' }]) {
      expect(roomVerdicts(balloonPage(), [column, other], [fence], W)[0]!.reason).toBe('room')
    }
  })

  it('declines a room that would cover another block\'s lettering', () => {
    // A second run of text in the same balloon, filed as free text so the
    // one-block-to-a-balloon rule does not see it: the column's room would be
    // lettered over it.
    const beside = { kind: 'sfx', cx: px(160), cy: px(200), w: px(14), h: px(40) }
    const [verdict] = roomVerdicts(balloonPage(), [column, beside], [fence], W)

    expect(verdict!.reason).toBe('crowded')
    expect(verdict!.room).toBeNull()
  })

  it('declines a tilted block, whose balloon an upright room does not fit', () => {
    expect(roomsFor(balloonPage(), [{ ...column, angle: 21 }], [fence], W)).toEqual([null])
    expect(roomsFor(balloonPage(), [{ ...column, skewX: 5 }], [fence], W)).toEqual([null])
  })

  it('falls back to clear paper where the detector drew no balloon around the block', () => {
    // No fence, so no balloon fill: what is measured is the clear paper, which
    // on this page stops at the outline the detector did not draw.
    for (const fences of [[], [{ x: 300, y: 300, w: 60, h: 60 }]]) {
      const [verdict] = roomVerdicts(balloonPage(), [column], fences, W)

      expect(verdict!.reason).toBe('clear')
      expect(verdict!.room!.cx - verdict!.room!.w / 2).toBeGreaterThanOrEqual(px(140))
      expect(verdict!.room!.cx + verdict!.room!.w / 2).toBeLessThanOrEqual(px(260))
    }
  })

  it('declines both blocks when two share one balloon', () => {
    // Two translations handed the same room would be lettered over each other.
    const left = { ...column, cx: px(180) }
    const right = { ...column, cx: px(220) }

    expect(roomsFor(balloonPage(), [left, right], [fence], W)).toEqual([null, null])
  })

  it('still measures a block alone in its balloon beside a pair that share one', () => {
    const other = { x: 300, y: 300, w: 60, h: 60 }
    const inOther = { kind: 'bubble', cx: px(330), cy: px(330), w: px(10), h: px(10) }
    const [room, ...rest] = roomsFor(balloonPage(), [column, inOther, { ...inOther, cx: px(335) }], [fence, other], W)

    expect(room).not.toBeNull()
    expect(rest).toEqual([null, null])
  })
})

describe('fencesOf', () => {
  it('counts a balloon holding two regions once', () => {
    const regions = [
      { x: 150, y: 150, w: 20, h: 80, label: 'text_bubble' as const, score: 0.9, bubble: fence },
      { x: 220, y: 150, w: 20, h: 80, label: 'text_bubble' as const, score: 0.9, bubble: { ...fence } },
      { x: 10, y: 10, w: 20, h: 20, label: 'text_free' as const, score: 0.9 },
    ]

    expect(fencesOf(regions)).toEqual([fence])
  })
})
