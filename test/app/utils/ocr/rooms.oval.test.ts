import { describe, expect, it } from 'vitest'

import type { Measured } from '~/utils/ocr/rooms'
import type { Sheet } from '~/utils/paper'

import { shapeFor } from '#shared/utils/lettering'
import { ovalIn } from '~/utils/ocr/balloon'
import { roomVerdicts } from '~/utils/ocr/rooms'

/**
 * Desktop: a round balloon's room is its own oval, not the largest rectangle
 * inside it — so a horizontal translation of a tall Japanese column is not held
 * to a strip barely wider than the column (found 2026-10-22: "bubble is big but
 * text is really small").
 *
 * On a hand-built page, as `rooms.test.ts` builds its own: 400 pixels wide, the
 * sheet the same, so a block at `cx: 0.5` sits at pixel 200.
 */

const W = 400
const px = (v: number) => v / W

function page (w: number, h: number): Sheet {
  return { data: new Uint8ClampedArray(w * h * 4).fill(255), w, h }
}

function dot (sheet: Sheet, x: number, y: number) {
  if (x < 0 || y < 0 || x >= sheet.w || y >= sheet.h) return

  const at = (y * sheet.w + x) * 4

  sheet.data[at] = 0
  sheet.data[at + 1] = 0
  sheet.data[at + 2] = 0
}

/** An ellipse's outline, three pixels thick, centred at (cx, cy) with radii rx, ry. */
function ellipse (sheet: Sheet, cx: number, cy: number, rx: number, ry: number) {
  for (let y = 0; y < sheet.h; y++) {
    for (let x = 0; x < sheet.w; x++) {
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry)

      if (Math.abs(r - 1) * Math.min(rx, ry) < 1.5) dot(sheet, x, y)
    }
  }
}

/** A column of Japanese down the middle: twenty wide, a hundred and twenty tall. */
function column (sheet: Sheet) {
  for (let y = 140; y < 260; y += 10) {
    for (let yy = y; yy < y + 7; yy++) for (let x = 190; x < 210; x++) dot(sheet, x, yy)
  }
}

const block: Measured = { kind: 'bubble', cx: px(200), cy: px(200), w: px(30), h: px(130) }

/** A tall oval balloon, 160 wide and 260 tall, round a column of lettering. */
function tallBalloon () {
  const sheet = page(400, 400)

  ellipse(sheet, 200, 200, 80, 130)
  column(sheet)

  return { sheet, fence: { x: 118, y: 68, w: 164, h: 264 } }
}

describe('a round balloon\'s room', () => {
  it('is the balloon\'s oval, wider than the largest rectangle in it', () => {
    const { sheet, fence } = tallBalloon()
    const [verdict] = roomVerdicts(sheet, [block], [fence], W)

    expect(verdict!.reason).toBe('room')
    expect(verdict!.room).toMatchObject({ round: true })
    // The rectangle it would have been, kept for when the oval crowds a neighbour.
    expect(verdict!.square).toBeDefined()
    expect(verdict!.room!.w).toBeGreaterThan(verdict!.square!.w * 1.2)

    // Inside the outline, and centred on the balloon.
    expect(verdict!.room!.cx).toBeCloseTo(px(200), 2)
    expect(verdict!.room!.cy).toBeCloseTo(px(200), 2)
    expect(verdict!.room!.w).toBeLessThan(px(160))
    expect(verdict!.room!.h).toBeLessThan(px(260))
  })

  it('is lettered as an oval, unless somebody chose a shape or moved the frame', () => {
    const line = { type: 'bubble', translation: 'For now, I\'ll show you around the neighborhood...' }

    expect(shapeFor({ shape: null, points: null }, { ...line, room: { round: true } })).toBe('oval')
    expect(shapeFor({ shape: 'box', points: null }, { ...line, room: { round: true } })).toBe('box')
    expect(shapeFor({ shape: null, points: null }, { ...line, room: { round: true }, letter: { x: 1, y: 1, w: 1, h: 1 } })).toBe('soft')
    expect(shapeFor({ shape: null, points: null }, { ...line, room: {} })).toBe('soft')
  })

  it('stays a rectangle in a box-shaped balloon', () => {
    const sheet = page(400, 400)

    for (let x = 120; x < 280; x++) for (const y of [70, 71, 72, 328, 329, 330]) dot(sheet, x, y)
    for (let y = 70; y < 331; y++) for (const x of [120, 121, 122, 277, 278, 279]) dot(sheet, x, y)
    column(sheet)

    const [verdict] = roomVerdicts(sheet, [block], [{ x: 118, y: 68, w: 164, h: 264 }], W)

    expect(verdict!.reason).toBe('room')
    expect(verdict!.room!.round).toBeUndefined()
  })

  it('gives way to the rectangle where the oval would cover a neighbour', () => {
    const { sheet, fence } = tallBalloon()
    // Inside the oval's frame (x 130–270 here) and clear of the rectangle's (149–252).
    const neighbour: Measured = { kind: 'bubble', cx: px(139), cy: px(200), w: px(14), h: px(40) }
    const [alone] = roomVerdicts(sheet, [block], [fence], W)
    const [beside] = roomVerdicts(sheet, [block, neighbour], [fence, { x: 130, y: 178, w: 18, h: 44 }], W)

    // Not handed nothing: the smaller, square room it would have had before.
    expect(beside!.reason).toBe('room')
    expect(beside!.room).toEqual(alone!.square)
  })
})

describe('ovalIn', () => {
  /** A filled interior, as `balloonIn` hands it over. */
  function mask (w: number, h: number, inside: (x: number, y: number) => boolean) {
    const out = new Uint8Array(w * h)

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = inside(x, y) ? 1 : 0

    return out
  }

  it('is not dragged off the balloon by its tail', () => {
    // An oval 100 by 160 at (60, 90), with a tail running off the bottom right.
    const inside = (x: number, y: number) =>
      Math.hypot((x - 60) / 50, (y - 90) / 80) <= 1 || (x > 80 && x < 95 && y > 150 && y < 200 && x - 80 > (y - 150) * 0.2)
    const oval = ovalIn(mask(120, 200, inside), 120, 200)!

    expect(oval.x + oval.w / 2).toBeCloseTo(60, -1)
    expect(oval.y + oval.h / 2).toBeCloseTo(90, -1)
    expect(oval.h).toBeLessThan(160)
  })

  it('never crosses the outline of a balloon that is not an ellipse', () => {
    // A diamond: its bounding box's ellipse would run out past every side.
    const inside = (x: number, y: number) => Math.abs(x - 100) / 80 + Math.abs(y - 100) / 80 <= 1
    const oval = ovalIn(mask(200, 200, inside), 200, 200)

    if (oval) {
      const cx = oval.x + oval.w / 2
      const cy = oval.y + oval.h / 2

      for (let i = 0; i < 36; i++) {
        const t = (i / 36) * Math.PI * 2

        expect(inside(Math.round(cx + Math.cos(t) * oval.w / 2), Math.round(cy + Math.sin(t) * oval.h / 2))).toBe(true)
      }
    }
  })

  it('is nothing in nothing', () => {
    expect(ovalIn(new Uint8Array(100), 10, 10)).toBeNull()
  })
})
