/**
 * A finished page as a file — the encoding half of an export, written once and
 * run wherever there is a thread for it: an encoder worker (`encoder.ts`), or
 * this one where no worker can be had.
 *
 * It was `toBlob` on the composed canvas, on the main thread, and that was the
 * slow half of every export. Measured on 3732 × 5197 pages: 1.13 s wall a JPEG
 * page with a ~100 ms stall of the page (PNG 1.25 s, 230 ms), because Chrome
 * reads the canvas back where it was asked and then encodes in idle time — of
 * which a tab in the background gets almost none. `convertToBlob` in a worker
 * is 212 ms a JPEG page and 267 ms a PNG, and the page never notices.
 *
 * The page arrives as the bitmap the composed canvas was copied into, and is
 * put on a canvas of exactly its size at the origin, nothing scaled, nothing
 * smoothed — so the pixels encoded are the canvas's pixels, and the encoder is
 * the same one `toBlob` used. Checked in Chrome on the eight 3732 × 5197 pages
 * of the test chapter, each drawn once and encoded both ways: every PNG and
 * every JPEG came out byte for byte what `toBlob` made of the same canvas, and
 * so did a page with translucent and fully transparent pixels in it.
 *
 * On a 2D canvas rather than a `bitmaprenderer` one, which takes the bitmap
 * without copying it and measured the same bytes about 10 ms sooner a page. The
 * copy is 78 MB a page in flight; what decided it is that a browser whose
 * `convertToBlob` mishandles that rarer context would export blank pages
 * without a word, and a 2D canvas is the path every browser's encoder is
 * exercised on.
 *
 * The checksum is taken here because the bytes are here. A zip wants every
 * entry's CRC in the header *before* the entry, which used to mean reading the
 * whole export back on the main thread once it was made — five seconds for a
 * sixty-page PNG export. Summing what was just made, in the worker that made
 * it, costs a read of memory already hot and nothing on the page.
 *
 * Imports are written out: this runs in a worker, where Nuxt's auto-imports do
 * not reach.
 */
import { crc32Of } from '../crc32'

export interface EncodeJob {
  type: 'image/png' | 'image/jpeg'
  /** JPEG quality, 0–1. Left out for PNG, which has none. */
  quality?: number
  /** Whether to sum what was made: a zip entry needs it, a PDF page does not. */
  crc: boolean
}

export interface Encoded {
  blob: Blob
  /** The file's CRC-32, where it was asked for. */
  crc: number | null
}

/** What the pool sends: one page, and how to encode it. The bitmap is transferred. */
export type EncodeRequest = EncodeJob & { id: number, bitmap: ImageBitmap }

export type EncodeReply =
  /**
   * Said once, first, before any page is sent: whether this thread has a
   * canvas to draw on. A worker without `OffscreenCanvas` could take a page
   * and do nothing with it, and a page transferred there is lost to the page.
   */
  | { kind: 'ready', canvas: boolean }
  | { kind: 'done', id: number, blob: Blob, crc: number | null }
  | { kind: 'failed', id: number, error: string }

/** The page on a canvas of its own size, encoded. Closes the bitmap. */
async function encoded (bitmap: ImageBitmap, job: EncodeJob): Promise<Blob> {
  const { width, height } = bitmap
  const quality = job.type === 'image/jpeg' ? job.quality : undefined

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const c = canvas.getContext('2d')

    if (!c) throw new Error('The page could not be encoded.')

    c.drawImage(bitmap, 0, 0)
    bitmap.close()

    try {
      return await canvas.convertToBlob({ type: job.type, ...(quality === undefined ? {} : { quality }) })
    } finally {
      // 78 MB a page at the largest size, given back now rather than at the
      // collector's leisure: the next page is on its way.
      canvas.width = 0
    }
  }

  // No `OffscreenCanvas` anywhere — only ever this thread, in an older
  // browser. The old way, which is what that browser has.
  const canvas = document.createElement('canvas')

  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()

  try {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The page could not be encoded.'))), job.type, quality)
    })
  } finally {
    canvas.width = 0
  }
}

export async function encodePage (bitmap: ImageBitmap, job: EncodeJob): Promise<Encoded> {
  const blob = await encoded(bitmap, job)

  return { blob, crc: job.crc ? await crc32Of(blob) : null }
}
