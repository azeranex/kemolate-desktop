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
