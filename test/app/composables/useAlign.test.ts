import { beforeEach, describe, expect, it } from 'vitest'

import type { Block } from '~/composables/useComic'

import { useAlign } from '~/composables/useAlign'
import { useComic } from '~/composables/useComic'

/**
 * Align lines up what a drag would move — on a translated block, its lettering.
 *
 * The report: aligning did nothing to translated balloons. Align measured and
 * moved each block's own box, the one its words were *read* from, while the
 * canvas draws a translation in its lettering frame (`Block.letter`) — so a
 * block with a frame of its own did not move at all, and one without had the
 * rectangle its repair was cut from dragged about instead.
 *
 * Seam: `useAlign` on `useComic`'s own page and selection. The page is 1000 ×
 * 1000 so a percentage is ten pixels and every number reads as itself.
 */

const block = (id: string, x: number, over: Partial<Block> = {}): Block => ({
  id,
  type: 'dialogue',
  x,
  y: 10,
  w: 10,
  h: 10,
  source: '原文',
  translation: '',
  confidence: 100,
  hidden: false,
  ...over,
}) as Block

describe('align', () => {
  beforeEach(() => {
    const { pages, at, selection, keyed, framing } = useComic()

    pages.value = [{
      id: 'scan:1.jpg',
      name: '1.jpg',
      blocks: [
        block('plain', 10),
        // Translated, its lettering moved off to the right of where it was read.
        block('framed', 40, { translation: 'Hello', letter: { x: 60, y: 10, w: 10, h: 10 } }),
        // Translated, its lettering still on the box it was read from.
        block('onbox', 30, { translation: 'Hi' }),
      ],
      scan: { url: 'blob:page', file: new File([], '1.jpg'), width: 1000, height: 1000, hash: 'h' },
    }] as ComicPage[]
    at.value = 0
    selection.value = ['plain', 'framed', 'onbox']
    keyed.value = null
    framing.value = 'lettering'
  })

  const find = (id: string) => useComic().page.value!.blocks.find((candidate) => candidate.id === id)!

  it('moves a translated block\'s lettering frame, and leaves the box it was read from', () => {
    const { alignTo, align } = useAlign()

    alignTo.value = 'selection'
    align('x', 'start')

    expect(find('framed').letter?.x).toBeCloseTo(10)
    expect(find('framed').x).toBe(40)
  })

  it('gives lettering still on its box a frame of its own rather than moving the box', () => {
    const { alignTo, align } = useAlign()

    alignTo.value = 'selection'
    align('x', 'start')

    expect(find('onbox').letter).toMatchObject({ x: 10, y: 10, w: 10, h: 10 })
    expect(find('onbox').x).toBe(30)
  })

  it('measures a translated block by its lettering, not by the box nobody can see', () => {
    const { alignTo, align } = useAlign()

    // The right edge of the selection is the framed block's lettering (60 + 10),
    // not its box (40 + 10).
    alignTo.value = 'selection'
    align('x', 'end')

    expect(find('plain').x).toBeCloseTo(60)
  })

  it('still moves an untranslated block\'s own box', () => {
    const { alignTo, align } = useAlign()

    alignTo.value = 'page'
    align('x', 'end')

    expect(find('plain').x).toBeCloseTo(90)
    expect(find('plain').letter).toBeUndefined()
  })

  it('moves the box it was read from while the reading is what is being framed', () => {
    const { framing } = useComic()
    const { alignTo, align } = useAlign()

    framing.value = 'reading'
    alignTo.value = 'page'
    align('x', 'start')

    expect(find('framed').x).toBeCloseTo(0)
    expect(find('framed').letter?.x).toBe(60)
  })
})

/**
 * Columns — desktop. Several lines in one balloon, kept separate blocks, laid
 * side by side: three staggered lines whose lettering frames overlap, on the
 * same 1000 × 1000 page, so a percentage is ten pixels.
 */
describe('columns', () => {
  const staggered = () => [
    // In reading order: the first line top right, each next one lower and further left.
    block('first', 55, { y: 10, h: 20, translation: 'We received a tip.', letter: { x: 55, y: 10, w: 12, h: 20 } }),
    block('second', 45, { y: 15, h: 20, translation: 'Your rank is stripped.', letter: { x: 44, y: 15, w: 12, h: 20 } }),
    block('third', 35, { y: 20, h: 20, translation: 'Come quietly.', letter: { x: 35, y: 20, w: 12, h: 20 } }),
  ]

  beforeEach(() => {
    const { pages, at, selection, keyed, framing } = useComic()

    pages.value = [{
      id: 'scan:1.jpg',
      name: '1.jpg',
      blocks: staggered(),
      scan: { url: 'blob:page', file: new File([], '1.jpg'), width: 1000, height: 1000, hash: 'h' },
    }] as ComicPage[]
    at.value = 0
    // Picked in another order than they read — the page's order is the one that counts.
    selection.value = ['third', 'first', 'second']
    keyed.value = null
    framing.value = 'lettering'
    useState('workspace-direction').value = 'rtl'
  })

  const find = (id: string) => useComic().page.value!.blocks.find((candidate) => candidate.id === id)!

  it('sets them side by side in equal widths with the gap between, the first line rightmost', () => {
    useAlign().columns(20)

    const [first, second, third] = ['first', 'second', 'third'].map((id) => find(id).letter!)

    // The space they covered: 35 % to 67 %, so 320 px, less two 20 px gaps, in three.
    for (const column of [first, second, third]) expect(column!.w).toBeCloseTo((320 - 40) / 3 / 10)

    expect(third!.x).toBeCloseTo(35)
    expect(second!.x).toBeCloseTo(third!.x + third!.w + 2)
    expect(first!.x).toBeCloseTo(second!.x + second!.w + 2)
    expect(first!.x + first!.w).toBeCloseTo(67)
  })

  it('runs each column as high and low as its original, so the stagger stays — not as its frame', () => {
    // Its frame squeezed to a band of the balloon; the column still runs where the original did.
    useComic().update('second', { letter: { x: 35, y: 30, w: 32, h: 4 } })
    useAlign().columns(20)

    expect(['first', 'second', 'third'].map((id) => find(id).letter!.y)).toEqual([10, 15, 20])
    expect(find('second').letter!.h).toBeCloseTo(20)
  })

  it('puts the first line leftmost on a page read left to right', () => {
    useState('workspace-direction').value = 'ltr'
    useAlign().columns(0)

    expect(find('first').letter!.x).toBeCloseTo(35)
    expect(find('third').letter!.x + find('third').letter!.w).toBeCloseTo(67)
  })

  it('needs two — one block is already a column of itself', () => {
    const { selection } = useComic()

    selection.value = ['first']
    expect(useAlign().columnable.value).toBe(false)

    selection.value = ['first', 'second']
    expect(useAlign().columnable.value).toBe(true)
  })
})
