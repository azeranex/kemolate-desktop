/**
 * Work on a whole page that ends in something other than a bitmap for the page
 * engine — a thumbnail, a copy for somebody else to look at, the pixels a model
 * reads — done on the background decoder rather than on the page's thread.
 *
 * What it moves is the *shrinking*, not the decoding. Measured on a 3732 × 5197
 * JPEG in Chrome, on the main thread:
 *
 * - `createImageBitmap(file)` at full size: 158 ms, and the page never noticed
 *   — no frame over 9.4 ms. Chrome decodes a `Blob` on a thread of its own.
 * - the same with `resizeWidth`: 197 ms, with one frame of 41. The resize runs
 *   where it was asked for.
 * - `drawImage` of the full bitmap onto a 1600 px canvas: one frame of 50.
 * - transformers.js's `RawImage.fromBlob`, which draws the whole page and reads
 *   every pixel back: one frame of 168.
 *
 * So a reader that needs the page at full size — the brush's clone and heal,
 * a clean, the recognisers cutting out balloons, the mask plate — is left
 * where it is: it has nothing to gain here, and a bitmap handed across would
 * be the same 78 MB either way. Everything that makes the page smaller, or
 * reads all of it back, comes here.
 *
 * Every job is the same drawing it was on the main thread, step for step —
 * the same decode, the same canvas calls, the same smoothing — so the pixels
 * out are the pixels that came out before. `willReadFrequently` is kept where
 * it was, because it chooses the software rasteriser, and the segmenter's and
 * the detector's inputs were compared against it.
 *
 * Imports are written out: this runs in a worker, where Nuxt's auto-imports
 * do not reach.
 */
import { imageDimensions } from '../dimensions'

import type { RenditionRegion } from '../rendition'

export type Job =
  /** A thumbnail — see `thumbs.ts`. */
  | { what: 'thumb', width: number, type: string, quality: number }
  /** A copy for the MCP relay — see `rendition.ts`. */
  | { what: 'rendition', maxEdge: number, quality: number, region: RenditionRegion | null }
  /** The page as a vision model is sent it — see `shrinkForModel`. */
  | { what: 'model', maxEdge: number, type: string, quality: number }
  /**
   * A page's repairs drawn into one transparent picture, `width` × `height`,
   * each at its place in scan pixels times `scale` — see `cleaningSignature`
   * in `previews.ts`. The repairs are fetched here by their object URLs, which
   * a worker of the same page can read.
   */
  | { what: 'cleaning', width: number, height: number, scale: number, repairs: { url: string, sx: number, sy: number, sw: number, sh: number }[] }
  /**
   * The page — the file handed in, which is its preview — small, with its
   * repairs drawn over it: a sketch (`SKETCH_WIDTH` in `previews.ts`).
   */
  | { what: 'sketch', width: number, height: number, scale: number, repairs: { url: string, sx: number, sy: number, sw: number, sh: number }[] }
  /**
   * The page drawn onto a canvas and read back, for a model's input tensor.
   *
   * `canvas` is the canvas's size, or `page` for the page's own. `draw` is
   * where the page goes on it: `edge` scales its longest side to that many
   * pixels, from the top left; left out, the page fills the canvas. `fill` is
   * painted first, for a page that does not cover it.
   *
   * `via: 'rgb'` draws it the way transformers.js resizes an image it has read
   * with `RawImage.fromBlob` and turned to RGB: the page read back whole, its
   * alpha set opaque, put onto a canvas of its own, and that canvas drawn down.
   * The detector's processor did exactly that on the page's thread, over all
   * nineteen million pixels of a large page; given the result, its own resize
   * is a copy at the same size. A JPEG skips the read-back, having no alpha to
   * set — see `pixels`.
   */
  | {
    what: 'pixels'
    canvas: { width: number, height: number } | 'page'
    draw?: { edge: number }
    fill?: string
    smoothing?: ImageSmoothingQuality
    via?: 'rgb'
    readable: boolean
  }

export interface JobResult {
  /** The size of what came out — for `pixels`, the page's own. */
  width: number
  height: number
  blob?: Blob
  /** RGBA, the canvas's size, row by row. */
  pixels?: Uint8ClampedArray
  /** The file itself is the answer: nothing was made. */
  same?: boolean
}

/**
 * Run one job. `full` is the page's full decode, from the host — held where it
 * can be, so a caller that asked for the size first does not pay for a second.
 */
export async function runJob (file: Blob, job: Job, full: () => Promise<ImageBitmap>): Promise<JobResult | null> {
  switch (job.what) {
    case 'thumb': return thumb(file, job)
    case 'rendition': return rendition(file, job)
    case 'model': return model(await full(), job)
    case 'cleaning': return cleaning(job)
    case 'sketch': return sketch(file, job)
    case 'pixels': return pixels(await full(), job, file.type)
  }
}

/**
 * `createImageBitmap` with `resizeWidth` is the part that matters: it decodes
 * *and* scales in one step, in the browser's own image pipeline, so the
 * full-size bitmap never has to exist. Drawing the file into a canvas at a
 * smaller size would decode it whole first and undo the point.
 *
 * The size off the header rather than off a decode. Decoding the whole scan to
 * learn its width and then again at thumbnail size was two decodes a page — 70
 * ms each at 2700 × 4000. The width alone is named and the height left to
 * follow, so a JPEG turned by its EXIF comes out the right shape. Only a header
 * this cannot read pays for the extra decode. A scan smaller than the thumbnail
 * is left alone rather than blown up.
 */
async function thumb (file: Blob, job: Extract<Job, { what: 'thumb' }>): Promise<JobResult | null> {
  const header = await imageDimensions(file)
  const bitmap = header ? null : await createImageBitmap(file)
  const width = header?.width ?? bitmap!.width

  const small = width > job.width
    ? await createImageBitmap(file, { resizeWidth: job.width, resizeQuality: 'high' })
    : bitmap ?? await createImageBitmap(file)

  try {
    const canvas = new OffscreenCanvas(small.width, small.height)
    const context = canvas.getContext('2d')

    if (!context) return null

    context.drawImage(small, 0, 0)

    const blob = await canvas.convertToBlob({ type: job.type, quality: job.quality })

    return { width: small.width, height: small.height, blob }
  } finally {
    bitmap?.close()
    if (small !== bitmap) small.close()
  }
}

const RENDITION_TYPE = 'image/jpeg'

/**
 * When the file itself is the better answer.
 *
 * A page already smaller than the bound gains nothing from being re-encoded and
 * routinely *loses*: a 232 KB JPEG came back out of the canvas at 255 KB, worse
 * to look at and 10% more for the reader to upload. So where the source is
 * already a JPEG, already within the bound, and small enough to be worth
 * nobody's second thought, it goes as it is.
 *
 * Only for a whole-page ask. A region is by definition not the file.
 */
const PASSTHROUGH_BYTES = 1.5 * 1024 * 1024

async function rendition (file: Blob, job: Extract<Job, { what: 'rendition' }>): Promise<JobResult | null> {
  const { maxEdge, quality, region } = job
  let bitmap: ImageBitmap | null = null
  let small: ImageBitmap | null = null

  try {
    /*
     * A whole page: its size read off the header, and then one decode, straight
     * to the size it travels at. It used to decode the full scan first just to
     * learn the size and then decode it again resized, which left the one thing
     * the resize is for — the full-size bitmap never existing — undone. The
     * resize names the width alone and lets the height follow, so a JPEG turned
     * by its EXIF, whose header has the sides the other way round, still comes
     * out the right shape. A header this cannot read goes the old way, below.
     */
    const header = region ? null : await imageDimensions(file)

    if (header) {
      const edge = Math.max(header.width, header.height)

      if (file.type === RENDITION_TYPE && file.size <= PASSTHROUGH_BYTES && edge <= maxEdge) {
        return { width: header.width, height: header.height, same: true }
      }

      const fit = Math.min(1, maxEdge / edge)

      small = fit < 1
        ? await createImageBitmap(file, { resizeWidth: Math.max(1, Math.round(header.width * fit)), resizeQuality: 'high' })
        : await createImageBitmap(file)

      return await onPaper(small.width, small.height, (context) => context.drawImage(small!, 0, 0), quality)
    }

    bitmap = await createImageBitmap(file)

    if (
      !region
      && file.type === RENDITION_TYPE
      && file.size <= PASSTHROUGH_BYTES
      && Math.max(bitmap.width, bitmap.height) <= maxEdge
    ) {
      return { width: bitmap.width, height: bitmap.height, same: true }
    }

    /*
     * The rectangle in the scan's own pixels.
     *
     * Both axes are divided by the *width*, which is the convention every box
     * in this app uses — so the multiplier here is `bitmap.width` for `y` and
     * `h` as well, and that is not a bug to tidy. Clamped to the page, because
     * a caller padding a balloon by a margin will routinely ask for a rectangle
     * that runs off the edge, and the honest answer is the part that exists.
     */
    const source = region
      ? (() => {
          const x = Math.max(0, Math.round(region.x * bitmap!.width))
          const y = Math.max(0, Math.round(region.y * bitmap!.width))

          return {
            x,
            y,
            w: Math.max(1, Math.min(bitmap!.width - x, Math.round(region.w * bitmap!.width))),
            h: Math.max(1, Math.min(bitmap!.height - y, Math.round(region.h * bitmap!.width))),
          }
        })()
      : { x: 0, y: 0, w: bitmap.width, h: bitmap.height }

    /*
     * Scaled *up* where the region is small, which is the whole point of asking
     * for one. A balloon eighty pixels across is unreadable at eighty pixels
     * and perfectly legible at six hundred; the bound is a ceiling on what
     * travels, not a description of the crop. Capped at four times so a
     * one-character sound effect does not come back as a megabyte of blur.
     */
    const scale = Math.min(maxEdge / Math.max(source.w, source.h), region ? 4 : 1)

    const width = Math.max(1, Math.round(source.w * scale))
    const height = Math.max(1, Math.round(source.h * scale))

    // `createImageBitmap`'s own resize only takes the whole image, so a region
    // is drawn through the canvas instead. Full pages still go the cheap way,
    // which is the case where the heap cost actually matters.
    small = region
      ? null
      : scale < 1
        ? await createImageBitmap(file, {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: 'high',
          })
        : bitmap

    return await onPaper(width, height, (context) => {
      if (small) context.drawImage(small, 0, 0)
      else context.drawImage(bitmap!, source.x, source.y, source.w, source.h, 0, 0, width, height)
    }, quality)
  } finally {
    if (small && small !== bitmap) small.close()
    bitmap?.close()
  }
}

/**
 * A picture drawn onto white and encoded — the last step of every rendition.
 *
 * White underneath, before anything else. JPEG has no alpha, and a transparent
 * PNG drawn onto an empty canvas and encoded as one comes out with black where
 * the page was clear — which on a scan with a cut-out border is most of it.
 * Comics are on white paper; this is the answer that looks like the page rather
 * than the negative of it.
 */
async function onPaper (
  width: number,
  height: number,
  draw: (context: OffscreenCanvasRenderingContext2D) => void,
  quality: number,
): Promise<JobResult | null> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')

  if (!context) return null

  context.imageSmoothingQuality = 'high'
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  draw(context)

  const blob = await canvas.convertToBlob({ type: RENDITION_TYPE, quality })

  return { blob, width, height }
}

/**
 * Lossless, like the preview it lies over (quality 1 is lossless for WebP): a
 * repair is exactly what the page shows, and anything else would be a second,
 * slightly different cleaning of the same balloon for the moment it was shown.
 * Null if any repair will not decode — a cleaning missing a balloon would show
 * that balloon's printed lettering, which is the whole thing this avoids.
 */
async function cleaning (job: Extract<Job, { what: 'cleaning' }>): Promise<JobResult | null> {
  const canvas = new OffscreenCanvas(job.width, job.height)
  const context = canvas.getContext('2d')

  if (!context) return null

  context.imageSmoothingQuality = 'high'

  for (const repair of job.repairs) {
    const blob = await fetch(repair.url).then((response) => response.blob()).catch(() => null)
    const bitmap = blob ? await createImageBitmap(blob).catch(() => null) : null

    if (!bitmap) return null

    context.drawImage(bitmap, repair.sx * job.scale, repair.sy * job.scale, repair.sw * job.scale, repair.sh * job.scale)
    bitmap.close()
  }

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 })

  return { width: job.width, height: job.height, blob }
}

/**
 * Lossy, and white underneath for the reason `onPaper` gives. A repair that
 * will not decode spoils the sketch rather than leaving a hole in it — see
 * `cleaning`.
 */
async function sketch (file: Blob, job: Extract<Job, { what: 'sketch' }>): Promise<JobResult | null> {
  const base = await createImageBitmap(file, { resizeWidth: job.width, resizeHeight: job.height, resizeQuality: 'high' }).catch(() => null)

  if (!base) return null

  const canvas = new OffscreenCanvas(job.width, job.height)
  const context = canvas.getContext('2d')

  if (!context) return null

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, job.width, job.height)
  context.drawImage(base, 0, 0)
  base.close()
  context.imageSmoothingQuality = 'high'

  for (const repair of job.repairs) {
    const blob = await fetch(repair.url).then((response) => response.blob()).catch(() => null)
    const bitmap = blob ? await createImageBitmap(blob).catch(() => null) : null

    if (!bitmap) return null

    context.drawImage(bitmap, repair.sx * job.scale, repair.sy * job.scale, repair.sw * job.scale, repair.sh * job.scale)
    bitmap.close()
  }

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })

  return { width: job.width, height: job.height, blob }
}

/** Within the bound already: the file goes as it is. */
async function model (bitmap: ImageBitmap, job: Extract<Job, { what: 'model' }>): Promise<JobResult | null> {
  const scale = Math.min(1, job.maxEdge / Math.max(bitmap.width, bitmap.height))

  if (scale === 1) return { width: bitmap.width, height: bitmap.height, same: true }

  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')

  if (!context) return { width: bitmap.width, height: bitmap.height, same: true }

  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  const blob = await canvas.convertToBlob({ type: job.type, quality: job.quality })

  return { width: canvas.width, height: canvas.height, blob }
}

/**
 * Whether a file of this type decodes with nothing but opaque pixels. JPEG has
 * no alpha channel to carry anything else.
 */
const opaque = (type: string) => type === 'image/jpeg'

function pixels (bitmap: ImageBitmap, job: Extract<Job, { what: 'pixels' }>, type: string): JobResult | null {
  const size = job.canvas === 'page' ? { width: bitmap.width, height: bitmap.height } : job.canvas
  const canvas = new OffscreenCanvas(size.width, size.height)
  const context = (job.readable ? canvas.getContext('2d', { willReadFrequently: true }) : canvas.getContext('2d'))

  if (!context) return null

  if (job.fill) {
    context.fillStyle = job.fill
    context.fillRect(0, 0, size.width, size.height)
  }

  if (job.smoothing) context.imageSmoothingQuality = job.smoothing

  if (job.canvas === 'page') {
    context.drawImage(bitmap, 0, 0)
  } else if (job.via === 'rgb' && opaque(type)) {
    // The drawing below without its round trip, whose only effect is to set
    // every alpha to 255 — which a JPEG's already is. On a 3732 × 5197 page that
    // was 78 MB read back and written again to change nothing: 195–225 ms a
    // job with it, 115–145 without, and the same bytes out (SHA-256 of the
    // pixels compared on four pages). The canvas in between is not the waste it
    // looks: drawn straight from the bitmap, the page came out different.
    const whole = new OffscreenCanvas(bitmap.width, bitmap.height)
    const read = whole.getContext('2d')

    if (!read) return null

    read.drawImage(bitmap, 0, 0)
    context.drawImage(whole, 0, 0, size.width, size.height)
  } else if (job.via === 'rgb') {
    // `fromBlob`: drawn at its own size on a default canvas and read back.
    const whole = new OffscreenCanvas(bitmap.width, bitmap.height)
    const read = whole.getContext('2d')

    if (!read) return null

    read.drawImage(bitmap, 0, 0)

    // `rgb()` then `toCanvas()`: the alpha dropped and put back opaque.
    const image = read.getImageData(0, 0, bitmap.width, bitmap.height)

    for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255

    read.putImageData(image, 0, 0)

    // `resize`: that canvas drawn onto one of the new size.
    context.drawImage(whole, 0, 0, size.width, size.height)
  } else if (job.draw) {
    const scale = job.draw.edge / Math.max(bitmap.width, bitmap.height)

    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  } else {
    context.drawImage(bitmap, 0, 0, size.width, size.height)
  }

  const { data } = context.getImageData(0, 0, size.width, size.height)

  return { width: bitmap.width, height: bitmap.height, pixels: data }
}
