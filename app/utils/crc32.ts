/**
 * CRC-32 — the checksum zip and PNG both carry — once, for every writer here.
 * It is not one of the digests the platform offers (`crypto.subtle` has SHA
 * and nothing else), so it is written out.
 *
 * It was written three times, in `zip.ts`, `pdf/png.ts` and `images.ts`, each
 * with its own table and each walking the bytes one at a time with `for…of`.
 * Measured in Chrome that loop managed 181 MB/s, which is what made saving a
 * project slow: a sixty-page chapter of 25 MB scans spent eight seconds on the
 * main thread summing bytes before the archive could be put together. An
 * indexed loop over the same table is twice as fast. This is slice-by-8 —
 * eight tables, eight bytes a step, the way zlib does it — at about 1.6 GB/s
 * (measured in Node 24 on this machine, steady state, whole buffers and 64 KB
 * stream chunks alike).
 *
 * The eight bytes are put together by hand rather than read through a
 * `Uint32Array` over the same buffer. The view measured 8% faster and asks for
 * the data to be four-byte aligned and the machine little-endian; this asks for
 * neither, so a `subarray` at any offset is summed as it stands.
 *
 * The running form is zlib's: `crc32(b, crc32(a))` is `crc32(a + b)`, the
 * finished checksum of what came before handed back in. Carrying the
 * un-inverted register between chunks instead — and inverting per chunk by
 * mistake — was the classic way to get a streamed sum wrong, and this shape
 * leaves nothing to get wrong. It is also exactly the shape `node:zlib`'s
 * `crc32` has, which is what the tests hold this to.
 *
 * No imports, on purpose: this runs in the PDF worker and the export encoders
 * as well as on the page, and Nuxt's auto-imports reach neither worker.
 */

/** Eight 256-entry tables end to end: table `k` advances a byte through `k` more zero bytes. */
const TABLES = (() => {
  const tables = new Uint32Array(8 * 256)

  for (let n = 0; n < 256; n++) {
    let c = n

    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1

    tables[n] = c >>> 0
  }

  for (let n = 0; n < 256; n++) {
    let c = tables[n]!

    for (let k = 1; k < 8; k++) {
      c = tables[c & 0xFF]! ^ (c >>> 8)
      tables[k * 256 + n] = c
    }
  }

  return tables
})()

/**
 * The CRC-32 of `bytes` — or, given `previous`, of whatever `previous` was the
 * checksum of followed by `bytes`.
 */
export function crc32 (bytes: Uint8Array, previous = 0): number {
  const t = TABLES
  const n = bytes.length
  const whole = n - (n & 7)

  let c = ~previous
  let i = 0

  while (i < whole) {
    // The first four bytes are folded into the register and looked up through
    // the tables that carry them furthest; the next four go straight in.
    c ^= bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)
    c = t[1792 + (c & 0xFF)]! ^ t[1536 + ((c >>> 8) & 0xFF)]! ^ t[1280 + ((c >>> 16) & 0xFF)]! ^ t[1024 + (c >>> 24)]! ^
      t[768 + bytes[i + 4]!]! ^ t[512 + bytes[i + 5]!]! ^ t[256 + bytes[i + 6]!]! ^ t[bytes[i + 7]!]!
    i += 8
  }

  while (i < n) c = t[(c ^ bytes[i++]!) & 0xFF]! ^ (c >>> 8)

  return ~c >>> 0
}

/**
 * The CRC-32 of a blob, read through in the chunks its stream hands over.
 *
 * A stream rather than `arrayBuffer()` because the blob is usually a scan or a
 * finished page, and summing one should not mean holding it: a two hundred
 * page chapter answered as buffers is the chapter in the heap.
 */
export async function crc32Of (data: Blob): Promise<number> {
  const reader = data.stream().getReader()

  let crc = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) return crc

    crc = crc32(value, crc)
  }
}
