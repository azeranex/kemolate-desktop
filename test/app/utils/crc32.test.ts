import { randomBytes } from 'node:crypto'
import { crc32 as zlibCrc32 } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { crc32, crc32Of } from '~/utils/crc32'

/**
 * The checksum every zip entry and every PNG chunk the app writes carries,
 * held to an implementation that is not this one: `node:zlib`'s.
 *
 * A wrong CRC is not an error anywhere in this app. It is a project file that
 * the operating system's unarchiver calls damaged, or a PNG out of a PDF that
 * a strict decoder refuses — found by somebody else, later. Slice-by-8 has
 * three places to be wrong that a byte-at-a-time loop does not, and each case
 * below is one of them:
 *
 * - **The tail.** Eight bytes a step, then whatever is left one at a time, so
 *   every length around a multiple of eight: 0, 1, 7, 8, 9, 15, 16, 17.
 * - **Where the bytes start.** A `subarray` at an odd offset, which a version
 *   reading through a `Uint32Array` over the buffer would read misaligned or
 *   from the wrong place.
 * - **Carrying on.** `crc32(b, crc32(a))` must be `crc32(a + b)` wherever the
 *   cut falls — a blob is summed in the chunks its stream hands over.
 *
 * Seam: `crc32` and `crc32Of`, against `zlib.crc32` on random bytes.
 */

const LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 257, 1000, 4095, 4096, 4097, 65_535, 65_536, 65_537, 300_007]

describe('crc32', () => {
  it('agrees with zlib on every length around a multiple of eight', () => {
    for (const length of LENGTHS) {
      const bytes = new Uint8Array(randomBytes(length))

      expect(crc32(bytes), `length ${length}`).toBe(zlibCrc32(bytes))
    }
  })

  it('agrees with zlib on bytes that do not start at the start of their buffer', () => {
    const buffer = new Uint8Array(randomBytes(70_000))

    for (const offset of [1, 2, 3, 5, 7, 8, 9, 13]) {
      for (const length of [0, 1, 7, 8, 9, 64, 1001, 65_536]) {
        const view = buffer.subarray(offset, offset + length)

        expect(crc32(view), `offset ${offset}, length ${length}`).toBe(zlibCrc32(view))
      }
    }
  })

  it('carries on from a previous sum as zlib does, wherever the cut falls', () => {
    const bytes = new Uint8Array(randomBytes(10_000))

    for (const cut of [0, 1, 7, 8, 9, 4_999, 9_999, 10_000]) {
      const head = bytes.subarray(0, cut)
      const tail = bytes.subarray(cut)

      expect(crc32(tail, crc32(head)), `cut at ${cut}`).toBe(zlibCrc32(bytes))
      expect(crc32(tail, 0xDEADBEEF), `from an arbitrary sum, cut at ${cut}`).toBe(zlibCrc32(tail, 0xDEADBEEF))
    }
  })

  it('gives the checksums the formats publish', () => {
    // The check value every CRC-32 catalogue lists, and PNG's IEND chunk —
    // the one CRC in every PNG, over the four letters and no data.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926)
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xAE426082)
  })
})

describe('crc32Of', () => {
  it('sums a blob read in chunks the same as the bytes whole', async () => {
    // Past the 64 KB a blob's stream hands over at a time, and not a multiple
    // of eight, so the chunks' tails are exercised too.
    const bytes = new Uint8Array(randomBytes(1_000_003))

    expect(await crc32Of(new Blob([bytes]))).toBe(zlibCrc32(bytes))
  })

  it('sums an empty blob to nought', async () => {
    expect(await crc32Of(new Blob([]))).toBe(0)
  })
})
