import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'

import CanvasBoard from '~/components/canvas/Board.vue'
import CanvasSheet from '~/components/canvas/Sheet.vue'
import { useComic } from '~/composables/useComic'

/**
 * What a pan or a zoom costs the page.
 *
 * The stage's transform used to be written by the same render as every block's
 * lettering, repair and hit area, so every frame of a pan, a zoom or a glide
 * ran all of it again. Measured on the test chapter: 90 board renders for 90
 * frames of pan, each redoing every block. The page's contents are
 * `CanvasSheet` now, and nothing it is handed changes with the view — which is
 * the rule these hold, because it is the easy one to break: one prop worked out
 * from the pan, or one built afresh per render, brings the per-frame render
 * straight back.
 *
 * Seam: the board as the workspace mounts it, on a page with no scan here —
 * the lettering and the hit areas are drawn all the same, and nothing needs
 * decoding. The room is given rather than measured; happy-dom lays nothing out.
 */

mockNuxtImport('useElementSize', () => () => ({ width: ref(800), height: ref(600) }))

const block = (id: string, x: number): Block => ({
  id,
  type: 'bubble',
  x,
  y: 20,
  w: 10,
  h: 8,
  source: `line ${id}`,
  translation: '',
  confidence: 100,
  hidden: false,
})

/** Counts the renders of a mounted component from outside it. */
function counted (instance: { render?: (...args: unknown[]) => unknown }) {
  const render = instance.render!
  const tally = { renders: 0 }

  instance.render = function (this: unknown, ...args: unknown[]) {
    tally.renders++

    return render.apply(this, args)
  }

  return tally
}

describe('the view moving', () => {
  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [block('a', 10), block('b', 40), block('c', 70)],
      size: { width: 1000, height: 1500 },
    }] as unknown as ComicPage[]
    comic.at.value = 0
    comic.zoom.value = 1
    comic.pan.value = { x: 0, y: 0 }
  })

  it('leaves the page\'s contents alone, and moves the chrome with one transform', async () => {
    const wrapper = await mountSuspended(CanvasBoard)
    const sheet = wrapper.findComponent(CanvasSheet)

    expect(sheet.exists()).toBe(true)
    expect(wrapper.findAll('[data-block]')).toHaveLength(3)

    const tally = counted(sheet.vm.$ as never)
    const { zoom, pan, select } = useComic()

    // Something picked, so there is chrome to move — and a number label for
    // the picked block alone. Every block's used to be rendered, shown or not,
    // and placed again on every frame of a zoom.
    select('b')
    await nextTick()
    tally.renders = 0

    expect(wrapper.findAll('span.border-current').map((badge) => badge.text())).toEqual(['2'])

    for (let step = 1; step <= 10; step++) {
      zoom.value = 1 + step / 4
      pan.value = { x: -30 * step, y: -20 * step }
      await nextTick()
    }

    expect(tally.renders).toBe(0)

    // The chrome went with the pan by its container, not by being placed again
    // — wherever the bounds let the pan land.
    const chrome = wrapper.find('div.pointer-events-none.absolute.inset-0[style*="translate"]')

    expect(chrome.attributes('style')).toContain(`translate(${pan.value.x}px, ${pan.value.y}px)`)
  })
})
