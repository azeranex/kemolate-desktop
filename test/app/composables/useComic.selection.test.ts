import { beforeEach, describe, expect, it } from 'vitest'

import { useComic } from '~/composables/useComic'

/**
 * A reading landing on a page, and the selection on the page being worked on.
 *
 * `setBlocks` is how a reading reaches a page — a whole-chapter read calls it
 * once a page, and so do a restore, a collaborator's edit and blocks being
 * given their rows. It pruned the selection against whichever page it was
 * handed, and wrote the result back every time: so a reading landing on page
 * forty emptied a selection made on page three, and even an empty selection
 * came back as a new array — which every row of the block lists, the Blocks
 * panel and the board's chrome took for a change and drew again, once per page
 * read.
 *
 * Seam: `useComic`'s `pages`, `at`, `selection` and `setBlocks`.
 */

const block = (id: string): Block => ({
  id,
  type: 'bubble',
  x: 10,
  y: 10,
  w: 10,
  h: 10,
  source: id,
  translation: '',
  confidence: 100,
  hidden: false,
})

describe('a reading landing on a page', () => {
  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [
      { id: 'scan:1.png', name: '1.png', blocks: [block('a'), block('b')] },
      { id: 'scan:2.png', name: '2.png', blocks: [block('c')] },
    ] as unknown as ComicPage[]
    comic.at.value = 0
  })

  it('leaves the selection on the page on screen alone when it lands on another page', () => {
    const { selection, setBlocks } = useComic()

    selection.value = ['a']

    const before = selection.value

    setBlocks('scan:2.png', [block('d'), block('e')])

    expect(selection.value).toEqual(['a'])
    expect(selection.value).toBe(before)
  })

  it('does not hand back a new selection when nothing in it went', () => {
    const { selection, setBlocks } = useComic()

    selection.value = []

    const before = selection.value

    // Off screen, and on screen with the selected block kept.
    setBlocks('scan:2.png', [block('d')])
    setBlocks('scan:1.png', [block('a'), block('f')])

    expect(selection.value).toBe(before)
  })

  it('keeps the same selection when the page on screen keeps what was picked', () => {
    const { selection, setBlocks } = useComic()

    selection.value = ['a']

    const before = selection.value

    setBlocks('scan:1.png', [block('b'), block('a')])

    expect(selection.value).toBe(before)
  })

  it('still lets go of a picked block the page on screen no longer has', () => {
    const { selection, setBlocks } = useComic()

    selection.value = ['a', 'b']

    setBlocks('scan:1.png', [block('b')])

    expect(selection.value).toEqual(['b'])
  })
})
