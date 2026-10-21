import { describe, expect, it } from 'vitest'

import type { Block } from '~/composables/useComic'
import type { StoredBlock } from '~/utils/ocr/blocks'

/**
 * The two boxes, and which of them each part of the app is asking for.
 *
 * A block's box says **where the original lettering was found**, and it is what
 * the repair under it was cut from — `regionOf` and `patchKey` are worked out
 * from those four numbers, so changing them orphans the cleaned artwork. A
 * block's `letter` says **how much room the translation gets**, which is a
 * typesetting decision and a fact about nothing. They used to be one box doing
 * both jobs, and widening a balloon to take the English silently threw away the
 * clean under it.
 *
 * So the whole concept comes down to two questions that can be asked without a
 * browser: which box is read, and which box is written. Both are pinned here.
 *
 * `letterBoxOf`, `blockBoxOf` and `toLetterPatch` are not imported —
 * `composables/` and `utils/ocr` are auto-imported families, and this project
 * stands the real module graph up so a test reaches them the way the app does.
 * The types are imported, because a type is not.
 *
 * A square scan throughout, so the aspect is one and every number below can be
 * checked by eye. The change of space is `transform`'s argument to have, not
 * this file's.
 */
const SCAN = { width: 100, height: 100 }

function block (over: Partial<Block> = {}): Block {
  return {
    id: 'block:7',
    type: 'bubble',
    x: 10,
    y: 20,
    w: 30,
    h: 40,
    source: 'おはよう',
    translation: 'Good morning',
    confidence: 90,
    hidden: false,
    ...over,
  }
}

describe('letterBoxOf', () => {
  /**
   * The state every page written before this concept existed is in, and the one
   * that must need no migration: with no frame of its own, the lettering is set
   * in the block's box exactly as it always was.
   */
  it('falls back to the block’s own box', () => {
    expect(letterBoxOf(block())).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  /** And once there is a frame, it is the frame and nothing of the block's. */
  it('takes the frame where there is one', () => {
    const framed = block({ letter: { x: 5, y: 5, w: 60, h: 50 } })

    expect(letterBoxOf(framed)).toEqual({ x: 5, y: 5, w: 60, h: 50 })
  })

  /**
   * A turn of nought is left off rather than written down, so the fallback
   * round-trips through `toBoxed` unchanged — see the note on `Block.angle`,
   * which this is what keeps true.
   */
  it('leaves an unturned block carrying no angle', () => {
    expect(letterBoxOf(block())).not.toHaveProperty('angle')
    expect(letterBoxOf(block({ angle: 12, skewX: 3 }))).toMatchObject({ angle: 12, skewX: 3 })
  })

  /**
   * The frame's turn is the frame's. A block turned by the detector and a
   * translation set upright inside it is an ordinary thing, and reading the
   * block's angle through the frame would set the words at an angle nobody
   * chose.
   */
  it('does not let the block’s turn reach through a frame', () => {
    const framed = block({ angle: 30, letter: { x: 5, y: 5, w: 60, h: 50 } })

    expect(letterBoxOf(framed)).not.toHaveProperty('angle')
  })
})

/**
 * The block's box, asked for by name — which is what the cleaning path goes on
 * reading, and the whole reason a repair now survives being re-lettered.
 */
describe('blockBoxOf', () => {
  it('ignores the frame entirely', () => {
    const framed = block({ letter: { x: 5, y: 5, w: 60, h: 50, angle: 45 } })

    expect(blockBoxOf(framed)).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })
})

/**
 * The other half: which box a drag *writes*. This is the rule the whole concept
 * turns on, so it is pinned in every combination it has.
 */
describe('framesLettering', () => {
  /**
   * The case that started all of this: a letterer widens a translated balloon to
   * take the English, and the cleaned artwork under it must not move.
   */
  it('sends a translated block’s transform to its frame', () => {
    expect(framesLettering(block(), 'lettering')).toBe(true)
    expect(framedBoxOf(block({ letter: { x: 1, y: 2, w: 3, h: 4 } }), 'lettering'))
      .toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  /**
   * A block nobody has carried over yet has no typesetting to have opinions
   * about, and putting a detector's box right is a real act. So a page that has
   * only been read behaves exactly as it did before any of this existed — which
   * is what makes this need no migration and no relearning.
   */
  it('leaves an untranslated block writing its own box', () => {
    const read = block({ translation: '' })

    expect(framesLettering(read, 'lettering')).toBe(false)
    expect(framedBoxOf(read, 'lettering')).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  /**
   * And the way back. Once a frame exists the detection box is no longer under
   * the handles, and that box is what the repair is cut from — so it has to stay
   * correctable or this trades a silent trap for a silent wall. See `Framing`,
   * which argues why it is a mode and not a modifier.
   */
  it('hands the handles back to the reading in reading mode', () => {
    const framed = block({ letter: { x: 1, y: 2, w: 3, h: 4 } })

    expect(framesLettering(framed, 'reading')).toBe(false)
    expect(framedBoxOf(framed, 'reading')).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  /** Whitespace is not a translation, whatever a stray keystroke left behind. */
  it('does not count an empty line as a translation', () => {
    expect(framesLettering(block({ translation: '' }), 'lettering')).toBe(false)
  })
})

/**
 * The round trip to the row that holds it. Page percentages out, normalised by
 * the scan's *width* on both axes in — the same space a block's own box is
 * stored in, and for the same reason: dividing y by the height squashes the
 * space, and a rotation in a squashed space is not a rotation.
 */
describe('toLetterPatch and toLetterBox', () => {
  /**
   * Rounded before comparing, and only here. Dividing by a hundred and
   * multiplying back is not exact in binary — 5 comes home as 4.999999999999999
   * — and pinning that would be pinning the arithmetic rather than the round
   * trip. Nine places is far below a pixel of any scan.
   */
  const round = (box: object) => Object.fromEntries(
    Object.entries(box).map(([key, value]) => [
      key,
      typeof value === 'number'
        ? Number(value.toFixed(9))
        : Array.isArray(value) ? value.map((v: number) => Number(v.toFixed(9))) : value,
    ]),
  )

  it('comes back the box it went out as', () => {
    const letter = { x: 5, y: 5, w: 60, h: 50, angle: 30, skewX: 4, skewY: -2 }
    const there = toLetterPatch(letter, SCAN)

    expect(round(toLetterBox({ locale: 'en', text: '', ...there }, SCAN)!)).toEqual(letter)
  })

  /**
   * The corner offsets are lengths in the scan's own pixels, so unlike the angle
   * they do not survive the change of space untouched.
   */
  it('carries a pulled corner through both spaces', () => {
    const letter = { x: 0, y: 0, w: 50, h: 50, quad: [1, 2, 3, 4, 5, 6, 7, 8] }
    const there = toLetterPatch(letter, SCAN)

    expect(there.quad).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08])
    expect(round(toLetterBox({ locale: 'en', text: '', ...there }, SCAN)!)).toEqual(letter)
  })

  /**
   * Nulls all the way down, and never an omission. The server treats absent and
   * null alike and writes both, so a block with no frame has to say so out loud
   * — otherwise a balloon somebody put back on its block would be put straight
   * back off it by the next settle.
   */
  it('says “no frame” out loud rather than by omission', () => {
    const there = toLetterPatch(undefined, SCAN)

    expect(Object.keys(there).sort()).toEqual(
      ['angle', 'cx', 'cy', 'h', 'quad', 'skewX', 'skewY', 'w'],
    )
    expect(Object.values(there).every((v) => v === null)).toBe(true)
  })

  /**
   * And undefined rather than a box matching the block on the way back, because
   * those are different claims: "no frame of its own" follows the block if the
   * detection is corrected later, and a copy of today's box does not.
   */
  it('reads an empty row as no frame at all', () => {
    expect(toLetterBox({ locale: 'en', text: 'Hi' }, SCAN)).toBeUndefined()
    expect(toLetterBox(undefined, SCAN)).toBeUndefined()
  })

  /** A frame with no width is not a frame, whatever a half-written row says. */
  it('refuses a frame with nothing to it', () => {
    const half = { locale: 'en', text: 'Hi', cx: 0.5, cy: 0.5, w: 0, h: 0.2 }

    expect(toLetterBox(half, SCAN)).toBeUndefined()
  })

  /**
   * A frame centred on the page's own edge, where `cx` is honestly nought.
   *
   * Null and nought are different claims about these columns — null is "this
   * lettering sits on its block", nought is "it has a frame and that frame is
   * here" — so the guard above asks `cx == null` rather than `!cx`. The shorter
   * spelling is the obvious tidy-up and it is wrong: lettering is allowed to
   * bleed off the edge (`blockDraftSchema` permits negatives for exactly that),
   * so a balloon hanging half off the left of the page has `cx` of nought or
   * less, and `!cx` would read it as never having been moved and drop it back
   * onto its block. This is the client-side twin of "`cx IS NOT NULL`, never
   * `cx != 0`" on the server.
   */
  it('keeps a frame whose centre is honestly nought', () => {
    const edge = { locale: 'en', text: 'Hi', cx: 0, cy: 0.5, w: 0.5, h: 0.2 }

    expect(toLetterBox(edge, SCAN)).toEqual({ x: -25, y: 40, w: 50, h: 20 })
  })
})

/**
 * Hydration: the frame has to come back off the row it was filed under, and off
 * *that language's* row. A chapter carried into two languages is two frames, for
 * the same reason it is two sizes — German wants more room than English.
 */
describe('toBlocks', () => {
  function row (translations?: StoredBlock['translations']): StoredBlock {
    return {
      id: 7,
      position: 0,
      kind: 'bubble',
      cx: 0.5,
      cy: 0.5,
      w: 0.2,
      h: 0.2,
      angle: 0,
      source: 'おはよう',
      confidence: 90,
      hidden: false,
      ...(translations ? { translations } : {}),
    }
  }

  it('puts a stored frame back on the block', () => {
    const [made] = toBlocks([row([
      { locale: 'en', text: 'Good morning', cx: 0.5, cy: 0.5, w: 0.4, h: 0.3 },
    ])], SCAN, 'en')

    expect(made?.letter).toEqual({ x: 30, y: 35, w: 40, h: 30 })
    // And the block's own box is untouched by it, which is the point.
    expect(made).toMatchObject({ x: 40, y: 40, w: 20, h: 20 })
  })

  it('takes the frame from the language being worked in', () => {
    const [made] = toBlocks([row([
      { locale: 'en', text: 'Good morning', cx: 0.5, cy: 0.5, w: 0.4, h: 0.3 },
      { locale: 'de', text: 'Guten Morgen', cx: 0.5, cy: 0.5, w: 0.6, h: 0.3 },
    ])], SCAN, 'de')

    expect(made?.letter?.w).toBe(60)
  })

  /**
   * A row from before the frame existed, which is most of them. Absent rather
   * than a copy of the block's box — the same rule `style` follows, and the
   * reason this needed no migration.
   */
  it('leaves a block with no stored frame carrying none', () => {
    const [made] = toBlocks([row([{ locale: 'en', text: 'Good morning' }])], SCAN, 'en')

    expect(made?.letter).toBeUndefined()
  })
})
