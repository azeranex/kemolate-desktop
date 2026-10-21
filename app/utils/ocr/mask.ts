/**
 * Which pixels of a block are lettering — the question the whole cleanup
 * turns on.
 *
 * Split out of `clean.ts` because it is the part that will keep changing.
 * The inpainters are interchangeable and already behind one interface; the
 * mask is where the quality actually lives, and a learned text segmenter
 * will one day replace the threshold below. Everything downstream takes a
 * mask rather than making one, so that day is a change to this file alone.
 *
 * ## That day, and why it is not a replacement
 *
 * The segmenter is here — `learnedInk`, reading `segment.ts`'s whole-page
 * answer — and it is better than the threshold on exactly the cases the
 * threshold is worst at: faint lines in a stack, and lettering on a dark fill
 * that Otsu inverts. It is not better everywhere. It under-responds to
 * invented sound effects, so a block it says nothing about falls back to the
 * threshold rather than going uncleaned, and the whole thing is opt-in
 * because it costs a model download.
 *
 * Which means both masks exist at once and a patch has to say which made it
 * — see `PatchKey.source`. That is the part that bites silently: the toggle
 * flips back and forth, patches from the two sources sit side by side on
 * disk, and a key that did not name the source would serve the other one.
 *
 * ## Two masks, not one
 *
 * A mask is wanted in two different shapes at once, and conflating them is
 * the mistake that costs an afternoon:
 *
 * - **hard** — nought or one, for the model. Inpainters are trained on
 *   binary masks; a half is not "half invent it", it is undefined, and the
 *   edge comes back as mush.
 * - **soft** — nought to one, for the composite. This is an alpha blend
 *   between the original artwork and what the model drew, and a hard edge
 *   between two rasters that disagree by a shade is exactly what an eye
 *   picks out.
 *
 * So one pass produces both, and a feathered brush means "how strongly do I
 * want this gone" without ever lying to the model about what is a hole.
 *
 * ## One threshold per region, one mask
 *
 * Otsu picks *one* grey level, and one level cannot describe a tall stack of
 * lines printed at different weights. An info balloon of five rows — 姓名,
 * 年齡, 身高, 體重, 婚姻狀況 — has the top rows dark enough to pull the split
 * up past whatever the bottom rows are printed at, so the faint ones fall on
 * the background side, contribute no ink, and survive the repair untouched
 * while their neighbours are painted out. Nothing warns, because as far as
 * the block is concerned a mask *was* found.
 *
 * So the threshold is taken over each region separately and the ink is
 * unioned — `autoMaskOver` — while `autoMask` remains the one-region case of
 * it. A joined balloon's children are already exact per-line boxes, so the
 * regions cost nothing to come by; see `useClean.lettering`, and note that
 * only the *mask* is split this way. The patch stays one rectangle over the
 * whole block, because repairing the lines separately leaves seams of
 * untouched balloon between them.
 *
 * `TOO_MUCH` is judged per region for the same reason: one line that reads as
 * mostly ink is one line to leave alone, not grounds to abandon the other
 * four.
 *
 * What this gives up is the strips *between* the parts: they belong to no
 * line, so nothing there is thresholded, where the block-wide pass would have
 * taken whatever crossed its level. On a balloon of lines those strips are
 * paper. On a balloon somebody joined out of two distant blocks they might not
 * be, and the brush is the answer for that — a mask that painted out an
 * unread scrap between two lines was never doing it on purpose.
 *
 * ## The automatic half is never stored
 *
 * Otsu over a crop is deterministic and costs a fraction of a millisecond,
 * so the automatic mask is recomputed wherever it is wanted rather than
 * written down. Only a person's corrections are worth keeping, because only
 * they cannot be derived again — see `MASK_RECIPE` in `patches.ts` for what
 * makes that safe.
 */

// The brush's shape lives with the brush. This file only decides what the
// strokes *mean*; how soft one is belongs to `stamps`, which the paint plate,
// the cursor and the live preview all read from too. Imported by hand because
// only `utils/ocr` is auto-imported as a family — see `nuxt.config.ts`.
import type { Point } from '#shared/utils/raster'
import type { Boxed } from '#shared/utils/transform'

import { cornersOf, isDistorted, mapped, matrixOf, toOriented } from '#shared/utils/transform'
import { feathered, maskCore, maskReach } from '~/utils/paint/stamps'

/** How far to grow the mask past the ink, in pixels of the tile. */
const DILATE = 3

/**
 * A mask covering more of its own box than this is not lettering — it is a
 * box drawn over artwork, or a threshold that found the balloon instead of
 * the words. Painting that out removes the drawing.
 *
 * Judged per region rather than per block, so a balloon is not abandoned
 * whole because one of its lines sits over a black panel.
 */
const TOO_MUCH = 0.6

/**
 * The one wording a refusal is reported in.
 *
 * Written once because it is said twice — to the console, which is where it
 * has always gone, and to whoever is looking at the page, which is where it
 * is any use. A sentence that drifts between the two is a sentence somebody
 * searches the source for and cannot find.
 */
function tooMuchNote (ink: number, inside: number): string {
  return `${Math.round((ink / inside) * 100)}% of the box read as ink, over the ${Math.round(TOO_MUCH * 100)}% a box of lettering is expected to stay under. Narrow the block onto the words, or paint the mask by hand.`
}

/** One region the threshold would not take, and what to tell somebody about it. */
export interface MaskRefusal {
  /** Which region, by its place in the list handed in. */
  at: number
  /** How much of that region's box read as ink, nought to one. */
  share: number
  /** One sentence a person can act on. */
  why: string
}

/**
 * What one pass of the threshold found, and what it refused to touch.
 *
 * Desktop: `Ink` in the web build. `shared/utils/layers` has an `Ink` too —
 * which kind of layer a stroke lands on — and the auto-imports hold one meaning
 * per name; so this one is `InkMask`. (It used to also need importing by hand
 * past the DOM's own `Ink`; see `clean.ts`.) The `Point` this file had is
 * `shared/utils/raster`'s, which was the same shape under the same name.
 */
export interface InkMask {
  /** One where the lettering is, nought elsewhere: every region's, grown once. */
  mask: Float32Array
  /** How many of the regions had any pixels on the tile at all. */
  read: number
  /** The ones left out for reading as mostly ink — empty in the ordinary case. */
  refused: MaskRefusal[]
}

/**
 * Every refusal a block collected, as the one sentence it is worth showing.
 *
 * Only reached when a block ends up with no mask at all: a balloon where four
 * of five lines masked cleanly is a balloon that cleaned, and saying anything
 * about the fifth would be reporting a success as a failure.
 */
export function refusalNote (refused: MaskRefusal[], read: number): string {
  const only = refused[0]

  if (!only) return ''
  if (refused.length === 1 && read <= 1) return only.why

  const worst = Math.round(refused.reduce((top, item) => Math.max(top, item.share), 0) * 100)

  return `${refused.length} of the block's ${read} parts read as mostly ink, the worst at ${worst}% of its box, over the ${Math.round(TOO_MUCH * 100)}% a box of lettering is expected to stay under. Narrow the block onto the words, or paint the mask by hand.`
}

/** The two shapes a mask is wanted in — see the header. */
export interface Mask {
  /** Nought or one, for the model. */
  hard: Float32Array
  /** Nought to one, for blending the result back over the page. */
  soft: Float32Array
  /** How many regions the threshold was taken over — see `autoMaskOver`. */
  read: number
  /** The regions it would not take, in the order they were given. */
  refused: MaskRefusal[]
}

/**
 * One correction, in the tile's own pixels.
 *
 * A polyline rather than a raster, because a stroke has to be drawn at
 * whatever size the tile happens to be worked at — see `clean.ts`, which
 * scales small balloons up and large ones down. A stored raster would have
 * to be resampled to that size, softening the edge, which then gets
 * thresholded, which gives a ragged mask. Rasterised from the line at the
 * tile's own scale, the edge is exactly as crisp as the model can use.
 */
export interface MaskEdit {
  /** `add` paints mask in; `wipe` takes it out again. */
  kind: 'add' | 'wipe'
  /**
   * Where the stroke sits in its surface's log, once it has one.
   *
   * Not used to draw — rasterisation replays the array in order — but it is
   * how a local list and a fetched one are told apart: a local edit whose
   * seq the server has not echoed back is a write still in flight, and one
   * whose seq comes back retracted is an undo to be believed. Absent only
   * for the instant between drawing and stamping.
   */
  seq?: number
  /** Flat pairs — x, y, x, y — in the tile's pixels. */
  points: number[]
  /** Brush width in tile pixels. */
  size: number
  /** Nought is a soft edge, one is a hard one. */
  hardness: number
}

/** Distance from a point to a segment — the segment may be a single point. */
function pointGap (px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * How finely a stroke's centreline is walked when the eraser cuts it, in
 * pixels. The same pitch the brush stores points at, so a resampled piece is
 * as faithful as the stroke it came from.
 */
const CLIP_STEP = 2

/**
 * What one pass of an eraser leaves of a stroke: the pieces of its
 * centreline the pass never reached — or `null` when it never touched the
 * stroke at all, which is the caller's cue to leave the original alone.
 *
 * This is a *path* eraser, not a row eraser: the swept part goes and the
 * rest of the mark stands. The stroke counts at its own width and the eraser
 * at its own radius, so grazing a mark's body cuts it — not just crossing
 * its centreline, which on a forty-pixel brush would make the eraser feel a
 * quarter as wide as its ring says it is. Feather is left out of both: the
 * soft skirt is where a stroke fades to nothing, and cutting a mark because
 * the eraser brushed the last few per cent of its halo would take things the
 * eye reads as missed.
 *
 * The centreline is walked at `CLIP_STEP` and each footfall is tested
 * against the whole path swept so far — exact point-to-segment distance, so
 * a fast flick between two pointer events cannot tunnel through. Surviving
 * runs shorter than half the stroke's own width are dropped rather than
 * kept: a two-pixel remnant of a thirty-pixel brush renders as a stray blob
 * that reads as dirt, not as the end of a mark.
 */
export function clipEdit (edit: MaskEdit, path: number[], radius: number): number[][] | null {
  const reach = radius + edit.size / 2
  const points = edit.points

  // The centreline, resampled to an even pitch. Original vertices are kept
  // as footfalls of their own so corners survive the walk.
  const samples: number[] = [points[0]!, points[1]!]

  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i]!
    const ay = points[i + 1]!
    const bx = points[i + 2]!
    const by = points[i + 3]!
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / CLIP_STEP))

    for (let step = 1; step <= steps; step++) {
      samples.push(ax + ((bx - ax) * step) / steps, ay + ((by - ay) * step) / steps)
    }
  }

  const clear = (x: number, y: number): boolean => {
    for (let i = 0; i + 1 < path.length; i += 2) {
      const bx = path[i + 2] ?? path[i]!
      const by = path[i + 3] ?? path[i + 1]!

      if (pointGap(x, y, path[i]!, path[i + 1]!, bx, by) <= reach) return false
    }

    return true
  }

  const pieces: number[][] = []
  let run: number[] | null = null
  let touched = false

  for (let i = 0; i + 1 < samples.length; i += 2) {
    if (clear(samples[i]!, samples[i + 1]!)) {
      run ??= []
      run.push(samples[i]!, samples[i + 1]!)
    } else {
      touched = true

      if (run) pieces.push(run)

      run = null
    }
  }

  if (run) pieces.push(run)
  if (!touched) return null

  return pieces.filter((piece) => piece.length >= 4 && (piece.length / 2 - 1) * CLIP_STEP >= edit.size / 2)
}

/**
 * Which way the lettering in a mask runs, in degrees.
 *
 * The detector gives axis-aligned boxes — it is an object detector, and a
 * box is what object detection produces — so a sound effect running
 * diagonally across a panel comes back as a huge upright rectangle mostly
 * full of artwork. But the mask already knows exactly which pixels are ink,
 * and the smallest rectangle that encloses them is turned to match. So the
 * angle costs no model and no download: it is a second reading of something
 * already computed.
 *
 * Found by turning the points rather than by rotating calipers over a convex
 * hull. Text is a scatter of strokes rather than one blob, so its hull is
 * large and unhelpful, and a sweep is both simpler and — over a few thousand
 * sampled points at one degree — fast enough to be unnoticeable.
 *
 * ## What it cannot tell you
 *
 * Nothing here separates *rotated* text from *vertical* text: a Japanese
 * balloon set in columns is as tall-and-narrow as an upright English one is
 * wide-and-short, and the smallest rectangle around either is axis-aligned.
 * So a right angle means "set the other way", not "turned on its side", and
 * the caller has to know which it wanted. What this is good for is the
 * slanted case, where the answer is neither nought nor ninety.
 */
export interface InkRect {
  /** The middle of the lettering, in the mask's own pixels. */
  cx: number
  cy: number
  /** Along the text's own direction, and across it. */
  w: number
  h: number
  /** Degrees, positive clockwise, folded into ±45. */
  angle: number
  /**
   * Which exit produced this answer — the measurement explaining itself.
   *
   * Added when ECLIPSE page 22 came back upright on every visibly leaning
   * balloon and the only way to know *why* was to guess among four gates,
   * each of which exists against a different real failure. An upright answer
   * is not one fact but five — too few samples, a credible glyph line at 0,
   * a sweep whose rectangle was not elongated enough to believe, a lean
   * inside the snap band — and relaxing the wrong gate reintroduces the
   * failure it was built against. `sparse` and `no-fit` are the empty cases;
   * `glyph-line` is the preferred path; `sweep` its shape-based fallback;
   * `column-line` the CJK path, a lean read off the columns themselves;
   * `sweep-declined` the fallback refusing to guess on squarish ink;
   * `agreed` that refusal overturned because the weak glyph fit and the
   * declined sweep named the same angle independently; `snapped` a real but
   * sub-noise lean rounded to level.
   */
  via: 'sparse' | 'column-line' | 'glyph-line' | 'sweep' | 'sweep-declined' | 'agreed' | 'snapped' | 'no-fit'
}

/** One blob of ink that is the right size to be a letter, or part of one. */
interface Glyph {
  cx: number
  cy: number
  x0: number
  y0: number
  x1: number
  y1: number
  /** Ink pixels, so merged parts can weight their shared middle. */
  n: number
  /**
   * A thin sample of the blob's own pixels. What the fallback sweep runs
   * over — the point of carrying them is that they are *sieved* pixels: the
   * burst and the speedlines are already gone by the time these exist, so a
   * rectangle fitted to them describes the lettering rather than the frame
   * around it.
   */
  px: number[]
  py: number[]
}

/**
 * Stroke blobs folded into the glyphs they spell.
 *
 * A kanji is not one blob — 何 is two, 話 is three — and fitting a line
 * through *stroke* middles smears every glyph into a little cloud of its
 * own. Against real lettering that cross-scatter was enough to make a
 * genuinely diagonal sound effect look like no line at all, while the
 * balloons it was meant to protect still slipped through elsewhere.
 *
 * Merged where their boxes intersect, with no margin, and that is the
 * load-bearing choice: the strokes of one character overlap each other's
 * extents, but stacked characters in a column — and letters in a word —
 * sit apart. So this folds parts into wholes without folding neighbours
 * into each other, which a margin of any size starts to do.
 */
function clustered (parts: Glyph[]): Glyph[] {
  const owner = parts.map((_, i) => i)

  const find = (i: number): number => (owner[i] === i ? i : (owner[i] = find(owner[i]!)))

  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      const p = parts[a]!
      const q = parts[b]!

      if (p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1) {
        owner[find(a)] = find(b)
      }
    }
  }

  const merged = new Map<number, Glyph>()

  for (let i = 0; i < parts.length; i++) {
    const root = find(i)
    const p = parts[i]!
    const held = merged.get(root)

    if (!held) {
      merged.set(root, { ...p, px: [...p.px], py: [...p.py] })

      continue
    }

    const n = held.n + p.n

    held.cx = (held.cx * held.n + p.cx * p.n) / n
    held.cy = (held.cy * held.n + p.cy * p.n) / n
    held.x0 = Math.min(held.x0, p.x0)
    held.y0 = Math.min(held.y0, p.y0)
    held.x1 = Math.max(held.x1, p.x1)
    held.y1 = Math.max(held.y1, p.y1)
    held.n = n
    held.px.push(...p.px)
    held.py.push(...p.py)
  }

  return [...merged.values()]
}

/**
 * The glyphs in a mask, as the middles of the blobs they are made of.
 *
 * Found by flood fill and then sieved by size, which is what makes this
 * worth doing: the outline of a balloon or a sound effect's burst is one
 * enormous component and screentone is a scatter of tiny ones, so both fall
 * out on the way past and what is left is lettering.
 *
 * Returns nothing when the glyphs run together — a heavy Latin word floods
 * into a single blob, and one point describes no direction. That is the
 * signal to fall back to measuring the ink's shape instead.
 */
export function glyphCentres (mask: Float32Array, w: number, h: number): Glyph[] {
  const seen = new Uint8Array(w * h)
  const found: Glyph[] = []
  const stack: number[] = []

  const small = w * h * 0.0005
  const large = { w: w * 0.7, h: h * 0.7 }

  for (let start = 0; start < w * h; start++) {
    if (mask[start]! <= 0.5 || seen[start]) continue

    let count = 0
    let sumX = 0
    let sumY = 0
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    const px: number[] = []
    const py: number[] = []

    stack.push(start)
    seen[start] = 1

    while (stack.length) {
      const at = stack.pop()!
      const x = at % w
      const y = (at / w) | 0

      count++
      sumX += x
      sumY += y

      // Every 17th pixel, which is plenty for a rectangle and cheap enough
      // to carry — and a prime step, so a raster pattern cannot alias it
      // into sampling one column of the blob.
      if (count % 17 === 0) {
        px.push(x)
        py.push(y)
      }

      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      // Four-connected: diagonals join strokes that only touch at a corner,
      // which merges neighbouring glyphs more often than it mends one.
      if (x > 0 && mask[at - 1]! > 0.5 && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1) }
      if (x < w - 1 && mask[at + 1]! > 0.5 && !seen[at + 1]) { seen[at + 1] = 1; stack.push(at + 1) }
      if (y > 0 && mask[at - w]! > 0.5 && !seen[at - w]) { seen[at - w] = 1; stack.push(at - w) }
      if (y < h - 1 && mask[at + w]! > 0.5 && !seen[at + w]) { seen[at + w] = 1; stack.push(at + w) }
    }

    if (count < small) continue
    if (maxX - minX > large.w || maxY - minY > large.h) continue

    // A blob smaller than the sampling step still deserves one point.
    if (!px.length) {
      px.push(Math.round(sumX / count))
      py.push(Math.round(sumY / count))
    }

    found.push({ cx: sumX / count, cy: sumY / count, x0: minX, y0: minY, x1: maxX, y1: maxY, n: count, px, py })
  }

  // Whole glyphs, not strokes — see `clustered` for why the difference is
  // the difference between finding a diagonal and refusing it.
  return clustered(found)
}

/**
 * How much longer a scatter is than it is wide before its direction is
 * believed.
 *
 * The gate this file needs most. A *line* of glyphs has a clear direction; a
 * balloon of several columns is a two-dimensional cloud, and fitting a line
 * to a cloud returns whatever slight imbalance happens to tip it — which is
 * how upright balloons came back at −13° and 16°. Worse for CJK than for
 * Latin, because a kanji is several disconnected strokes and so contributes
 * several points rather than one.
 *
 * Twelve, and the number was found rather than chosen. A *single line* of
 * glyphs is very nearly collinear, so its scatter is enormously longer than
 * it is wide and clears any sane bar. A balloon of two columns is elongated
 * too — five characters down against two across is about six to one — and a
 * gate of four let it through, whereupon unequal column lengths tipped the
 * fit and an upright balloon came back at minus thirteen degrees.
 *
 * So the bar sits above what a column grid can reach and below what a line
 * comfortably does. Anything between is refused, which costs a slanted line
 * of two or three glyphs its angle and saves every balloon on the page from
 * being handed a wrong one — the right way round, since nought is correct
 * for a balloon and merely unhelpful for a sound effect.
 */
const LINEAR_ENOUGH = 12

/**
 * The line the glyph middles lie along, however weakly they lie along it.
 *
 * The angle comes with the eigenvalue ratio that says how line-like the
 * scatter is, and the caller decides what ratio is worth believing —
 * `centreAngle` demands `LINEAR_ENOUGH`, the agreement rescue in `inkRect`
 * accepts less because it holds a second witness.
 */
export function centreFit (points: Glyph[]): { angle: number, ratio: number } | null {
  if (points.length < 3) return null

  const midX = points.reduce((total, p) => total + p.cx, 0) / points.length
  const midY = points.reduce((total, p) => total + p.cy, 0) / points.length

  let xx = 0
  let yy = 0
  let xy = 0

  for (const p of points) {
    const dx = p.cx - midX
    const dy = p.cy - midY

    xx += dx * dx
    yy += dy * dy
    xy += dx * dy
  }

  xx /= points.length
  yy /= points.length
  xy /= points.length

  // The spread along the scatter's own two axes: the eigenvalues of what is
  // above. Their ratio is how line-like it is.
  const mean = (xx + yy) / 2
  const span = Math.sqrt(Math.max(0, ((xx - yy) / 2) ** 2 + xy * xy))

  const major = mean + span
  const minor = mean - span

  if (major <= 1e-6) return null

  return {
    angle: Math.round((0.5 * Math.atan2(2 * xy, xx - yy) * 180) / Math.PI),
    ratio: minor > 1e-6 ? major / minor : Infinity,
  }
}

/**
 * The line the glyph middles lie along, in degrees — or nothing, when they
 * do not lie along one *credibly*.
 *
 * Refusing is the important half. Nothing here can tell a tilted line from a
 * grid that leans, so the only safe answer for a cloud is no answer, which
 * hands the question back to the ink's shape and, failing that, to nought.
 */
function centreAngle (points: Glyph[]): number | null {
  const fit = centreFit(points)

  if (fit === null || fit.ratio < LINEAR_ENOUGH) return null

  return fit.angle
}

/** A lean folded into ±45 — the two ways of naming one rectangle, reconciled. */
function foldLean (degrees: number): number {
  return ((degrees % 90) + 135) % 90 - 45
}

/**
 * Only the clusters big enough to be characters.
 *
 * Every direction-fitting path has now been caught believing ellipsis dots:
 * the whole-scatter fit read a diagonal dot-trail under three upright
 * characters as a 34° lean *through* `LINEAR_ENOUGH` — three characters
 * plus six trailing dots are a genuinely elongated scatter — and the same
 * trail once dragged fit and sweep into "agreement" at −37°. Dots may say
 * where ink is; only characters say which way the text runs.
 *
 * Judged by bounding-box size, not ink count, after ink count failed: a
 * chunky printed dot carries a twelfth of a light hanzi's pixels and slid
 * under a mass floor, but no dot is a third of a character's *size* — and
 * size is also the honest measure for sparse-stroked glyphs, whose boxes
 * are large however little ink they hold. Relative to the largest cluster
 * at a quarter, which survives `clustered` merging a character pair into
 * one double-height box; relative to a median it would fail outright, since
 * in a mostly-dots balloon the median cluster *is* a dot.
 */
function heavyOnly (parts: Glyph[]): Glyph[] {
  if (!parts.length) return parts

  const side = (p: Glyph) => Math.max(p.x1 - p.x0, p.y1 - p.y0)
  const largest = Math.max(...parts.map(side))

  return parts.filter((p) => side(p) >= largest / 4)
}

/**
 * The lean of the lettering's *columns* — the CJK answer to a question the
 * whole-scatter fit keeps getting wrong.
 *
 * Measured on ECLIPSE page 22 and its neighbours, with the fits drawn over
 * the crops, the whole-scatter eigenvalue ratio cannot tell a real lean from
 * a fake one: the four genuinely leaning balloons fit at ratios 4–11 and the
 * two false leans at 9–11 — the same band. The structure the eye uses is
 * different: leaning lettering is a *column* of characters tracking a line,
 * and both failure modes are things that are not columns —
 *
 *   * a multi-column dialogue balloon is a cloud whose slight imbalance the
 *     fit reads as −5°, which is how upright balloons grow leans;
 *   * a trailing ellipsis drifting diagonally under upright characters drags
 *     the fit to −17°, because four dots weigh as much as four characters
 *     when only centres are counted.
 *
 * So: keep only clusters heavy enough to be characters (an ellipsis dot is
 * one to two orders of magnitude lighter than the lightest hanzi in its
 * balloon — the floor is relative to the heaviest cluster, not the median,
 * because in a mostly-dots balloon the median *is* a dot). Group them into
 * columns by x-overlap, which survives the leans in question — at 25° a
 * thirty-pixel character shifts sixteen pixels per step, still half a width
 * of overlap — and stays empty for horizontal text, whose boxes never
 * overlap in x, so Latin falls through to the paths that already handle it.
 * Fit each column of three or more on its own; a true column is near
 * collinear and clears `LINEAR_ENOUGH` with room, so no weaker bar is
 * needed. Columns of one block share the block's rotation, so several that
 * disagree are not a rotated block but a cloud, and are refused.
 */
function columnLean (parts: Glyph[]): { direction: number, firm: boolean } | null {
  if (parts.length < 3) return null

  // Whole characters, not the pieces they are drawn in. A Hangul syllable is
  // two or three separate jamo stacked in one cell, and as pieces they are a
  // three-member "column" whose members sit a few pixels off each other — a
  // lone `학` read as −19° that way. `characters` rebuilds each syllable into
  // one member, and it cannot join two real characters, so a hanzi column
  // keeps every member it had. Merged after the size floor, so the ellipsis
  // dots the floor sets aside are never fused into something heavy.
  const floored = heavyOnly(parts)
  const heavy = characters(floored)

  /**
   * Too few characters to vote — the single-glyph-plus-ellipsis balloon,
   * `要……`. Here the size floor works against the truth: the dot column *is*
   * most of the lettering, and its direction is the direction a letterer
   * would set the line along. So the floored-out clusters get the vote the
   * characters cannot cast, under a stricter bar than characters ever face —
   * at least five of them, near-collinear beyond `LINEAR_ENOUGH`, because a
   * scatter of screentone survivors must not elect a direction. The ±32 cap
   * below still applies, which is what keeps the steep diagonal tails of the
   * staircase balloons from arriving by this door; those are det's to claim.
   */
  if (heavy.length < 3) {
    // Against the pieces the floor kept, not `heavy`: merging makes new
    // objects, so `heavy.includes` matched nothing and every piece of a
    // two-syllable line — `이봐,` — voted as a dot, and read +12°.
    const light = parts.filter((part) => !floored.includes(part))

    if (light.length < 5) return null

    const fit = centreFit(light)

    if (fit === null || fit.ratio < LINEAR_ENOUGH) return null

    const lean = foldLean(fit.angle)

    if (Math.abs(lean) > 32) return null

    const direction = lean + 90

    return {
      direction: direction > 90 ? direction - 180 : direction,
      firm: fit.ratio >= 25,
    }
  }

  const owner = heavy.map((_, i) => i)
  const find = (i: number): number => (owner[i] === i ? i : (owner[i] = find(owner[i]!)))

  for (let a = 0; a < heavy.length; a++) {
    for (let b = a + 1; b < heavy.length; b++) {
      const p = heavy[a]!
      const q = heavy[b]!
      const overlap = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)

      if (overlap >= 0.5 * Math.min(p.x1 - p.x0, q.x1 - q.x0)) owner[find(a)] = find(b)
    }
  }

  const columns = new Map<number, Glyph[]>()

  for (let i = 0; i < heavy.length; i++) {
    const root = find(i)

    if (!columns.has(root)) columns.set(root, [])
    columns.get(root)!.push(heavy[i]!)
  }

  const leans: { lean: number, members: number, ratio: number, column: Glyph[] }[] = []

  for (const members of columns.values()) {
    if (members.length < 3) continue

    // Stacked, or it is not a column. Two members overlapping in y sit side
    // by side, which is a line of horizontal lettering chained into this
    // group through its x-overlaps — three short centred lines
    // (`늦어서 / 미.. / 에엥?`) joined that way and read as −11°. A real
    // column's characters sit one above the next and never share a height.
    let sideBySide = false

    for (let i = 0; i < members.length && !sideBySide; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const p = members[i]!
        const q = members[j]!
        const overlap = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0)

        if (overlap >= 0.5 * Math.min(p.y1 - p.y0, q.y1 - q.y0)) {
          sideBySide = true
          break
        }
      }
    }

    if (sideBySide) continue

    const fit = centreFit(members)

    // The bar here is deliberately low — see `firm` below for where the
    // real credibility decision lives, and note the members are already
    // character-sized (`heavyOnly`), so what is being fitted is characters,
    // not whatever the balloon scattered around them. Three was chosen over
    // four after a real column sat exactly on the boundary and fell out.
    if (fit === null || fit.ratio < 3) continue

    // Long enough to be a column — see `elongation`. Three stacked pieces of
    // one syllable, or a character with punctuation under it, are about as
    // long as they are wide; three real characters are three times longer.
    if (elongation(members, fit.angle) < 2.5) continue

    leans.push({ lean: foldLean(fit.angle), members: members.length, ratio: fit.ratio, column: members })
  }

  if (!leans.length) return null

  if (rowsNotColumns(heavy, leans.map((c) => c.column))) return null

  // Columns must hold most of the lettering — three in five. Vertical text is
  // columns through and through; an alignment that happens to stack a few
  // characters of horizontal lines is a minority of the balloon, and its
  // "lean" is whatever the alignment left.
  const inColumns = leans.reduce((sum, c) => sum + c.members, 0)

  if (inColumns * 5 < heavy.length * 3) return null

  const low = Math.min(...leans.map((c) => c.lean))
  const high = Math.max(...leans.map((c) => c.lean))

  if (high - low > 8) return null

  const total = leans.reduce((sum, c) => sum + c.members, 0)
  const lean = leans.reduce((sum, c) => sum + c.lean * c.members, 0) / total

  // Past this a "column" is not a lean, it is layout the grouping misread —
  // hand lettering does not slant its dialogue by forty degrees, and the
  // sweep already owns the genuinely diagonal sound effects.
  if (Math.abs(lean) > 32) return null

  // Back into a direction `extentsAt` can take: the column runs a quarter
  // turn from its lean, and the ±45 fold at the end of `inkRect` brings the
  // rectangle home with its sides swapped, exactly as the whole-scatter
  // path's near-vertical angles always have.
  const direction = lean + 90

  return {
    direction: direction > 90 ? direction - 180 : direction,
    /**
     * Whether this stands on its own. Measured on the corpus: real leaning
     * columns fit at ratios 4–12, because `clustered` merges character
     * pairs and the merged centroids wobble off the line — so a high bar
     * refuses every one of them, and a low bar with few points believes
     * noise. The way out is not a cleverer threshold: several agreeing
     * columns are firm (an upright grid decomposes into upright columns, so
     * the old cloud hazard cannot reach here), one column with points to
     * spare and a clean line is firm, and everything else is a *weak*
     * witness that `inkRect` only accepts when the min-area sweep
     * independently lands within a few degrees of it.
     */
    firm: leans.length > 1
      || leans.some((c) => (c.members >= 4 && c.ratio >= 6) || c.ratio >= LINEAR_ENOUGH),
  }
}

/**
 * Whether these "columns" are really horizontal lines stacked one over the next.
 *
 * Centred lines of different lengths line their characters up vertically, and
 * the result is indistinguishable from vertical text by shape: `예? / 그게 /
 * 무슨..` came out of the grouping as two tidy three-character columns, each
 * stacked, each long, together holding the whole balloon, agreeing with each
 * other — and read +9°, because centring drifts every row a little. `오오 /
 * 오옥 / !!!` did it with one column and −11°. Every test `columnLean` makes
 * is a test of *shape*, and the shape is right.
 *
 * What differs is spacing, which is how a reader tells the two apart at a
 * glance. Set horizontally, a line's characters nearly touch and the lines sit
 * further apart; set vertically, it is the other way round. So each column
 * member's nearest character *outside* its column is compared with the step to
 * the next character *down* it, centre to centre — which holds at any lean, as
 * a turned column's step is still along it. On those two balloons the row
 * neighbours were 55 and 66 pixels away against column steps of 88 and 82. A
 * lone column with nothing beside it has no row to compare and is left alone.
 */
function rowsNotColumns (heavy: Glyph[], columns: Glyph[][]): boolean {
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!
  const steps: number[] = []
  const across: number[] = []

  for (const column of columns) {
    const down = [...column].sort((a, b) => a.cy - b.cy)

    for (let i = 1; i < down.length; i++) {
      steps.push(Math.hypot(down[i]!.cx - down[i - 1]!.cx, down[i]!.cy - down[i - 1]!.cy))
    }

    for (const member of column) {
      const beside = heavy
        .filter((other) => !column.includes(other))
        .map((other) => Math.hypot(other.cx - member.cx, other.cy - member.cy))

      if (beside.length) across.push(Math.min(...beside))
    }
  }

  if (!steps.length || !across.length) return false

  return median(across) < median(steps)
}

/**
 * The pieces of ink that make up one character, put back together.
 *
 * `glyphCentres` finds connected ink and `clustered` joins pieces whose boxes
 * *overlap*. That is enough for most hanzi and it is not enough for Hangul: a
 * syllable is two or three jamo stacked or set side by side with clean paper
 * between them — `윽` is ㅇ over ㅡ over ㄱ, three separate pieces — so a
 * line of Korean arrives here as a scatter of fragments, each a fraction of a
 * character. Every fit downstream then measures how the fragments sit inside
 * their syllable, not how the syllables sit along the line.
 *
 * Merged by size alone: two pieces join when the box around both is still no
 * bigger than one character cell. That is what a syllable's jamo are, and it
 * is exactly what two neighbouring characters are *not* — any two whole
 * characters, side by side or one above the other, span two cells — so this
 * cannot fuse a line or a column into one blob. Smallest union first, so a
 * syllable's own pieces find each other before a stray dot beside it does.
 *
 * The cell is the largest piece, ignoring anything more than three times the
 * median — a balloon's tail or a screentone fragment that slipped past the
 * sieve must not decide what size a character is.
 */
function characters (parts: Glyph[]): Glyph[] {
  if (parts.length < 2) return parts

  const sideOf = (p: Glyph) => Math.max(p.x1 - p.x0, p.y1 - p.y0) + 1
  const sides = parts.map(sideOf).sort((a, b) => a - b)
  const median = sides[sides.length >> 1]!
  const cell = Math.max(...sides.filter((side) => side <= median * 3)) * 1.2

  const units = parts.map((p) => ({ ...p }))

  for (;;) {
    let pick: [number, number] | null = null
    let smallest = Infinity

    for (let a = 0; a < units.length; a++) {
      for (let b = a + 1; b < units.length; b++) {
        const p = units[a]!
        const q = units[b]!
        const uw = Math.max(p.x1, q.x1) - Math.min(p.x0, q.x0) + 1
        const uh = Math.max(p.y1, q.y1) - Math.min(p.y0, q.y0) + 1

        if (Math.max(uw, uh) > cell) continue

        if (uw * uh < smallest) {
          smallest = uw * uh
          pick = [a, b]
        }
      }
    }

    if (!pick) return units

    const [a, b] = pick
    const p = units[a]!
    const q = units[b]!
    const n = p.n + q.n

    units[a] = {
      cx: (p.cx * p.n + q.cx * q.n) / n,
      cy: (p.cy * p.n + q.cy * q.n) / n,
      x0: Math.min(p.x0, q.x0),
      y0: Math.min(p.y0, q.y0),
      x1: Math.max(p.x1, q.x1),
      y1: Math.max(p.y1, q.y1),
      n,
      px: p.px,
      py: p.py,
    }
    units.splice(b, 1)
  }
}

/**
 * How many times longer than wide some pieces are, measured along `degrees` —
 * their own direction, so the answer does not change as they turn.
 *
 * The gate every fitted lean now has to clear, and the one thing all the
 * false leans had in common: they were read off lettering one or two
 * characters long. A syllable's stacked jamo, a pair of characters and a
 * comma, `해서`, `啊，嗯…` — any few points are "a line" to a fit, and
 * whatever small offsets their shapes have become its angle. Counting
 * characters does not survive a real page (jamo split, and a turned row's
 * pieces clump into a few blobs), but length does: a line has to be about
 * three characters long before it can say which way it runs.
 */
function elongation (parts: Glyph[], degrees: number): number {
  const xs: number[] = []
  const ys: number[] = []

  // The ink's own sampled pixels, not the pieces' boxes: a turned piece's
  // upright box sticks out sideways, and on a turned row of clumped pieces
  // that alone halved the measured length and refused a real 22° line.
  for (const p of parts) {
    xs.push(...p.px)
    ys.push(...p.py)
  }

  const rect = extentsAt(xs, ys, degrees)

  return rect.h > 0 ? rect.w / rect.h : Infinity
}

/**
 * The glyph line, but only when it really is one line.
 *
 * `centreAngle` asks whether the centres are line-like, and a few centres
 * always are: across three pieces any scatter is "elongated". That is how the
 * whole-scatter fit put −5° to +9° on upright shouts — `느옥!!`, `으악!!`,
 * `哈啊。` — once the punctuation beside two characters was allowed to count
 * as a third. So the fit must also pass close to *every* letter: none more
 * than three quarters of a letter off it. One line of lettering does that
 * with room to spare, final consonants and all; a fit that threads several
 * lines, or a centred stack, does not. And it must be long enough to have a
 * direction at all — see `elongation`.
 */
function singleLine (parts: Glyph[]): number | null {
  const angle = centreAngle(parts)

  if (angle === null) return null

  const radians = (angle * Math.PI) / 180
  const midX = parts.reduce((total, p) => total + p.cx, 0) / parts.length
  const midY = parts.reduce((total, p) => total + p.cy, 0) / parts.length
  const sizes = parts.map((p) => Math.max(p.x1 - p.x0, p.y1 - p.y0) + 1).sort((a, b) => a - b)
  const size = sizes[sizes.length >> 1]!
  const farthest = Math.max(...parts.map((p) =>
    Math.abs(-(p.cx - midX) * Math.sin(radians) + (p.cy - midY) * Math.cos(radians))))

  if (farthest > size * 0.75) return null

  return elongation(parts, angle) >= 3 ? angle : null
}

/**
 * The pieces shaped like letters: neither side thin next to a typical piece.
 *
 * Sets aside `!`, `?`'s dot, `。`, commas and the like, which sit off the line
 * letters make and, among two or three characters, steer it. Three or fewer
 * pieces are left as they are — there is nothing to judge a typical one by.
 */
function lettersOnly (parts: Glyph[]): Glyph[] {
  if (parts.length < 3) return parts

  const sizes = parts.map((p) => Math.max(p.x1 - p.x0, p.y1 - p.y0) + 1).sort((a, b) => a - b)
  const size = sizes[sizes.length >> 1]!

  return parts.filter((p) => Math.min(p.x1 - p.x0, p.y1 - p.y0) + 1 >= size * 0.35)
}

/** The box the ink fills when measured along one direction. */
function extentsAt (xs: number[], ys: number[], degrees: number): Omit<InkRect, 'via'> {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity

  for (let i = 0; i < xs.length; i++) {
    const u = xs[i]! * cos + ys[i]! * sin
    const v = -xs[i]! * sin + ys[i]! * cos

    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }

  const midU = (minU + maxU) / 2
  const midV = (minV + maxV) / 2

  return {
    cx: midU * cos - midV * sin,
    cy: midU * sin + midV * cos,
    w: maxU - minU,
    h: maxV - minV,
    angle: degrees,
  }
}

/**
 * The smallest rectangle that holds the ink, turned to match it.
 *
 * The angle alone is not enough to draw with: the box a detector gives is
 * the upright *bounding* box of slanted text, which is far larger than the
 * text and, spun about its centre, hugs nothing. What is wanted is this
 * rectangle — measured along the text's own axes.
 *
 * ## Two ways of asking, because neither is enough
 *
 * The direction is taken from where the glyphs *sit* where that can be
 * seen, and from the shape of the ink where it cannot.
 *
 * Shape alone — the smallest enclosing rectangle — is what this did first,
 * and it is wrong twice over on comics. A sound effect inside a burst is
 * mostly burst, so the rectangle describes the frame and comes back
 * upright; and CJK glyphs are individually square, so three of them in a
 * row are not an elongated shape at all. Measured against text drawn at
 * −55°, shape gave 0° inside a burst and 43° outside one.
 *
 * Where the glyphs sit is a better question, because a burst is one huge
 * blob that can be sieved out by size and a run of glyphs is a line of
 * points whichever script it is in. Both cases come back at −55° exactly.
 *
 * It is not always available: a heavy Latin word floods into one blob, and
 * one point has no direction — which is precisely the case shape handles
 * well, since a long word *is* an elongated rectangle. So each covers the
 * other's failure, and the arrangement is preferred when there is one.
 */
export function inkRect (mask: Float32Array, w: number, h: number): InkRect {
  const xs: number[] = []
  const ys: number[] = []

  // Sampled rather than exhaustive: a balloon is tens of thousands of ink
  // pixels and a few thousand describe the same rectangle.
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)))

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (mask[y * w + x]! > 0.5) {
        xs.push(x)
        ys.push(y)
      }
    }
  }

  if (xs.length < 12) return { cx: w / 2, cy: h / 2, w, h, angle: 0, via: 'sparse' }

  // Where the glyphs sit, if that can be seen at all.
  const glyphs = glyphCentres(mask, w, h)
  // Mass-floored, or a dot-trail steers the line — see `heavyOnly`. Then
  // letter-shaped only, and one line only — see `singleLine`.
  const arranged = singleLine(lettersOnly(heavyOnly(glyphs)))

  /**
   * Every measurement below runs over the glyphs' own sampled pixels when
   * there are any, and over the raw ink only when there are none. This is
   * the line that makes the burst harmless *everywhere*: the sieve already
   * dropped it, so a rectangle fitted to these points describes the
   * lettering whichever path chose the angle — including the fallback,
   * which used to sweep the raw ink and dutifully measured the frame.
   */
  let overX = xs
  let overY = ys

  if (glyphs.length) {
    overX = glyphs.flatMap((glyph) => glyph.px)
    overY = glyphs.flatMap((glyph) => glyph.py)

    // The samples are every seventeenth pixel along a depth-first fill, and
    // a fill's path clusters them — a 25-pixel character's dozen samples can
    // span half its true width, and the measured box on ECLIPSE page 22's
    // `要……` came out narrower than the character it contained. The bounding
    // corners are tracked exactly during the fill and cost nothing; with
    // them in, an extent can never undershoot a kept cluster.
    for (const glyph of glyphs) {
      overX.push(glyph.x0, glyph.x1, glyph.x0, glyph.x1)
      overY.push(glyph.y0, glyph.y0, glyph.y1, glyph.y1)
    }
  }

  let found: InkRect | null = null

  // Columns first: for CJK they are the structure the lean actually lives
  // in, and the whole-scatter fit below cannot tell a leaning column from a
  // leaning cloud — see `columnLean`. A weak column is held back rather
  // than used: it goes to the sweep's agreement check below.
  const columns = columnLean(glyphs)

  if (columns?.firm) found = { ...extentsAt(overX, overY, columns.direction), via: 'column-line' }
  else if (arranged !== null) found = { ...extentsAt(overX, overY, arranged), via: 'glyph-line' }

  // Otherwise the shape of the ink: the direction whose rectangle is
  // smallest, which is what an elongated run of letters points along.
  if (!found) {
    /**
     * The direction from the characters, where there are two or more of them;
     * the rectangle is still everything's. A smallest rectangle is decided by
     * its extremes, and the extremes of a short line are whatever sits off it:
     * `啊，嗯…` read +8° because the detector's box clipped a corner of the
     * balloon's outline into an 11-pixel triangle above the first character,
     * and tilting was the cheapest way to take it in. `heavyOnly` is the
     * sieve every other path already uses, for the reason it gives — dots and
     * specks may say where ink is, only characters say which way it runs. A
     * single character keeps every piece, since one glyph has no direction
     * and its dots are then the only line there is.
     */
    const letters = heavyOnly(glyphs)
    // Corners in as well, for the reason `overX` has them.
    const steerX = letters.length >= 2 ? letters.flatMap((g) => [...g.px, g.x0, g.x1, g.x0, g.x1]) : overX
    const steerY = letters.length >= 2 ? letters.flatMap((g) => [...g.py, g.y0, g.y0, g.y1, g.y1]) : overY
    let best = Infinity

    for (let degrees = -90; degrees < 90; degrees++) {
      const steer = extentsAt(steerX, steerY, degrees)
      const area = steer.w * steer.h

      if (area < best) {
        best = area
        found = { ...extentsAt(overX, overY, degrees), via: 'sweep' }
      }
    }

    /**
     * Believed only when the ink is clearly a line of something. The
     * smallest rectangle around square-ish content — a balloon of columns,
     * a lone character — lands at whatever angle its ragged edges happen to
     * favour, and on real scans they always favour *something*. An upright
     * answer is right for all of those; the elongated case is the only one
     * where this sweep knows better.
     */
    if (found) {
      const long = Math.max(found.w, found.h)
      const short = Math.min(found.w, found.h)

      if (short > 0 && long / short < 2.2) {
        /**
         * One rescue before giving up: agreement between two witnesses too
         * weak to believe alone. A CJK column is square glyphs stacked, so
         * its smallest rectangle is never elongated and the sweep above is
         * *always* declined for it — which is how every leaning balloon on
         * ECLIPSE page 22 came back upright, unanimously via this exit. But
         * the glyph fit that was too cloudy for `LINEAR_ENOUGH` still has an
         * axis, and it measures centres where the sweep measures extents —
         * independent readings of the same ink. Ragged edges land the sweep
         * at whatever angle they favour; they do not conspire with the
         * centres to favour the *same* one. Within a few degrees, on the
         * 90° equivalence the sweep works in, agreement is the evidence.
         *
         * The snap band below still applies, so an agreed near-level lean
         * is levelled like any other.
         */
        // Only a *column* may be the weak witness. The first version fell
        // back to the whole-scatter fit when no column formed, and page
        // 22's bottom balloons showed why that is not a second witness at
        // all: their ellipsis dots trail diagonally, the dots drag the
        // scatter fit and the sweep the *same* way — shared inputs, not
        // independent readings — and the two "agreed" on a −37° lean that
        // rotated a correctly-reading crop into garbage. The column is
        // mass-floored and capped, so what it endorses a sweep can confirm;
        // a cloud endorsing a sweep is the dots agreeing with themselves.
        const witness = columns?.direction ?? null
        const raw = witness === null ? null : (((found.angle - witness) % 90) + 90) % 90
        const apart = raw === null ? null : Math.min(raw, 90 - raw)

        found = witness !== null && apart! <= 8
          ? { ...extentsAt(overX, overY, witness), via: 'agreed' }
          : { ...extentsAt(overX, overY, 0), via: 'sweep-declined' }
      }
    }
  }

  if (!found) return { cx: w / 2, cy: h / 2, w, h, angle: 0, via: 'no-fit' }

  /**
   * The fold comes first because the snap has to judge the *lean*, not the
   * direction. A vertical column measured at +86° is a 4° lean — the same
   * rectangle a quarter turn later — and testing the raw angle let it slip
   * past as "steep" and come out of the fold as a spurious −4°, while a
   * lean the fold produced (+3° from −87°) emerged *under* the band the
   * snap exists to close. Both on the same page.
   */
  if (found.angle <= -45) found = { ...found, w: found.h, h: found.w, angle: found.angle + 90 }
  else if (found.angle >= 45) found = { ...found, w: found.h, h: found.w, angle: found.angle - 90 }

  /**
   * Snapped level when it is nearly level. A degree or three of measured
   * tilt on a balloon is the raggedness of its ink, not a letterer's hand —
   * and downstream a spurious two-degree rotation is worse than none, since
   * it turns every crop and redraw for nothing.
   */
  if (Math.abs(found.angle) <= 4 && found.angle !== 0) {
    return { ...extentsAt(overX, overY, 0), via: 'snapped' }
  }

  return found
}

/** Just the angle, for callers that only want to know which way it runs. */
export function inkAngle (mask: Float32Array, w: number, h: number): number {
  return inkRect(mask, w, h).angle
}

/**
 * Corrections in page pixels, moved into a tile's own pixels.
 *
 * The one conversion the cleaning needs. A stroke is *stored* against the
 * page, because that is where the ink is and a block's box may be resized
 * without the ink moving; it is *drawn* against the tile, because that is
 * what the model sees. Keeping the two apart is what lets a tile be scaled
 * up to the model's floor without the corrections blurring with it.
 */
export function editsForTile (edits: MaskEdit[], tile: Region, size: { w: number, h: number }): MaskEdit[] {
  const sx = size.w / tile.w
  const sy = size.h / tile.h

  return edits.map((edit) => ({
    ...edit,
    points: edit.points.map((value, i) => (i % 2 === 0 ? (value - tile.x) * sx : (value - tile.y) * sy)),
    // A brush is round, so one scale has to serve both axes. The tile keeps
    // the region's proportions, so the two agree to within a rounding.
    size: edit.size * ((sx + sy) / 2),
  }))
}

/**
 * Otsu's threshold: the grey level that best splits a histogram in two.
 *
 * Chosen over a fixed threshold because a balloon is not always white and
 * ink is not always black — a screentoned panel and a night scene have
 * nothing in common except that the lettering is the part that stands out,
 * which is precisely what this maximises.
 */
function otsu (histogram: Uint32Array, total: number): number {
  let sum = 0

  for (let i = 0; i < 256; i++) sum += i * histogram[i]!

  let sumBack = 0
  let weightBack = 0
  let best = 0
  let cut = 127

  for (let level = 0; level < 256; level++) {
    weightBack += histogram[level]!

    if (!weightBack) continue

    const weightFore = total - weightBack

    if (!weightFore) break

    sumBack += level * histogram[level]!

    const meanBack = sumBack / weightBack
    const meanFore = (sum - sumBack) / weightFore
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2

    if (between > best) {
      best = between
      cut = level
    }
  }

  return cut
}

/**
 * The ink inside one tile, thresholded region by region and unioned.
 *
 * Each region is a box within the tile — the threshold is taken from it and
 * the mask is confined to it, so the artwork kept around the crop for context
 * is neither counted nor erased. Handed several, each gets its own split and
 * its own verdict, which is what lets a five-line balloon come out whole; see
 * the header for the page that made this necessary.
 *
 * Unioned as raw ink and grown *once* at the end rather than per region: two
 * dilations of adjacent lines meeting in the middle would be the same pixels
 * either way, but a region that was refused must not have the mask of its
 * neighbour spread into it, and doing the growing after the union keeps the
 * skirt on the outside of what was actually accepted.
 */
export function autoMaskOver (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  regions: { x: number, y: number, w: number, h: number }[],
  /**
   * The box to read the ink's *colour* off, where that is a wider box than the
   * ones being thresholded — the block's own, when the regions are its lines.
   * Defaults to the regions themselves, which is right whenever they are all
   * there is.
   */
  polarityOver?: { x: number, y: number, w: number, h: number },
  /** Grown for the inpainter by default; `false` is `inkOnly`'s measuring path. */
  grow = true,
): InkMask {
  const grey = new Uint8Array(w * h)

  for (let i = 0; i < w * h; i++) {
    grey[i] = Math.round(0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!)
  }

  /**
   * Which side of the split is the lettering — decided once, over the widest
   * box there is, and then imposed on every region.
   *
   * The rule itself is unchanged and still the only one that works both ways
   * round: the lettering is the *smaller* side, because glyph strokes are a
   * minority of a box drawn around text, whichever colour they are. What
   * changed is where it is allowed to be asked. A box around a whole balloon
   * has paper to spare and the minority is unmistakably the ink; a box drawn
   * tight around one line of **extra bold** lettering does not — heavy CJK
   * glyphs in a tight box genuinely cover more than half of it, the rule picks
   * the paper instead, and the mask comes back inverted: the background is
   * painted out and the words are left standing on it.
   *
   * That is the whole of why the bottom lines of an info balloon survived the
   * repair while their lighter neighbours vanished, and why a bold title on a
   * dark banner came back as a solid blob with the letters still in it. Taking
   * the threshold per region — which is what fixes faint lines — is exactly
   * what made it reachable, because it is what made the boxes tight.
   *
   * So the *value* of the threshold stays per region, where local contrast
   * lives, and the *side* is read off `polarityOver` — the block's own box,
   * which is the only one here with paper to spare in it. Reading it off the
   * lines added together is not good enough and was tried: five tight boxes
   * hold no more background than one of them does, so a balloon set in bold
   * throughout flips exactly as it did before. Left out, the regions are all
   * there is and answer for themselves, which is what a plain block has always
   * done.
   */
  const whole = new Uint32Array(256)
  let across = 0

  for (const region of polarityOver ? [polarityOver] : regions) {
    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue

        whole[grey[y * w + x]!]!++
        across++
      }
    }
  }

  let under = 0

  if (across) {
    const settled = otsu(whole, across)

    for (let level = 0; level <= settled; level++) under += whole[level]!
  }

  const light = under > across - under

  const raw = new Uint8Array(w * h)
  const refused: MaskRefusal[] = []
  let read = 0

  for (const [at, region] of regions.entries()) {
    const histogram = new Uint32Array(256)
    let inside = 0

    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue

        histogram[grey[y * w + x]!]!++
        inside++
      }
    }

    // A region wholly off the tile is not a region that was judged, so it is
    // neither counted nor reported. Only the caller knows whether that is a
    // block with nothing in it or a box someone dragged off the page.
    if (!inside) continue

    read++

    // This region's own grey level to cut at, which is the half of the
    // judgement that has to follow the local contrast — see the header. Which
    // side of it is the lettering was settled above, across every region at
    // once, and a tight box around bold lettering may not overrule it.
    const cut = otsu(histogram, inside)

    // Counted before a single pixel is written, so an over-inked region can be
    // dropped by never joining the union — rather than by being taken back out
    // of it, which cannot be done once a neighbour has written the same pixel.
    let ink = 0

    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue

        const value = grey[y * w + x]!

        if (light ? value > cut : value <= cut) ink++
      }
    }

    if (ink > inside * TOO_MUCH) {
      const why = tooMuchNote(ink, inside)

      // Said out loud, because the alternative is a block that quietly refuses to
      // clean and gives no way to find out why. The threshold is a judgement about
      // what a box of lettering looks like, and a box it judges wrongly is exactly
      // the case somebody needs to be able to see. Which part, when there is more
      // than one — a balloon reported five times over says nothing about *where*.
      const which = regions.length > 1 ? ` (part ${at + 1} of ${regions.length})` : ''

      console.warn(`[kemolate] mask left alone${which}: ${why}`)

      refused.push({ at, share: ink / inside, why })

      continue
    }

    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue

        const value = grey[y * w + x]!

        if (light ? value > cut : value <= cut) raw[y * w + x] = 1
      }
    }
  }

  // The measuring path stops here: growth is for the repair, and it fuses
  // small glyphs — see `inkOnly`.
  if (!grow) return { mask: Float32Array.from(raw), read, refused }

  // Grown, because a threshold cuts through the anti-aliased edge of every
  // glyph and leaves a grey halo the model would otherwise treat as artwork
  // worth keeping — which reads as the ghost of the lettering removed.
  const grown = new Float32Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue

      for (let dy = -DILATE; dy <= DILATE; dy++) {
        for (let dx = -DILATE; dx <= DILATE; dx++) {
          const nx = x + dx
          const ny = y + dy

          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

          grown[ny * w + nx] = 1
        }
      }
    }
  }

  return { mask: grown, read, refused }
}

/** Which answer to "where is the lettering" a mask was made from. */
export type MaskSource = 'threshold' | 'segmenter'

/**
 * Where the segmenter's probability has to reach before it counts as ink.
 *
 * A half, the ordinary reading of a probability, and it can be that blunt
 * because the model is not the threshold: it was trained to say "glyph" and
 * the number it gives back is confident at both ends. Nothing here has to
 * work out which side of a split is the lettering, because it was never a
 * split — which is the whole reason a bold title on a dark banner comes back
 * with the letters marked instead of the fill.
 */
const SEG_INK = 0.5

/**
 * A page-resolution field, resampled onto the tile the repair is worked at.
 *
 * The mask has to live wherever the crop lives. `clean.ts` draws its crop at
 * `tileSize` — 256 to 512 on the long edge, so a small balloon is *enlarged*
 * and a big one shrunk — while `segFor` slices the model's answer at the
 * page's own pixels. Handed over unresampled the mask would be a picture of
 * the right thing at the wrong size, and every glyph it marked would sit
 * somewhere the artwork does not.
 *
 * Taken as the **largest** value each destination pixel covers rather than
 * the average, and that is the load-bearing half. Shrinking a page crop onto
 * a tile can put two or three page pixels into one, and a glyph's stroke is
 * often exactly that thin: averaged, a one-pixel stroke landing among
 * background comes back at a third and falls under the threshold, so the
 * strokes the model was right about vanish and the repair leaves their ghost.
 * Over-reaching by a pixel costs nothing by comparison — the mask is grown by
 * `DILATE` immediately afterwards anyway.
 */
export function ontoTile (field: Float32Array, fw: number, fh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)

  for (let y = 0; y < h; y++) {
    // The band of source rows this row of the tile stands for, always at
    // least one — an enlarged tile samples the same row several times over,
    // which is the nearest-neighbour case falling out of the same arithmetic.
    const y0 = Math.min(fh - 1, Math.floor((y * fh) / h))
    const y1 = Math.max(y0, Math.min(fh - 1, Math.ceil(((y + 1) * fh) / h) - 1))

    for (let x = 0; x < w; x++) {
      const x0 = Math.min(fw - 1, Math.floor((x * fw) / w))
      const x1 = Math.max(x0, Math.min(fw - 1, Math.ceil(((x + 1) * fw) / w) - 1))

      let most = 0

      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const value = field[sy * fw + sx] ?? 0

          if (value > most) most = value
        }
      }

      out[y * w + x] = most
    }
  }

  return out
}

/**
 * The segmenter's answer for one tile, or nothing when it had none.
 *
 * The learned half of this file — `autoMaskOver`'s counterpart, and shaped
 * the same way on purpose, so `effectiveMask` can be handed either without
 * caring which it got.
 *
 * `field` is the model's mask for the *crop*, at the crop's own page pixels
 * (`segFor`), and `crop` says what size that was. Everything else is in the
 * tile's pixels.
 *
 * ## Confined to the regions, exactly as the threshold is
 *
 * A crop carries a quarter of the block's size in real artwork around it, for
 * the inpainter to work from, and on a busy page that margin often contains
 * the edge of a *neighbouring* balloon. The threshold never sees those pixels
 * because it only ever reads inside its regions; a page-wide segmenter has
 * already marked them. Left in, cleaning one balloon would take a bite out of
 * the lettering of the one beside it — a repair that looks deliberate and is
 * nowhere near the block anybody was working on.
 *
 * ## Nothing found is a fallback, not a refusal
 *
 * `null` rather than an empty mask, because the two mean different things to
 * the caller. The model under-responds to invented sound effects (see
 * `segment.ts`), and a block it says nothing about is a block the threshold
 * should answer for — not a block to leave uncleaned. Only when *both* find
 * nothing is there something to report, and `clean.ts` already has that path.
 *
 * There is no `TOO_MUCH` here, deliberately. That guard exists because a
 * threshold can pick the wrong side of its own split and hand back the
 * inverse of the lettering; a segmenter has no side to pick, and a mask that
 * covers most of its box is what a full-bleed sound effect genuinely looks
 * like. Refusing those would throw away the case the threshold is worst at.
 */
export function learnedInk (
  field: Float32Array,
  crop: { w: number, h: number },
  w: number,
  h: number,
  regions: { x: number, y: number, w: number, h: number }[],
): InkMask | null {
  const tile = ontoTile(field, Math.max(1, Math.round(crop.w)), Math.max(1, Math.round(crop.h)), w, h)

  const raw = new Uint8Array(w * h)
  let read = 0
  let found = 0

  for (const region of regions) {
    let inside = 0

    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue

        inside++

        if (tile[y * w + x]! >= SEG_INK) {
          raw[y * w + x] = 1
          found++
        }
      }
    }

    // A region wholly off the tile was not read, so it is not counted —
    // the same accounting `autoMaskOver` keeps, for the same reason.
    if (inside) read++
  }

  if (!found) return null

  // Grown for the same reason the threshold's mask is: a mask that stops at
  // the edge of a stroke leaves the anti-aliased shoulder behind, and the
  // model keeps that as artwork worth having — which reads as the ghost of
  // the lettering that was removed.
  const grown = new Float32Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue

      for (let dy = -DILATE; dy <= DILATE; dy++) {
        for (let dx = -DILATE; dx <= DILATE; dx++) {
          const nx = x + dx
          const ny = y + dy

          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

          grown[ny * w + nx] = 1
        }
      }
    }
  }

  return { mask: grown, read, refused: [] }
}

/**
 * The ink inside one tile, judged as a single box.
 *
 * What `autoMaskOver` was before it could take more than one region, and what
 * every caller that has only one box to offer still wants: the detector's own
 * crop (`prose`, `deskew`) or a lab bench asking about a whole tile. Kept as
 * the one-region case rather than as a second implementation, so the two
 * cannot drift.
 */
export function autoMask (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  inner: { x: number, y: number, w: number, h: number },
): Float32Array {
  return autoMaskOver(data, w, h, [inner]).mask
}

/**
 * The threshold's answer *without* the growth — for measuring, not repairing.
 *
 * `DILATE` exists for the inpainter: a threshold cuts through the anti-aliased
 * edge of every glyph, and an ungrown mask leaves the ghost of the lettering
 * in the repair. But growth is exactly wrong for geometry. At a real page's
 * scale — characters around thirty pixels — three pixels of growth in every
 * direction fuses a column of hanzi into **one** connected blob, and one blob
 * has no arrangement: `glyphCentres` returned a single glyph on every leaning
 * balloon of ECLIPSE page 22, so `centreFit` had nothing to fit and every
 * lean came back upright, unanimously via `sweep-declined`. The synthetic
 * bench never caught it because its 80-pixel lettering keeps its gaps even
 * after growth.
 *
 * Same threshold, same polarity choice, same refusals — only the growth is
 * skipped, so the components are the strokes as printed.
 */
export function inkOnly (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  inner: { x: number, y: number, w: number, h: number },
): Float32Array {
  return autoMaskOver(data, w, h, [inner], undefined, false).mask
}

/**
 * The automatic mask with a person's corrections laid over it, in order.
 *
 * On a canvas rather than by hand: a browser already rasterises a stroked
 * polyline with round joins and a soft edge, and doing it here in JavaScript
 * would be slower and worse. The alpha channel comes back as the strength of
 * the mask, which is what a feathered brush means.
 *
 * ## Why the strokes are replayed one at a time
 *
 * The first version rasterised every addition onto one canvas and every wipe
 * onto another, then did `max(auto, added) - wiped` per pixel. That is not
 * "the last thing you said wins" — it is "a wipe always wins", whenever it
 * was drawn. Wipe a balloon early, and every addition made over that spot
 * afterwards was subtracted away on release: the live brush showed the mark,
 * the recomposited mask did not, and the area was permanently unpaintable
 * with no way to tell why.
 *
 * Replaying in `seq` order on a single canvas — `source-over` for an
 * addition, `destination-out` for a wipe — is both the fix and the smaller
 * piece of code, because a canvas already means exactly this. Seeding it
 * with the automatic mask is what lets a wipe take out threshold ink as well
 * as brushed ink, which was the point of having wipes at all.
 */
function composited (auto: Float32Array, w: number, h: number, edits: MaskEdit[]): Float32Array {
  const usable = edits.filter((edit) => edit.points.length >= 2)

  if (!usable.length) return auto

  const canvas = new OffscreenCanvas(w, h)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) return auto

  // White at the automatic mask's own strength, so a later stroke composites
  // against the threshold's result rather than against nothing.
  const seed = context.createImageData(w, h)

  for (let i = 0; i < w * h; i++) {
    seed.data[i * 4] = 255
    seed.data[i * 4 + 1] = 255
    seed.data[i * 4 + 2] = 255
    seed.data[i * 4 + 3] = Math.round(auto[i]! * 255)
  }

  context.putImageData(seed, 0, 0)

  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = '#fff'

  for (const edit of usable) {
    context.globalCompositeOperation = edit.kind === 'wipe' ? 'destination-out' : 'source-over'

    /*
     * The brush's own falloff, as bands to stroke — see `feathered`, and
     * `maskCore` for why a mask centres it on the nominal radius while paint
     * fades inward from there. The threshold below wants the half-coverage line
     * to be the brush's width, and this is what puts it there.
     *
     * It used to make up its own shape here: a core and two skirts at a flat
     * 0.35, reaching twice the radius at zero hardness. Same intent, no shared
     * definition — so the plate and the mask drifted into different brushes and
     * the ring under the pointer could only be honest about one of them.
     */
    const soft = 1 - Math.min(1, Math.max(0, edit.hardness))

    for (const band of feathered(maskCore(1, soft), maskReach(1, soft))) {
      context.globalAlpha = band.alpha
      context.lineWidth = Math.max(1, edit.size * band.radius)
      context.beginPath()
      context.moveTo(edit.points[0]!, edit.points[1]!)

      for (let i = 2; i < edit.points.length - 1; i += 2) {
        context.lineTo(edit.points[i]!, edit.points[i + 1]!)
      }

      // A dot, for a press that never moved.
      if (edit.points.length === 2) context.lineTo(edit.points[0]! + 0.01, edit.points[1]!)

      context.stroke()
    }
  }

  context.globalAlpha = 1

  const { data } = context.getImageData(0, 0, w, h)
  const out = new Float32Array(w * h)

  for (let i = 0; i < w * h; i++) out[i] = data[i * 4 + 3]! / 255

  return out
}

/**
 * The mask a block is actually cleaned with: what was found, plus what was
 * corrected, in both the shapes the pipeline needs.
 *
 * The corrections are applied in the order they were made, so the last thing
 * said about a pixel is what holds — see `composited`. The soft copy keeps
 * the brush's own feather; the hard copy is that same thing decided one way
 * or the other for the model.
 *
 * `parts` are the block's own pieces within the tile — a joined balloon's
 * per-line boxes — and each is thresholded on its own. Left out, the block's
 * box is the one region, which is what a plain block is and what every caller
 * did before there were parts at all.
 *
 * ## Being handed one instead of making one
 *
 * `given` is an automatic mask somebody else already worked out — the learned
 * segmenter's, in practice, by way of `learnedInk`. Passed one, this does not
 * threshold at all; `parts` then say nothing, because the regions were already
 * applied when the mask was made.
 *
 * A parameter rather than a second function, because everything *after* the
 * automatic half is what has to stay identical whichever half it was: the
 * corrections composite on top in the order they were drawn, and the hard and
 * soft copies are cut from the result the same way. A learned mask that took
 * its own path through the compositing would be a second place for the brush
 * to behave differently, and the brush behaving differently under a toggle is
 * the sort of thing nobody finds for a month. Left out — which is every caller
 * that has not opted in — nothing about the threshold's path changes.
 */
/**
 * Where a block really is on the page: its outline, turned, leant and pulled
 * as it is drawn, and the upright rectangle around that — in page pixels.
 *
 * A block's `x/y/w/h` is its box *before* it is turned. Cleaning used to cut
 * that box and nothing else, so a tilted line — the three messages on a phone
 * screen, turned 21° — was cleaned in a horizontal band through its middle and
 * the tops and bottoms of its letters were left on the page. The crop is now
 * the rectangle around the turned outline, and the mask is kept inside the
 * outline itself (`insideOutline`), so the lines above and below it, which the
 * wider crop also takes in, are not painted out on this block's behalf.
 *
 * `outline` is null for a block that is not turned, leant or pulled — the
 * ordinary case, and the one where the region is exactly what it always was.
 */
export function blockOutline (block: Boxed, pageW: number, pageH: number): { region: { x: number, y: number, w: number, h: number }, outline: Point[] | null } {
  const upright = {
    x: (block.x / 100) * pageW,
    y: (block.y / 100) * pageH,
    w: (block.w / 100) * pageW,
    h: (block.h / 100) * pageH,
  }

  const oriented = toOriented(block, { width: pageW, height: pageH })

  if (!oriented.angle && !oriented.skewX && !oriented.skewY && !isDistorted(oriented)) {
    return { region: upright, outline: null }
  }

  const matrix = matrixOf(oriented)
  const outline = cornersOf(oriented).map((corner) => {
    const at = mapped(matrix, corner.x, corner.y)

    return { x: oriented.cx + at.x, y: oriented.cy + at.y }
  })

  const xs = outline.map((point) => point.x)
  const ys = outline.map((point) => point.y)
  const left = Math.max(0, Math.min(...xs))
  const top = Math.max(0, Math.min(...ys))
  const right = Math.min(pageW, Math.max(...xs))
  const bottom = Math.min(pageH, Math.max(...ys))

  return { region: { x: left, y: top, w: right - left, h: bottom - top }, outline }
}

/**
 * A joined balloon's lines, when they sit inside the balloon — and none when
 * they do not.
 *
 * The lines are where the threshold and the learned mask are taken (see
 * `autoMaskOver`), so a line in the wrong place is a mask looking at the wrong
 * pixels. It came back empty — "nothing in its mask reached half strength" —
 * and the balloon was left uncleaned with its old repair withdrawn, so the
 * original lettering reappeared. The cause was data, not this code: the page
 * shape bug fixed in `501d0f1` squeezed stored boxes toward the top of the page
 * once per save, and a joined balloon's lines were written back squeezed while
 * the balloon itself was re-joined correctly. On Business trip grooming 2 all
 * eighteen joined balloons had lines at their true height divided by 1.5/1.406
 * raised to the number of saves — six on page 3, where the lines sat above the
 * balloon altogether.
 *
 * All or nothing, on purpose. The balloon's own box is always a correct place
 * to look, only a coarser one (one threshold rather than one per line), so
 * ignoring the lines costs a little on a balloon printed at several weights.
 * Keeping the half that happen to fit would mask those lines and quietly leave
 * the rest, which is the failure this exists to stop. Measured by how much of
 * each line lies inside the box, with room for a line drawn a little past it.
 */
export function partsWithin<T extends { x: number, y: number, w: number, h: number }> (
  parts: T[],
  box: { x: number, y: number, w: number, h: number },
): T[] {
  const inside = (part: T) => {
    const w = Math.min(part.x + part.w, box.x + box.w) - Math.max(part.x, box.x)
    const h = Math.min(part.y + part.h, box.y + box.h) - Math.max(part.y, box.y)

    return w > 0 && h > 0 && (w * h) / Math.max(1e-9, part.w * part.h) >= 0.5
  }

  if (parts.every(inside)) return parts

  // Once: the plate asks on every redraw, and one line says what is going on.
  if (!partsWarned) {
    partsWarned = true
    console.warn('[kemolate] a joined balloon\'s lines are not inside it — masking the whole balloon instead.')
  }

  return []
}

let partsWarned = false

/** Whether a point is inside a polygon — the even-odd rule. */
export function insideOutline (outline: readonly Point[], x: number, y: number): boolean {
  let inside = false

  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]!
    const b = outline[j]!

    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }

  return inside
}

export function effectiveMask (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  inner: { x: number, y: number, w: number, h: number },
  edits: MaskEdit[] = [],
  parts: { x: number, y: number, w: number, h: number }[] = [],
  given?: InkMask | null,
  outline?: Point[] | null,
): Mask {
  // The pieces are thresholded one at a time; which side of those thresholds
  // is the lettering is read off the block's whole box, `inner`. That box is
  // the only one with paper to spare in it — see `autoMaskOver`, where the
  // reason a tight box cannot be asked is set out at length.
  const found = given ?? autoMaskOver(data, w, h, parts.length ? parts : [inner], inner)

  // A turned block's own lettering only, in this tile's pixels — see
  // `blockOutline`. The automatic half is clipped and the corrections are not:
  // a stroke somebody drew is where they meant it, outline or no.
  const ink = outline ? clippedTo(found.mask, w, h, outline) : found.mask
  const soft = composited(ink, w, h, edits)
  const hard = new Float32Array(w * h)

  for (let i = 0; i < w * h; i++) hard[i] = soft[i]! >= 0.5 ? 1 : 0

  return { soft, hard, read: found.read, refused: found.refused }
}

/**
 * How far outside a turned block's outline its mask may still reach, in tile
 * pixels: the growth, and one more for the grey edge beyond it.
 *
 * The clip first cut exactly at the outline, and that undid `DILATE` wherever a
 * glyph touched its box. The growth is what keeps a stroke's anti-aliased edge
 * out of the picture the inpainter is shown; cut off, that edge sat just
 * outside the hole, and LaMa read it as the start of a line and drew the line
 * back in through the hole. Nearly every block carries a small angle from the
 * detector (−0.3°, −0.9°), so nearly every block was clipped, and the end
 * stems of Korean lines came back as dark bars all over Business trip grooming
 * 2 — 511 pixels on one balloon with the exact clip, none without it.
 *
 * Four pixels is far less than the gap between two lines of lettering, so a
 * neighbour's text is still kept out, which is what the clip is for.
 */
const OUTLINE_REACH = DILATE + 1

/** A mask with everything more than `OUTLINE_REACH` outside `outline` taken out. */
function clippedTo (mask: Float32Array, w: number, h: number, outline: readonly Point[]): Float32Array {
  const out = new Float32Array(mask.length)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x

      if (!mask[i]) continue

      const px = x + 0.5
      const py = y + 0.5

      if (insideOutline(outline, px, py) || nearOutline(outline, px, py, OUTLINE_REACH)) out[i] = mask[i]!
    }
  }

  return out
}

/** Whether a point is within `reach` of any edge of a polygon. */
function nearOutline (outline: readonly Point[], x: number, y: number, reach: number): boolean {
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j]!
    const b = outline[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = dx * dx + dy * dy
    const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0
    const cx = a.x + t * dx - x
    const cy = a.y + t * dy - y

    if (cx * cx + cy * cy <= reach * reach) return true
  }

  return false
}

/**
 * The ink with its non-text components removed, whole.
 *
 * Filtering ink by a text-probability map sounds like a per-pixel `AND`, and
 * that is what it was first: on ECLIPSE page 22's `要……` the segmenter's
 * blocky upscaled map cut the character into shards, every shard fell under
 * `glyphCentres`' size floor, and the measured box collapsed onto the dot
 * column — 12 pixels wide under a 25-pixel character. The component is the
 * right unit, and the verdicts are near-absolute at that grain: sampled over
 * page 22, every real mark carries ~100% support and the balloon's spiked
 * edge — the artifact that flipped a measured sign — carries 0%. Each
 * connected component is kept or dropped whole on majority support, so a
 * kept character keeps every stroke — and so do the hearts: a `♥` set
 * among text reads ~67% support where the balloon's own edge reads 0%,
 * so symbols on the line survive and artwork beside it does not. A
 * corridor-based re-admission built before that was measured turned out
 * to re-admit only artifacts, and was removed.
 * kept character keeps every stroke.
 */
export function textOnlyInk (
  mask: Float32Array,
  w: number,
  h: number,
  isText: (x: number, y: number) => boolean,
): Float32Array {
  const seen = new Uint8Array(w * h)
  const out = new Float32Array(w * h)
  const stack: number[] = []
  const pixels: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (mask[start]! <= 0.5 || seen[start]) continue

    pixels.length = 0

    let support = 0

    stack.push(start)
    seen[start] = 1

    while (stack.length) {
      const at = stack.pop()!
      const x = at % w
      const y = (at / w) | 0

      pixels.push(at)

      if (isText(x, y)) support++

      if (x > 0 && mask[at - 1]! > 0.5 && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1) }
      if (x < w - 1 && mask[at + 1]! > 0.5 && !seen[at + 1]) { seen[at + 1] = 1; stack.push(at + 1) }
      if (y > 0 && mask[at - w]! > 0.5 && !seen[at - w]) { seen[at - w] = 1; stack.push(at - w) }
      if (y < h - 1 && mask[at + w]! > 0.5 && !seen[at + w]) { seen[at + w] = 1; stack.push(at + w) }
    }

    if (support * 2 >= pixels.length) {
      for (const at of pixels) out[at] = 1
    }
  }

  return out
}
