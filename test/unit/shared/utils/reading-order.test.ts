import { describe, expect, it } from 'vitest'

import { centredReadingOrder, readingOrder } from '#shared/utils/ocr'

/**
 * The order somebody reads a page in.
 *
 * Worth a test of its own because the function is a *heuristic that must still
 * be a total order*, and those two pull against each other. The prose on
 * `readingOrder` explains why a comparator cannot do this job: "right of" and
 * "above" disagree on a comic page, so a pairwise answer is not transitive and
 * the result depends on the order the input happened to arrive in. The banding
 * is what makes it stable, and stability is the property nobody notices until
 * pressing Sort twice gives two answers.
 *
 * Boxes are given as `x, y, w, h` with the top-left corner, which is what the
 * canvas holds. `centredReadingOrder` is the same thing for the centre-and-size
 * form the drafts and the database use.
 */

const at = (id: string, x: number, y: number, w = 0.1, h = 0.1) => ({ id, x, y, w, h })

const ids = (blocks: { id: string }[]) => blocks.map((block) => block.id).join('')

describe('readingOrder', () => {
  it('runs right to left across a band, then down the page', () => {
    // Two bands of two. Within each, the right-hand block reads first; the
    // upper band reads before the lower.
    const page = [
      at('d', 0.1, 0.5),
      at('a', 0.8, 0.0),
      at('c', 0.8, 0.5),
      at('b', 0.1, 0.0),
    ]

    expect(ids(readingOrder(page, 'rtl'))).toBe('abcd')
  })

  it('runs left to right when the chapter does', () => {
    const page = [at('b', 0.8, 0.0), at('a', 0.1, 0.0)]

    expect(ids(readingOrder(page, 'ltr'))).toBe('ab')
  })

  it('is stable — sorting an already sorted page changes nothing', () => {
    const page = [
      at('a', 0.8, 0.0),
      at('b', 0.1, 0.02),
      at('c', 0.7, 0.4),
      at('d', 0.05, 0.44),
      at('e', 0.4, 0.9),
    ]

    const once = readingOrder(page, 'rtl')
    const twice = readingOrder(once, 'rtl')

    expect(ids(twice)).toBe(ids(once))
  })

  it('gives one answer whatever order it is handed', () => {
    // The transitivity failure a comparator would have: the same page shuffled
    // must not come out differently.
    const page = [
      at('a', 0.8, 0.0),
      at('b', 0.1, 0.03),
      at('c', 0.75, 0.5),
      at('d', 0.1, 0.52),
    ]

    const forwards = ids(readingOrder(page, 'rtl'))
    const backwards = ids(readingOrder([...page].reverse(), 'rtl'))

    expect(backwards).toBe(forwards)
  })

  it('treats blocks that overlap vertically as one band, however uneven', () => {
    // A balloon hanging a little lower than its neighbour still reads beside
    // it — see `BESIDE`. Without that they become two bands and the order
    // jumps back up the page.
    const page = [at('b', 0.1, 0.06), at('a', 0.8, 0.0)]

    expect(ids(readingOrder(page, 'rtl'))).toBe('ab')
  })

  it('orders by the right edge in rtl, so a wide balloon reads from where it begins', () => {
    const wide = { id: 'a', x: 0.5, y: 0, w: 0.45, h: 0.1 }
    const narrow = { id: 'b', x: 0.5, y: 0, w: 0.1, h: 0.1 }

    expect(ids(readingOrder([narrow, wide], 'rtl'))).toBe('ab')
  })

  it('leaves a page of one block, or none, alone', () => {
    expect(readingOrder([], 'rtl')).toEqual([])
    expect(ids(readingOrder([at('a', 0.3, 0.3)], 'rtl'))).toBe('a')
  })
})

describe('centredReadingOrder', () => {
  it('reads the same page held by its centre', () => {
    // The same four blocks as the first case, expressed the way a `BlockDraft`
    // and a `blocks` row hold them.
    const page = [
      { id: 'd', cx: 0.15, cy: 0.55, w: 0.1, h: 0.1 },
      { id: 'a', cx: 0.85, cy: 0.05, w: 0.1, h: 0.1 },
      { id: 'c', cx: 0.85, cy: 0.55, w: 0.1, h: 0.1 },
      { id: 'b', cx: 0.15, cy: 0.05, w: 0.1, h: 0.1 },
    ]

    expect(ids(centredReadingOrder(page, 'rtl'))).toBe('abcd')
  })

  it('hands back the objects it was given, not copies', () => {
    // Callers reorder rows and then read ids off them; a copy would work and a
    // shallow one would drift the moment a field was added.
    const one = { id: 'a', cx: 0.8, cy: 0.1, w: 0.1, h: 0.1 }
    const two = { id: 'b', cx: 0.2, cy: 0.1, w: 0.1, h: 0.1 }

    const sorted = centredReadingOrder([two, one], 'rtl')

    expect(sorted[0]).toBe(one)
    expect(sorted[1]).toBe(two)
  })

  it('copes with a tall page, where cy and h run past one', () => {
    // Both axes are divided by the *width*, so this is ordinary rather than
    // exceptional — see the note on `Box`.
    const page = [
      { id: 'b', cx: 0.5, cy: 1.30, w: 0.1, h: 0.1 },
      { id: 'a', cx: 0.5, cy: 0.90, w: 0.1, h: 0.1 },
    ]

    expect(ids(centredReadingOrder(page, 'rtl'))).toBe('ab')
  })
})
