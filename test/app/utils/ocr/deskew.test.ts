import { describe, expect, it } from 'vitest'

import { boxOf } from '#shared/utils/ocr'
import { tiltedQuad } from '~/utils/ocr/deskew'

/**
 * A lean, once measured, has to survive being written down.
 *
 * `uprightRegion` measures the tilt in order to straighten a crop, and until now
 * spent it there — every block was filed as the detector's upright rectangle
 * however far its lettering leaned. `tiltedQuad` is the other half, and the only
 * thing that makes it worth having is that the angle comes back out again at the
 * far end.
 *
 * That round trip crosses two conventions that disagree with each other on
 * purpose, which is the whole reason to pin it here rather than trust it:
 *
 *   * `Upright.tilt` is *the lean to undo*, so `regionCanvas` rotates by
 *     `-tilt`. The page-space corners are therefore at `+tilt` — the opposite
 *     sign. Getting this backwards mirrors every stored angle, and on a page of
 *     mostly-upright balloons it would look like nothing much until somebody
 *     drew a box.
 *   * `boxOf` normalises by the page's **width on both axes**, so `cy` and `h`
 *     run past 1 on a tall page. It takes its angle from the top edge, which is
 *     why `tiltedQuad` must emit `[tl, tr, br, bl]` in that order and no other.
 *
 * The tolerances are loose on purpose: this asserts the convention, not the
 * arithmetic. A sign error is degrees out, not hundredths.
 */
describe('tiltedQuad', () => {
  const upright = { tilt: 0, cx: 300, cy: 400, w: 120, h: 60 }

  it('puts the corners in the order boxOf destructures', () => {
    const [tl, tr, br, bl] = tiltedQuad(upright) as [
      { x: number, y: number }, { x: number, y: number },
      { x: number, y: number }, { x: number, y: number },
    ]

    expect(tl).toEqual({ x: 240, y: 370 })
    expect(tr).toEqual({ x: 360, y: 370 })
    expect(br).toEqual({ x: 360, y: 430 })
    expect(bl).toEqual({ x: 240, y: 430 })
  })

  it('centres on the lettering, not the detector box', () => {
    const box = boxOf(tiltedQuad(upright), 1000)

    expect(box.cx).toBeCloseTo(0.3, 5)
    expect(box.cy).toBeCloseTo(0.4, 5)
    // Normalised by width on both axes — 60/1000, not 60 over a height.
    expect(box.h).toBeCloseTo(0.06, 5)
  })

  it.each([-30, -12, -5, 5, 12, 30, 45])('round-trips a %s degree lean', (tilt) => {
    const box = boxOf(tiltedQuad({ ...upright, tilt }), 1000)

    // Same sign, not the mirror of it. This is the assertion that fails if the
    // rotate-to-undo convention leaks into the corners.
    expect(box.angle).toBeCloseTo(tilt, 3)
    // A rotation moves no centre and changes no side.
    expect(box.cx).toBeCloseTo(0.3, 5)
    expect(box.cy).toBeCloseTo(0.4, 5)
    expect(box.w).toBeCloseTo(0.12, 5)
    expect(box.h).toBeCloseTo(0.06, 5)
  })
})
