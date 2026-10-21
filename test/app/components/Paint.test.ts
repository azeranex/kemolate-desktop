import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import CanvasPaint from '~/components/canvas/Paint.vue'
import { useComic } from '~/composables/useComic'
import { usePaintCache } from '~/composables/usePaintCache'
import { surfaceKey, takeDirty } from '~/utils/raster/engine/surfaces'

/**
 * A paint surface holds the page's pixels only while it has something to hold.
 *
 * The report: memory on a chapter of 3732 × 5197 pages. Every page mounts a
 * paint canvas for the clean plate and one per blank sheet, each the scan's
 * size — 78 MB — with a second copy kept beside it, on pages nobody ever
 * retouched. Now a surface with no marks, no brush out over it and nobody
 * drawing on it is a canvas of no size, and takes its pixels when one of those
 * changes.
 *
 * Seam: the component as the board mounts it, on a local page with no strokes.
 * happy-dom's canvas has no 2D context, so a stand-in one is enough to let the
 * session be made; what is asserted is the canvas's own size.
 */

const platform = { getContext: HTMLCanvasElement.prototype.getContext }

/** Every surface mounted, unmounted after each test: they share one page and one surface name, and a stroke in one test wakes the others. */
let mounted: { unmount: () => void }[] = []

const mount = async (props: Record<string, unknown>) => {
  const wrapper = await mountSuspended(CanvasPaint, { props: props as never })

  mounted.push(wrapper)

  return wrapper
}

describe('a paint surface', () => {
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return new Proxy({}, { get: (_, name) => (name === 'canvas' ? this : () => ({ data: new Uint8ClampedArray(4) })) })
    } as unknown as typeof platform.getContext

    const comic = useComic()

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [],
      scan: { url: 'blob:1.png', file: new File([], '1.png'), width: 3732, height: 5197, hash: 'h1' },
    }] as unknown as ComicPage[]
  })

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()
    mounted = []
    HTMLCanvasElement.prototype.getContext = platform.getContext
  })

  it('has no pixels while it has nothing to show', async () => {
    const { pages } = useComic()
    const wrapper = await mount({ page: pages.value[0]!, active: false })
    const canvas = wrapper.find('canvas').element as HTMLCanvasElement

    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('takes the page\'s size when a brush is put over it, and gives it back after', async () => {
    const { pages } = useComic()
    const wrapper = await mount({ page: pages.value[0]!, active: false })
    const canvas = wrapper.find('canvas').element as HTMLCanvasElement

    await wrapper.setProps({ active: true })

    expect([canvas.width, canvas.height]).toEqual([3732, 5197])

    await wrapper.setProps({ active: false })

    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  /*
   * The first mark on a bare surface is already on the canvas when the button
   * comes up, like any other. It used to be replayed from scratch instead —
   * the shortcut asked for a page-sized copy of the pixels, which a bare
   * surface did not have — and the whole surface marked changed, which the
   * engine answers by uploading all 78 MB of it for a stroke a few hundred
   * pixels long.
   */
  it('tells the engine only where the first stroke went, not the whole page', async () => {
    const { pages } = useComic()
    const wrapper = await mount({ page: pages.value[0]!, active: true })
    const key = surfaceKey('scan:1.png', 'bg')

    await flushPromises()

    const hit = wrapper.find('div').element as HTMLElement

    hit.getBoundingClientRect = () => ({ left: 0, top: 0, width: 3732, height: 5197, right: 3732, bottom: 5197, x: 0, y: 0, toJSON: () => ({}) })

    const press = (type: string, x: number) => hit.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: 1000, pointerId: 1 }))

    takeDirty(key)
    press('pointerdown', 1000)
    press('pointermove', 1100)
    press('pointermove', 1200)
    takeDirty(key)
    press('pointerup', 1200)
    await flushPromises()

    const after = takeDirty(key)

    expect(after === null || after.w * after.h < 3732 * 5197).toBe(true)
  })

  /*
   * Somebody else's stroke landing while this hand is down. Laying a row back
   * down opens and closes a stroke on the same session as the one being drawn,
   * so the arriving row used to end this hand's stroke — and a stroke ended
   * that way comes up empty and is never saved. The redraw now waits for the
   * hand to lift.
   */
  it('keeps this hand\'s stroke when a collaborator\'s lands in the middle of it', async () => {
    const { pages } = useComic()
    const paint = usePaintCache()
    const wrapper = await mount({ page: pages.value[0]!, active: true })

    await flushPromises()

    const hit = wrapper.find('div').element as HTMLElement

    hit.getBoundingClientRect = () => ({ left: 0, top: 0, width: 3732, height: 5197, right: 3732, bottom: 5197, x: 0, y: 0, toJSON: () => ({}) })

    const press = (type: string, y: number) => hit.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 2000, clientY: y, pointerId: 1 }))
    const rows = () => (paint.strokes.value['h1:bg'] ?? []).filter((row) => !row.retracted)
    const mine = rows().filter((row) => row.clientId !== 'peer').length

    press('pointerdown', 2000)
    press('pointermove', 2100)

    paint.add('h1:bg', { tool: 'brush', composite: null, params: { size: 20, colour: '#ff0000' }, points: [100, 100, 300, 300], seq: 1, clientId: 'peer' } as never)
    await flushPromises()

    press('pointermove', 2200)
    press('pointerup', 2200)
    await flushPromises()

    expect(rows().filter((row) => row.clientId !== 'peer').length).toBe(mine + 1)
    expect(rows().some((row) => row.clientId === 'peer')).toBe(true)
  })
})
