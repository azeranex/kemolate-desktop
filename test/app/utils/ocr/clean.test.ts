import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The part of the repair that decides there is nothing to invent, and the page
 * it was found on.
 *
 * `flatContext`, `flatFill` and `paintOver` are auto-imported, the way the app
 * reaches them, and all three are pure arithmetic over plain arrays — which is
 * the whole reason this decision was put where it is. Everything else in
 * `clean.ts` needs a model, a canvas and a page.
 *
 * The case is the two title blocks on page 4 of Eclipse 2: extra bold CJK
 * glyphs on plain white paper, no banner and nothing behind them. The strokes
 * are nearly half the crop, so the mask is an enormous hole and the inpainter
 * is asked to invent plausible content for a rectangle of blank paper. It
 * obliges — measured at mean luminance 216 with 15% of the block still
 * near-black, where the paper it should be is 255 and none. Every honest
 * answer for a hole in blank paper is the paper.
 */

/** A greyscale tile as RGBA, so the value written is the value read back. */
function tile (w: number, h: number, grey: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const value = grey(x, y)
      const at = (y * w + x) * 4

      data[at] = value
      data[at + 1] = value
      data[at + 2] = value
      data[at + 3] = 255
    }
  }

  return data
}

const w = 64
const h = 64

/** The block's own box on the tile — a quarter margin all round, as `CONTEXT`. */
const inner = { x: 16, y: 16, w: 32, h: 32 }

const insideBlock = (x: number, y: number) =>
  x >= inner.x && y >= inner.y && x < inner.x + inner.w && y < inner.y + inner.h

describe('flatContext', () => {
  it('reads blank paper through heavy lettering', () => {
    // Half the block is ink, which is what makes this page hard: measured over
    // the *crop* this is anything but uniform. The ring is what is asked.
    const data = tile(w, h, (x, y) => (insideBlock(x, y) && x < inner.x + 16 ? 8 : 250))

    const flat = flatContext(data, w, h, inner)

    expect(flat).not.toBeNull()
    expect(flat!.r).toBe(250)
    expect(flat!.g).toBe(250)
    expect(flat!.b).toBe(250)
    expect(flat!.share).toBe(1)
  })

  it('is not thrown off by scanner noise, or by one dark corner', () => {
    const data = tile(w, h, (x, y) => {
      if (insideBlock(x, y)) return 8
      // A panel border clipping one corner of the crop: a mean would be
      // dragged by it and a variance dominated by it. About 1.5% of the ring.
      if (x < 6 && y < 6) return 0

      return 248 + ((x * 7 + y * 3) % 5)
    })

    const flat = flatContext(data, w, h, inner)

    expect(flat).not.toBeNull()
    expect(flat!.r).toBeGreaterThanOrEqual(248)
    expect(flat!.r).toBeLessThanOrEqual(252)
  })

  it('refuses a ring with a drawing in it', () => {
    // Screentone: two levels far further apart than the tolerance, half the
    // ring each. Filling this block would paint a flat rectangle over the art.
    const data = tile(w, h, (x, y) => {
      if (insideBlock(x, y)) return 8

      return (x + y) % 2 ? 255 : 40
    })

    expect(flatContext(data, w, h, inner)).toBeNull()
  })

  it('refuses a gradient that has no one colour', () => {
    const data = tile(w, h, (x, y) => (insideBlock(x, y) ? 8 : Math.round((x / (w - 1)) * 255)))

    expect(flatContext(data, w, h, inner)).toBeNull()
  })

  it('refuses a ring too small to be evidence', () => {
    // A block that fills its own crop. A handful of pixels agree with their
    // own median every time, so without a floor the emptiest ring is the one
    // most certain the page is blank.
    const data = tile(w, h, () => 250)

    expect(flatContext(data, w, h, { x: 0, y: 0, w, h })).toBeNull()
  })
})

describe('the flat fill, through the composite', () => {
  const data = tile(w, h, (x, y) => (insideBlock(x, y) ? 8 : 250))

  /** A mask over the middle of the block, well clear of the ring. */
  const soft = new Float32Array(w * h)

  for (let y = 24; y < 40; y++) {
    for (let x = 24; x < 40; x++) soft[y * w + x] = 1
  }

  it('lands the colour of the ring in the masked pixels and nowhere else', () => {
    const flat = flatContext(data, w, h, inner)

    expect(flat).not.toBeNull()

    const out = paintOver(data, flatFill(flat!, w * h), soft, w, h)
    const at = (x: number, y: number) => out[(y * w + x) * 4]!

    // Inside the mask: the paper, exactly. This is the assertion the whole
    // change is about — the model would have invented something here.
    expect(at(32, 32)).toBe(250)
    expect(at(25, 25)).toBe(250)

    // Two pixels clear of the mask: untouched artwork. The composite feathers
    // by one pixel, so the neighbour of a masked pixel is half blended and
    // anything past it is the original — see `paintOver`.
    expect(at(21, 32)).toBe(8)
    expect(at(32, 42)).toBe(8)

    // And the ring the colour was read off is left as it was.
    expect(at(2, 2)).toBe(250)
  })

  it('fills with the colour it was given, not with white', () => {
    // A night panel: flat black paper is as fillable as flat white, and a fill
    // that assumed white would be a hole punched in the dark.
    const dark = tile(w, h, (x, y) => (insideBlock(x, y) ? 230 : 20))
    const flat = flatContext(dark, w, h, inner)

    expect(flat).not.toBeNull()

    const out = paintOver(dark, flatFill(flat!, w * h), soft, w, h)

    expect(out[(32 * w + 32) * 4]).toBe(20)
  })
})

/**
 * The decoded page, kept between cleans of the same page.
 *
 * The mask brush cleans one block per correction, and each clean decoded the
 * whole scan to cut one crop from it — 60–70 ms a stroke on a 2654×4025 PNG,
 * paid again on every correction to the same caption. A page run with no
 * regions still takes the page, which is what lets this watch the decode
 * without a model or a canvas.
 */
describe('cleanPage, on the page it cleaned a moment ago', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function decoder () {
    const made: { close: ReturnType<typeof vi.fn> }[] = []

    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const bitmap = { width: 600, height: 900, close: vi.fn() }

      made.push(bitmap)

      return bitmap
    }))

    return made
  }

  it('decodes the page once for a run of cleans on it', async () => {
    const made = decoder()
    const page = { file: new File(['a'], '1.png'), width: 600 }

    await cleanPage(page, [])
    await cleanPage(page, [])
    await cleanPage(page, [])

    expect(made).toHaveLength(1)
    expect(made[0]!.close).not.toHaveBeenCalled()
  })

  it('lets the page go when another is asked for, and after a while on its own', async () => {
    vi.useFakeTimers()

    const made = decoder()

    await cleanPage({ file: new File(['a'], '1.png'), width: 600 }, [])
    await cleanPage({ file: new File(['b'], '2.png'), width: 600 }, [])

    // The first is closed as soon as nothing is drawing from it.
    await vi.runAllTimersAsync()
    expect(made[0]!.close).toHaveBeenCalledOnce()

    // And the second once it has sat unused past the keep.
    expect(made[1]!.close).toHaveBeenCalledOnce()
  })

  it('never answers a replaced file with the pixels of the one before it', async () => {
    const made = decoder()

    await cleanPage({ file: new File(['a'], '1.png'), width: 600 }, [])
    // Same name and size, different object — a page linked or fetched again.
    await cleanPage({ file: new File(['a'], '1.png'), width: 600 }, [])

    expect(made).toHaveLength(2)
  })
})
