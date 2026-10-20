/**
 * What colour the page is under a block, so the words set on it can be a colour
 * you can read against it.
 *
 * The bug this exists for: every line was set in `neutral-900` because comics
 * are printed on white paper, and comics are not all printed on white paper. A
 * black balloon — a night panel, a whispered line, half of any horror chapter —
 * got dark ink on a dark ground, and the translation was invisible on a page
 * whose original lettering had been perfectly legible.
 *
 * Read off the *scan*, not off what is currently drawn. Two reasons, and the
 * second is the load-bearing one:
 *
 * - The scan is the only thing here that can be read at all. The page on screen
 *   is a pile of layers with a cleaned patch, a placed image and a sheet of
 *   paint in it, and reading it back would mean flattening the stack on every
 *   frame to decide how to draw the stack.
 * - What the repair fills a balloon with *is* the colour around the hole — see
 *   `flatContext` in `ocr/clean`, which takes the same median of the same ring.
 *   So the scan's answer and the cleaned page's answer are the same answer, and
 *   this one is available before a single block has been cleaned.
 *
 * Inside the block, not around it — and that is the second design, not the
 * first. The first read a ring *around* the block, on the reasoning that the
 * inside is the printed lettering and the lettering is the one part of a
 * balloon that is not the balloon's colour. That treats type as a solid fill,
 * which it is not: in a box drawn round lettering the strokes are a minority
 * and the paper between them is most of what is there — the same fact
 * `papersIn` in `ocr/balloon` already leans on. A ring, meanwhile, has to reach
 * past the lettering, and a block usually fills its balloon, so the ring's
 * reach (four-tenths of the short edge) was out past the outline and onto the
 * art. A white balloon set tight on a dark ground read as dark and was lettered
 * in white. Across the 324 translated blocks of two finished chapters, the
 * ring and the inside disagreed on four, and those were the three a reader had
 * set to black by hand and a fourth nobody had caught.
 *
 * And inside the block's *shape*, not its unturned rectangle. A phone message
 * turned twenty degrees, read as the rectangle it would be unturned, is a flat
 * strip across the tone the message sits on.
 */
import { scanAside } from './raster/decoder'

import type { Paper } from '#shared/utils/lettering'
import type { Boxed } from '#shared/utils/transform'

import { cornersOf, mapped, matrixOf, toOriented } from '#shared/utils/transform'

/**
 * The page, small enough to read in one go.
 *
 * A downsample rather than the scan's own pixels, because this is a question
 * about large flat areas and it is asked again on every drag of every handle. A
 * 4000px scan is 16 megapixels to `getImageData`; at 640 across it is under a
 * megapixel, and a balloon is still forty pixels wide in it.
 *
 * Averaging during the downsample is exactly what we want here and would be
 * wrong anywhere else: it is the ring's *median* that is being taken, and a
 * blur of paper with paper is still paper.
 */
export interface Sheet {
  data: Uint8ClampedArray
  w: number
  h: number
}

/** How wide the page is read at. See `Sheet` for why it is small. */
const SHEET_WIDTH = 640

/**
 * Below this many pixels a median is noise — a block a few pixels across on the
 * sheet — and the reading widens to the shape's bounds and a margin round them.
 */
const SAMPLES_MIN = 24

/**
 * The page at reading size, or nothing if the browser could not decode it.
 *
 * `createImageBitmap` on the `File` rather than on the object URL: the bytes are
 * already in hand and the URL is only good for drawing.
 */
export async function readSheet (file: File): Promise<Sheet | null> {
  try {
    const bitmap = await createImageBitmap(file)

    const w = Math.max(1, Math.min(SHEET_WIDTH, bitmap.width))
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w))

    return sheetFrom(bitmap, w, h)
  } catch {
    // A page that will not decode is a page with no colour to report, which
    // every caller already has to handle — the first frame draws before any of
    // this has happened. Not an error worth stopping a render for.
    return null
  }
}

/**
 * The page at reading size, from the scan decoder's background thread rather
 * than a decode of its own here — for a scan whose size is already known, which
 * is every scan on screen.
 *
 * `readSheet` decodes the whole file on this thread's behalf to shrink it to
 * 640 pixels: on a 3732 × 5197 page, 78 MB for a 1.3 MB answer, on every page
 * turn. And not on the thread the page itself is decoded on — see `scanAside`
 * for what that cost a page turn.
 */
export async function readScanSheet (scan: { url: string, file: File, width: number, height: number }): Promise<Sheet | null> {
  const w = Math.max(1, Math.min(SHEET_WIDTH, scan.width))
  const h = Math.max(1, Math.round((scan.height / scan.width) * w))

  try {
    // Low, as `readSheet`'s canvas shrink is: an averaging downscale blends
    // outline and lettering into the paper a median is meant to find, and was
    // measured moving a white balloon to 239. At low, all 101 blocks of a
    // finished chapter read within two levels of what they did.
    const bitmap = await scanAside(scan.url, scan.file, w, h, 'low')

    return sheetFrom(bitmap, w, h)
  } catch {
    return null
  }
}

/** A bitmap already at reading size, as pixels. Closes the bitmap either way. */
function sheetFrom (bitmap: ImageBitmap, w: number, h: number): Sheet | null {
  try {
    const canvas = new OffscreenCanvas(w, h)
    const context = canvas.getContext('2d', { willReadFrequently: true })

    if (!context) {
      bitmap.close()

      return null
    }

    context.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()

    return { data: context.getImageData(0, 0, w, h).data, w, h }
  } catch {
    bitmap.close()

    return null
  }
}

/**
 * The colour of the page under a block, as a median per channel.
 *
 * `box` is in percentages of the page, like every box in this app, with its
 * turn, lean and pulled corners — the shape the block is drawn as. Pulled
 * corners are offsets in scan pixels, so they need the scan's width to be
 * brought down to the sheet's; without it they are left off, which is the
 * rectangle the corners were pulled from.
 *
 * Median rather than mean, and per channel rather than over luminance. The mean
 * is dragged by the printed lettering; the median is not moved by it until the
 * strokes are most of what was looked at, which in a box drawn round type they
 * are not. Per channel because the answer is handed to `inkOn`, which weighs the
 * channels differently — a mean of luminances would have thrown away the hue
 * before the one function that needs it could see it.
 */
export function paperAt (sheet: Sheet, box: Boxed, scan?: { width: number }): Paper | null {
  const { data, w, h } = sheet
  const shape = toOriented(box, { width: w, height: h })

  if (shape.w <= 0 || shape.h <= 0) return null

  const scale = scan?.width ? w / scan.width : 0

  shape.quad = scale && shape.quad ? shape.quad.map((v) => v * scale) : null

  const m = matrixOf(shape)
  const corners = cornersOf(shape).map(({ x, y }) => {
    const out = mapped(m, x, y)

    return { x: shape.cx + out.x, y: shape.cy + out.y }
  })

  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  const bounds = {
    left: Math.max(0, Math.floor(Math.min(...xs))),
    top: Math.max(0, Math.floor(Math.min(...ys))),
    right: Math.min(w, Math.ceil(Math.max(...xs))),
    bottom: Math.min(h, Math.ceil(Math.max(...ys))),
  }

  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]

  /** Count the pixels whose centres `keep` says are in, over the bounds grown by `margin`. */
  const gather = (margin: number, keep: (x: number, y: number) => boolean) => {
    let count = 0

    for (let y = Math.max(0, bounds.top - margin); y < Math.min(h, bounds.bottom + margin); y++) {
      for (let x = Math.max(0, bounds.left - margin); x < Math.min(w, bounds.right + margin); x++) {
        if (!keep(x + 0.5, y + 0.5)) continue

        const at = (y * w + x) * 4

        histograms[0]![data[at]!]!++
        histograms[1]![data[at + 1]!]!++
        histograms[2]![data[at + 2]!]!++
        count++
      }
    }

    return count
  }

  let count = gather(0, (x, y) => inside(corners, x, y))

  if (count < SAMPLES_MIN) {
    histograms.forEach((histogram) => histogram.fill(0))
    count = gather(2, () => true)
  }

  if (!count) return null

  /** The level half the samples sit below — the robust centre, per channel. */
  const middle = (histogram: Uint32Array) => {
    let seen = 0

    for (let level = 0; level < 256; level++) {
      seen += histogram[level]!

      if (seen * 2 >= count) return level
    }

    return 255
  }

  return { r: middle(histograms[0]!), g: middle(histograms[1]!), b: middle(histograms[2]!) }
}

/**
 * Whether a point is inside a four-cornered outline — by counting crossings, so
 * a quad pulled out of convexity is still asked about the shape it is drawn as.
 */
function inside (corners: { x: number, y: number }[], x: number, y: number): boolean {
  let within = false

  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i]!
    const b = corners[j]!

    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) within = !within
  }

  return within
}
