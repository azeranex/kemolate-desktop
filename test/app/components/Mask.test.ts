import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import CanvasMask from '~/components/canvas/Mask.vue'
import { useComic } from '~/composables/useComic'
import { useMaskEdits } from '~/composables/useMaskEdits'

/**
 * The mask plate, hidden — which is where it nearly always is.
 *
 * It stays mounted while hidden, for the collaborator strokes it listens for,
 * and its redraw was keyed on every block's box and on every correction on the
 * page written out as JSON. The key was worked out whatever the plate was
 * doing, so every frame of a block being dragged spelled out every point of
 * every correction on the page, for a plate that then drew nothing.
 *
 * Seam: the component as the sheet mounts it, and the page's corrections in
 * `useMaskEdits`' state — made of a getter here, so a read of them is counted.
 */

const block = (id: string): Block => ({
  id,
  type: 'bubble',
  x: 10,
  y: 10,
  w: 20,
  h: 10,
  source: id,
  translation: '',
  confidence: 100,
  hidden: false,
})

const scan = { url: 'blob:1.png', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'hash-1' }

describe('a hidden mask plate', () => {
  let reads = 0

  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [
      { id: 'scan:1.png', name: '1.png', blocks: [block('a')], scan },
    ] as unknown as ComicPage[]

    reads = 0
    useMaskEdits().edits.value = {
      'scan:1.png': {
        get a () {
          reads++

          return [{ kind: 'add' as const, seq: 1, points: [1, 2, 3, 4], size: 12, hardness: 1 }]
        },
      },
    }
  })

  it('reads nothing of the page while a block is dragged', async () => {
    const { pages } = useComic()
    const page = pages.value[0]!

    await mountSuspended(CanvasMask, { props: { page, shown: false } })
    await nextTick()

    reads = 0

    for (const x of [12, 14, 16, 18, 20]) {
      page.blocks[0]!.x = x
      await nextTick()
    }

    expect(reads).toBe(0)
  })
})
