import { describe, expect, it } from 'vitest'

import { cleanPage } from '~/utils/ocr/clean'
import { blockOutline, effectiveMask, inkRect, insideOutline, partsWithin } from '~/utils/ocr/mask'

/**
 * The oriented-box measurement, on masks built to be the failure cases.
 *
 * Every scenario here is a real page reduced to its geometry — ECLIPSE page
 * 22 and its neighbours, where the measurement's history was written. The
 * masks are stamped straight into the array because that is what `inkRect`
 * takes: no canvas, no JPEG, and the glyph sizes are the ~16–30px of a real
 * scan, which is precisely the scale the synthetic bench got wrong before
 * (80px lettering survives everything; 30px lettering does not).
 *
 * `via` is asserted alongside the angle on purpose: the right answer down
 * the wrong path is the next regression waiting — a 0 from `sweep-declined`
 * and a 0 from `column-line` agree today and diverge the day either path is
 * touched.
 */

/** Stamp a filled axis-aligned square of ink. */
function square (mask: Float32Array, w: number, cx: number, cy: number, side: number) {
  const half = side / 2

  for (let y = Math.round(cy - half); y < cy + half; y++) {
    for (let x = Math.round(cx - half); x < cx + half; x++) {
      mask[y * w + x] = 1
    }
  }
}

const W = 160
const H = 240

/**
 * A column of `count` squares leaning `lean` degrees off vertical.
 *
 * The sign follows `tiltedQuad`'s convention — positive is clockwise, so a
 * point below the centre rotates to (−sin, +cos). The first draft of this
 * helper stamped (+sin, +cos) and both leaning tests failed with mirrored
 * angles, which looked like a bug in `columnLean` and was a bug in the
 * fixture: get the convention from the code under test's own round-trip
 * (`deskew.test.ts`), not from intuition about screen coordinates.
 */
function column (mask: Float32Array, lean: number, count = 5, side = 18, cx = W / 2) {
  const radians = (lean * Math.PI) / 180
  const step = side + 10

  for (let i = 0; i < count; i++) {
    const along = (i - (count - 1) / 2) * step

    square(mask, W, cx - along * Math.sin(radians), H / 2 + along * Math.cos(radians), side)
  }
}

describe('inkRect on real-page geometry', () => {
  it('reads a leaning column off the columns themselves', () => {
    const mask = new Float32Array(W * H)

    column(mask, 15)

    const rect = inkRect(mask, W, H)

    expect(rect.via).toBe('column-line')
    expect(rect.angle).toBeGreaterThan(10)
    expect(rect.angle).toBeLessThan(20)
  })

  it('reads the mirror lean with the mirror sign', () => {
    const mask = new Float32Array(W * H)

    column(mask, -15)

    const rect = inkRect(mask, W, H)

    expect(rect.via).toBe('column-line')
    expect(rect.angle).toBeGreaterThan(-20)
    expect(rect.angle).toBeLessThan(-10)
  })

  it('keeps a multi-column balloon level', () => {
    // Three upright columns — the dialogue-balloon cloud whose slight
    // imbalance the whole-scatter fit once read as a lean.
    const mask = new Float32Array(W * H)

    column(mask, 0, 5, 18, 40)
    column(mask, 0, 4, 18, 80)
    column(mask, 0, 5, 18, 120)

    const rect = inkRect(mask, W, H)

    expect(rect.angle).toBe(0)
  })

  it('does not let an ellipsis tail drag upright characters over', () => {
    // Four characters straight down, then a diagonal drift of dots — the
    // `怎麼可以……` case, which read as −17° when dots weighed as much as
    // characters.
    const mask = new Float32Array(W * H)

    column(mask, 0, 4, 20)
    for (let i = 0; i < 5; i++) {
      square(mask, W, W / 2 - 12 - i * 7, 190 + i * 8, 3)
    }

    const rect = inkRect(mask, W, H)

    expect(rect.angle).toBe(0)
  })

  it('does not let dots agree with themselves', () => {
    // Two characters and a long diagonal dot-tail — page 22's bottom
    // balloons. Too few characters to form a column, so the only possible
    // "witnesses" are the whole-scatter fit and the sweep, and the dots
    // drag both the same way: shared inputs, not independent readings.
    // They once "agreed" on −37° and rotated a correctly-reading crop into
    // garbage. With no column there must be no lean.
    const mask = new Float32Array(W * H)

    square(mask, W, W / 2, 60, 20)
    square(mask, W, W / 2, 90, 20)
    for (let i = 0; i < 7; i++) {
      square(mask, W, W / 2 - 8 - i * 9, 115 + i * 11, 3)
    }

    const rect = inkRect(mask, W, H)

    expect(rect.angle).toBe(0)
  })

  it('declines a single fused blob rather than guessing', () => {
    // What DILATE growth makes of a small column: one blob, no arrangement.
    const mask = new Float32Array(W * H)

    square(mask, W, W / 2, H / 2, 60)

    const rect = inkRect(mask, W, H)

    expect(rect.angle).toBe(0)
    expect(rect.via).toBe('sweep-declined')
  })

  it('leaves horizontal text to the paths that already handle it', () => {
    // A row never groups into a column — x-intervals do not overlap — so
    // the column path must stay out of the way.
    const mask = new Float32Array(W * H)

    for (let i = 0; i < 5; i++) {
      square(mask, W, 30 + i * 26, H / 2, 18)
    }

    const rect = inkRect(mask, W, H)

    expect(rect.via).not.toBe('column-line')
    expect(rect.angle).toBe(0)
  })
})

/**
 * A repair called off before it starts.
 *
 * The brush's case: a correction drawn while the previous correction's repair
 * is still running. That repair is of a mask that no longer exists, so a new
 * stroke abandons it — and abandoning has to reject as an abort, which the
 * caller reads as "stopped" rather than reporting a failure on the balloon.
 */
describe('cleanPage, called off', () => {
  it('rejects with an AbortError before doing any work', async () => {
    const page = { file: new File([], '1.png'), width: 600 }
    const regions = [{ x: 10, y: 10, w: 100, h: 100 }]

    await expect(cleanPage(page, regions, undefined, 'aot', { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * Where a turned block is — what cleaning cuts and what its mask is kept in.
 *
 * The report: three messages on a phone screen, turned 21°, came back from
 * cleaning with the tops and bottoms of their letters still on the page. The
 * crop had been the block's box before it was turned. An upright block must
 * come out exactly as it always did, or every repair on every page is renamed.
 */
describe('blockOutline', () => {
  it('leaves an upright block as it was, with no outline', () => {
    const { region, outline } = blockOutline({ x: 10, y: 20, w: 30, h: 5 }, 1000, 2000)

    expect(region).toEqual({ x: 100, y: 400, w: 300, h: 100 })
    expect(outline).toBeNull()
  })

  it('cuts a turned block as the rectangle around its turned corners', () => {
    // 300×100 page pixels, turned a quarter: 100 wide and 300 tall, same centre.
    const { region, outline } = blockOutline({ x: 10, y: 20, w: 30, h: 5, angle: 90 }, 1000, 2000)

    expect(outline).toHaveLength(4)
    expect(region.w).toBeCloseTo(100, 5)
    expect(region.h).toBeCloseTo(300, 5)
    expect(region.x + region.w / 2).toBeCloseTo(250, 5)
    expect(region.y + region.h / 2).toBeCloseTo(450, 5)
  })

  it('keeps a mask point inside the turned outline and drops one in its corner', () => {
    const { region, outline } = blockOutline({ x: 10, y: 20, w: 30, h: 5, angle: 45 }, 1000, 2000)

    // The middle is inside; the rectangle's own corner is not part of the block.
    expect(insideOutline(outline!, region.x + region.w / 2, region.y + region.h / 2)).toBe(true)
    expect(insideOutline(outline!, region.x + 1, region.y + 1)).toBe(false)
  })
})

/**
 * A joined balloon's lines, trusted only when they sit inside it.
 *
 * The report: four balloons on page 3 of Business trip grooming 2 would not
 * mask at all. Their lines had been saved squeezed toward the top of the page
 * by the old page-shape bug — the stored heights divided by 1.474 — so the
 * mask was taken over paper above the balloon, found nothing, and the repair
 * was withdrawn. These are that balloon's numbers, in page pixels.
 */
describe('partsWithin', () => {
  const balloon = { x: 217, y: 765, w: 182, h: 232 }

  it('keeps lines that sit inside their balloon', () => {
    const lines = [{ x: 227, y: 775, w: 150, h: 100 }, { x: 217, y: 890, w: 182, h: 45 }]

    expect(partsWithin(lines, balloon)).toBe(lines)
  })

  it('drops them all when they were saved somewhere else', () => {
    // Block 676's lines as stored: every y and height divided by 1.474.
    const squeezed = [{ x: 227, y: 519, w: 153, h: 102 }, { x: 217, y: 634, w: 182, h: 43 }]

    expect(partsWithin(squeezed, balloon)).toEqual([])
  })

  it('drops them all when only one is out, rather than masking half the balloon', () => {
    const one = [{ x: 227, y: 775, w: 150, h: 100 }, { x: 217, y: 634, w: 182, h: 43 }]

    expect(partsWithin(one, balloon)).toEqual([])
  })

  it('allows a line drawn a little past the balloon', () => {
    const over = [{ x: 207, y: 760, w: 200, h: 60 }]

    expect(partsWithin(over, balloon)).toBe(over)
  })
})

/**
 * How far a turned block's mask may reach past its outline.
 *
 * The report: dark bars at the end of Korean lines across a whole chapter.
 * The outline clip cut the mask exactly at the block's box, which undid the
 * mask's growth wherever a glyph touched the box — and almost every block has
 * a small detector angle, so almost every block was clipped. The stroke's edge
 * was left just outside the hole and LaMa drew it back in. The growth has to
 * survive the clip; a neighbouring line, much further off, still must not.
 */
describe('effectiveMask, clipped to an outline', () => {
  const w = 60
  const h = 40
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  const inner = { x: 10, y: 10, w: 30, h: 20 }
  // The box, as a turned block's outline — a near-upright one, like the detector's.
  const outline = [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 30 }, { x: 10, y: 30 }]

  /** A mask with one pixel set, handed over as found ink. */
  const found = (x: number, y: number) => {
    const mask = new Float32Array(w * h)

    mask[y * w + x] = 1

    return { mask, read: 1, refused: [] }
  }

  it('keeps the growth that spills a few pixels past the outline', () => {
    // Three pixels right of the box: exactly what `DILATE` adds to a stroke
    // that ends on the box's edge.
    const { hard } = effectiveMask(data, w, h, inner, [], [], found(42, 20), outline)

    expect(hard[20 * w + 42]).toBe(1)
  })

  it('still drops ink well outside it, such as the next line', () => {
    const { hard } = effectiveMask(data, w, h, inner, [], [], found(50, 20), outline)

    expect(hard[20 * w + 50]).toBe(0)
  })
})
