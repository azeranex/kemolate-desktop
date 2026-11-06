import { describe, expect, it } from 'vitest'

import { extentOf, shapeOf } from '~~/server/utils/mcp'

/**
 * How a box is shown to an agent, and what a crop of it asks for. A turned
 * frame cropped by its centre and size alone cut its own corners off.
 */

describe('a box as an agent sees it', () => {
  it('says a turn, lean or pulled corner only where there is one', () => {
    expect(shapeOf({ cx: 0.5, cy: 1.2, w: 0.2, h: 0.1, angle: 0, skewX: 0, skewY: 0, quad: [0, 0, 0, 0, 0, 0, 0, 0] })).toEqual({ cx: 0.5, cy: 1.2, w: 0.2, h: 0.1 })
    expect(shapeOf({ cx: 0.5, cy: 1.2, w: 0.2, h: 0.1, angle: 15, skewY: 3, quad: [4, 0, 0, 0, 0, 0, 0, 0] })).toEqual({ cx: 0.5, cy: 1.2, w: 0.2, h: 0.1, angle: 15, skewY: 3, quad: [4, 0, 0, 0, 0, 0, 0, 0] })
  })

  it('crops a quarter-turned box across its height, and a pulled corner as far as it reaches', () => {
    const turned = extentOf({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.1, angle: 90 }, 1000)

    expect(turned.w).toBeCloseTo(0.1)
    expect(turned.h).toBeCloseTo(0.4)
    expect(turned.x).toBeCloseTo(0.45)
    expect(turned.y).toBeCloseTo(0.3)

    // The north-west corner pulled 100 scan pixels left, on a page 1000 wide.
    const pulled = extentOf({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.1, quad: [-100, 0, 0, 0, 0, 0, 0, 0] }, 1000)

    expect(pulled.x).toBeCloseTo(0.2)
    expect(pulled.w).toBeCloseTo(0.5)
  })
})
