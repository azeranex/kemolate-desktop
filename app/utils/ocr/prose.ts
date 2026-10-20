/**
 * Cutting prose down to something the reader can actually see.
 *
 * Every crop is stretched onto the encoder's 224×224 square. That is right for a
 * balloon and ruinous for a paragraph, and the reason is compression rather than
 * shape: squaring a line of width `w` and height `h` leaves each glyph
 * `224 / (w / h)` pixels across. On a real colophon the lines are 1911×65, so a
 * glyph arrives 7.6 pixels wide — and what comes back is not a bad reading but
 * fluent Japanese, the decoder falling back to its strongest prior when handed
 * something with no legible letters in it. That looks like a language-detection
 * failure and is really a geometry one.
 *
 * A balloon line of 222×30 lands at 30 pixels and is perfectly fine: it is only
 * stretched vertically, which costs nothing. So the test here is the glyph size
 * the encoder would receive, not the shape of the box — judging by aspect alone
 * split ordinary balloons too and made them worse.
 *
 * Splitting into lines is not enough by itself, because each line of that
 * colophon is still 29:1. Each line is cut again into near-square pieces, on
 * whitespace where there is any, and the pieces are read in order and joined.
 *
 * Only wide prose is handled. The mirrored case — a very tall column of prose —
 * would fail the same way, but it has not turned up on a real page and guessing
 * at a fix for something unmeasured is how the last two thresholds here got set
 * wrong.
 */

/** The square every crop is stretched onto, which is what does the compressing. */
const MODEL_EDGE = 224

/**
 * How small a glyph may get once its line is squared.
 *
 * Below this the strokes are gone and the reader is guessing. Measured: 7.6px
 * produces Japanese from Korean prose, 30px reads correctly.
 */
const MIN_GLYPH = 16

/** How wide each piece may be, as a multiple of its line's height. */
const PIECE_ASPECT = 4

/** A piece with less ink than this is blank — and blank is not nothing. */
const MIN_INK = 40

/** Rows with no ink separate one line of a paragraph from the next. */
function inkRows (mask: Float32Array, w: number, h: number): [number, number][] {
  const perRow = new Float32Array(h)
  let most = 0

  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = 0; x < w; x++) sum += mask[y * w + x]!
    perRow[y] = sum
    if (sum > most) most = sum
  }

  if (most <= 0) return []

  const floor = most * 0.02
  const bands: [number, number][] = []
  let start: number | null = null

  for (let y = 0; y < h; y++) {
    if (perRow[y]! > floor && start === null) start = y
    else if (perRow[y]! <= floor && start !== null) {
      if (y - start > 8) bands.push([start, y])
      start = null
    }
  }

  if (start !== null) bands.push([start, h])

  return bands
}

/**
 * Where to cut a line, preferring a column of whitespace near each mark.
 *
 * Cutting mid-glyph costs a character at every seam, and on a paragraph that is
 * a dozen characters. A gap is looked for within a third of the ideal width
 * either way, and the middle of the widest one is taken; failing that the ideal
 * point is used, because a slightly damaged seam still beats reading nothing.
 */
function cutPoints (
  mask: Float32Array, w: number, h: number,
  top: number, bottom: number, width: number,
): number[] {
  const blank = new Uint8Array(w)

  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = top; y < bottom; y++) sum += mask[y * w + x]!
    blank[x] = sum === 0 ? 1 : 0
  }

  const points = [0]
  let at = 0

  while (w - at > width * 1.35) {
    const ideal = at + Math.round(width)
    const lo = Math.max(at + 20, ideal - Math.round(width * 0.35))
    const hi = Math.min(w - 1, ideal + Math.round(width * 0.35))

    const gaps: number[] = []
    for (let x = lo; x < hi; x++) if (blank[x]) gaps.push(x)

    points.push(gaps.length ? gaps[Math.floor(gaps.length / 2)]! : ideal)
    at = points[points.length - 1]!
  }

  points.push(w)

  return points
}

/**
 * A region as the pieces the reader can take, or nothing when it is fine as is.
 *
 * `null` is the ordinary answer and means "read this the usual way". The pieces
 * come back in page coordinates, so they go through the same crop, margin and
 * de-skew path as any other region — nothing here is a shortcut around it.
 */
export function proseParts (bitmap: ImageBitmap, region: Region): Region[] | null {
  const x = Math.max(0, Math.round(region.x))
  const y = Math.max(0, Math.round(region.y))
  const w = Math.min(bitmap.width - x, Math.round(region.w))
  const h = Math.min(bitmap.height - y, Math.round(region.h))

  if (w < 32 || h < 8) return null

  // Cheap rejection before any pixels are touched: a region that is not wider
  // than it is tall cannot contain a line thin enough to matter.
  if (w / h < 2) return null

  const canvas = new OffscreenCanvas(w, h)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) return null

  context.drawImage(bitmap, x, y, w, h, 0, 0, w, h)

  const mask = autoMask(context.getImageData(0, 0, w, h).data, w, h, { x: 0, y: 0, w, h })
  const bands = inkRows(mask, w, h)

  if (!bands.length) return null

  // Judge the lines, not the box, and judge them by what the encoder receives.
  const tight = bands.some(([top, bottom]) => (MODEL_EDGE * (bottom - top)) / w < MIN_GLYPH)

  if (!tight) return null

  const parts: Region[] = []

  for (const [top, bottom] of bands) {
    const pad = 6
    const lineTop = Math.max(0, top - pad)
    const lineBottom = Math.min(h, bottom + pad)
    const lineHeight = lineBottom - lineTop
    const marks = cutPoints(mask, w, h, top, bottom, lineHeight * PIECE_ASPECT)

    for (let k = 0; k < marks.length - 1; k++) {
      const from = marks[k]!
      const to = marks[k + 1]!

      let ink = 0
      for (let py = top; py < bottom && ink <= MIN_INK; py++) {
        for (let px = from; px < to; px++) ink += mask[py * w + px]!
      }

      // Handed white space the reader invents text — a blank piece came back
      // as "중국에서" every time until these were dropped.
      if (ink <= MIN_INK) continue

      parts.push({ x: x + from, y: y + lineTop, w: to - from, h: lineHeight })
    }
  }

  return parts.length ? parts : null
}
