/**
 * Where a balloon's inside is — the room a translation actually has, as opposed
 * to the shape of the words it is replacing.
 *
 * ## Why this exists
 *
 * The app already fits type by measuring it: `fitSize` lays the words out and
 * binary-searches the largest size whose ink stays inside the box. What it is
 * handed is `letterBoxOf`, which is the block's own box until a letterer drags
 * it — and a block's box is where the *source* lettering was found. On a
 * Japanese page that is a column forty pixels wide, so the English carried into
 * it is fitted to a column forty pixels wide and comes out at the size floor.
 * The measurement was never wrong; it was being asked about the wrong rectangle.
 *
 * So this answers the other question: given a block, how much of the balloon
 * around it is empty paper. Nothing here letters anything — it hands back a
 * rectangle, and what writes it into a frame is the caller's business.
 *
 * ## Why a flood fill rather than a model
 *
 * A balloon is defined by its outline, and an outline is exactly what a region
 * grow stops at. There is no download, no session, no worker, and the picture is
 * already decoded and cached: `usePaper` reads every page to a 640-wide `Sheet`
 * to sample the colour under each block, and that array is all a fill needs — so
 * a balloon costs a few hundred thousand byte comparisons on something already
 * in hand.
 *
 * A learned bubble segmenter is the better answer for the cases below and is
 * worth having second, on the terms `learnedInk` already set in `mask.ts`: a
 * named source, opt-in, falling back per block rather than replacing the cheap
 * path. It is not worth having *first*, because most of a page is closed
 * balloons and those a fill gets exactly right.
 *
 * ## Three decisions inside
 *
 * - **Colour distance, not brightness.** A balloon may be black with white
 *   lettering — `inkOn` already handles that on the ink side — so what is grown
 *   through is "near the colour the block is mostly made of", whatever that is,
 *   and both of the block's two colours are tried. See `papersIn`.
 * - **The holes are filled.** The lettering inside the balloon is ink, so the
 *   grow leaves it as holes; anything enclosed by the fill is part of the room,
 *   or the rectangle would have to dodge the very words it is being measured
 *   for. So a second pass floods the *outside* from the window's border and
 *   whatever it never reaches is interior.
 * - **A fill that escapes says so.** An open caption, a gradient, or a broken
 *   outline lets the grow out into the art, where it will happily swallow a
 *   panel. There is no rectangle worth having in that case and the honest move
 *   is to report it: `escaped` is true when the interior reaches three of the
 *   window's four sides, which a real balloon inside a window this size does
 *   not. A caller that ignores the flag will letter into the artwork.
 */

import type { Paper } from '#shared/utils/lettering'
import type { Sheet } from '~/utils/paper'

/**
 * How far past the block the fill may reach, as a share of the block's own size
 * on each side. A balloon is drawn around its lettering with a margin, not a
 * field, and a window that reaches further mostly gives a leak more room to run.
 */
const REACH = 1.6

/**
 * How far a pixel's colour may sit from the paper's and still be the balloon,
 * as a plain RGB distance. Well above the noise of a scan and a JPEG, well below
 * an outline: a mid-grey stroke on white is over two hundred away.
 */
const TOLERANCE = 60

/** How far inside the outline the room stops, as a share of its short edge. */
const MARGIN = 0.04

/**
 * How solid the interior must be against its own bounding box.
 *
 * The measurement that catches what `sides` and `share` cannot. Both of those
 * are relative to a window derived from the block, so a fill that wanders out
 * of a balloon into the pale background of its own panel — never reaching a
 * window edge, never taking half the window — reads as held on both counts and
 * is drawn over the artwork anyway. That is the bleeding left on the bench
 * after the first two constants were fixed: nine bubbles, six of them out in
 * the panel, not one flagged.
 *
 * A balloon is a closed convex-ish blob. An ellipse is 0.785 and a rounded
 * rectangle more. Measured on the page: the three that held came to 0.76, 0.76
 * and 0.79, and the six that had escaped to 0.45, 0.56, 0.56, 0.64, 0.66 and
 * 0.68. Confirmed independently by what sits *under* each mask in the scan —
 * the escaped ones cover 67–90% bare paper, the held ones a third, because a
 * balloon that holds is mostly lettering and one that has got out is mostly
 * empty panel. Two measurements, same split, and 0.72 sits in the gap.
 *
 * It does not replace the other two. The caption that forced `SIDES` down came
 * back at 0.80 — a leak can be perfectly solid if what it escaped into is a
 * solid shape. Each of the three catches something the others do not.
 *
 * Erring low is the safe direction: a balloon wrongly called a leak falls back
 * to the block's own box, which is where lettering sat before any of this
 * existed. A leak wrongly called a balloon is type written across the drawing.
 */
const SOLID = 0.72

/**
 * The floor a *bounded* fill must clear instead.
 *
 * Lower than `SOLID`, and not a softening — the two floors are measured on
 * different populations. 0.72 was set on unbounded fills of oval balloons,
 * where anything less solid had left its balloon. A bounded fill cannot leave,
 * so what its solidity distinguishes is the shape it was given: a teardrop or
 * a spiked burst balloon legitimately scores 0.69–0.71 against its own box,
 * while a fill that grabbed screentone off a character's body inside a
 * mis-drawn bubble box comes back ragged at 0.62 or less.
 *
 * Measured on ten pages of the test chapter, eight bounded escapes read by
 * eye: five were tone-grabs at 0.47, 0.51, 0.57, 0.57 and 0.62, and three
 * were real balloons filled exactly — a teardrop at 0.70, an oval at 0.71, a
 * spiked hex at 0.69. The gap between 0.62 and 0.69 is clean on this material
 * and this sits in the middle of it. The crops are in
 * `test/nuxt/utils/ocr/balloon.test.ts` as the bounded observation table.
 *
 * Not the whole test any more. A second chapter's spiked bursts, filled exactly,
 * scored 0.55–0.66 — inside that gap — so a bounded fill is now a leak only when
 * it is this ragged *and* reached all four sides of its window. See `leaked`.
 */
const SOLID_BOUNDED = 0.66

/**
 * How many of the window's four sides the interior may touch before it is a leak.
 *
 * Two, not three. Three was unreachable for most of the blocks that leak: a side
 * the window was *cut off* at does not count (see `sidesTouched`, which is right
 * to do that), and a tall block's window is clipped top and bottom by the page,
 * so at most two sides remain countable and the test could never fire however
 * far the fill ran. The caption that prompted this reached two of two.
 */
const SIDES = 2

/**
 * How much of the window the interior may be before it is a leak, whatever it
 * touches.
 *
 * The sides alone were not enough, and the bench is where that showed: on page
 * 25 a balloon opening onto the white gutter between two panels filled the
 * gutter, reached two sides of its window, and was reported as held. A window is
 * over three times the block on each axis, so a balloon that genuinely fits
 * inside one is a minority of it; anything past this is the fill out in the open,
 * where the largest rectangle it can find has nothing to do with the balloon.
 *
 * Lowered from 0.55, which never fired on the page it needed to. Measured there:
 * eleven blocks the detector found came to 3, 8, 10, 11, 14, 18, 20, 24, 25, 25
 * and 27% of their windows, and a vertical caption over a building — one of the
 * regions flagged by eye as covering artwork — came to 38%. There is a clear gap
 * between the two and 0.35 sits in it. That is eleven observations on one page
 * rather than a survey, so it is a threshold to revisit with `grown` and
 * `solidity` in front of you, not a constant to trust.
 */
const SHARE = 0.35

/** A rectangle in the sheet's own pixels. */
export interface Room {
  x: number
  y: number
  w: number
  h: number
}

export interface Balloon {
  /** The room found, inset from the outline, in the sheet's own pixels. */
  room: Room
  /** The patch of sheet the fill was allowed to run in. */
  window: Room
  /** The interior, one byte a pixel, row-major over `window`. */
  mask: Uint8Array
  /** How many of the window's sides the interior reached. */
  sides: number
  /** How much of the window the interior came to, nought to one. */
  share: number
  /**
   * How much of the window the fill reached before `filled` closed its holes.
   *
   * A balloon's holes are the lettering inside it, so `share` sits a little
   * above this and the two track each other. A fill that has partitioned its
   * window makes them diverge hard — `filled` cannot reach round the barrier
   * and hands back everything behind it, so `share` is several times this.
   */
  grown: number
  /**
   * The interior against its own bounding box, nought to one.
   *
   * A balloon is a closed convex-ish blob: an ellipse is 0.79 and a rounded
   * rectangle higher. A fill loose in the artwork threads between panels and
   * around figures, and comes back well under that however large it is — which
   * is why this catches leaks that a share of the window cannot.
   */
  solidity: number
  /** The fill ran past what a balloon can be — see the header. */
  escaped: boolean
  /**
   * Desktop: the balloon's own oval — the frame of the largest ellipse, held
   * off the outline, that lies inside the interior — in the sheet's pixels; null
   * where none does. See `ovalIn`.
   */
  oval: Room | null
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

/**
 * The balloon around one block, or nothing where there is no paper to grow from.
 *
 * `seed` is in the sheet's own pixels, like everything that comes back. Pure —
 * a sheet and a rectangle in, arithmetic out — so it can be tested against a
 * hand-built page without standing anything up.
 *
 * The colour it grows through is worked out from inside the block and not taken
 * from `usePaper`, which was the first version and was a real mistake rather
 * than a shortcut: `paperAt` then sampled a *ring around* the block, and a ring
 * around a balloon reaches straight into the artwork. On page 25 of the test
 * chapter it gave the black art around a tight white balloon, so the fill
 * matched almost nothing and the block fell back to its own box while sitting on
 * plain white paper. (`paperAt` reads inside the block now too, having made the
 * same mistake about ink.) Both classes are tried here for the same reason
 * `inkOn` exists — a balloon may be black with white lettering — and the better
 * result wins.
 */
/*
 * Desktop: `field`, a window given outright with no balloon behind it — for
 * `balloonJudge`, which asks whether a neighbour is inside this block's balloon
 * and so needs a window reaching the neighbour: `reach` is a share of each side,
 * and a column's window is then a column, which every fill touches both sides of.
 * It is *not* `bounds`, on purpose: a window the detector drew is a balloon, and
 * a fill inside one is judged by the laxer bounded leak test. A field is only a
 * guess, so a fill in one is held to the strict test, as a fill by `reach` is —
 * a leak through a hairline, called held, would join two balloons into one.
 */
export function balloonIn (sheet: Sheet, seed: Room, bounds?: Room | null, reach = REACH, field?: Room): Balloon | null {
  let best: Balloon | null = null

  for (const paper of papersIn(sheet, seed)) {
    const found = grow(sheet, seed, paper, bounds, reach, field)

    if (found && better(found, best)) best = found
  }

  return best
}

/**
 * Which of two fills to believe: one that stayed inside a balloon over one that
 * escaped, and the larger of the two otherwise.
 *
 * Size last, and only as a tie-break, because the biggest fill is exactly what a
 * leak produces — a fill that has got out into the page has the whole page.
 */
function better (found: Balloon, against: Balloon | null): boolean {
  if (!against) return true
  if (found.escaped !== against.escaped) return !found.escaped

  return found.share > against.share
}

/**
 * The two colours a block's own box is made of — its paper and its ink, without
 * knowing which is which.
 *
 * Otsu over the box's luminance, then the mean of each side. Written here rather
 * than reached for in `mask.ts`, whose `otsu` is over a tile being prepared for
 * an inpainter and answers in a different shape; the fifteen lines are cheaper
 * than a shared helper that has to serve both.
 *
 * Ordered by how much of the box each covers, so the commoner one is tried
 * first — in a box drawn round lettering that is the paper, nearly always.
 */
function papersIn (sheet: Sheet, seed: Room): Paper[] {
  const { data, w: sw, h: sh } = sheet

  const left = clamp(Math.floor(seed.x), 0, sw)
  const top = clamp(Math.floor(seed.y), 0, sh)
  const right = clamp(Math.ceil(seed.x + seed.w), 0, sw)
  const bottom = clamp(Math.ceil(seed.y + seed.h), 0, sh)

  if (right <= left || bottom <= top) return []

  const histogram = new Uint32Array(256)
  let total = 0

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const at = (y * sw + x) * 4

      histogram[grey(data[at]!, data[at + 1]!, data[at + 2]!)]!++
      total++
    }
  }

  if (!total) return []

  const cut = split(histogram, total)
  const sums = [
    { r: 0, g: 0, b: 0, n: 0 },
    { r: 0, g: 0, b: 0, n: 0 },
  ]

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const at = (y * sw + x) * 4
      const side = sums[grey(data[at]!, data[at + 1]!, data[at + 2]!) > cut ? 1 : 0]!

      side.r += data[at]!
      side.g += data[at + 1]!
      side.b += data[at + 2]!
      side.n++
    }
  }

  return sums
    .filter((side) => side.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((side) => ({
      r: Math.round(side.r / side.n),
      g: Math.round(side.g / side.n),
      b: Math.round(side.b / side.n),
    }))
}

/** Luminance as a byte — the same weights `luminanceOf` uses, without the gamma. */
const grey = (r: number, g: number, b: number) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)

/** Otsu: the level that leaves the two sides as far apart as they can be. */
function split (histogram: Uint32Array, total: number): number {
  let whole = 0

  for (let level = 0; level < 256; level++) whole += level * histogram[level]!

  let below = 0
  let seen = 0
  let best = 0
  let cut = 127

  for (let level = 0; level < 256; level++) {
    seen += histogram[level]!

    if (!seen) continue

    const rest = total - seen

    if (!rest) break

    below += level * histogram[level]!

    const gap = below / seen - (whole - below) / rest
    const found = seen * rest * gap * gap

    if (found > best) {
      best = found
      cut = level
    }
  }

  return cut
}

/** One fill, from one candidate colour. */
function grow (sheet: Sheet, seed: Room, paper: Paper, bounds: Room | null | undefined, reach: number, field?: Room): Balloon | null {
  const { data, w: sw, h: sh } = sheet

  if (seed.w <= 0 || seed.h <= 0) return null

  // The window is the balloon where one was detected, and `reach` around the
  // block where none was. `reach` is a guess at how far a balloon might extend;
  // `bounds` is the detector saying where it actually does, and a guess should
  // not be allowed to overrule a measurement.
  //
  // It used to be both — the guess cut to the balloon — which let the guess
  // overrule exactly what this says it must not: a narrow column of lettering
  // in a wide balloon (ECLIPSE p12, `別說話～` in a black circle three times
  // its width) had its window cut to 1.6 columns either side, and the fill
  // stopped on a straight line in the middle of the balloon. The block is
  // folded in so a detector box drawn a little tight cannot cut the lettering.
  const given = bounds ?? field
  const edge = given
    ? {
        left: Math.min(given.x, seed.x),
        top: Math.min(given.y, seed.y),
        right: Math.max(given.x + given.w, seed.x + seed.w),
        bottom: Math.max(given.y + given.h, seed.y + seed.h),
      }
    : {
        left: seed.x - seed.w * reach,
        top: seed.y - seed.h * reach,
        right: seed.x + seed.w * (1 + reach),
        bottom: seed.y + seed.h * (1 + reach),
      }

  const left = clamp(Math.floor(edge.left), 0, sw)
  const top = clamp(Math.floor(edge.top), 0, sh)
  const right = clamp(Math.ceil(edge.right), 0, sw)
  const bottom = clamp(Math.ceil(edge.bottom), 0, sh)

  const ww = right - left
  const wh = bottom - top

  if (ww < 4 || wh < 4) return null

  /** Near the paper, over the window alone. */
  const like = new Uint8Array(ww * wh)

  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const at = ((y + top) * sw + x + left) * 4
      const dr = data[at]! - paper.r
      const dg = data[at + 1]! - paper.g
      const db = data[at + 2]! - paper.b

      like[y * ww + x] = dr * dr + dg * dg + db * db <= TOLERANCE * TOLERANCE ? 1 : 0
    }
  }

  // Grown from inside the block: the gaps between the glyphs are paper, and
  // they are paper that is inside this balloon by construction — which is what
  // makes the seed self-evidently right, where a seed picked from around the
  // block could sit on the far side of the outline.
  const inner = {
    left: clamp(Math.floor(seed.x) - left, 0, ww),
    top: clamp(Math.floor(seed.y) - top, 0, wh),
    right: clamp(Math.ceil(seed.x + seed.w) - left, 0, ww),
    bottom: clamp(Math.ceil(seed.y + seed.h) - top, 0, wh),
  }

  const firm = eroded(like, ww, wh)

  let grown = flood(firm, ww, wh, inner)

  // A balloon can be thinner than the closing it is being asked to survive — a
  // one-character bubble, or a caption strip — and eroding one away leaves the
  // block with nothing to grow from. The open fill is worse and is still better
  // than no answer, and the escape check is what stops it doing harm.
  if (!grown) grown = flood(like, ww, wh, inner)

  // Nothing in the block matched the colour this pass is growing through, which
  // is the ordinary way the ink candidate fails on a page of dark lettering.
  if (!grown) return null

  const wide = widened(grown, like, ww, wh)
  const mask = filled(wide, ww, wh)
  const sides = sidesTouched(mask, ww, wh, {
    left: left > 0,
    top: top > 0,
    right: right < sw,
    bottom: bottom < sh,
  })

  let inside = 0
  let reached = 0

  for (let at = 0; at < mask.length; at++) {
    inside += mask[at]!
    reached += wide[at]!
  }

  const share = inside / (ww * wh)
  const solidity = solidityOf(mask, ww, wh)
  const room = inset(roomIn(mask, ww, wh, inner), left, top)
  const oval = ovalIn(mask, ww, wh)

  return {
    room,
    window: { x: left, y: top, w: ww, h: wh },
    mask,
    sides,
    share,
    // What the fill itself came to, before the holes in it were closed. The
    // two are the same number for a balloon, whose holes are its lettering;
    // they come apart when `filled` has claimed something the fill never
    // reached, which is the failure this pair was added to make visible.
    grown: reached / (ww * wh),
    solidity,
    escaped: leaked(sides, share, solidity, Boolean(bounds)),
    oval: oval && { x: left + oval.x, y: top + oval.y, w: oval.w, h: oval.h },
  }
}

/**
 * The paper with one pixel taken off every edge of it — which is to say the
 * balloon's outline with one pixel added to it, and that is what this is for.
 *
 * The leak a flood fill actually dies of is not a colour it should have stopped
 * at; it is a *gap*. Where a balloon's outline meets another balloon, a tail, or
 * the panel border, a scan at reading size leaves a hairline the fill walks
 * straight through, and once it is out it has the whole page. Measured on the
 * bottom-left balloon of `__ctl-24.jpg`: the open fill reached three sides of
 * its window at every tolerance from 18 to 60 — so it was never a question of
 * how near the colour had to be — and closing the barrier by a single pixel
 * brought it back inside.
 *
 * Missing neighbours off the window's edge count as paper rather than against
 * it. Eroding the window's own border would make the interior unable to reach
 * it, and reaching it is exactly the signal `sidesTouched` reads.
 */
function eroded (like: Uint8Array, w: number, h: number): Uint8Array {
  const firm = new Uint8Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * w + x

      if (!like[at]) continue

      const left = x > 0 ? like[at - 1]! : 1
      const right = x < w - 1 ? like[at + 1]! : 1
      const up = y > 0 ? like[at - w]! : 1
      const down = y < h - 1 ? like[at + w]! : 1

      firm[at] = left && right && up && down ? 1 : 0
    }
  }

  return firm
}

/**
 * The pixel the erosion took back, where the fill got there — so the room is
 * measured against the balloon's real edge and not one inside it.
 *
 * One step, and only onto paper the fill is already beside. A hairline that was
 * closed cannot re-open into a channel: it gains its one pixel and stops, having
 * nowhere to flood on to.
 */
function widened (grown: Uint8Array, like: Uint8Array, w: number, h: number): Uint8Array {
  const wide = new Uint8Array(grown)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * w + x

      if (grown[at] || !like[at]) continue

      if (
        (x > 0 && grown[at - 1])
        || (x < w - 1 && grown[at + 1])
        || (y > 0 && grown[at - w])
        || (y < h - 1 && grown[at + w])
      ) wide[at] = 1
    }
  }

  return wide
}

/**
 * The fill itself: every pixel reachable from inside the block, or nothing where
 * the block holds none of this colour at all.
 *
 * Iterative because a page-sized recursion blows the stack.
 */
function flood (
  like: Uint8Array,
  w: number,
  h: number,
  inner: { left: number, top: number, right: number, bottom: number },
): Uint8Array | null {
  const grown = new Uint8Array(w * h)
  const stack: number[] = []

  for (let y = inner.top; y < inner.bottom; y++) {
    for (let x = inner.left; x < inner.right; x++) {
      const at = y * w + x

      if (like[at] && !grown[at]) {
        grown[at] = 1
        stack.push(at)
      }
    }
  }

  if (!stack.length) return null

  const push = (next: number) => {
    if (grown[next] || !like[next]) return

    grown[next] = 1
    stack.push(next)
  }

  while (stack.length) {
    const at = stack.pop()!
    const x = at % w
    const y = (at - x) / w

    if (x > 0) push(at - 1)
    if (x < w - 1) push(at + 1)
    if (y > 0) push(at - w)
    if (y < h - 1) push(at + w)
  }

  return grown
}

/**
 * The grow with everything it encloses — the lettering, mostly.
 *
 * Done the way morphology does it: flood the *outside* in from the window's
 * border, and whatever the outside never reached is inside. Marking holes
 * directly would mean finding them first, which is this same flood run backwards.
 *
 * A size limit on what may be closed was tried here and reverted. The theory was
 * that a fill spanning its window walls it in two and this step then hands back
 * the far side as balloon; it is a real shape and it is not what is happening.
 * Measured on the page that prompted it, `share` and `grown` came back within
 * 1% of each other on every block — this step adds the lettering and nothing
 * else. The bleeding is the fill, not the closing. `grown` is on `Balloon` so
 * that the next person to suspect this can check it in one run instead of
 * rediscovering it.
 */
function filled (grown: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []

  const enter = (at: number) => {
    if (outside[at] || grown[at]) return

    outside[at] = 1
    stack.push(at)
  }

  for (let x = 0; x < w; x++) {
    enter(x)
    enter((h - 1) * w + x)
  }

  for (let y = 0; y < h; y++) {
    enter(y * w)
    enter(y * w + w - 1)
  }

  while (stack.length) {
    const at = stack.pop()!
    const x = at % w
    const y = (at - x) / w

    if (x > 0) enter(at - 1)
    if (x < w - 1) enter(at + 1)
    if (y > 0) enter(at - w)
    if (y < h - 1) enter(at + w)
  }

  const mask = new Uint8Array(w * h)

  for (let at = 0; at < mask.length; at++) mask[at] = outside[at] ? 0 : 1

  return mask
}

/**
 * Whether a fill ran past what a balloon can be.
 *
 * A function of its own, and exported, for the reason `departed` is one in
 * `useBlockSync`: it is the whole of the decision, it is two thresholds that
 * were both wrong once, and testing it needs two numbers rather than a page.
 * The observations it is set against are in `test/nuxt/utils/ocr/balloon.test.ts`
 * — real blocks off a real page, which is the only kind of evidence that has
 * ever moved either constant.
 */
export function leaked (sides: number, share: number, solidity: number, bounded = false): boolean {
  // A fill that was given the balloon cannot have left it, so the two
  // containment tests do not apply — and applying them anyway is not a
  // conservative mistake, it is the opposite verdict. `sides` and `share` are
  // both measured against the window, and once the window *is* the balloon a
  // healthy fill reaches all four of its edges and takes most of its area.
  // Bounded, every balloon on the test page came back "escaped" on numbers
  // that meant it had worked: 79–89% solid, filling the shape it was handed.
  //
  // What is still worth asking of a bounded fill is whether it is a fill at
  // all. Heavy lettering, a screentone, a balloon the detector drew around two
  // of them — any of those leave something ragged rather than a blob, and
  // solidity says so without caring how big the window was.
  //
  // Ragged *and* run into every wall. Solidity alone refused spiked bursts:
  // on istani's chapter five of them were filled exactly to their outline and
  // called leaks at 0.55–0.66, because a burst's spikes are what solidity
  // measures. What every recorded tone-grab had besides raggedness was that it
  // reached all four sides of its window — it spread until the fence stopped
  // it everywhere, so its shape is the fence's. The bursts stopped at their own
  // outlines, touching none or one. See the observation tables in
  // `test/nuxt/utils/ocr/balloon.test.ts`.
  if (bounded) return solidity < SOLID_BOUNDED && sides >= 4

  return sides >= SIDES || share > SHARE || solidity < SOLID
}

/**
 * The interior against its own bounding box.
 *
 * Measured on the mask rather than the window, so it says something about the
 * shape found instead of the shape of the search — which is the whole reason it
 * is here. `share` and `sides` are both relative to a window derived from the
 * block, so a big block buys a big window and a leak inside it stays a small
 * fraction; this does not move when the window does.
 */
function solidityOf (mask: Uint8Array, w: number, h: number): number {
  let n = 0
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue

      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }

  if (x1 < 0) return 0

  return n / ((x1 - x0 + 1) * (y1 - y0 + 1))
}

/**
 * How many of the window's sides the interior reaches. Three is a leak.
 *
 * A side the window was *cut off* at does not count, and that distinction is
 * load-bearing rather than tidy. A balloon in the corner of a page has its
 * window clipped by the page itself, so its interior runs to two of the four
 * edges for a reason that says nothing about whether the fill held — and two of
 * those free sides is the whole of the margin the escape check works in.
 */
function sidesTouched (
  mask: Uint8Array,
  w: number,
  h: number,
  open: { left: boolean, top: boolean, right: boolean, bottom: boolean },
): number {
  let sides = 0

  const row = (y: number) => {
    for (let x = 0; x < w; x++) if (mask[y * w + x]) return true

    return false
  }

  const column = (x: number) => {
    for (let y = 0; y < h; y++) if (mask[y * w + x]) return true

    return false
  }

  if (open.top && row(0)) sides++
  if (open.bottom && row(h - 1)) sides++
  if (open.left && column(0)) sides++
  if (open.right && column(w - 1)) sides++

  return sides
}

/**
 * The largest rectangle inside the balloon that still covers the block's centre.
 *
 * Two decisions, and the bench settled both.
 *
 * **Largest by area, rather than the first rectangle that cannot grow.** Growing
 * the block's own box outwards a side at a time was the first version and it is
 * wrong on precisely the balloons this feature is for. A shield or a teardrop
 * narrows towards its points, so a rectangle that has already taken the full
 * height can never take any width — on page 25 of the test chapter it settled at
 * 63×214 in a balloon with room for something twice as wide and half as tall,
 * and reported *less* room than the block box it started from. Searching for the
 * largest area finds the short wide rectangle instead, which is the shape a line
 * of English wants and the shape the tapering was hiding.
 *
 * **Anchored on the block's centre, not containing its box.** The frame has to
 * sit where the printed lettering sat or the translation is set somewhere the
 * balloon's tail does not point, but it does not have to *cover* the source: the
 * words are laid out again from scratch, and demanding the old column be inside
 * the answer re-imposes the tall thin shape the search exists to escape.
 *
 * Optimal rather than approximate, and cheap enough to be. Any rectangle through
 * the centre column is, on each of its rows, inside that row's run of interior
 * either side of the centre — so the widest one for a range of rows is the
 * narrowest of those runs, and walking every range of rows through the centre is
 * a few hundred thousand comparisons on a window this size.
 */
function roomIn (mask: Uint8Array, w: number, h: number, seed: { left: number, top: number, right: number, bottom: number }): { left: number, top: number, right: number, bottom: number } {
  const cx = clamp(Math.floor((seed.left + seed.right) / 2), 0, w - 1)
  const cy = clamp(Math.floor((seed.top + seed.bottom) / 2), 0, h - 1)

  // A centre sitting on ink is a block on artwork, or one whose box is off the
  // balloon entirely. There is no rectangle to report; the block's own box is
  // the honest answer, which is what the caller was using anyway.
  if (!mask[cy * w + cx]) return { left: seed.left, top: seed.top, right: seed.right, bottom: seed.bottom }

  /** How far the interior runs either side of the centre column, per row. */
  const from = new Int32Array(h)
  const upto = new Int32Array(h)

  for (let y = 0; y < h; y++) {
    if (!mask[y * w + cx]) {
      // Marked empty, and the walk below stops at it: a rectangle cannot span a
      // row where the centre column has left the balloon.
      upto[y] = -1

      continue
    }

    let left = cx
    let right = cx

    while (left > 0 && mask[y * w + left - 1]) left--
    while (right < w - 1 && mask[y * w + right + 1]) right++

    from[y] = left
    upto[y] = right + 1
  }

  let best = { left: cx, top: cy, right: cx + 1, bottom: cy + 1 }
  let area = 1

  for (let top = cy; top >= 0 && upto[top]! >= 0; top--) {
    let left = 0
    let right = w

    for (let y = top; y <= cy; y++) {
      left = Math.max(left, from[y]!)
      right = Math.min(right, upto[y]!)
    }

    for (let bottom = cy; bottom < h && upto[bottom]! >= 0; bottom++) {
      left = Math.max(left, from[bottom]!)
      right = Math.min(right, upto[bottom]!)

      const found = (right - left) * (bottom + 1 - top)

      if (found > area) {
        area = found
        best = { left, top, right, bottom: bottom + 1 }
      }
    }
  }

  return best
}

/**
 * The room as the sheet sees it, held off the outline.
 *
 * The inset is what keeps a descender from sitting on the balloon's own stroke —
 * a rectangle that touches the ink is arithmetically inside the balloon and
 * plainly wrong on the page.
 */
function inset (
  found: { left: number, top: number, right: number, bottom: number },
  left: number,
  top: number,
): Room {
  const w = found.right - found.left
  const h = found.bottom - found.top
  const pad = Math.min(Math.floor(Math.min(w, h) * MARGIN), Math.floor((Math.min(w, h) - 1) / 2))
  const room = Math.max(0, pad)

  return {
    x: left + found.left + room,
    y: top + found.top + room,
    w: w - room * 2,
    h: h - room * 2,
  }
}

/**
 * How far inside the outline the oval stops, as a share of each radius — more
 * than the rectangle's `MARGIN`, because an oval's lines run out to the outline
 * at the middle, where a letterer leaves the most air.
 */
const OVAL_INSET = 0.1

/** How many points round the oval are checked against the interior. */
const OVAL_POINTS = 72

/** Of those, how many may fall outside it — antialiasing, a stray speck — before it is shrunk. */
const OVAL_SLACK = 2

/** How small the oval may be shrunk, against its first size, before there is none. */
const OVAL_LEAST = 0.6

/**
 * Desktop: the balloon's own oval — what a letterer sets a speech balloon's
 * lines into, short at the top and bottom, long through the middle.
 *
 * `roomIn` finds the largest *rectangle*, and in an oval balloon that has the
 * oval's own proportions and covers under two thirds of it: a tall balloon
 * gives a tall, narrow room, barely wider than the Japanese column it was read
 * from, and a horizontal translation set in it is held to the width of its
 * longest word — tiny type in a big balloon. The oval is the room the balloon
 * actually has, and `shapeFor` wraps a line into it.
 *
 * Centred on the interior's centroid, not its bounding box, and given the
 * nearer edge on each axis as its radius: a tail is a small area off one side,
 * which barely moves the centroid and is never the nearer edge, so it can
 * neither pull the oval off the balloon nor stretch it. Held `OVAL_INSET` off
 * the outline, then shrunk until its rim lies inside the interior — a shield,
 * a cloud or a spiky shout is not an ellipse, and an oval that crossed the
 * outline would set words over it. Null where none survives `OVAL_LEAST`.
 */
export function ovalIn (mask: Uint8Array, w: number, h: number): Room | null {
  let n = 0
  let sx = 0
  let sy = 0
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue

      n++
      sx += x
      sy += y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }

  if (!n) return null

  const cx = sx / n
  const cy = sy / n
  const rx = Math.min(cx - x0, x1 + 1 - cx) * (1 - OVAL_INSET)
  const ry = Math.min(cy - y0, y1 + 1 - cy) * (1 - OVAL_INSET)

  if (rx < 2 || ry < 2) return null

  const inside = (scale: number) => {
    let out = 0

    for (let i = 0; i < OVAL_POINTS; i++) {
      const t = (i / OVAL_POINTS) * Math.PI * 2
      const x = Math.round(cx + Math.cos(t) * rx * scale)
      const y = Math.round(cy + Math.sin(t) * ry * scale)

      if (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) out++
      if (out > OVAL_SLACK) return false
    }

    return true
  }

  for (let scale = 1; scale >= OVAL_LEAST; scale -= 0.05) {
    if (inside(scale)) return { x: cx - rx * scale, y: cy - ry * scale, w: rx * scale * 2, h: ry * scale * 2 }
  }

  return null
}

/** How much more room the balloon is than the block, by area. One is no gain. */
export const roomGain = (room: Room, seed: Room) =>
  (seed.w * seed.h > 0 ? (room.w * room.h) / (seed.w * seed.h) : 1)

/** Darker than this, nought to 255, is ink as far as clear paper is concerned — screentone included. */
const INK = 170

/** How much ink a strip may carry and still count as clear: specks, JPEG noise, a stroke's anti-aliased edge. */
const SPECKS = 0.015

/** How far inside the clear space the room stops, as a share of its shorter side. */
const CLEAR_INSET = 0.04

/**
 * The clear paper round lettering that has no balloon — borderless dialogue
 * set straight onto a panel's white ground, which a flood fill cannot measure
 * because there is no outline for it to stop at.
 *
 * The block's box is pushed outward one sheet pixel at a time, a side at a
 * time, round the four in turn; a side stops at the first strip that crosses
 * ink (`INK`, which screentone is, so grey tone stops it as surely as an
 * outline) and at `reach` pixels from where it started. Round-robin rather than
 * one side to its limit and then the next, so the room grows evenly where it
 * can and a long clear run on one side does not take all the width. The cap is
 * what keeps a line in a large empty panel from being given the whole panel.
 *
 * Null where the block is not on clear paper at all, or where the space found
 * is no room to speak of — which is the ordinary answer for a sound effect
 * drawn over artwork.
 *
 * `across` first spreads the box sideways as far as it will go and only then up
 * and down — for lettering that will be set horizontally into a space measured
 * round a vertical column, where the width is the room that matters. See
 * `clearOf` in `rooms.ts`, which tries it on bands of the column.
 */
export function clearAround (sheet: Sheet, seed: Room, reach: number, across = false): Room | null {
  const { data, w: sw, h: sh } = sheet
  const dark = (x: number, y: number) => {
    const at = (y * sw + x) * 4

    return grey(data[at]!, data[at + 1]!, data[at + 2]!) < INK
  }

  let left = clamp(Math.round(seed.x), 0, sw - 1)
  let top = clamp(Math.round(seed.y), 0, sh - 1)
  let right = clamp(Math.round(seed.x + seed.w), left + 1, sw)
  let bottom = clamp(Math.round(seed.y + seed.h), top + 1, sh)

  const limit = {
    left: Math.max(0, left - reach),
    top: Math.max(0, top - reach),
    right: Math.min(sw, right + reach),
    bottom: Math.min(sh, bottom + reach),
  }

  /** Whether the column or row just outside the box is clear enough to take. */
  const clearColumn = (x: number) => {
    let ink = 0

    for (let y = top; y < bottom; y++) if (dark(x, y)) ink++

    return ink <= Math.max(2, (bottom - top) * SPECKS)
  }
  const clearRow = (y: number) => {
    let ink = 0

    for (let x = left; x < right; x++) if (dark(x, y)) ink++

    return ink <= Math.max(2, (right - left) * SPECKS)
  }

  // Sideways first, when asked — the rows are then checked across the full
  // width they will have, which is what makes the trade honest.
  const open = { left: true, top: !across, right: true, bottom: !across }

  for (let pass = across ? 0 : 1; pass < 2; pass++) {
    if (pass === 1 && across) {
      open.top = true
      open.bottom = true
    }

    while (open.left || open.top || open.right || open.bottom) {
      if (open.left) {
        if (left > limit.left && clearColumn(left - 1)) left--
        else open.left = false
      }

      if (open.right) {
        if (right < limit.right && clearColumn(right)) right++
        else open.right = false
      }

      if (open.top) {
        if (top > limit.top && clearRow(top - 1)) top--
        else open.top = false
      }

      if (open.bottom) {
        if (bottom < limit.bottom && clearRow(bottom)) bottom++
        else open.bottom = false
      }
    }
  }

  const inset = Math.round(Math.min(right - left, bottom - top) * CLEAR_INSET)
  const room = { x: left + inset, y: top + inset, w: right - left - inset * 2, h: bottom - top - inset * 2 }

  return room.w > 0 && room.h > 0 ? room : null
}
