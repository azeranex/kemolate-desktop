import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import CanvasRegionBrush from '~/components/canvas/RegionBrush.vue'
import { useBrushCursor } from '~/composables/useBrushCursor'
import { useComic } from '~/composables/useComic'
import { usePaintSettings } from '~/composables/usePaintSettings'

/**
 * Where the region brush is, asked once a gesture — and asked again whenever the
 * page has moved under it.
 *
 * The brush maps the pointer through its surface's rectangle. It read that
 * rectangle twice on every move of a hover and three times on every move of a
 * stroke, and each first read after the ring had moved was a layout of the
 * page. So it reads it once a gesture now, the way the mask brush does, and
 * lets go of it when the view moves, the room changes or the page turns.
 *
 * The letting go is the half that matters. A reading kept too long is the bug
 * this brush was first written with: `shown` was a `computed` over the
 * rectangle, which nothing could ever invalidate, so after a window resize, a
 * dock column dragged or a panel opened the mark was laid at the scale the page
 * had when the tool was picked up.
 *
 * Seam: the brush as the sheet mounts it, and the DOM read itself — happy-dom
 * lays nothing out, so where the page is drawn is whatever the test says. The
 * errand a stroke is handed to is caught rather than run: the path it is handed
 * is where the mark was laid.
 */

const { runRegion } = vi.hoisted(() => ({
  runRegion: vi.fn<(pageId: string, region: { path: number[], radius: number }, mode: string) => Promise<void>>(
    () => Promise.resolve(),
  ),
}))

mockNuxtImport('useRegion', () => () => ({ runRegion }))

// Only the progress line is read from the reader, for the note under a stroke.
mockNuxtImport('useOcr', () => () => ({ progress: ref(null) }))

const scan = { url: 'blob:1.png', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'hash-1' }
const spread = { ...scan, url: 'blob:2.png', width: 2000, hash: 'hash-2' }

/** Where the page is drawn: at the top left of the window, half size to begin with. */
let drawn = new DOMRect(0, 0, 500, 750)

const reads = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => drawn)

const pointer = (type: string, x: number, y: number, button = 0) =>
  new PointerEvent(type, { clientX: x, clientY: y, button, pointerId: 1, bubbles: true })

async function mounted () {
  const { pages } = useComic()
  const wrapper = await mountSuspended(CanvasRegionBrush, { props: { page: pages.value[0]!, mode: 'read' } })

  return { wrapper, surface: wrapper.find('div').element }
}

beforeEach(() => {
  const comic = useComic()

  comic.reset()
  comic.pages.value = [
    { id: 'scan:1.png', name: '1.png', blocks: [], scan },
    { id: 'scan:2.png', name: '2.png', blocks: [], scan: spread },
  ] as unknown as ComicPage[]

  usePaintSettings().size.value = 28
  drawn = new DOMRect(0, 0, 500, 750)
  reads.mockClear()
  runRegion.mockClear()
})

afterAll(() => reads.mockRestore())

describe('the region brush, reading where it is', () => {
  it('reads it once, however far a hover goes', async () => {
    const { surface } = await mounted()

    reads.mockClear()

    for (let at = 0; at < 20; at++) surface.dispatchEvent(pointer('pointermove', 100 + at, 100 + at))

    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('reads it once a stroke, however long the stroke runs', async () => {
    const { surface } = await mounted()

    surface.dispatchEvent(pointer('pointermove', 100, 100))
    reads.mockClear()

    surface.dispatchEvent(pointer('pointerdown', 100, 100))

    for (let at = 1; at <= 20; at++) surface.dispatchEvent(pointer('pointermove', 100 + at * 4, 100))

    // The press reads it afresh; nothing after it does.
    expect(reads).toHaveBeenCalledTimes(1)

    surface.dispatchEvent(pointer('pointerup', 180, 100))
    await nextTick()

    expect(runRegion).toHaveBeenCalledTimes(1)
  })
})

describe('the region brush, when the page moves under it', () => {
  /**
   * The three ways the sheet moves without the brush being mounted again, each
   * followed by the page being drawn somewhere new: twice the size, and further
   * from the corner.
   */
  const moves: [string, (wrapper: Awaited<ReturnType<typeof mounted>>['wrapper']) => Promise<void>][] = [
    ['the view moves', async () => { useComic().zoom.value = 2 }],
    ['the room changes, as a window resized or a dock column dragged', async () => { useComic().room.value = { w: 1200, h: 900 } }],
    ['the page turns', async (wrapper) => { await wrapper.setProps({ page: useComic().pages.value[1]! }) }],
  ]

  it.each(moves)('places the ring by where the page is drawn now, once %s', async (_, move) => {
    const { wrapper, surface } = await mounted()
    const { at } = useBrushCursor()

    // 100 px into a 500 px wide drawing of a 1000 px scan: page pixel 200.
    surface.dispatchEvent(pointer('pointermove', 100, 100))
    expect(at.value?.x).toBeCloseTo(200)

    await move(wrapper)
    drawn = new DOMRect(50, 50, 1000, 1500)
    await nextTick()

    // 50 px into a drawing at the scan's own size, of whichever page is there.
    surface.dispatchEvent(pointer('pointermove', 100, 100))
    expect(at.value?.x).toBeCloseTo((50 / 1000) * (wrapper.props('page') as ComicPage).scan!.width)
    expect(at.value?.y).toBeCloseTo(50)
  })

  /**
   * A glide still carrying the page when the stroke begins — a key pressed and
   * the brush put straight down — moves the page under a stroke already in
   * flight. The rest of the stroke is laid where the page is drawn now.
   */
  it('lays the rest of a stroke by where the page is drawn now, when the view moves mid-stroke', async () => {
    const { surface } = await mounted()

    surface.dispatchEvent(pointer('pointerdown', 100, 100))
    surface.dispatchEvent(pointer('pointermove', 110, 100))

    useComic().zoom.value = 2
    drawn = new DOMRect(0, 0, 1000, 1500)
    await nextTick()

    surface.dispatchEvent(pointer('pointermove', 120, 100))
    surface.dispatchEvent(pointer('pointerup', 120, 100))
    await nextTick()

    expect(runRegion).toHaveBeenCalledWith('scan:1.png', { path: [200, 200, 220, 200, 120, 100], radius: 14 }, 'read')
  })

  /**
   * The bug as it was: the sizing drag measured against the page as it was
   * first drawn. A hover asks for the scale on every move, so it has been
   * asked — and would have been kept — before the room changes.
   */
  it('sizes the brush against the page as drawn now, after the room has changed', async () => {
    const { surface } = await mounted()
    const { size } = usePaintSettings()

    surface.dispatchEvent(pointer('pointermove', 100, 100))

    useComic().room.value = { w: 1200, h: 900 }
    drawn = new DOMRect(0, 0, 1000, 1500)
    await nextTick()

    // The right button, dragged thirty screen pixels across: thirty page
    // pixels of diameter at this size, where the old drawing made it sixty.
    surface.dispatchEvent(pointer('pointerdown', 100, 100, 2))
    surface.dispatchEvent(pointer('pointermove', 130, 100, 2))
    surface.dispatchEvent(pointer('pointerup', 130, 100, 2))

    expect(size.value).toBe(58)
  })
})
