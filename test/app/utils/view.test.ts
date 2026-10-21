import { describe, expect, it } from 'vitest'

import type { BoardView } from '~/utils/view'

import { sheetCorner, sheetInView, sheetToView, viewToSheet } from '~/utils/view'

/**
 * Where the page lands on screen, and where the pointer lands on the page.
 *
 * The board draws its chrome — outlines, grips, the brush ring, the rubber
 * band — outside the stage's transform, and takes the pointer back through it,
 * all as arithmetic. The pointer half used to be a `getBoundingClientRect` of
 * the sheet on every move, which read straight after the previous move's render
 * was a layout of the page per move; it is now the inverse of the drawing half,
 * and these hold the two to each other and to what the stage's CSS does.
 *
 * Seam: the pure functions in `utils/view`, in screen pixels.
 */

/** A room of 800 × 600 with a sheet of 400 × 560 laid out in it — the fit. */
const FIT: BoardView = {
  pan: { x: 0, y: 0 },
  zoom: 1,
  room: { w: 800, h: 600 },
  sheet: { w: 400, h: 560 },
}

const zoomed = (view: BoardView, zoom: number, pan: { x: number, y: number }) => ({ ...view, zoom, pan })

describe('the sheet on screen', () => {
  it('is centred in the room before the pan and the zoom say anything', () => {
    expect(sheetCorner(FIT)).toEqual({ x: 200, y: 20 })
    expect(sheetToView(FIT, { x: 0, y: 0 })).toEqual({ x: 200, y: 20 })
    expect(sheetToView(FIT, { x: 400, y: 560 })).toEqual({ x: 600, y: 580 })
  })

  /*
   * `translate(pan) scale(zoom)` about the top left: every point, centring and
   * all, is scaled, then moved by the pan. Doing the pan inside the scale
   * instead is the classic slip, and it only shows once both are in play.
   */
  it('is scaled about the top left, then panned, as the stage is', () => {
    const view = zoomed(FIT, 2, { x: -300, y: -40 })

    expect(sheetToView(view, { x: 0, y: 0 })).toEqual({ x: -300 + 2 * 200, y: -40 + 2 * 20 })
    expect(sheetToView(view, { x: 100, y: 50 })).toEqual({ x: -300 + 2 * 300, y: -40 + 2 * 70 })
  })

  /*
   * The chrome's container wears the pan, so the chrome is placed in the view
   * with the pan left out — and must land exactly where the page does once the
   * container's translation is added back.
   */
  it('differs from the chrome\'s frame by exactly the pan', () => {
    const view = zoomed(FIT, 3.5, { x: -812.25, y: 97.5 })
    const still = { ...view, pan: { x: 0, y: 0 } }
    const p = { x: 123.4, y: 456.7 }

    const onPage = sheetToView(view, p)
    const inChrome = sheetToView(still, p)

    expect(onPage.x).toBeCloseTo(inChrome.x + view.pan.x, 9)
    expect(onPage.y).toBeCloseTo(inChrome.y + view.pan.y, 9)
  })
})

describe('the pointer on the sheet', () => {
  it('is the drawing run backwards, at any pan and zoom', () => {
    for (const view of [FIT, zoomed(FIT, 2, { x: -300, y: -40 }), zoomed(FIT, 7.25, { x: -4000.5, y: -1234.75 })]) {
      for (const p of [{ x: 0, y: 0 }, { x: 400, y: 560 }, { x: 37.5, y: 211.125 }]) {
        const back = viewToSheet(view, sheetToView(view, p))

        expect(back.x).toBeCloseTo(p.x, 9)
        expect(back.y).toBeCloseTo(p.y, 9)
      }
    }
  })

  it('stays under the pointer when the page moves under it', () => {
    // The same screen point, before and after a pan of +50: the page slid
    // right, so the pointer is fifty sheet pixels further left on it — at a
    // zoom of one. A captured rectangle would have said it had not moved.
    const before = viewToSheet(FIT, { x: 400, y: 300 })
    const after = viewToSheet({ ...FIT, pan: { x: 50, y: 0 } }, { x: 400, y: 300 })

    expect(after.x).toBe(before.x - 50)
    expect(after.y).toBe(before.y)
  })
})

describe('the part of the sheet in view', () => {
  it('is the whole sheet at the fit', () => {
    expect(sheetInView(FIT)).toEqual({ x: 0, y: 0, w: 400, h: 560 })
  })

  it('is the middle of it when zoomed about the middle', () => {
    // Twice the size, pinned about the room's centre: pan = centre − centre × 2.
    const view = zoomed(FIT, 2, { x: 400 - 400 * 2, y: 300 - 300 * 2 })

    expect(sheetInView(view)).toEqual({ x: 0, y: 130, w: 400, h: 300 })
  })

  it('widens by the margin in screen pixels, and never past the sheet', () => {
    const view = zoomed(FIT, 2, { x: 400 - 400 * 2, y: 300 - 300 * 2 })

    // Forty screen pixels either side is twenty sheet pixels at twice the size.
    expect(sheetInView(view, 40)).toEqual({ x: 0, y: 110, w: 400, h: 340 })
    // And a sheet already wholly in view has nothing more to give.
    expect(sheetInView(FIT, 96)).toEqual({ x: 0, y: 0, w: 400, h: 560 })
  })

  it('is empty, not negative, once the sheet has left the room', () => {
    const gone = zoomed(FIT, 1, { x: 5000, y: 0 })

    expect(sheetInView(gone).w).toBe(0)
  })
})
