/**
 * Straightening leaning lettering before a reader sees it.
 *
 * The readers have no tolerance for rotation to speak of, and the detector only
 * ever hands them axis-aligned boxes — so a sound effect running diagonally
 * across a panel arrives as an upright rectangle mostly full of artwork, with
 * the words crossing it corner to corner. Measured on one string set at four
 * angles, both trained readers are exact at 0° and 15°, and by 30° they emit
 * unrelated Japanese: `太慣著你` comes back as `イベントの`. Straightening the
 * same crop first restores it to exact.
 *
 * So this is a missing preprocessing step rather than a limit of the models, and
 * it is worth fixing here instead of in training: rotation is entirely absent
 * from the synthetic data — the generator's only rotation is `RandomRotate90`,
 * which flips orientation, and its `ElasticTransform` passes `alpha_affine=0` —
 * so no amount of further training addresses it.
 *
 * The angle itself comes from `inkRect` in `mask.ts`, which already does the
 * careful version of this: it clusters glyphs, fits a line through their
 * middles, falls back to the smallest enclosing rectangle only when that fit is
 * not credible, gates the fallback on elongation so square-ish ink is never
 * turned on the strength of its ragged edges, and snaps small angles to zero.
 * Nothing here re-measures what that already knows.
 */
import { inkOnly, inkRect, textOnlyInk } from './mask'

/**
 * How far a crop has to lean before straightening it is worth the resample.
 *
 * Under this the readers are unaffected, and every resample softens the strokes
 * they are trying to tell apart — so turning an upright balloon costs accuracy
 * and buys nothing. Above it they fail completely, so the threshold sits inside
 * the band between "measurably fine" and "measurably broken".
 *
 * This is a *reading* decision, and it must not gate the measurement itself.
 * It did, briefly: `uprightRegion` returned null under this line, and the tilt
 * quads built from it filed every balloon under 12° as upright — which on a
 * real page is most of them. ECLIPSE page 22 leans nearly every balloon by
 * single digits, and every one came back at 0 while a synthetic 25° column
 * came back exact. An 8° lean is real geometry the resample is right to
 * ignore; `worthStraightening` is the resample asking its own question.
 */
const MIN_TILT = 12

/**
 * Is this lean worth the resample it costs to undo? See `MIN_TILT` — and the
 * band excluded in the middle, which exists because a measured angle does not
 * say *what* leans. ECLIPSE page 22's `要去拿…` is three upright characters
 * staggered diagonally: the arrangement measures 34°, the box drawn at 34°
 * hugs the lettering correctly, and rotating the crop by it turned a reading
 * that was exact (`要去拿・・・`) into `解析!!` — because the glyphs were never
 * rotated, only laid out on a diagonal. A 34° staircase and a 34° sound
 * effect are the same three centres on the same line; nothing in the angle
 * tells them apart. What does discriminate is what rotation *buys*: measured
 * long ago, the readers are exact to 15°, dead by 30° with or without this
 * crutch, and genuinely rescued at 45° — so under the band rotation is
 * needed, inside it rotation gambles a working reading on a guess about
 * which kind of lean this is, and beyond it the lean can only be a rotated
 * sound effect, since nobody staggers dialogue at fifty degrees.
 */
export function worthStraightening (upright: Upright, trusted = false): boolean {
  const lean = Math.abs(upright.tilt)

  if (lean < MIN_TILT) return false

  // A measurement from the det head has no dead band. The band exists because
  // the *ink* path cannot tell a staircase of upright glyphs from a rotated
  // line and, worse, got the sign wrong on the very balloons in that range —
  // `要去拿…` measured +34 from ink and −29 from det, and rotating by the ink
  // figure turned an exact reading into `解析!!`. Given the det angle both of
  // page 22's steep balloons straighten to exact (`不是說…` at 32°, `要去拿…`
  // at 29°), so refusing the band would now cost the readings it was invented
  // to protect.
  return trusted || lean <= 30 || lean > 40
}

/**
 * How much artwork to take around the box before turning it.
 *
 * A rotation pulls the corners of the crop in from outside it, so a crop taken
 * tight on the box would rotate blank wedges into view over the lettering. This
 * is generous enough for a 45° turn of a long box.
 */
const CONTEXT = 0.55

/** A region turned upright: where its lettering is, and which way it leans. */
export interface Upright {
  /** Degrees, positive clockwise — the lean to undo. */
  tilt: number
  /** The middle of the lettering, in the page's own pixels. */
  cx: number
  cy: number
  /** Along the text's own direction, and across it. */
  w: number
  h: number
}

/**
 * Which way one region's lettering leans, or nothing when it does not.
 *
 * `null` is the ordinary answer and means "read this the usual way": either the
 * text is upright, or its direction could not be established well enough to act
 * on. Both deserve the same treatment, because a crop turned by a guess reads
 * worse than one left alone.
 */
export function uprightRegion (
  bitmap: ImageBitmap,
  region: { x: number, y: number, w: number, h: number },
  /**
   * Text probability for an arbitrary crop of the page, when a segmentation
   * exists — `segFor` partially applied. The threshold's ink cannot tell
   * lettering from the balloon's own spiked edge, and on ECLIPSE page 22's
   * `啊啊啊啊` that artifact flipped the measured sign outright: −7 from raw
   * ink, +20 — the mirror of its twin balloon's −21, as the symmetric spread
   * demands — once the ink is intersected with what the segmenter calls
   * text. Optional because a Read must not require the model; unfiltered ink
   * is the answer it always was when nobody has segmented the page.
   */
  textProb?: (crop: { x: number, y: number, w: number, h: number }) => Float32Array,
): Upright | null {
  const pad = Math.round(Math.min(region.w, region.h) * CONTEXT)

  const x = Math.max(0, Math.round(region.x) - pad)
  const y = Math.max(0, Math.round(region.y) - pad)
  const w = Math.min(bitmap.width - x, Math.round(region.w) + pad * 2)
  const h = Math.min(bitmap.height - y, Math.round(region.h) + pad * 2)

  if (w < 8 || h < 8) return null

  const canvas = new OffscreenCanvas(w, h)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) return null

  context.drawImage(bitmap, x, y, w, h, 0, 0, w, h)

  // The threshold is taken from the block's own box rather than the whole tile,
  // so the artwork kept around it for rotation headroom neither sets the
  // threshold nor gets counted as ink.
  const inner = {
    x: Math.round(region.x) - x,
    y: Math.round(region.y) - y,
    w: Math.round(region.w),
    h: Math.round(region.h),
  }

  // The *ungrown* ink — `inkOnly`, not the repair mask. Growth by DILATE
  // fuses a real page's thirty-pixel glyphs into one blob, and one blob has
  // no arrangement to measure: every leaning balloon on ECLIPSE page 22
  // measured upright through the grown mask. The first attempt at this
  // switch regressed — a confident line through three sparse components
  // read an upright balloon at −14° — and what made it safe the second time
  // is in `inkRect`: leans are read off *columns* (`columnLean`), a weak
  // column needs the min-area sweep to independently agree, and the snap
  // judges the folded lean. Regression corpus: twelve balloons across
  // ECLIPSE pages 16/22/24 — four true leans (mirror-signed pairs on the
  // symmetric spread), eight controls including the multi-column cloud and
  // the drifting-ellipsis tail that used to come back −5° and −17°.
  const mask = inkOnly(context.getImageData(0, 0, w, h).data, w, h, inner)

  let measured = mask

  if (textProb) {
    // Whole components, not pixels — the per-pixel version shredded a
    // character into shards the size floor discarded. See `textOnlyInk`.
    const prob = textProb({ x, y, w, h })
    const filtered = textOnlyInk(mask, w, h, (px, py) => prob[py * w + px]! > 0.3)

    let total = 0
    let kept = 0

    for (let i = 0; i < w * h; i++) {
      if (mask[i]! > 0.5) total++
      if (filtered[i]! > 0.5) kept++
    }

    // The segmenter under-responds to burst lettering, and a filter that
    // erased the balloon would measure nothing at all. When it keeps too
    // little of the ink it is blind here, not selective — carry on
    // unfiltered.
    if (total > 0 && kept / total >= 0.2) measured = filtered
  }

  const rect = inkRect(measured, w, h)

  // Zero is `inkRect`'s own verdict — it snaps anything within its noise band
  // level, so a 0 here means "no credible lean", not "a small one". Anything
  // else is a real measurement and is returned however small: whether it is
  // worth *acting* on is the caller's question, and `worthStraightening` is
  // the resample's answer to it.
  if (rect.angle === 0) return null

  return { tilt: rect.angle, cx: x + rect.cx, cy: y + rect.cy, w: rect.w, h: rect.h }
}

/**
 * The same oriented box as four page-space corners.
 *
 * Straightening a crop measures exactly the thing a tilted block needs to be
 * *stored* as, and until now that measurement was spent on the resample and
 * dropped. The readers were the only consumer, so a sound effect read correctly
 * came back filed as the detector's upright rectangle — and everything after
 * that point already knew better: `blocks.quad` is a column, `boxOf` derives an
 * angle from four corners, and coordinates are normalised by page width on both
 * axes precisely so a rotation survives the trip (`shared/utils/ocr.ts`).
 *
 * Corners come out `[tl, tr, br, bl]`, which is the order `boxOf` destructures
 * and the order it takes `angle` from — it reads the top edge, so `tr - tl`
 * must be the text's own direction or the stored angle is somebody else's.
 *
 * The box is the *ink's*, from `inkRect`, not the detector's: tighter than the
 * region it came from, which is the point. `regionCanvas` adds air around it
 * before reading; that air is headroom for the resample and not part of where
 * the lettering is, so it is deliberately not added here.
 */
export function tiltedQuad (upright: Upright): Vertex[] {
  // `tilt` is the lean to undo, so the lettering's own frame sits at `+tilt` in
  // the page — the opposite sign to the `rotate()` that straightens a crop.
  const radians = (upright.tilt * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  const halfW = upright.w / 2
  const halfH = upright.h / 2

  return ([[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]] as const)
    .map(([dx, dy]) => ({
      x: upright.cx + dx * cos - dy * sin,
      y: upright.cy + dx * sin + dy * cos,
    }))
}

/**
 * Is this measured lean worth *storing* on a block's quad?
 *
 * The same dead band as `worthStraightening`, for the same reason wearing a
 * different consequence. A lean in the 30–40 band is ambiguous between a
 * staircase of upright glyphs and a rotated line, and the ink measurement
 * lands there most often precisely when it has gone wrong — page 22's
 * det-missed vocalisation balloon came back at +32 with even the sign
 * disputed. Under the band a lean is ordinary lettering and believable;
 * past it only a rotated sound effect is possible and the measurement is
 * usually the min-area sweep on a genuinely diagonal line, which earns its
 * keep. In between, an upright box is the smaller lie.
 *
 * Applied to the *ink* measurement only. The det head's boxes are measured
 * from dense strokes by a model that knows what text is, and its staircase
 * angles are the arrangement's real extent — a det box is stored as given.
 */
export function quadWorthy (upright: Upright): boolean {
  const lean = Math.abs(upright.tilt)

  return lean <= 30 || lean > 40
}
