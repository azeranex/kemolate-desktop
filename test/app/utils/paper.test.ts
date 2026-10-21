import { describe, expect, it } from 'vitest'

import { paperAt } from '~/utils/paper'

/**
 * What colour the page is under a block — the measurement half of the automatic
 * ink. `inkOn` decides what to do with the answer and is tested under
 * `test/unit`, since it is arithmetic; this is about reading the right pixels.
 *
 * Synthetic pages rather than a fixture, because every case here is a claim
 * about *which* pixels are looked at, and a real scan cannot state one. Printed
 * lettering is painted as strokes — bars with paper between them — because that
 * is what type is, and the first version of these tests painted it as one solid
 * rectangle. That page has no paper inside the block at all, so it could only
 * be answered from a ring around it, and the ring is what lettered white
 * balloons on dark art in white.
 */

/** A page of one colour, with rectangles painted onto it. */
function sheet (
  w: number,
  h: number,
  ground: [number, number, number],
  marks: { x: number, y: number, w: number, h: number, rgb: [number, number, number] }[] = [],
) {
  const data = new Uint8ClampedArray(w * h * 4)

  for (let i = 0; i < w * h; i++) {
    data[i * 4] = ground[0]
    data[i * 4 + 1] = ground[1]
    data[i * 4 + 2] = ground[2]
    data[i * 4 + 3] = 255
  }

  for (const mark of marks) {
    for (let y = mark.y; y < mark.y + mark.h; y++) {
      for (let x = mark.x; x < mark.x + mark.w; x++) {
        const at = (y * w + x) * 4

        data[at] = mark.rgb[0]
        data[at + 1] = mark.rgb[1]
        data[at + 2] = mark.rgb[2]
      }
    }
  }

  return { data, w, h }
}

/** A box in percentages, which is the unit every box in this app is in. */
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

/** Lettering inside a box: three bars across it, a quarter of it inked. */
const type = (x: number, y: number, w: number, h: number, rgb: [number, number, number]) => [0, 1, 2]
  .map((i) => ({ x, y: y + Math.round(((i + 0.5) * h) / 3) - Math.max(1, Math.round(h / 24)), w, h: Math.max(1, Math.round(h / 12)), rgb }))

describe('paperAt', () => {
  /**
   * The bug, stated as a page: a white balloon the block fills, on dark art. A
   * ring reaching past the block reads the art and letters the balloon white.
   * Istani page 6's "Hm?" and grooming page 43 were this page exactly.
   */
  it('reads a white balloon the block fills as white, whatever is round it', () => {
    const page = sheet(100, 100, [40, 40, 40], [
      { x: 30, y: 30, w: 40, h: 30, rgb: [250, 250, 250] },
      ...type(32, 32, 36, 26, [10, 10, 10]),
    ])

    expect(paperAt(page, box(32, 32, 36, 26))!.r).toBeGreaterThan(200)
  })

  /** The other way round: white lettering on a black balloon asks for white ink. */
  it('reads a black balloon with white type in it as black', () => {
    const page = sheet(100, 100, [255, 255, 255], [
      { x: 20, y: 20, w: 60, h: 60, rgb: [12, 12, 12] },
      ...type(30, 30, 40, 40, [255, 255, 255]),
    ])

    const paper = paperAt(page, box(30, 30, 40, 40))!

    expect(Math.max(paper.r, paper.g, paper.b)).toBeLessThan(40)
  })

  /**
   * A block turned with its balloon. Read as the rectangle it would be unturned,
   * it is a flat strip mostly across the tone around a tilted message — which
   * is how a row of phone messages on grooming page 6 was lettered white.
   */
  it('reads a turned block inside the shape it is turned to', () => {
    const angle = (30 * Math.PI) / 180
    const [cx, cy, hw, hh] = [50, 50, 30, 5]
    const page = sheet(100, 100, [60, 60, 60])

    // A white band turned thirty degrees, painted by its own arithmetic.
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const u = dx * Math.cos(angle) + dy * Math.sin(angle)
        const v = -dx * Math.sin(angle) + dy * Math.cos(angle)

        if (Math.abs(u) <= hw + 1 && Math.abs(v) <= hh + 1) page.data.fill(250, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3)
      }
    }

    const flat = box(cx - hw, cy - hh, hw * 2, hh * 2)

    expect(paperAt(page, flat)!.r).toBeLessThan(128)
    expect(paperAt(page, { ...flat, angle: 30 })!.r).toBeGreaterThan(200)
  })

  /**
   * Median, not mean: lettering heavy enough to drag a mean half-way to the ink
   * does not move a median while it is under half the box.
   */
  it('is not dragged by heavy lettering', () => {
    const page = sheet(100, 100, [245, 245, 245], [
      { x: 20, y: 22, w: 60, h: 14, rgb: [0, 0, 0] },
      { x: 20, y: 52, w: 60, h: 14, rgb: [0, 0, 0] },
    ])

    expect(paperAt(page, box(20, 20, 60, 60))!.r).toBe(245)
  })

  /** A block too small to take a median of reads a little round it instead. */
  it('widens a block too small to read', () => {
    const page = sheet(100, 100, [200, 30, 30])

    expect(paperAt(page, box(50, 50, 2, 2))).toEqual({ r: 200, g: 30, b: 30 })
  })

  /** Nothing to read from a box with no area — the state a fresh block is in. */
  it('answers with nothing for an empty box', () => {
    expect(paperAt(sheet(20, 20, [255, 255, 255]), box(10, 10, 0, 0))).toBeNull()
  })

  /** A block against the page edge, turned so part of it is off the page. */
  it('reads a block at the edge without running off the page', () => {
    const page = sheet(100, 100, [200, 30, 30])

    expect(paperAt(page, { ...box(-5, -5, 20, 20), angle: 45 })).toEqual({ r: 200, g: 30, b: 30 })
  })
})
