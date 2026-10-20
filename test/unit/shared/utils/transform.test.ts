import { describe, expect, it } from 'vitest'

import type { Oriented } from '#shared/utils/transform'

import { cornersOf, mapped, matrixOf, transposed, wrapDeg } from '#shared/utils/transform'

/**
 * `transposed` claims something geometric — that a quarter turn draws the
 * identical outline — and a claim like that is exactly the kind a comment can go
 * on making after the code has stopped being true. So it is checked here rather
 * than asserted there: the four corners on the page before and after, as a set,
 * with nothing about the box's own frame in the comparison. If the sign of the
 * turn or the order of the swap is ever changed, this is what says so.
 */

const box = (over: Partial<Oriented> = {}): Oriented => ({
  cx: 400,
  cy: 300,
  w: 40,
  h: 260,
  angle: 0,
  skewX: 0,
  skewY: 0,
  quad: null,
  ...over,
})

/**
 * The corners as the page sees them: the box's own corners run through its
 * matrix and carried out to its centre — the same two steps `cornersAt` in
 * `canvas/Board` takes to put a grip on one. Sorted and rounded, because "the
 * same four points" is a claim about a set: a quarter turn renames which corner
 * is the north-west one, and that renaming is not a move.
 */
const outline = (b: Oriented) => {
  const m = matrixOf(b)

  return cornersOf(b)
    .map((corner) => {
      const p = mapped(m, corner.x, corner.y)

      return { x: Number((b.cx + p.x).toFixed(6)), y: Number((b.cy + p.y).toFixed(6)) }
    })
    .sort((a, z) => a.x - z.x || a.y - z.y)
}

describe('transposed', () => {
  it.each([0, 37, -12, 90, 174])('leaves the outline where it was at %i°', (angle) => {
    const before = box({ angle })

    expect(outline(transposed(before))).toEqual(outline(before))
    expect(outline(transposed(before, true))).toEqual(outline(before))
  })

  it('swaps the sizes and turns the frame a quarter', () => {
    expect(transposed(box({ angle: 10 }))).toMatchObject({ w: 260, h: 40, angle: 100 })
    expect(transposed(box({ angle: 10 }), true)).toMatchObject({ w: 260, h: 40, angle: -80 })
  })

  it('leaves the centre alone', () => {
    const turned = transposed(box({ angle: 33 }))

    expect(turned.cx).toBe(400)
    expect(turned.cy).toBe(300)
  })

  // Two presses are the same outline with the type upside down, which is the
  // property the button's tooltip has to warn about — pinned here so that a
  // later change to the wrap cannot make the tooltip a lie.
  it('comes back upside down after two presses and exact after four', () => {
    const start = box({ angle: -12 })
    const twice = transposed(transposed(start))

    expect(twice).toMatchObject({ w: 40, h: 260, angle: 168 })
    expect(outline(twice)).toEqual(outline(start))

    expect(transposed(transposed(twice))).toEqual(start)
  })

  it.each([0, 37, -12, 100, 174.5, -179.9])('comes back exact after four presses from %i°', (angle) => {
    let turned = box({ angle })

    for (let i = 0; i < 4; i++) turned = transposed(turned)

    expect(turned).toEqual(box({ angle }))
  })

  /**
   * The one case that does not come back *bit* for bit. A detector's angle is a
   * long decimal, and adding ninety to one four times and taking a circle off in
   * the middle is four roundings — the numbers agree to fifteen figures and not
   * to sixteen. Written down rather than rounded away: an eighth of a
   * femto-degree is nothing on a page, but a later reader deserves to know the
   * cycle is exact by construction only for angles that survive the arithmetic,
   * and that `wrapDeg` is shaped the way it is to keep the residue this small.
   */
  it('comes back to within a rounding after four presses from a measured angle', () => {
    const angle = -15.83800000136964
    let turned = box({ angle })

    for (let i = 0; i < 4; i++) turned = transposed(turned)

    expect(turned.angle).not.toBe(angle)
    expect(turned.angle).toBeCloseTo(angle, 12)
    expect(outline(turned)).toEqual(outline(box({ angle })))
  })

  it('refuses a box whose corners have been pulled', () => {
    const pulled = box({ quad: [0, 0, 5, -3, 0, 0, 0, 0] })

    expect(transposed(pulled)).toEqual(pulled)
  })

  // An all-nought quad is no quad — see `isDistorted` — so this one is turned.
  it('turns a box carrying an untouched quad', () => {
    expect(transposed(box({ quad: [0, 0, 0, 0, 0, 0, 0, 0] }))).toMatchObject({ w: 260, h: 40, angle: 90 })
  })

  // The documented exception. A lean is read in the box's own frame, so it turns
  // with the frame and the parallelogram leans the other way — stated here so
  // that "the outline never moves" is not read as covering a case it does not.
  it('carries a lean through untouched, outline and all', () => {
    const leant = box({ skewX: 20 })
    const turned = transposed(leant)

    expect(turned).toMatchObject({ skewX: 20, skewY: 0 })
    expect(outline(turned)).not.toEqual(outline(leant))
  })
})

describe('wrapDeg', () => {
  it('folds a turn into half a circle either way', () => {
    expect(wrapDeg(0)).toBe(0)
    expect(wrapDeg(360)).toBe(0)
    expect(wrapDeg(180)).toBe(180)
    expect(wrapDeg(-180)).toBe(180)
    expect(wrapDeg(270)).toBe(-90)
    expect(wrapDeg(-270)).toBe(90)
    expect(wrapDeg(450)).toBe(90)
  })

  // Every angle it can produce is one the schema will take — see `angle` in
  // `shared/schemas/workspace`, which is where a patch that overshot would be
  // rejected rather than merely drawn wrong.
  it('stays inside what a block row will accept', () => {
    for (const v of [-1080, -359, -90, 12, 359, 1080]) {
      expect(wrapDeg(v)).toBeGreaterThan(-181)
      expect(wrapDeg(v)).toBeLessThanOrEqual(180)
    }
  })
})
