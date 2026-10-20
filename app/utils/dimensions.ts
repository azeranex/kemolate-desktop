/**
 * An image's size, read off its header instead of decoded out of its pixels.
 *
 * The canvas falls back to the usual 2:3 page until a scan says how big it is,
 * and a scan used to say so only by being drawn — so the first look at any
 * uncached page rendered at the guessed shape and then snapped to the real one
 * a beat later. Decoding every page up front to avoid that would cost real
 * time and memory; this reads the two numbers every format keeps in its first
 * few bytes, which costs neither.
 *
 * Formats a comic actually arrives in: PNG, JPEG, WebP, GIF, BMP. Anything
 * else returns null and the page falls back to measure-on-draw, which is the
 * old behaviour — a sniff that cannot read a file must never be worse than not
 * having sniffed.
 */

export interface ImageSize {
  width: number
  height: number
}

/**
 * Enough for any header this reads. JPEG is the one that wanders — a camera
 * dumps EXIF before the frame — and even generous EXIF sits well inside this.
 */
const HEADER_BYTES = 256 * 1024

export async function imageDimensions (file: Blob): Promise<ImageSize | null> {
  const buffer = await file.slice(0, HEADER_BYTES).arrayBuffer().catch(() => null)

  if (!buffer || buffer.byteLength < 16) return null

  const view = new DataView(buffer)

  try {
    return png(view) ?? jpeg(view) ?? webp(view) ?? gif(view) ?? bmp(view)
  } catch {
    // A truncated or lying header. The img-load fallback will settle it.
    return null
  }
}

const ok = (width: number, height: number): ImageSize | null =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null

function png (v: DataView): ImageSize | null {
  if (v.getUint32(0) !== 0x89504E47 || v.getUint32(4) !== 0x0D0A1A0A) return null

  // The IHDR chunk is required to come first, at a fixed offset.
  return ok(v.getUint32(16), v.getUint32(20))
}

/**
 * Walk the segments to a start-of-frame. JPEG keeps its size in whichever SOFn
 * the encoder chose, somewhere after any amount of metadata — so this is a
 * walk rather than an offset, and the one format that earns the big header
 * read above.
 *
 * ## The size it is drawn at, not the size it is stored at
 *
 * A camera stores the sensor's frame and says in EXIF how to turn it, and
 * every decode in this app honours that — `createImageBitmap`'s default — so a
 * photo stored landscape and tagged to be turned a quarter is a portrait page
 * everywhere it is drawn, read or cleaned. Reporting the stored frame made the
 * page's box the wrong shape, and every block on it was divided by the wrong
 * width: the detector's coordinates came off the turned picture. So an
 * Orientation of 5–8 (the four that turn a quarter) swaps the sides; 2–4 flip
 * or turn a half and keep them.
 */
function jpeg (v: DataView): ImageSize | null {
  if (v.getUint16(0) !== 0xFFD8) return null

  let at = 2
  let turned = false

  while (at + 9 < v.byteLength) {
    if (v.getUint8(at) !== 0xFF) {
      at++

      continue
    }

    const marker = v.getUint8(at + 1)

    // Padding and restart markers carry no length.
    if (marker === 0xFF || (marker >= 0xD0 && marker <= 0xD9)) {
      at += marker === 0xFF ? 1 : 2

      continue
    }

    // Every SOFn except the arithmetic-coding tables that share the range.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const width = v.getUint16(at + 7)
      const height = v.getUint16(at + 5)

      return turned ? ok(height, width) : ok(width, height)
    }

    // APP1, where EXIF lives — before the frame, as the standard requires.
    if (marker === 0xE1) {
      const orientation = exifOrientation(v, at + 4, at + 2 + v.getUint16(at + 2))

      turned = orientation >= 5 && orientation <= 8
    }

    at += 2 + v.getUint16(at + 2)
  }

  return null
}

/**
 * The Orientation tag of an APP1 segment's EXIF, or 0 where there is none or
 * it cannot be read — `start` is just past the segment's length field, `end`
 * one past its last byte.
 *
 * Only IFD0 is looked at, which is where the tag lives. Every offset is
 * checked against the segment rather than trusted: a truncated or lying EXIF
 * must fall back to the stored frame, never throw the whole sniff away.
 */
function exifOrientation (v: DataView, start: number, end: number): number {
  const limit = Math.min(end, v.byteLength)

  // 'Exif' and two NULs, then the TIFF header the offsets count from.
  if (start + 14 > limit || v.getUint32(start) !== 0x45786966 || v.getUint16(start + 4) !== 0) return 0

  const tiff = start + 6
  const order = v.getUint16(tiff)

  if (order !== 0x4949 && order !== 0x4D4D) return 0

  const little = order === 0x4949

  if (v.getUint16(tiff + 2, little) !== 42) return 0

  const ifd = tiff + v.getUint32(tiff + 4, little)

  if (ifd + 2 > limit) return 0

  const entries = v.getUint16(ifd, little)

  for (let index = 0; index < entries; index++) {
    const entry = ifd + 2 + index * 12

    if (entry + 12 > limit) return 0
    if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little)
  }

  return 0
}

function webp (v: DataView): ImageSize | null {
  if (v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57454250) return null

  const kind = v.getUint32(12)

  // VP8X: extended header, canvas size as 24-bit minus-one fields.
  if (kind === 0x56503858) {
    const w = 1 + (v.getUint8(24) | (v.getUint8(25) << 8) | (v.getUint8(26) << 16))
    const h = 1 + (v.getUint8(27) | (v.getUint8(28) << 8) | (v.getUint8(29) << 16))

    return ok(w, h)
  }

  // VP8: lossy keyframe, dimensions after the 9D 01 2A start code.
  if (kind === 0x56503820) {
    if (v.getUint8(23) !== 0x9D || v.getUint8(24) !== 0x01 || v.getUint8(25) !== 0x2A) return null

    return ok(v.getUint16(26, true) & 0x3FFF, v.getUint16(28, true) & 0x3FFF)
  }

  // VP8L: lossless, both sizes packed into one little-endian word.
  if (kind === 0x5650384C) {
    if (v.getUint8(20) !== 0x2F) return null

    const bits = v.getUint32(21, true)

    return ok(1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF))
  }

  return null
}

function gif (v: DataView): ImageSize | null {
  // 'GIF8'
  if (v.getUint32(0) !== 0x47494638) return null

  return ok(v.getUint16(6, true), v.getUint16(8, true))
}

function bmp (v: DataView): ImageSize | null {
  if (v.getUint16(0) !== 0x424D) return null

  // Height is signed: negative means top-down rows, not a negative picture.
  return ok(v.getInt32(18, true), Math.abs(v.getInt32(22, true)))
}
