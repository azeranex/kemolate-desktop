import { describe, expect, it } from 'vitest'

import type { Translation } from '~~/server/database'
import type { TranslationEntry } from '~~/server/services/translations'

import { boxOf, sameBox } from '~~/server/services/frames'

/**
 * The server end of "null and nought are different claims".
 *
 * All-null is *this lettering sits on its block*; a row of numbers, zeroes
 * among them, is *it has a frame of its own that happens to be square and
 * level*. Lettering may hang off the page edge, so a balloon centred on the
 * left border honestly has a centre of nought — and every `??` in these two
 * functions is what keeps that apart from having no frame at all.
 *
 * The tidy-up these exist to catch is `??` rewritten as `||`, which reads as
 * identical and is not. In `boxOf` it files a frame at the border as unframed
 * and puts the balloon back where the detector found it. In `sameBox` it makes
 * a nought and a null compare equal, so the move that put a balloon on the
 * border is judged to have changed nothing and is never written.
 *
 * These live in `frames.ts` rather than beside their caller because
 * `translations.ts` imports `db`, and `server/database/client` opens a real
 * `DatabaseSync` at module load — importing them from there would stand a
 * database up inside this sub-second project.
 */

/** A stored row, with only the fields these two look at. */
function row (frame: Partial<Translation> = {}): Translation {
  return { cx: null, cy: null, w: null, h: null, angle: null, skewX: null, skewY: null, quad: null, ...frame } as Translation
}

/** An entry off the wire, likewise. */
function entry (frame: Partial<TranslationEntry> = {}): TranslationEntry {
  return { blockId: 1, text: 'x', ...frame }
}

describe('boxOf', () => {
  it('reads an absent field as no frame', () => {
    expect(boxOf(entry())).toEqual({
      cx: null, cy: null, w: null, h: null, angle: null, skewX: null, skewY: null, quad: null,
    })
  })

  it('keeps a centre of nought, which is a place and not an absence', () => {
    const box = boxOf(entry({ cx: 0, cy: 0, w: 0.5, h: 0.2, angle: 0, skewX: 0, skewY: 0 }))

    expect(box.cx).toBe(0)
    expect(box.cx).not.toBeNull()
    expect(box.angle).toBe(0)
    expect(box.skewY).toBe(0)
  })

  it('passes a quad through as it stands', () => {
    expect(boxOf(entry({ quad: [0, 0, 1, 0, 1, 1, 0, 1] })).quad).toEqual([0, 0, 1, 0, 1, 1, 0, 1])
  })
})

describe('sameBox', () => {
  it('calls an unframed row and an entry with no frame the same', () => {
    expect(sameBox(row(), entry())).toBe(true)
  })

  it('tells a frame on the border from no frame at all', () => {
    expect(sameBox(row(), entry({ cx: 0 }))).toBe(false)
    expect(sameBox(row({ cx: 0 }), entry())).toBe(false)
  })

  it('agrees when the numbers match, noughts included', () => {
    const frame = { cx: 0, cy: 0.5, w: 0.4, h: 0.2, angle: 0, skewX: 0, skewY: 0 }

    expect(sameBox(row(frame), entry(frame))).toBe(true)
  })

  it('sees a nudge of one unit', () => {
    expect(sameBox(row({ cx: 0.5 }), entry({ cx: 0.5001 }))).toBe(false)
  })

  it('compares a quad corner by corner, and by length', () => {
    const quad = [0, 0, 1, 0, 1, 1, 0, 1]

    expect(sameBox(row({ quad }), entry({ quad: [...quad] }))).toBe(true)
    expect(sameBox(row({ quad }), entry({ quad: [0, 0, 1, 0, 1, 1, 0, 9] }))).toBe(false)
    expect(sameBox(row({ quad }), entry({ quad: [0, 0, 1, 0] }))).toBe(false)
    expect(sameBox(row({ quad }), entry())).toBe(false)
  })
})
