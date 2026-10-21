import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, watchEffect } from 'vue'

import { useComic } from '~/composables/useComic'
import { useLetteringFit } from '~/composables/useLetteringFit'

/**
 * Fitting the lettering, and what a fit costs the things that read it.
 *
 * `refit` runs on every keystroke into a balloon, every tick of a lettering
 * slider, every frame of a frame being resized and once per page of an export.
 * It used to copy the whole chapter's fits — every page's, not the page being
 * fitted — on every one of those, and to hand back a new map whenever anything
 * had moved: so typing into one balloon was heard by everything that had read
 * any balloon's size, and an export re-drew the board once per page it fitted.
 * Neither map was ever pruned either, across chapters or workspaces.
 *
 * Seam: `useLetteringFit` over `useComic`'s pages, with the measuring itself
 * (`fitSize`) and the face check (`loadFace`) replaced — the probe needs a real
 * layout engine, and which size comes back is not what these are about.
 */

const { measure } = vi.hoisted(() => ({
  measure: vi.fn((input: { text: string }) => 12 + input.text.length),
}))

mockNuxtImport('fitSize', () => measure)
mockNuxtImport('loadFace', () => () => true)

/**
 * Fitted sizes are remembered by what they were measured from, for the life of
 * the tab — so every test letters words nobody has measured before.
 */
let words = 0
const fresh = () => `line ${++words} of dialogue`

const block = (id: string, text: string): Block => ({
  id,
  type: 'bubble',
  x: 10,
  y: 10,
  w: 20,
  h: 10,
  source: '',
  translation: text,
  confidence: 100,
  hidden: false,
})

const scan = { url: 'blob:1.png', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'hash-1' }

describe('refitting a page', () => {
  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [
      { id: 'scan:1.png', name: '1.png', blocks: [block('a', fresh()), block('b', fresh()), block('c', fresh())], scan },
    ] as unknown as ComicPage[]

    useState('lettering-fits-ready').value = true
    measure.mockClear()
  })

  const fitPage = () => {
    const { pages, styleOf } = useComic()

    useLetteringFit().refit(pages.value[0], styleOf, () => false)
  }

  it('measures only the balloon whose words changed', () => {
    fitPage()

    expect(measure).toHaveBeenCalledTimes(3)

    const { pages } = useComic()

    pages.value[0]!.blocks[1]!.translation = fresh()
    fitPage()

    expect(measure).toHaveBeenCalledTimes(4)
    expect(measure.mock.lastCall?.[0]).toMatchObject({ text: pages.value[0]!.blocks[1]!.translation })
  })

  /*
   * The half that was wrong. Writing the whole map back made every reader of
   * any block's size run again for the one block that had moved — the board
   * drew all its lettering, the Lettering panel recomputed — and an export did
   * it for every page it fitted.
   */
  it('is heard only by what read the block that changed', () => {
    fitPage()

    const { fits, fitOf } = useLetteringFit()
    const { pages } = useComic()
    const map = fits.value
    let heard = 0

    const first = pages.value[0]!.blocks[0]!
    const scope = effectScope()

    scope.run(() => watchEffect(() => {
      fitOf(first)
      heard++
    }, { flush: 'sync' }))

    try {
      expect(heard).toBe(1)

      // Nothing changed: nothing written, nothing heard.
      fitPage()

      expect(fits.value).toBe(map)
      expect(heard).toBe(1)

      // Another block changed: its size is written where it lives, and the
      // reader of the first block hears nothing of it.
      pages.value[0]!.blocks[2]!.translation = `${fresh()} and then some more of it`
      fitPage()

      expect(fits.value).toBe(map)
      expect(fits.value.c).toBe(12 + pages.value[0]!.blocks[2]!.translation.length)
      expect(heard).toBe(1)
    } finally {
      scope.stop()
    }
  })

  it('forgets the blocks that are on no page', async () => {
    fitPage()

    const { fits } = useLetteringFit()
    const { pages } = useComic()

    expect(Object.keys(fits.value)).toEqual(expect.arrayContaining(['a', 'b', 'c']))

    // The page read again: new blocks, and the old ones gone from every page.
    pages.value[0]!.blocks = [block('d', fresh())]
    await nextTick()

    expect(fits.value).not.toHaveProperty('a')
    expect(fits.value).not.toHaveProperty('b')
    expect(fits.value).not.toHaveProperty('c')
  })

  it('keeps the blocks that are on another page', async () => {
    const { pages, styleOf } = useComic()

    pages.value = [
      ...pages.value,
      { id: 'scan:2.png', name: '2.png', blocks: [block('e', fresh())], scan: { ...scan, url: 'blob:2.png' } },
    ] as unknown as ComicPage[]
    await nextTick()

    useLetteringFit().refit(pages.value[1], styleOf, () => false)

    const { fits } = useLetteringFit()

    pages.value[0]!.blocks = [block('f', fresh())]
    await nextTick()

    expect(fits.value).toHaveProperty('e')
  })
})
