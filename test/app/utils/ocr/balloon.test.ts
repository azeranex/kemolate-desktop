import { describe, expect, it } from 'vitest'

import type { Sheet } from '~/utils/paper'

import { balloonIn, leaked } from '~/utils/ocr/balloon'

/**
 * The room measurement: the geometry on a hand-built page, and the leak
 * decision on numbers off a real one.
 *
 * `balloonIn` is pure — a sheet and a rectangle in, arithmetic out — so the
 * first test stamps its page straight into a `Uint8ClampedArray` rather than
 * decoding a scan. That is the whole reason it takes a `Sheet` and not a `File`.
 *
 * `leaked` is tested separately and from recorded observations, because a
 * synthetic page is no evidence at all about where a threshold belongs. Two
 * attempts at building a leak by hand produced fills of 2% and 44% of their
 * windows depending on where the artwork was put — neither of which says
 * anything about what a comic does. The numbers below were measured.
 */

/** A blank sheet of paper. */
function page (w: number, h: number): Sheet {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)

  return { data, w, h }
}

function put (sheet: Sheet, x: number, y: number, v: number) {
  if (x < 0 || y < 0 || x >= sheet.w || y >= sheet.h) return

  const at = (y * sheet.w + x) * 4

  sheet.data[at] = v
  sheet.data[at + 1] = v
  sheet.data[at + 2] = v
  sheet.data[at + 3] = 255
}

function rect (sheet: Sheet, x0: number, y0: number, x1: number, y1: number, v: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(sheet, x, y, v)
}

/** A closed outline, drawn thick enough to survive the erosion inside `grow`. */
function outline (sheet: Sheet, x0: number, y0: number, x1: number, y1: number) {
  for (let t = 0; t < 3; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) {
      put(sheet, x, y0 - t, 0)
      put(sheet, x, y1 + t, 0)
    }

    for (let y = y0 - t; y <= y1 + t; y++) {
      put(sheet, x0 - t, y, 0)
      put(sheet, x1 + t, y, 0)
    }
  }
}

/** Lettering: a few small blots of ink, the holes a fill is meant to close. */
function lettering (sheet: Sheet, x0: number, y0: number, rows: number, cols: number) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) rect(sheet, x0 + c * 10, y0 + r * 10, x0 + c * 10 + 6, y0 + r * 10 + 6, 0)
  }
}

describe('balloonIn', () => {
  it('holds inside a closed balloon, and closes the lettering in it', () => {
    const sheet = page(400, 400)

    outline(sheet, 140, 140, 260, 260)
    lettering(sheet, 165, 165, 6, 6)

    const balloon = balloonIn(sheet, { x: 165, y: 165, w: 66, h: 66 })

    expect(balloon).not.toBeNull()
    expect(balloon!.escaped).toBe(false)

    // The holes were closed: the mask is bigger than the paper the fill
    // actually touched, which is the whole job of `filled`.
    expect(balloon!.share).toBeGreaterThan(balloon!.grown)

    // ...but only by the ink. A balloon is a solid blob.
    expect(balloon!.solidity).toBeGreaterThan(0.9)
    expect(balloon!.share / balloon!.grown).toBeLessThan(1.5)

    // The room is inside the outline and around the lettering.
    expect(balloon!.room.x).toBeGreaterThanOrEqual(140)
    expect(balloon!.room.y).toBeGreaterThanOrEqual(140)
    expect(balloon!.room.x + balloon!.room.w).toBeLessThanOrEqual(261)
    expect(balloon!.room.y + balloon!.room.h).toBeLessThanOrEqual(261)
  })

  it('lets a balloon wider than the guess be as wide as it is', () => {
    // ECLIPSE p12: `別說話～`, a narrow column in a black circle three times
    // its width. The window used to be the detector's balloon cut to `REACH`
    // around the column, and the fill stopped on a straight line in the middle
    // of the balloon. The balloon the detector drew is a measurement; the
    // reach is a guess, and must not cut it.
    const sheet = page(400, 400)

    lettering(sheet, 195, 150, 8, 1)

    const seed = { x: 195, y: 150, w: 6, h: 76 }
    const bounds = { x: 60, y: 60, w: 280, h: 260 }
    const balloon = balloonIn(sheet, seed, bounds)

    expect(balloon).not.toBeNull()
    expect(balloon!.window.w).toBeGreaterThanOrEqual(bounds.w - 1)
    expect(balloon!.room.w).toBeGreaterThan(seed.w * 1.6 * 2 + seed.w)
  })

  it('cannot put anything outside the balloon it was given', () => {
    // A page with no outline anywhere: unbounded, the fill takes all of it.
    // The bound is the only thing that can stop it, so this asserts the
    // guarantee the whole pairing rests on rather than a number.
    const sheet = page(400, 400)

    lettering(sheet, 190, 190, 3, 3)

    const seed = { x: 190, y: 190, w: 26, h: 26 }
    // Tighter than `REACH` would reach, so the bound is what stops the fill.
    const bounds = { x: 170, y: 170, w: 70, h: 70 }

    const loose = balloonIn(sheet, seed)
    const tight = balloonIn(sheet, seed, bounds)

    expect(loose).not.toBeNull()
    expect(tight).not.toBeNull()

    // The window itself is cut to the bound...
    expect(tight!.window.x).toBeGreaterThanOrEqual(bounds.x)
    expect(tight!.window.y).toBeGreaterThanOrEqual(bounds.y)
    expect(tight!.window.x + tight!.window.w).toBeLessThanOrEqual(bounds.x + bounds.w)
    expect(tight!.window.y + tight!.window.h).toBeLessThanOrEqual(bounds.y + bounds.h)

    // ...and the loose one really would have gone further, or this proves
    // nothing about the bound.
    expect(loose!.window.w * loose!.window.h)
      .toBeGreaterThan(tight!.window.w * tight!.window.h)

    // The room lands inside the balloon too, which is the point of all of it.
    expect(tight!.room.x).toBeGreaterThanOrEqual(bounds.x)
    expect(tight!.room.x + tight!.room.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1)
  })

  /**
   * Measured on one page — Yoshida Wasabi, `2_8.jpg`, 4535px wide — with the
   * `full` detector, read off the bench's own labels.
   *
   * `sides` is how many of the window's four the interior reached, `share` how
   * much of the window it came to, `solidity` the interior against its own
   * bounding box. `leak` is what the page shows: whether that mask was drawn
   * over artwork or stayed in its balloon.
   *
   * Each of the three constants is load-bearing and this table is why. Sorting
   * by any one of them alone puts a held balloon on the wrong side:
   *
   * - `share` alone cannot separate them — the six that escaped came to 11–25%
   *   of their windows and the three that held to 8–14%, which overlap.
   * - `solidity` alone misses the caption, which escaped at 0.80.
   * - `sides` alone misses every one of the six, which reached 0 or 1.
   */
  const observed = [
    // Held: solid blobs, and the bench shows them inside their balloons.
    { what: 'bubble 581x857', sides: 0, share: 0.08, solidity: 0.76, leak: false },
    { what: 'bubble 347x546', sides: 0, share: 0.14, solidity: 0.76, leak: false },
    { what: 'bubble 276x446', sides: 0, share: 0.10, solidity: 0.79, leak: false },

    // Escaped into the pale background of their own panels. Every one of these
    // reads as held on `sides` and on `share`; only solidity separates them.
    { what: 'bubble 461x687 out in the panel', sides: 0, share: 0.18, solidity: 0.56, leak: true },
    { what: 'bubble 361x588 out in the panel', sides: 0, share: 0.11, solidity: 0.66, leak: true },
    { what: 'bubble 510x758 out in the panel', sides: 1, share: 0.24, solidity: 0.68, leak: true },
    { what: 'bubble 376x666 out in the panel', sides: 0, share: 0.25, solidity: 0.56, leak: true },
    { what: 'bubble 361x666 out in the panel', sides: 1, share: 0.25, solidity: 0.45, leak: true },
    { what: 'bubble 376x503 out in the panel', sides: 1, share: 0.20, solidity: 0.64, leak: true },

    // The caption over the building. Solid, so only `sides` and `share` catch
    // it — the case that keeps those two constants honest.
    { what: 'caption over the building', sides: 2, share: 0.386, solidity: 0.80, leak: true },
  ]

  it.each(observed)('unbounded: $what', ({ sides, share, solidity, leak }) => {
    expect(leaked(sides, share, solidity)).toBe(leak)
  })

  /**
   * The same nine bubbles, re-measured with the detector's balloon as the
   * window — which is the state the fill is actually in now.
   *
   * Every one of them fills most of what it was given and reaches its edges,
   * because the thing it was given is the balloon. Read with the unbounded
   * rule they are nine leaks; read correctly they are nine balloons, and the
   * solidity that separated leaks from balloons before now sits at 0.79–0.89
   * across the lot. This table exists so that `bounded` cannot be quietly
   * dropped from `leaked` without nine failures saying so.
   */
  const bounded = [
    { what: '581x857', sides: 2, share: 0.82, solidity: 0.88 },
    { what: '468x659', sides: 3, share: 0.83, solidity: 0.85 },
    { what: '361x588', sides: 1, share: 0.76, solidity: 0.80 },
    { what: '404x680', sides: 3, share: 0.88, solidity: 0.89 },
    { what: '376x666', sides: 2, share: 0.77, solidity: 0.80 },
    { what: '361x666', sides: 4, share: 0.82, solidity: 0.82 },
    { what: '347x546', sides: 1, share: 0.75, solidity: 0.80 },
    { what: '276x446', sides: 0, share: 0.70, solidity: 0.79 },
    { what: '326x595', sides: 2, share: 0.80, solidity: 0.85 },
  ]

  it.each(bounded)('bounded: $what holds', ({ sides, share, solidity }) => {
    expect(leaked(sides, share, solidity, true)).toBe(false)

    // ...and would have been called a leak by the unbounded rule, which is
    // why the flag is not cosmetic.
    expect(leaked(sides, share, solidity)).toBe(true)
  })

  /**
   * The bounded escapes from a ten-page sweep of the same chapter, each crop
   * read by eye. Five are the fill grabbing screentone off a body inside a
   * mis-drawn bubble box; three are real balloons whose shape is simply not an
   * oval — a teardrop, a wide oval with a tail, a spiked hex — filled exactly
   * and rejected by the unbounded floor. `SOLID_BOUNDED` sits in the gap
   * between the two groups (0.62 → 0.69), and this table is that gap.
   */
  const sweep = [
    { what: 'p14 tone off a body', sides: 4, share: 0.47, solidity: 0.47, leak: true },
    { what: 'p14 tone off a body, second', sides: 4, share: 0.57, solidity: 0.57, leak: true },
    { what: 'p17 tone behind sfx', sides: 4, share: 0.51, solidity: 0.51, leak: true },
    { what: 'p21 tone behind sfx', sides: 4, share: 0.57, solidity: 0.57, leak: true },
    { what: 'p37 a mane, not a balloon', sides: 4, share: 0.62, solidity: 0.62, leak: true },
    { what: 'p33 spiked hex balloon', sides: 1, share: 0.62, solidity: 0.69, leak: false },
    { what: 'p17 teardrop balloon', sides: 1, share: 0.64, solidity: 0.70, leak: false },
    { what: 'p29 oval balloon with tail', sides: 1, share: 0.67, solidity: 0.71, leak: false },
  ]

  it.each(sweep)('bounded sweep: $what', ({ sides, share, solidity, leak }) => {
    expect(leaked(sides, share, solidity, true)).toBe(leak)
  })

  /**
   * The bounded "escapes" of a whole second chapter — istani's, 19 pages, every
   * fill traced on the page in the OCR lab and read by eye. Not one had left
   * its balloon. Five are spiked bursts filled exactly to their outline, whose
   * spikes put them under `SOLID_BOUNDED` (0.55–0.66); three are ovals with the
   * lettering touching the outline, filled exactly too. What none of them did is
   * reach all four sides of the window, which every tone-grab above did — that
   * is the difference the bounded rule now reads, and this table is why.
   */
  const bursts = [
    { what: 'p6 射了，射了!! burst', sides: 1, share: 0.50, solidity: 0.55 },
    { what: 'p9 鸡巴…停不下来 burst', sides: 0, share: 0.51, solidity: 0.60 },
    { what: 'p9 哈啊啊!!!! burst', sides: 1, share: 0.52, solidity: 0.58 },
    { what: 'p15 哈啊啊嗯 burst', sides: 0, share: 0.47, solidity: 0.56 },
    { what: 'p16 啊？! burst', sides: 0, share: 0.53, solidity: 0.66 },
    { what: 'p5 oval, lettering to its edge', sides: 3, share: 0.64, solidity: 0.65 },
    { what: 'p6 嗯？ oval on dark tone', sides: 0, share: 0.41, solidity: 0.62 },
    { what: 'p12 哈啊 oval, lettering to its edge', sides: 0, share: 0.49, solidity: 0.64 },
  ]

  it.each(bursts)('bounded, istani: $what holds', ({ sides, share, solidity }) => {
    expect(leaked(sides, share, solidity, true)).toBe(false)
  })
})
