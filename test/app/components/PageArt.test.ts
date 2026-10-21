import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import PageArt from '~/components/canvas/PageArt.vue'
import { useComic } from '~/composables/useComic'

/**
 * A page is measured by its own scan, never by the one it replaced.
 *
 * The report: now and then a page came up with grey down its sides, its
 * lettering off the balloons and its repairs off the art. The page was being
 * drawn at another page's proportions. Opening a chapter lands on page one
 * and turns to the page it was left on; the scan's element is made anew for
 * each page, and page one's, still loading when it was replaced, finished
 * anyway — and measured the page now on screen with page one's size.
 *
 * Seam: the component as the canvas mounts it, the page turned under it, and
 * the old element's `load` arriving late.
 */

const scan = (name: string, width: number, height: number) => ({
  url: `blob:${name}`,
  file: new File([], name),
  width,
  height,
  hash: `hash-${name}`,
})

describe('measuring a page from its scan', () => {
  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [
      { id: 'scan:1.png', name: '1.png', blocks: [], scan: scan('1.png', 2874, 4041) },
      { id: 'scan:11.png', name: '11.png', blocks: [], scan: scan('11.png', 2681, 4047) },
    ] as unknown as ComicPage[]
  })

  it('ignores the late load of the page it was showing before', async () => {
    const { pages } = useComic()
    const wrapper = await mountSuspended(PageArt, { props: { page: pages.value[0]! } })
    const stale = wrapper.find('img[alt="1.png"]').element as HTMLImageElement

    Object.defineProperty(stale, 'naturalWidth', { value: 2874 })
    Object.defineProperty(stale, 'naturalHeight', { value: 4041 })

    await wrapper.setProps({ page: pages.value[1]! })

    // Page one's scan finishes decoding only now, its element already gone.
    stale.dispatchEvent(new Event('load'))

    expect(pages.value[1]!.scan).toMatchObject({ width: 2681, height: 4047 })
  })

  it('still measures a page from its own scan', async () => {
    const { pages } = useComic()

    pages.value[1]!.scan!.width = 0
    pages.value[1]!.scan!.height = 0

    const wrapper = await mountSuspended(PageArt, { props: { page: pages.value[1]! } })
    const own = wrapper.find('img[alt="11.png"]').element as HTMLImageElement

    Object.defineProperty(own, 'naturalWidth', { value: 2681 })
    Object.defineProperty(own, 'naturalHeight', { value: 4047 })

    own.dispatchEvent(new Event('load'))

    expect(pages.value[1]!.scan).toMatchObject({ width: 2681, height: 4047 })
  })

  /**
   * And a size once known is never changed. What made the late load lasting
   * rather than a flicker: the page's frames had been read at the wrong size,
   * the right one then replaced it, and the translation sync saved every frame
   * converted at the new size — 7% down the page, with nobody touching it.
   */
  it('keeps the size a page already has, whatever a load says later', () => {
    const { pages, measure } = useComic()

    measure('scan:11.png', 2874, 4041)

    expect(pages.value[1]!.scan).toMatchObject({ width: 2681, height: 4047 })
  })
})

/**
 * The Pages strip waits for the page on screen, and never shows a scan.
 *
 * The report: the first flick through a freshly opened chapter had a frame of
 * 125–135 ms with the strip open, and none over 9 ms with it closed. Every
 * tile drew its page's whole scan until a thumbnail existed, and did it beside
 * the page being read. A tile now shows its thumbnail, once the page on screen
 * has been shown, and a placeholder until then.
 *
 * Seam: the tile as the strip mounts it; `page-shown-in` is what the page on
 * screen sets when it is drawn, and `page-thumbs` what the thumbnail queue fills.
 */
describe('a tile in the Pages strip', () => {
  beforeEach(() => {
    const comic = useComic()

    comic.reset()
    comic.pages.value = [
      { id: 'scan:1.png', name: '1.png', blocks: [], scan: scan('1.png', 2874, 4041) },
    ] as unknown as ComicPage[]

    useState('page-thumbs').value = {}
    useState('page-shown-in').value = -1
  })

  it('shows a placeholder, not the scan, until the page on screen has been shown', async () => {
    const { pages } = useComic()

    useState<Record<string, string>>('page-thumbs').value = { 'hash-1.png': 'blob:thumb-1' }

    const wrapper = await mountSuspended(PageArt, { props: { page: pages.value[0]!, preview: true } })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)

    useState('page-shown-in').value = useComic().epoch.value
    await nextTick()

    expect(wrapper.find('img').attributes('src')).toBe('blob:thumb-1')
  })

  it('never falls back to the scan while its thumbnail is being made', async () => {
    const { pages } = useComic()

    useState('page-shown-in').value = useComic().epoch.value

    const wrapper = await mountSuspended(PageArt, { props: { page: pages.value[0]!, preview: true } })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
  })
})
