/**
 * The math under the paint tools: where the dabs of a stroke land, how a
 * stroke's dirty rectangle grows, and the grid alignment the clone stamp
 * depends on. No canvas in here — the tools paint, this computes.
 *
 * Ported from the earlier build's `core/raster.ts` with its numbers intact,
 * because every constant in it was tuned against a symptom: dab spacing against
 * beading, grid rounding against the clone stamp blurring what it copies. It
 * lives in `shared/` because replay has to run wherever strokes are turned back
 * into pixels — the browser today, a bake somewhere else tomorrow — and two
 * copies of `dabSpots` that disagree would put the same stroke in two places.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Where a copied region should be lifted from and set down, on the pixel grid.
 *
 * Every position arrives as a float: the pointer is a screen coordinate mapped
 * into page pixels, and the offset to a clone source is the difference of two
 * of them. Handed to `drawImage` as they come, both ends land between pixels
 * and the browser interpolates — once lifting the pixels and again setting them
 * down, on every dab, over ground earlier dabs have already resampled. What is
 * copied then arrives softer than what it was copied from, which is the one
 * thing a clone stamp must not do.
 *
 * The offset is rounded whole rather than the two ends separately, so the
 * source keeps its exact distance from the brush and the copy cannot drift
 * away from what it is copying as a stroke goes on.
 */
export function gridCopy (
  to: Point,
  offset: Point,
): { dx: number, dy: number, sx: number, sy: number } {
  const dx = Math.round(to.x)
  const dy = Math.round(to.y)

  return {
    dx,
    dy,
    sx: dx + Math.round(offset.x),
    sy: dy + Math.round(offset.y),
  }
}

/** The bounds grown to cover a mark of radius `r` at (x, y). */
export function grownBounds (b: Bounds | null, x: number, y: number, r: number): Bounds {
  const mark = { x0: x - r, y0: y - r, x1: x + r, y1: y + r }

  if (!b) return mark

  return {
    x0: Math.min(b.x0, mark.x0),
    y0: Math.min(b.y0, mark.y0),
    x1: Math.max(b.x1, mark.x1),
    y1: Math.max(b.y1, mark.y1),
  }
}

/**
 * How far apart marks sit, as a fraction of the radius.
 *
 * A quarter of a radius is plenty when marks are summed, but a stroke built
 * from the *greatest* coverage ripples at the spacing instead: at full softness
 * a mark is only opaque at its exact centre, so halfway between two of them the
 * best any mark offers is short of solid, and the stroke comes out beaded. A
 * twentieth takes that dip from 30/255 to 5/255, which is under a rounding
 * step. Marks are cheap on that path — they are gradient fills into a buffer,
 * and the per-frame cost is the patch that gets read back, not their number.
 */
export const DAB_STEP = 0.25
export const DAB_STEP_SMOOTH = 0.05

/**
 * Where the marks of one stroke segment land: evenly spaced along it, close
 * enough together that the row of discs reads as one line.
 *
 * Replay calls this against the same recorded points with the same radius, so
 * the dabs land exactly where they landed live — which is the property that
 * lets heal record one sampled colour per dab and pay it back out by index.
 */
export function dabSpots (from: Point, to: Point, r: number, frac = DAB_STEP): Point[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const step = Math.max(1, r * frac)
  const n = Math.max(1, Math.ceil(dist / step))
  const spots: Point[] = []

  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1)

    spots.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
  }

  return spots
}

/**
 * The stroke run straight from where it began, snapped to the nearest
 * eighth-turn — horizontal, vertical or diagonal. Panel borders and
 * speech-bubble edges are the things most often retouched, and freehand
 * cannot follow them.
 */
export function straighten (a: Point, b: Point): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  const len = Math.hypot(dx, dy)

  return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len }
}

export const rgbOf = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) || 0,
  Number.parseInt(hex.slice(3, 5), 16) || 0,
  Number.parseInt(hex.slice(5, 7), 16) || 0,
]

export const hexOf = (rgb: [number, number, number]): string =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
