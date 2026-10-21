import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import CanvasMaskBrush from '~/components/canvas/MaskBrush.vue'
import { useBrushCursor } from '~/composables/useBrushCursor'
import { useComic } from '~/composables/useComic'

/**
 * Where the mask brush is, asked once a gesture rather than once a move.
 *
 * The brush maps the pointer through its surface's rectangle, and it read that
 * rectangle twice on every move of a hover — once for the ring, once for a size
 * gesture whether one was running or not — and three times on a stroke. Each
 * first read after the previous move had written the ring was a layout of the
 * page. The rectangle only moves when the view does, so it is read once and
 * let go of when the view moves.
 *
 * Seam: the component as the sheet mounts it, and the DOM read itself.
 */

const scan = { url: 'blob:1.png', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'hash-1' }

const move = (at: number) => new PointerEvent('pointermove', { clientX: 100 + at, clientY: 100 + at, bubbles: true })

describe('the mask brush, hovering', () => {
  // happy-dom lays nothing out, and a surface of no size is not one to keep.
  const reads = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, 0, 500, 750))

  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [{ id: 'scan:1.png', name: '1.png', blocks: [], scan }] as unknown as ComicPage[]
    reads.mockClear()
  })

  afterAll(() => reads.mockRestore())

  it('reads where it is once, however far the pointer goes', async () => {
    const { pages } = useComic()
    const wrapper = await mountSuspended(CanvasMaskBrush, { props: { page: pages.value[0]! } })
    const surface = wrapper.find('div').element

    reads.mockClear()

    for (let at = 0; at < 20; at++) surface.dispatchEvent(move(at))

    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('reads again once the view has moved under it', async () => {
    const { pages, zoom } = useComic()
    const wrapper = await mountSuspended(CanvasMaskBrush, { props: { page: pages.value[0]! } })
    const surface = wrapper.find('div').element

    surface.dispatchEvent(move(0))
    reads.mockClear()

    zoom.value = 2
    await nextTick()

    surface.dispatchEvent(move(1))
    surface.dispatchEvent(move(2))

    expect(reads).toHaveBeenCalledTimes(1)
  })

  // A page turned from the keyboard moves nothing the view watches, and the
  // pointer never leaves — but a page of another shape lays the sheet out anew.
  it('reads again once the page has turned under it', async () => {
    const { pages } = useComic()
    const spread = { id: 'scan:2.png', name: '2.png', blocks: [], scan: { ...scan, url: 'blob:2.png', width: 2000, hash: 'hash-2' } }

    pages.value = [...pages.value, spread] as unknown as ComicPage[]

    const wrapper = await mountSuspended(CanvasMaskBrush, { props: { page: pages.value[0]! } })
    const surface = wrapper.find('div').element

    surface.dispatchEvent(move(0))
    reads.mockClear()

    await wrapper.setProps({ page: pages.value[1]! })

    surface.dispatchEvent(move(1))
    surface.dispatchEvent(move(2))

    expect(reads).toHaveBeenCalledTimes(1)
  })
})

/**
 * A hover writes nothing to Nuxt's payload.
 *
 * The rectangle above turned out to cost fifteen microseconds a move. What cost
 * the frame was the ring: its position was a `useState`, and in development
 * Nuxt DevTools re-reads the whole payload — every page, every block, every
 * point of every mask correction — after any write to it. So each move of a
 * hover paid for the chapter, and more the longer the mask had been worked on.
 * See `useBrushCursor`, where the position now lives outside it.
 *
 * Seam: the brush as the sheet mounts it, and a deep watcher on the payload
 * standing in for DevTools' own.
 */
describe('the mask brush, hovering, and the payload', () => {
  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [{ id: 'scan:1.png', name: '1.png', blocks: [], scan }] as unknown as ComicPage[]
  })

  /*
   * Desktop: the web build's test also watched Nuxt's payload, which every move
   * once wrote to and DevTools walked. There is no payload here; what is left
   * is that the ring follows.
   */
  it('moves the ring with the pointer', async () => {
    const reads = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(0, 0, 500, 750))

    const { pages } = useComic()
    const wrapper = await mountSuspended(CanvasMaskBrush, { props: { page: pages.value[0]! } })
    const surface = wrapper.find('div').element
    for (let at = 0; at < 20; at++) {
      surface.dispatchEvent(move(at))
      await nextTick()
    }

    reads.mockRestore()

    // The ring followed: the last move, 119 px into a 500 × 750 surface
    // over a 1000 × 1500 scan, is page pixel 238 on both axes.
    const ring = useBrushCursor().at.value

    expect(ring?.x).toBeCloseTo(238)
    expect(ring?.y).toBeCloseTo(238)
  })
})
