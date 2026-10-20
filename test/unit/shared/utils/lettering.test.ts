import { describe, expect, it } from 'vitest'

import type { Lettering } from '#shared/utils/lettering'

import {
  contrastOf, customFrom, estimateSize, INK_DARK, INK_LIGHT, inking, inkOn, LETTERING, LETTERING_RANGE, letteringOf,
  letteringRange, luminanceOf, reverseOf, shapeFloats, shapeFor, shapeOutline, shapeSpans, squeezed, validPoints,
} from '#shared/utils/lettering'

/**
 * The colour half of `Lettering` — which ink goes on which paper.
 *
 * The bug being guarded against is a specific one and it is worth naming: every
 * line was set in `neutral-900` regardless of what was under it, so a black
 * balloon got dark type on a dark ground and the translation could not be read
 * on a page whose printed lettering was perfectly legible.
 *
 * What the sampling reads is tested next door in `test/nuxt/utils/paper` — it
 * needs a canvas. Everything here is arithmetic over a colour already in hand.
 */
describe('inkOn', () => {
  /**
   * The two ends, which are the whole of the ordinary case: a comic is printed
   * on white paper, and the balloons that broke were the black ones.
   */
  it('takes the dark ink on white paper and the light one on black', () => {
    expect(inkOn({ r: 255, g: 255, b: 255 })).toBe(INK_DARK)
    expect(inkOn({ r: 0, g: 0, b: 0 })).toBe(INK_LIGHT)
  })

  /**
   * The regression itself, on the near-blacks a scan actually produces rather
   * than on a mathematical one. A balloon printed black and scanned comes back
   * somewhere in the twenties, and an implementation that only handled `#000`
   * would leave every real page exactly as broken as it was.
   */
  it('takes the light ink on a scanned black, not only on a perfect one', () => {
    expect(inkOn({ r: 24, g: 22, b: 27 })).toBe(INK_LIGHT)
    expect(inkOn({ r: 58, g: 58, b: 58 })).toBe(INK_LIGHT)
  })

  /**
   * Why the channels are weighed rather than averaged. A saturated blue has a
   * middling mean and is dark to the eye; the plain average calls it light and
   * puts black type on it, which is the case that made this WCAG's formula and
   * not a third of the sum.
   */
  it('weighs the channels, so a saturated blue reads as dark', () => {
    const blue = { r: 20, g: 40, b: 200 }

    expect((blue.r + blue.g + blue.b) / 3).toBeGreaterThan(85)
    expect(inkOn(blue)).toBe(INK_LIGHT)
  })

  /** Nothing read yet is the state the first frame draws in — see `usePaper`. */
  it('falls back to the dark ink when nothing has been read', () => {
    expect(inkOn(null)).toBe(INK_DARK)
  })
})

describe('luminanceOf and contrastOf', () => {
  it('runs nought to one, black to white', () => {
    expect(luminanceOf({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(luminanceOf({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })

  /** WCAG's own bounds, and the ratio is symmetric in its two arguments. */
  it('runs one to twenty-one either way round', () => {
    expect(contrastOf(0, 1)).toBeCloseTo(21, 5)
    expect(contrastOf(1, 0)).toBeCloseTo(21, 5)
    expect(contrastOf(0.4, 0.4)).toBe(1)
  })
})

describe('inking', () => {
  const style = (patch: Partial<Lettering> = {}) => letteringOf(patch)

  /**
   * The page's answer where nobody has given one — and the outline as the
   * reverse of it, which is the only thing a halo is ever for.
   */
  it('reads both off the paper when neither has been chosen', () => {
    expect(inking(style(), { r: 255, g: 255, b: 255 }))
      .toEqual({ fill: INK_DARK, outline: INK_LIGHT })
    expect(inking(style(), { r: 10, g: 10, b: 10 }))
      .toEqual({ fill: INK_LIGHT, outline: INK_DARK })
  })

  /** A letterer's choice is a decision, and no measurement overrides one. */
  it('lets a chosen colour win over what was read', () => {
    const chosen = inking(style({ color: '#ff0000' }), { r: 255, g: 255, b: 255 })

    expect(chosen.fill).toBe('#ff0000')
    // And the outline still follows the fill, not the paper: a red letter is
    // held apart from anything by a light halo.
    expect(chosen.outline).toBe(INK_LIGHT)
  })

  it('lets an outline be chosen on its own', () => {
    expect(inking(style({ outline: '#00ff00' }), { r: 0, g: 0, b: 0 }))
      .toEqual({ fill: INK_LIGHT, outline: '#00ff00' })
  })

  /**
   * What the page did before any of this existed: dark ink, white halo. A
   * default that changed this would move every balloon in every chapter already
   * lettered, which is the one thing switching an automatic choice on must not
   * do.
   */
  it('leaves a white page exactly as it was lettered before', () => {
    expect(LETTERING.color).toBeNull()
    expect(LETTERING.outline).toBeNull()
    expect(inking(style(), { r: 252, g: 250, b: 248 }))
      .toEqual({ fill: INK_DARK, outline: INK_LIGHT })
  })
})

describe('reverseOf', () => {
  it('answers with the other ink, whatever colour it is handed', () => {
    expect(reverseOf(INK_DARK)).toBe(INK_LIGHT)
    expect(reverseOf(INK_LIGHT)).toBe(INK_DARK)
    expect(reverseOf('#ffee00')).toBe(INK_DARK)
    expect(reverseOf('#3b0764')).toBe(INK_LIGHT)
  })
})

/**
 * Weight when nobody has chosen one.
 *
 * The report: "don't default dialog to bold". Every balloon was set bold until a
 * letterer turned it off, and the dialogue face is heavy enough without it. A
 * sound effect stays bold — it is display lettering drawn into the art — and a
 * weight somebody chose wins either way.
 */
describe('letteringOf, on weight', () => {
  it('sets dialogue regular by default, whatever kind of balloon it is in', () => {
    expect(letteringOf({}, 'bubble').bold).toBe(false)
    expect(letteringOf({}, 'caption').bold).toBe(false)
    expect(letteringOf(null).bold).toBe(false)
  })

  it('sets a sound effect bold by default', () => {
    expect(letteringOf({}, 'sfx').bold).toBe(true)
  })

  it('keeps a weight somebody chose, either way', () => {
    expect(letteringOf({ bold: true }, 'bubble').bold).toBe(true)
    expect(letteringOf({ bold: false }, 'sfx').bold).toBe(false)
  })
})

/**
 * How far the dials go. Size, spacing and stroke are scan pixels, and the range
 * was once fixed at 70 — about a fifth of what a balloon on a 3732-pixel page
 * holds, with every Fit and every automatic size clamped to it as well.
 */
describe('letteringRange', () => {
  it('grows the pixel ceilings with a big page and leaves the floors and the line alone', () => {
    const big = letteringRange(3732)

    expect(big.size).toMatchObject({ min: 10, max: 261 })
    expect(big.stroke.max).toBe(30)
    expect([big.spacing.min, big.spacing.max]).toEqual([-37, 37])
    expect(big.line).toEqual(LETTERING_RANGE.line)
  })

  it('never gives a small or unmeasured page less than it always had', () => {
    expect(letteringRange(640)).toEqual(LETTERING_RANGE)
    expect(letteringRange()).toEqual(LETTERING_RANGE)
  })

  it('lets a guess on a big page go past the old ceiling', () => {
    const balloon = { w: 900, h: 700 }

    expect(estimateSize('Hi!', balloon)).toBe(LETTERING_RANGE.size.max)
    expect(estimateSize('Hi!', balloon, undefined, letteringRange(3732).size)).toBeGreaterThan(LETTERING_RANGE.size.max)
  })
})

/**
 * The shapes a balloon's lines wrap into, and the two floats that carve them.
 *
 * The geometry is the half that can be wrong without a browser: whether a
 * shape's edge is where it should be at each line, and whether the floats'
 * polygons leave exactly that. Whether the browser then wraps into them is
 * checked in the running app.
 */
describe('shapes', () => {
  const block = (type: string, translation = 'Hello there') => ({ type, translation })

  it('wraps a translated balloon into the soft shape by default, and nothing else', () => {
    expect(shapeFor({ shape: null, points: null }, block('bubble'))).toBe('soft')
    expect(shapeFor({ shape: null, points: null }, block('caption'))).toBe('box')
    expect(shapeFor({ shape: null, points: null }, block('sfx'))).toBe('box')
  })

  /** Until there is a translation the block shows what was read, where it was read. */
  it('never shapes a line that has not been translated', () => {
    expect(shapeFor({ shape: 'diamond', points: null }, block('bubble', ''))).toBe('box')
  })

  it('falls back to the box for a custom shape with no usable points', () => {
    expect(shapeFor({ shape: 'custom', points: null }, block('bubble'))).toBe('box')
    expect(shapeFor({ shape: 'custom', points: [0, 0, 1, 0] }, block('bubble'))).toBe('box')
    expect(shapeFor({ shape: 'custom', points: [0, 0, 1, 0, 0.5, 1] }, block('bubble'))).toBe('custom')
  })

  it('draws the diamond short at the ends and full through the middle', () => {
    const spans = shapeSpans(shapeOutline('diamond')!, false)
    const middle = spans[spans.length >> 1]!
    const nearTop = spans[3]!

    expect(middle[0]).toBeCloseTo(0, 5)
    expect(middle[1]).toBeCloseTo(1, 5)
    expect(nearTop[1] - nearTop[0]).toBeLessThan(0.2)
  })

  it('keeps the soft shape full width through the middle and rounds the corners off', () => {
    const spans = shapeSpans(shapeOutline('soft')!, false)
    const middle = spans[spans.length >> 1]!
    const top = spans[0]!

    expect(middle[1] - middle[0]).toBeCloseTo(1, 5)
    expect(top[1] - top[0]).toBeGreaterThan(0)
    expect(top[1] - top[0]).toBeLessThan(0.8)
  })

  it('reads columns instead of rows when the text is set down the page', () => {
    // A wedge, wide at the left and a point at the right: across it every row
    // reaches the same left edge; down it the columns shrink to the right.
    const wedge = shapeOutline('custom', [0, 0, 1, 0.5, 0, 1])!
    const columns = shapeSpans(wedge, true)

    expect(columns[0]![1] - columns[0]![0]).toBeCloseTo(1, 5)
    expect(columns[columns.length - 1]![1] - columns[columns.length - 1]![0]).toBeCloseTo(0, 5)
  })

  it('carves the diamond with floats that leave its middle open and close its tips', () => {
    const { start, end } = shapeFloats(shapeOutline('diamond')!, false)

    // The start float covers its whole half at the top and none of it midway.
    expect(start).toMatch(/^polygon\(0% 0%, 100% 0%/)
    expect(start).toContain('0% 50%')
    expect(end).toMatch(/^polygon\(100% 0%, 0% 0%/)
    expect(end).toContain('100% 50%')
  })

  it('starts a custom shape from the one that was showing', () => {
    const points = customFrom('diamond')

    expect(points).toEqual([0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5])
    expect(validPoints(customFrom('soft'))).toBe(true)
    expect(customFrom('soft').length / 2).toBeLessThanOrEqual(12)
  })
})

describe('squeezed', () => {
  it('sets a hair tighter only when asked', () => {
    expect(squeezed(1.15, 0, 40)).toEqual({ line: 1.15, spacing: 0 })

    const tight = squeezed(1.15, 0, 40, true)

    expect(tight.line).toBeCloseTo(1.05, 5)
    expect(tight.spacing).toBeCloseTo(-1.2, 5)
  })
})
