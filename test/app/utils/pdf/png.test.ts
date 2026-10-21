import { inflateSync, crc32 as zlibCrc32 } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { encodePng } from '~/utils/pdf/png'

/**
 * A bare raster out of a PDF, wrapped as a PNG — held to what any decoder
 * checks, rather than to this app's own reading of it.
 *
 * Every chunk carries a CRC over its type and data, and a strict decoder
 * refuses the file on one wrong byte of it: a page of the chapter that will
 * not open anywhere but here. So each chunk is summed again with `node:zlib`,
 * and the image data inflated with it, back to the rows that went in with a
 * filter byte of nought in front of each.
 *
 * Seam: `encodePng` on a few rows of known bytes.
 */

/** Every chunk in a PNG: its type, its data, and the CRC it carries. */
function chunks (png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: { type: string, data: Uint8Array, crc: number, named: Uint8Array }[] = []

  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at)
    const named = png.subarray(at + 4, at + 8 + length)

    out.push({
      type: String.fromCharCode(...png.subarray(at + 4, at + 8)),
      data: png.subarray(at + 8, at + 8 + length),
      crc: view.getUint32(at + 8 + length),
      named,
    })

    at += 12 + length
  }

  return out
}

describe('encodePng', () => {
  it('writes chunks whose every CRC zlib agrees with, around the rows it was given', async () => {
    // Three rows of five RGB pixels — fifteen bytes a row, so the filter byte
    // in front of each puts every row off any word boundary.
    const width = 5
    const height = 3
    const rows = Uint8Array.from({ length: width * 3 * height }, (_, at) => (at * 37) & 0xFF)

    const found = chunks(await encodePng({ width, height, depth: 8, color: 2, data: rows }))

    expect(found.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])

    for (const chunk of found) expect(chunk.crc, chunk.type).toBe(zlibCrc32(chunk.named))

    const filtered = new Uint8Array(inflateSync(found[1]!.data))

    for (let row = 0; row < height; row++) {
      expect(filtered[row * (width * 3 + 1)]).toBe(0)
      expect(filtered.subarray(row * (width * 3 + 1) + 1, (row + 1) * (width * 3 + 1))).toEqual(rows.subarray(row * width * 3, (row + 1) * width * 3))
    }
  })

  it('sums a palette image\'s PLTE chunk too', async () => {
    const found = chunks(await encodePng({ width: 2, height: 1, depth: 8, color: 3, palette: new Uint8Array([255, 0, 0, 0, 0, 255]), data: new Uint8Array([0, 1]) }))

    expect(found.map((chunk) => chunk.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND'])

    for (const chunk of found) expect(chunk.crc, chunk.type).toBe(zlibCrc32(chunk.named))
  })
})
