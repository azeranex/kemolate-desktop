import { describe, expect, it } from 'vitest'

import fixtures from './fixtures/lean-horizontal.json'
import regions from './fixtures/lean-regions.json'

import { inkRect } from '~/utils/ocr/mask'

/**
 * The lean measurement on horizontal lettering — the case the ECLIPSE corpus
 * in `mask.test.ts` never had in it.
 *
 * Every mask here is real: the ink `inkOnly` found in one block of a real
 * page, run-length encoded exactly as it came out. That is deliberate. The
 * failure lives in *where the ink's pieces sit relative to each other* — a
 * Hangul syllable is two or three separate jamo stacked in one cell, and
 * their centroids are what the column fit measured — and stamping each piece
 * as its bounding rectangle moved the centroids and reproduced the fault in
 * six blocks of seventeen. The real ink reproduces it in all of them.
 *
 * Nineteen upright blocks are Korean from *Business Trip Grooming 2* and two
 * are horizontal Chinese from istani's hot-spring chapter. Each was stored
 * with a lean (`stored`), each is upright on the page — checked by eye against
 * the scan with the stored box drawn over it — and `via` is the path that
 * produced the wrong lean, which is the path a regression would come back by.
 * Three of them (690, 702, 760) were found only by re-measuring both chapters
 * after the first version of the fix, which got them wrong: the corpus is
 * what the fix was checked against, and it grew when it caught something.
 *
 * The four with a non-zero `truth` are genuinely tilted lettering: three
 * messages on a tilted phone screen and one hand-drawn label, all measured by
 * the det head. The ink measurement cannot see any of them — the messages are
 * white on dark bubbles and the label is outlined, so the "ink" is the bubble
 * or the outline — and it reads them level. They are held to the same rule as
 * everything else, not to that limitation, so the day the ink learns to see
 * them this file does not fail.
 *
 * ## The rule
 *
 * **Level or right, never wrong.** A measured lean must be the lean the
 * lettering has, within a few degrees; where the ink cannot establish one it
 * must say level. A wrong lean turns the crop the recogniser reads and the box
 * the translation is lettered into, and it is stored — which is how 61 upright
 * blocks in one chapter came to be tilted. An upright box on a tilted line is
 * merely unhelpful, and the det head exists to catch it.
 */

interface Fixture {
  block: number
  text: string
  truth: number
  stored: number
  via: string
  w: number
  h: number
  runs: number[]
}

/** Alternating runs of 0 and 1, starting with 0 — the encoding the fixtures use. */
function decode ({ w, h, runs }: Fixture): Float32Array {
  const mask = new Float32Array(w * h)
  let at = 0
  let on = false

  for (const run of runs) {
    if (on) mask.fill(1, at, at + run)
    at += run
    on = !on
  }

  return mask
}

/**
 * A mask turned `degrees` clockwise about its centre, onto a canvas big enough
 * to hold it — the lean `tiltedQuad` would call `+degrees`.
 *
 * Nearest-neighbour on purpose: the mask is binary, and interpolating would
 * invent grey that `inkRect` then thresholds at 0.5, thinning strokes the page
 * never had thin.
 */
function turned (mask: Float32Array, w: number, h: number, degrees: number) {
  const side = Math.ceil(Math.hypot(w, h))
  const out = new Float32Array(side * side)
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = x - side / 2
      const dy = y - side / 2
      // Inverse map: where in the source this output pixel came from.
      const sx = Math.round(w / 2 + dx * cos + dy * sin)
      const sy = Math.round(h / 2 - dx * sin + dy * cos)

      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * side + x] = mask[sy * w + sx]!
    }
  }

  return { mask: out, w: side, h: side }
}

/** Level, or within `slack` degrees of the truth — see "The rule". */
function levelOrRight (angle: number, truth: number, slack = 6) {
  if (angle === 0) return

  expect(Math.sign(angle)).toBe(Math.sign(truth))
  expect(Math.abs(angle - truth)).toBeLessThanOrEqual(slack)
}

const all = fixtures as Fixture[]
const byBlock = new Map(all.map((fixture) => [fixture.block, fixture]))

/**
 * The first line of block 621, `늑대랑 할땐` — five real syllables in one
 * row, cut from the two-line balloon at the blank band nearest its middle.
 * The only single row long enough here for the ink to be allowed a lean, so
 * it is what proves that path still works at all.
 */
function firstLine () {
  const fixture = byBlock.get(621)!
  const mask = decode(fixture)
  const profile = Array.from({ length: fixture.h }, (_, y) => {
    let n = 0

    for (let x = 0; x < fixture.w; x++) n += mask[y * fixture.w + x]!

    return n
  })
  const inked = profile.flatMap((n, y) => (n > 0 ? [y] : []))
  const middle = (inked[0]! + inked[inked.length - 1]!) / 2

  let cut = -1

  for (let y = inked[0]!; y <= inked[inked.length - 1]!; y++) {
    if (profile[y] === 0 && (cut < 0 || Math.abs(y - middle) < Math.abs(cut - middle))) cut = y
  }

  return { mask: mask.slice(0, cut * fixture.w), w: fixture.w, h: cut }
}

describe('upright horizontal lettering reads level', () => {
  it.each(all.filter((f) => f.truth === 0).map((f) => [f.block, f.text, f.stored, f.via, f] as const))(
    'block %s %s (was stored at %s° via %s)',
    (_block, _text, _stored, _via, fixture) => {
      expect(inkRect(decode(fixture), fixture.w, fixture.h).angle).toBe(0)
    },
  )
})

/**
 * The same kind of ink, cut the way a *read* cuts it.
 *
 * Every fixture above is the ink inside a block's stored box. These three are
 * the ink `uprightRegion` measured when both chapters' pages were run through
 * the detector and both readers again after the fix — the detector's region,
 * padded, which is a different crop of the same balloon — and they are the
 * three it still tilted. `stored` is what that read measured.
 *
 * - 760 `啊,嗯…` (+8°, `sweep`): the region clipped a corner of the balloon's
 *   outline into a speck above the first character, and the smallest
 *   rectangle tilted to take it in.
 * - 656 `예? / 그게 / 무슨..` (+9°) and 525 `오오 / 오옥 / !!!` (−11°), both
 *   `column-line`: centred lines whose characters line up vertically into
 *   columns that pass every test of shape. See `rowsNotColumns`.
 */
describe('upright lettering cut as a read cuts it reads level', () => {
  it.each((regions as Fixture[]).map((f) => [f.block, f.text, f.stored, f.via, f] as const))(
    'block %s %s (was read at %s° via %s)',
    (_block, _text, _stored, _via, fixture) => {
      expect(inkRect(decode(fixture), fixture.w, fixture.h).angle).toBe(0)
    },
  )
})

/**
 * Two columns of square characters, leaning `lean`°, `step` apart along each
 * column and `gap` apart across — the geometry `rowsNotColumns` judges, with
 * nothing else in it. Stamped rather than taken from a page because no chapter
 * here has leaning two-column lettering to take.
 */
function twoColumns (lean: number, step: number, gap: number, side = 26) {
  const w = 320
  const h = 320
  const mask = new Float32Array(w * h)
  const radians = (lean * Math.PI) / 180

  for (const across of [-gap / 2, gap / 2]) {
    for (let i = 0; i < 4; i++) {
      const along = (i - 1.5) * step
      const cx = w / 2 + across * Math.cos(radians) - along * Math.sin(radians)
      const cy = h / 2 + across * Math.sin(radians) + along * Math.cos(radians)

      for (let y = Math.round(cy - side / 2); y < cy + side / 2; y++) {
        for (let x = Math.round(cx - side / 2); x < cx + side / 2; x++) mask[y * w + x] = 1
      }
    }
  }

  return { mask, w, h }
}

/**
 * The other side of `rowsNotColumns`: real columns keep their lean. The
 * stacked-lines side is the two real balloons above, which fail without the
 * rule; a stamped grid set the other way round is refused by the grouping
 * before the rule is reached, so it would pass either way and prove nothing.
 */
describe('columns are told from stacked lines by their spacing', () => {
  // Not past about 20°: there the x-overlap grouping chains the top of one
  // four-character column to the bottom of the next and the whole grid becomes
  // one group, which reads level with or without the spacing rule. That is a
  // limit of the grouping, older than this, and on the right side of the rule.
  it.each([10, 15, -15])('keeps a %s° lean on two real columns — set closer down than across', (lean) => {
    // Vertical text: characters nearly touch down the column, and the
    // columns stand apart. This is what the spacing rule must never refuse.
    const t = twoColumns(lean, 30, 44)
    const rect = inkRect(t.mask, t.w, t.h)

    expect(rect.via).toBe('column-line')
    expect(Math.abs(rect.angle - lean)).toBeLessThanOrEqual(4)
  })
})

describe('genuinely tilted lettering reads level or right', () => {
  it.each(all.filter((f) => f.truth !== 0).map((f) => [f.block, f.text, f.truth, f] as const))(
    'block %s %s (tilted %s°)',
    (_block, _text, truth, fixture) => {
      levelOrRight(inkRect(decode(fixture), fixture.w, fixture.h).angle, truth)
    },
  )
})

describe('real ink turned by a known amount reads level or right', () => {
  const leans = [8, -8, 15, -15, 22, -22, 28, -28]

  // Short shouts, a line with a comma, two lines, a centred stack of three —
  // including 577, whose turned centred lines once chained into a slanted
  // "column" and read the opposite way to the text.
  for (const block of [484, 465, 615, 621, 577, 690, 702, 760]) {
    for (const lean of leans) {
      it(`block ${block} ${byBlock.get(block)!.text} turned ${lean}°`, () => {
        const fixture = byBlock.get(block)!
        const t = turned(decode(fixture), fixture.w, fixture.h, lean)

        levelOrRight(inkRect(t.mask, t.w, t.h).angle, lean)
      })
    }
  }

  for (const lean of leans) {
    it(`one real row of five syllables turned ${lean}°`, () => {
      const row = firstLine()
      const t = turned(row.mask, row.w, row.h, lean)

      levelOrRight(inkRect(t.mask, t.w, t.h).angle, lean)
    })
  }

  it('still finds a lean in a long enough row — the path is not simply switched off', () => {
    // Level-or-right is satisfied by levelling everything, so this is the
    // other half: a real five-syllable row, turned well clear of the snap
    // band, has to come back turned.
    const row = firstLine()

    for (const lean of [22, -22, 28, -28]) {
      const t = turned(row.mask, row.w, row.h, lean)
      const angle = inkRect(t.mask, t.w, t.h).angle

      expect(Math.abs(angle - lean)).toBeLessThanOrEqual(6)
    }
  })

  it('reads a short upright line level, and not by the column path', () => {
    // The plain case, stated on its own: three syllables and a bang, as
    // printed. It was −9° via `column-line` — each syllable's stacked jamo
    // taken for a column of its own.
    const fixture = byBlock.get(484)!
    const rect = inkRect(decode(fixture), fixture.w, fixture.h)

    expect(rect.angle).toBe(0)
    expect(rect.via).not.toBe('column-line')
  })
})
