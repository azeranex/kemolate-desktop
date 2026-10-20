/**
 * A PNG, written from raw scanlines — or put together around image data that
 * is already a PNG's in all but name.
 *
 * This is the smallest possible writer, and that is the point of it: an image
 * a PDF stored as bare pixels (Flate over rows, usually) is already exactly
 * the scanline layout PNG wants — same byte alignment, same bit packing, same
 * big-endian samples — so wrapping it losslessly takes nothing more than a
 * filter byte per row, a header, and checksums. The compressing itself is the
 * browser's `CompressionStream`, which speaks zlib, which is what PNG asks
 * for. No pixel is ever decoded or re-encoded on the way through.
 *
 * `wrapPng` is the half of that with no compressing in it. A PDF image stored
 * as Flate over PNG-predicted rows (`/Predictor` 10–15) *is* a PNG's image
 * data already — a zlib stream of rows, each led by its filter byte — so it
 * goes into the IDAT as it came out of the file, and the header and palette
 * are the ones `encodePng` would have written. `extract.ts` decides when that
 * applies; both writers share every byte outside the IDAT so the two can never
 * disagree about what the picture is.
 *
 * The chunk checksums are `utils/crc32.ts`, imported by path because this runs
 * in the PDF worker. A wrapped page's IDAT is the whole deflated page, and the
 * byte-at-a-time loop this had of its own summed it at 181 MB/s.
 */
import { crc32 } from '../crc32'

import { deflate } from './filters'

/** What a PNG says about itself before its pixels: size, depth, kind, palette. */
export interface PngShape {
  width: number
  height: number
  /** Bits per sample: 1, 2, 4, 8 or 16 — PDF and PNG agree on the set. */
  depth: number
  /** 0 greyscale, 2 truecolour, 3 palette. */
  color: 0 | 2 | 3
  /** RGB triples, for palette images. */
  palette?: Uint8Array
}

export interface RawImage extends PngShape {
  /** Scanlines, each padded to a whole byte — the layout PDF stores. */
  data: Uint8Array
}

export async function encodePng ({ data, ...shape }: RawImage): Promise<Uint8Array> {
  const { width, height, depth, color } = shape
  const channels = color === 2 ? 3 : 1
  const rowBytes = Math.ceil((width * channels * depth) / 8)

  // Every row gains one leading byte: filter 0, "as it is". Filtering better
  // would shave kilobytes and cost a reimplementation of PNG's heuristics for
  // images that are working files, not deliverables.
  const filtered = new Uint8Array((rowBytes + 1) * height)

  for (let row = 0; row < height; row++) {
    filtered.set(data.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1)
  }

  return wrapPng(shape, await deflate(filtered))
}

/**
 * A PNG around image data that is ready as it is: a zlib stream of `height`
 * rows, each a filter byte and then the row. Nothing is inflated or checked
 * here — `extract.ts` checks before it asks.
 */
export function wrapPng ({ width, height, depth, color, palette }: PngShape, idat: Uint8Array): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)

  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = depth
  header[9] = color
  // Compression, filter, interlace: each 0, each the only value there is.

  const chunks: Uint8Array[] = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
  ]

  if (color === 3) chunks.push(chunk('PLTE', palette ?? new Uint8Array(3)))

  chunks.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)))

  const total = chunks.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0

  for (const part of chunks) {
    out.set(part, at)
    at += part.length
  }

  return out
}

function chunk (type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12)
  const view = new DataView(out.buffer)

  view.setUint32(0, data.length)

  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)

  out.set(data, 8)
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)))

  return out
}
