import { describe, expect, it } from 'vitest'

import { keepPixels, keptPixels } from '~/utils/paint/kept'

/**
 * The finished paint kept between visits to a page.
 *
 * The report: turning to a page with a few wide strokes round its margin froze
 * the tab for most of a second, every time, because every stroke was replayed
 * from its points. These are the rules that make keeping the pixels safe to
 * rely on — what is kept, for how many surfaces, and what gives memory back.
 * Whether the kept pixels still describe the log is `Paint.redraw`'s prefix
 * test, not this file's.
 */
describe('kept paint', () => {
  /** A stand-in canvas: the cache only reads its size and zeroes its width. */
  const canvas = (w = 10, h = 10) => ({ width: w, height: h }) as HTMLCanvasElement

  it('gives back what was kept for a surface, with the rows it was made from', () => {
    const pixels = canvas()

    keepPixels('scan-a:bg', pixels, ['c:1', 'c:2'])

    expect(keptPixels('scan-a:bg')?.pixels).toBe(pixels)
    expect(keptPixels('scan-a:bg')?.keys).toEqual(['c:1', 'c:2'])
  })

  it('keeps nothing for a blank surface — there is nothing to save a replay of', () => {
    keepPixels('scan-b:bg', canvas(), [])
    keepPixels('scan-c:bg', canvas(0, 0), ['c:1'])

    expect(keptPixels('scan-b:bg')).toBeUndefined()
    expect(keptPixels('scan-c:bg')).toBeUndefined()
  })

  it('holds three surfaces, lets the oldest go, and gives its memory back', () => {
    const first = canvas()

    keepPixels('p1:bg', first, ['c:1'])
    keepPixels('p2:bg', canvas(), ['c:1'])
    keepPixels('p3:bg', canvas(), ['c:1'])
    keepPixels('p4:bg', canvas(), ['c:1'])

    expect(keptPixels('p1:bg')).toBeUndefined()
    expect(first.width).toBe(0)
    expect(keptPixels('p4:bg')).toBeDefined()
  })

  it('counts a page looked at again as the newest, so the one being moved between stays', () => {
    keepPixels('q1:bg', canvas(), ['c:1'])
    keepPixels('q2:bg', canvas(), ['c:1'])
    keepPixels('q3:bg', canvas(), ['c:1'])

    // Back to the first, then one more page: the second is now the oldest.
    keptPixels('q1:bg')
    keepPixels('q4:bg', canvas(), ['c:1'])

    expect(keptPixels('q1:bg')).toBeDefined()
    expect(keptPixels('q2:bg')).toBeUndefined()
  })

  it('does not share its record of the rows with the caller', () => {
    const keys = ['c:1']

    keepPixels('r1:bg', canvas(), keys)
    keys.push('c:2')

    expect(keptPixels('r1:bg')?.keys).toEqual(['c:1'])
  })
})
