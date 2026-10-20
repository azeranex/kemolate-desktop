/**
 * The stream filters a PDF wraps its bytes in, undone.
 *
 * Nothing in here knows what a PDF object is — these are plain byte-to-byte
 * transforms, named after the filters in the spec, and `objects.ts` decides
 * which to apply to what. Flate is the browser's own `DecompressionStream`
 * rather than a bundled inflater, which is the deal this app has made
 * everywhere: the machine already knows how to do this, so no library comes
 * along to do it again.
 */

/**
 * FlateDecode. Zlib-wrapped deflate, in every PDF a real producer writes —
 * but files exist with the two-byte zlib header missing, and a second try as
 * raw deflate costs nothing when the first has already failed.
 */
export async function inflate (data: Uint8Array): Promise<Uint8Array> {
  try {
    return await pump(data, 'deflate')
  } catch {
    return pump(data, 'deflate-raw')
  }
}

/**
 * Whether a zlib stream inflates to exactly `rows` PNG-filtered rows of
 * `rowBytes` each — a filter byte from 0 to 4, then the row — and nothing else.
 *
 * This is the check that lets `extract.ts` hand a PDF's own compressed bytes to
 * a PNG decoder without undoing them. Inflating is the cheap part of what the
 * old road did (the predictor loop and the deflate were the cost), and it is
 * the only way to be sure: a stream one row short, a row with a filter byte a
 * PNG decoder refuses, a bad checksum or junk after the end are all things
 * the old road padded, forgave or failed on, and a PNG built around them would
 * be a page that does not draw. Streamed and counted, never kept, so the check
 * holds a chunk of the page at a time rather than all of it.
 *
 * Zlib only, with its two-byte header: that is what an IDAT must hold, and the
 * raw-deflate files `inflate` forgives above cannot be wrapped as they are.
 */
export async function inflatesToRows (data: Uint8Array, rowBytes: number, rows: number): Promise<boolean> {
  const [cmf = 0, flg = 0] = data

  // Deflate, a window PNG allows, no preset dictionary, and the header's own
  // check — RFC 1950's four conditions on the first two bytes.
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || flg & 0x20 || ((cmf << 8) | flg) % 31) return false

  const stride = rowBytes + 1
  const expected = stride * rows
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  let at = 0
  let next = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) break

      const end = at + value.length

      if (end > expected) return false

      for (; next < end; next += stride) {
        if (value[next - at]! > 4) return false
      }

      at = end
    }
  } catch {
    // Corrupt, truncated, a checksum that does not add up, or bytes after the
    // end: all of it a stream a PNG decoder would stop on too.
    return false
  } finally {
    reader.cancel().catch(() => {})
  }

  return at === expected
}

/** Deflate with the zlib wrapper — which is the compression PNG wants too. */
export function deflate (data: Uint8Array): Promise<Uint8Array> {
  return pump(data, 'deflate', 'compress')
}

async function pump (data: Uint8Array, format: CompressionFormat, way: 'compress' | 'decompress' = 'decompress') {
  const transform = way === 'compress' ? new CompressionStream(format) : new DecompressionStream(format)
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform)

  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * LZWDecode. The TIFF flavour: codes packed most-significant-bit first,
 * growing from 9 to 12 bits, with 256 to clear the table and 257 to stop —
 * and `early` bumping the width one code sooner than the table strictly
 * requires, which is the spec's default and every real file's behaviour.
 */
export function lzw (data: Uint8Array, early = 1): Uint8Array {
  const out = new Bytes()
  let table: number[][] = []
  let width = 9
  let prev: number[] | null = null

  const reset = () => {
    table = []

    for (let i = 0; i < 256; i++) table.push([i])

    // The two control codes hold places 256 and 257 so real entries land at 258.
    table.push([], [])
  }

  reset()

  let held = 0
  let bits = 0

  for (let i = 0; i <= data.length; i++) {
    // One imaginary zero byte at the end lets a final partial code drain out.
    held = (held << 8) | (data[i] ?? 0)
    bits += 8

    while (bits >= width) {
      const code = (held >> (bits - width)) & ((1 << width) - 1)

      bits -= width

      if (code === 257 || i >= data.length) return out.take()

      if (code === 256) {
        reset()
        width = 9
        prev = null

        continue
      }

      // A code one past the table is the run that is defining itself: the
      // entry is the previous one plus its own first byte.
      const entry: number[] | null = code < table.length && table[code]!.length
        ? table[code]!
        : prev
          ? [...prev, prev[0]!]
          : null

      if (!entry) return out.take()

      out.push(entry)

      if (prev) table.push([...prev, entry[0]!])

      prev = entry

      if (table.length + early >= (1 << width) && width < 12) width++
    }
  }

  return out.take()
}

/** RunLengthDecode: a length byte, then either literals or one byte repeated. */
export function runLength (data: Uint8Array): Uint8Array {
  const out = new Bytes()

  for (let i = 0; i < data.length;) {
    const n = data[i++]!

    if (n === 128) break

    if (n < 128) {
      out.push(data.subarray(i, i + n + 1))
      i += n + 1
    } else {
      const byte = data[i++] ?? 0

      out.push(new Uint8Array(257 - n).fill(byte))
    }
  }

  return out.take()
}

/** ASCIIHexDecode: hex pairs, whitespace ignored, `>` the end, odd length padded. */
export function asciiHex (data: Uint8Array): Uint8Array {
  const out: number[] = []
  let nibble = -1

  for (const byte of data) {
    if (byte === 0x3e) break

    const digit = hexValue(byte)

    if (digit < 0) continue

    if (nibble < 0) {
      nibble = digit
    } else {
      out.push((nibble << 4) | digit)
      nibble = -1
    }
  }

  if (nibble >= 0) out.push(nibble << 4)

  return Uint8Array.from(out)
}

function hexValue (byte: number) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57

  return -1
}

/** ASCII85Decode: five characters to four bytes, `z` for four zeros, `~>` the end. */
export function ascii85 (data: Uint8Array): Uint8Array {
  const out = new Bytes()
  const group: number[] = []

  const flush = (count: number) => {
    // A short final group is padded with `u` (the highest digit) and the same
    // number of output bytes dropped — straight from the spec.
    const filled = [...group]

    while (filled.length < 5) filled.push(84)

    let value = 0

    for (const digit of filled) value = value * 85 + digit

    const bytes = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]

    out.push(Uint8Array.from(bytes.slice(0, count - 1)))
    group.length = 0
  }

  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!

    if (byte === 0x7e) break

    if (byte === 0x7a && !group.length) {
      out.push(new Uint8Array(4))

      continue
    }

    if (byte < 0x21 || byte > 0x75) continue

    group.push(byte - 0x21)

    if (group.length === 5) flush(5)
  }

  if (group.length > 1) flush(group.length)

  return out.take()
}

/**
 * The predictor some Flate and LZW streams apply before compressing, undone.
 *
 * PNG's per-row filters (predictors 10 and up) turn up on image data and on
 * cross-reference streams alike; TIFF's horizontal differencing (predictor 2)
 * is rarer. Anything unrecognised passes through untouched, which at worst is
 * a garbled image rather than a thrown-away one.
 */
export function unpredict (data: Uint8Array, predictor: number, colors: number, bits: number, columns: number): Uint8Array {
  if (predictor <= 1) return data

  const rowBytes = Math.ceil((colors * bits * columns) / 8)

  if (predictor === 2) {
    // TIFF differencing over sub-byte samples exists in theory and in no file
    // this has met; only the byte-aligned case is worth carrying.
    if (bits !== 8) return data

    const out = data.slice()

    for (let row = 0; row + rowBytes <= out.length; row += rowBytes) {
      for (let i = colors; i < rowBytes; i++) out[row + i] = (out[row + i]! + out[row + i - colors]!) & 0xff
    }

    return out
  }

  // PNG predictors: each row leads with a byte naming its filter, and the
  // reconstruction is exactly PNG's, whatever the leading byte says the
  // per-row choice was.
  const step = Math.max(1, (colors * bits) >> 3)
  const rows = Math.floor(data.length / (rowBytes + 1))
  const out = new Uint8Array(rows * rowBytes)
  const above = new Uint8Array(rowBytes)

  for (let row = 0; row < rows; row++) {
    const kind = data[row * (rowBytes + 1)]!
    const from = row * (rowBytes + 1) + 1
    const to = row * rowBytes

    for (let i = 0; i < rowBytes; i++) {
      const raw = data[from + i]!
      const left = i >= step ? out[to + i - step]! : 0
      const up = above[i]!
      const corner = i >= step ? above[i - step]! : 0

      let value = raw

      if (kind === 1) value = raw + left
      else if (kind === 2) value = raw + up
      else if (kind === 3) value = raw + ((left + up) >> 1)
      else if (kind === 4) value = raw + paeth(left, up, corner)

      out[to + i] = value & 0xff
    }

    above.set(out.subarray(to, to + rowBytes))
  }

  return out
}

function paeth (left: number, up: number, corner: number) {
  const guess = left + up - corner
  const dl = Math.abs(guess - left)
  const du = Math.abs(guess - up)
  const dc = Math.abs(guess - corner)

  if (dl <= du && dl <= dc) return left

  return du <= dc ? up : corner
}

/** Grown a chunk at a time, because decoded sizes are not known up front. */
class Bytes {
  private chunks: Uint8Array[] = []
  private length = 0

  push (chunk: Uint8Array | number[]) {
    const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk)

    this.chunks.push(bytes)
    this.length += bytes.length
  }

  take () {
    const out = new Uint8Array(this.length)
    let at = 0

    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }

    return out
  }
}
