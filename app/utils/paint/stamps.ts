/**
 * The painting primitives every stroke tool is built from: a feathered disc of
 * colour, a feathered disc taken from an image, and the coverage machinery
 * that keeps a soft stroke soft.
 *
 * Ported from the earlier build's `tools/stamps.ts` with its fixes intact.
 * Each of these encodes a bug somebody already hit: the gradient that fades to
 * its own colour at alpha nought rather than to `transparent` (which fringes
 * grey), the crisp clone disc special-cased because a radial gradient whose two
 * radii are equal paints nothing at all, and the whole coverage pipeline —
 * see `coverDisc` — without which a soft brush saturates to a hard one.
 */

/**
 * How wide the feather is, as a share of the radius at full softness: how far
 * it eats *inward* from the nominal edge, and how far it spills *outward* past
 * it.
 *
 * These two numbers are the whole character of the brush. All the way in and
 * not at all out is **Photoshop's** shape, and it was chosen with its dab sheet
 * alongside: at hardness zero a Photoshop mark is darkest only at its centre
 * and has faded to nothing by the brush's own edge, with no flat core anywhere.
 * Affinity's general brush keeps a wide solid core at the same setting — the
 * two really do differ at zero hardness, and this follows Photoshop.
 *
 * The fade ran from the centre to *twice* the radius before, which is where the
 * two complaints that started this came from: nothing in the mark ever reached
 * full strength, so the colour that landed was never the colour chosen, and the
 * mark was double the width the size field claimed.
 *
 * ## Softness makes the mark read narrower, and that is correct
 *
 * The note this replaced argued the opposite — that a fade ending at `r` makes
 * a soft brush look like "a smaller, harder brush that someone has smudged",
 * so the feather was pushed outward to keep the width. That was written against
 * a *straight* ramp, where the whole falloff is a wash of middling alpha with
 * no shape to it. With the curve below, and with a reference sheet to hand,
 * the narrowing is simply what these brushes do: one size, hardness zero and
 * hardness one hundred side by side, and the soft one reads visibly thinner in
 * Photoshop and in Affinity both. Size is the outer edge of the mark. Hardness
 * says how much of it is solid.
 *
 * ## What this costs, so nobody rediscovers it
 *
 * Coverage is the *greatest* of the marks rather than their sum (see
 * `coverDisc`), and with no solid core there is nothing to hide the seam where
 * a stroke doubles back on itself: the paint between two passes stays at one
 * pass's strength, so a sharp corner keeps a pale wedge tapering into it.
 * Photoshop has that same wedge at flow one hundred. What fills it there is
 * *flow* below one hundred, where dabs build up on one another instead of
 * taking the maximum. Until this brush has a flow of its own, the way out is
 * hardness — a little of it puts a core back, and the wedge goes with it.
 */
export const FEATHER_IN = 1
export const FEATHER_OUT = 0

/** Where the fade begins — solid at or inside this radius. */
export function core (r: number, soft: number): number {
  return r * (1 - FEATHER_IN * Math.min(1, Math.max(0, soft)))
}

/**
 * How far a mark actually reaches: beyond this nothing is touched at all.
 *
 * Every mark, every bound and both rings of the cursor are measured from this
 * and from `core`, so none of them can describe a different brush from the one
 * that paints. It returns the radius unchanged while `FEATHER_OUT` is nought,
 * and stays a function anyway: how far a mark carries is a fact about the shape
 * of the brush and not about its radius, and the one time those parted company
 * the bounds, the rings and the stamps each had to be found and corrected
 * separately.
 */
export function reach (r: number, soft: number): number {
  return r * (1 + FEATHER_OUT * Math.min(1, Math.max(0, soft)))
}

/**
 * Where a *mask* correction's fade starts and ends, which is not where a
 * paint stroke's does — the one place the two brushes part company, and it is
 * forced rather than chosen.
 *
 * A mask is thresholded at a half on its way to the model (`mask.ts`), because
 * an inpainter has no use for "somewhat a hole". So the half-coverage line is
 * the mask's real edge, and it is the thing that has to land where the ring
 * says. Centring the fade on the nominal radius puts it there exactly: solid
 * inside `r(1 - k·soft)`, gone by `r(1 + k·soft)`, and crossing a half at `r`
 * whatever the hardness. Paint has no threshold anywhere — its edge is simply
 * where the paint stops — so it fades inward from `r` instead, and softening it
 * makes a visibly narrower mark. Softening a mask brush moves only the blend.
 *
 * This is what the mask brush always did, in effect: a solid line at the full
 * width with fainter skirts outside it, which kept the thresholded mask exactly
 * the brush's width. Handing it the paint anchoring took that away — at zero
 * hardness a correction only crossed the threshold within half its radius, so
 * a wipe left the outer half of what it swept still masked and a block could be
 * wiped until the hard mask was empty, which reads as "the mask came back" and
 * then as "clean does nothing". The lesson is in the constant: the shape is
 * shared, the anchoring cannot be.
 */
export const MASK_FEATHER = 0.5

/** Where a mask correction is still at full strength. */
export function maskCore (r: number, soft: number): number {
  return r * (1 - MASK_FEATHER * Math.min(1, Math.max(0, soft)))
}

/** How far a mask correction's skirt carries past the nominal edge. */
export function maskReach (r: number, soft: number): number {
  return r * (1 + MASK_FEATHER * Math.min(1, Math.max(0, soft)))
}

/**
 * The *shape* of the fade between those two radii: how much paint lands at a
 * given fraction of the way across the feather.
 *
 * A gradient with two stops fades in a straight line, and a straight line is
 * the one falloff a brush must not have. Two things go wrong with it, and both
 * are visible rather than theoretical:
 *
 * - **It has corners.** The slope steps from nothing to its full value at the
 *   inner radius and back to nothing at the outer one, and the eye finds a
 *   discontinuity in slope about as easily as one in value — so a mark reads as
 *   a flat core with the fade *starting* somewhere, rather than as something
 *   that was never solid to begin with. That edge is the thing a soft brush is
 *   bought to avoid.
 * - **It is thin where it matters.** Alpha is not brightness: red at 200/255
 *   over paper looks like red, and the first third of a linear ramp does almost
 *   no visible work while the last third does nearly all of it. So the mark
 *   looks solid for a while and then falls away quickly, which is exactly
 *   backwards from what the slider says.
 *
 * `1 - smoothstep` instead: flat at both ends, steepest in the middle, and no
 * corner anywhere. It holds coverage near the centre — where a wide, nearly
 * solid core is what lets two passes of one stroke merge instead of leaving the
 * wedge that `coverDisc`'s greatest-of rule cannot fill — and thins the outer
 * tail, so the mark ends without ever having an edge.
 *
 * Exported because the brush cursor previews it in CSS and has to draw the same
 * curve; a preview of a different brush is worse than none.
 */
export function falloff (t: number): number {
  const u = Math.min(1, Math.max(0, t))

  return 2 * u ** 3 - 3 * u ** 2 + 1
}

/**
 * The same curve for the rasterisers that stroke a path instead of stamping
 * dabs along it: the falloff as a stack of flat discs, widest first.
 *
 * The mask brush is the reason this exists. A mask correction is laid as a
 * stroked polyline — the browser's own round joins, one path however long the
 * gesture, and no dab spacing to go wrong at a corner — which is the right
 * shape for something recomputed per block on every clean, and it cannot use a
 * radial gradient because a gradient belongs to a point and a stroke has a
 * whole line of them. Left to invent its own softness it invented a different
 * brush: a core and two skirts at a flat 0.35, spreading to *twice* the radius
 * at zero hardness, so the same slider meant one thing on the plate and another
 * on the mask, and the cursor could only be honest about one of them.
 *
 * The two radii are given rather than worked out from softness, because the two
 * brushes anchor the same fade differently and both are right — see
 * `maskCore`. Fractions of the brush's own radius, so a caller multiplies by
 * whatever radius it has.
 *
 * The alphas are pre-divided for compositing, which is the only subtle part.
 * Each band is painted over the ones before it, so a band's own alpha is not
 * the coverage wanted at that radius but what has to be added to reach it:
 * `(want - have) / (1 - have)`. Painted widest first they accumulate to the
 * curve; painted in any other order they do not, which is why the order is part
 * of what this returns rather than a convention a caller has to remember.
 *
 * ## How many
 *
 * Each band has a hard edge of its own, so the count is a staircase against a
 * curve and the default was measured rather than guessed. At a 76px brush,
 * fully soft: eight bands leave a worst error of 38/255 and a 47/255 step
 * between neighbouring pixels — plainly a set of rings; sixteen, 16 and 24;
 * twenty-four, 10 and 16, which is under what survives being blended into a
 * repair. A band is one stroked path, so the cost is paid in path operations
 * and not per pixel; somewhere drawing every frame should ask for fewer and say
 * why rather than take this.
 */
export function feathered (inner: number, outer: number, steps = 24): { radius: number, alpha: number }[] {
  if (outer - inner < 0.02) return [{ radius: Math.max(inner, outer), alpha: 1 }]

  const bands: { radius: number, alpha: number }[] = []

  let have = 0

  for (let i = 1; i <= steps; i++) {
    const t = 1 - i / steps
    const want = falloff(t)
    const alpha = (want - have) / (1 - have)

    have = want
    bands.push({ radius: inner + (outer - inner) * t, alpha })
  }

  return bands
}

/**
 * How many stops that curve is laid down with.
 *
 * A canvas gradient is straight between its stops, so this is a polyline
 * standing in for the curve. Sixteen puts the worst error under a
 * two-hundred-and-fifty-fifth — below what an eight-bit channel can hold — and
 * the stops cost nothing per mark: the gradient is built once and the fill is
 * the same fill either way.
 */
const FALLOFF_STOPS = 16

/** That curve, written into a gradient as `at(coverage)` for each stop. */
function feather (g: CanvasGradient, at: (coverage: number) => string): void {
  for (let i = 0; i <= FALLOFF_STOPS; i++) {
    const t = i / FALLOFF_STOPS

    g.addColorStop(t, at(falloff(t)))
  }
}

/**
 * One round mark. Softness moves the point at which the disc starts fading and
 * how far past the radius it carries on — see `reach`.
 */
export function paintDisc (
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rgb: [number, number, number],
  soft: number,
): void {
  const colour = `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`
  const out = reach(r, soft)

  if (soft < 0.02) {
    c.fillStyle = `rgb(${colour})`
  } else {
    const g = c.createRadialGradient(x, y, core(r, soft), x, y, out)

    feather(g, (a) => `rgba(${colour}, ${a.toFixed(4)})`)
    c.fillStyle = g
  }

  c.beginPath()
  c.arc(x, y, out, 0, Math.PI * 2)
  c.fill()
}

/** One mark taken from an image, feathered to match the brush. */
export function paintFromImage (
  c: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  x: number,
  y: number,
  r: number,
  offset: Point,
  soft: number,
  scratch: HTMLCanvasElement,
): void {
  // Sized to what the mark reaches rather than to the radius — a soft stamp
  // spills past `r`, and a scratch cut to `r` would clip that spill into a
  // square, which reads as a hard corner in the middle of a feathered edge.
  const out = reach(r, soft)
  const d = Math.max(1, Math.ceil(out * 2))

  scratch.width = d
  scratch.height = d

  const sc = scratch.getContext('2d')

  if (!sc) return

  // Lifted and set down on the pixel grid; see `gridCopy` for why.
  const { dx, dy, sx, sy } = gridCopy({ x: x - out, y: y - out }, offset)

  sc.drawImage(src, -sx, -sy)

  // Keep the disc and throw the corners away.
  sc.globalCompositeOperation = 'destination-in'

  if (soft < 0.02) {
    // A radial gradient whose two radii are equal paints nothing at all, so a
    // crisp edge has to be a plain disc — asking for a zero-width fade here
    // erased the whole stamp instead, and the clone appeared to do nothing.
    sc.fillStyle = 'rgba(255,255,255,1)'
    sc.beginPath()
    sc.arc(out, out, out, 0, Math.PI * 2)
    sc.fill()
  } else {
    const g = sc.createRadialGradient(out, out, core(r, soft), out, out, out)

    feather(g, (a) => `rgba(255,255,255,${a.toFixed(4)})`)
    sc.fillStyle = g
    sc.fillRect(0, 0, d, d)
  }

  c.drawImage(scratch, dx, dy)
}

/* ---------- stroke coverage ---------- */

/**
 * A stroke's softness, accumulated so that the feather survives the stroke.
 *
 * `paintDisc` draws one mark correctly, but `dabSpots` lays them a fraction of
 * a radius apart, so every pixel in the feather is painted by several of them.
 * Ordinary compositing sums those — 1-(1-a)^n — and any alpha worth seeing
 * saturates to opaque, which leaves the soft edge only where the marks were
 * nearly transparent to begin with. A 40px brush at 80% softness came out
 * fully opaque three quarters of the way to its rim.
 *
 * The fix is to take the *greatest* coverage any one mark gives a pixel rather
 * than the sum, which makes a stroke's cross-section the same shape as a single
 * mark's — a soft edge that stays soft however slowly it was drawn.
 *
 * Canvas has no max-alpha blend, but `lighten` is a per-channel maximum, and on
 * a canvas that starts opaque black every draw keeps alpha at 1 and leaves the
 * blend to do exactly that. Coverage therefore rides in the red channel, and
 * `coverageToAlpha` moves it back into alpha where a mask needs it.
 */
export function coverDisc (
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  soft: number,
): void {
  const out = reach(r, soft)

  if (soft < HARD) {
    c.fillStyle = '#fff'
  } else {
    const g = c.createRadialGradient(x, y, core(r, soft), x, y, out)

    // Grey rather than fading to transparent: the canvas has to stay opaque
    // for `lighten` to be a plain maximum, so coverage is carried as a tone —
    // white for all of it, black for none.
    feather(g, (a) => {
      const v = Math.round(a * 255)

      return `rgb(${v}, ${v}, ${v})`
    })
    c.fillStyle = g
  }

  c.beginPath()
  c.arc(x, y, out, 0, Math.PI * 2)
  c.fill()
}

/**
 * Below this softness a brush is hard: its coverage is solid out to its reach.
 * The same line `coverDisc` draws between a flat fill and a gradient.
 */
export const HARD = 0.02

/**
 * A hard brush's coverage from one point to the next, as one swept disc.
 *
 * A hard mark is a solid disc, and a row of solid discs close enough to read as
 * a line *is* a line with round ends — so for a hard brush the dabs are not
 * needed at all. They were expensive exactly where this brush is used most:
 * spaced at `DAB_STEP_SMOOTH`, a twentieth of the radius, so a soft brush does
 * not bead, a 212-pixel brush laid a 35,000-pixel disc every five pixels. A
 * sweep round a page's margin was nineteen hundred of them, filled in software
 * on the coverage buffer (it is read back every frame, so it lives on the CPU),
 * and that was 150 ms a stroke every time the page was drawn. One stroked line
 * fills each pixel once.
 *
 * The same shape, not an approximation of it: the union of discs of radius
 * `reach` centred along a segment is the segment thickened by that radius with
 * round caps, which is what `lineCap = 'round'` draws. Consecutive segments
 * share their end point, so the caps join them the way overlapping dabs did.
 */
export function coverSweep (
  c: CanvasRenderingContext2D,
  from: { x: number, y: number },
  to: { x: number, y: number },
  r: number,
  soft: number,
): void {
  c.strokeStyle = '#fff'
  c.lineWidth = reach(r, soft) * 2
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(from.x, from.y)
  c.lineTo(to.x, to.y)
  c.stroke()
}

/**
 * Turn a patch of accumulated coverage into the stroke itself: the paint colour
 * everywhere, carrying the coverage as its alpha. Only the region the latest
 * marks touched needs redoing — coverage is a maximum, so nothing outside it
 * can have changed.
 */
export function coverageToAlpha (
  cover: CanvasRenderingContext2D,
  out: CanvasRenderingContext2D,
  rgb: [number, number, number],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (w <= 0 || h <= 0) return

  const src = cover.getImageData(x, y, w, h)
  const dst = out.createImageData(w, h)
  const s = src.data
  const d = dst.data

  for (let i = 0; i < s.length; i += 4) {
    d[i] = rgb[0]
    d[i + 1] = rgb[1]
    d[i + 2] = rgb[2]
    d[i + 3] = s[i]! // the maximum any one mark reached here
  }

  out.putImageData(dst, x, y)
}
