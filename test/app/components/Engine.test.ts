import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRow } from '~/utils/raster/engine/run'
import type { ScanView } from '~/utils/raster/plan'

import CanvasEngine from '~/components/canvas/Engine.vue'
import { usePatchMap } from '~/composables/useClean'
import { useComic } from '~/composables/useComic'
import { keepFits } from '~/utils/raster/held'

/**
 * The page canvas draws its own scan, measures its own scan, and says so only
 * once it has.
 *
 * The page used to be an `<img>`, and the rules below were learned on it: a
 * page turned to must never be measured by the scan it replaced (grey down the
 * sides, every balloon off its mark, and the frames saved there), and must
 * never show the page it replaced while its own decodes. The canvas that took
 * its place gets its pixels from a worker, answers arrive late in exactly the
 * same way, and the rules have to hold again.
 *
 * Seam: the component as the board mounts it, with the decoder mocked at its
 * module boundary — each request a promise the test settles by hand.
 */

type Pending<T> = { key: string, resolve: (value: T) => void }

const asked = await vi.hoisted(async () => ({
  sizes: [] as Pending<{ width: number, height: number }>[],
  levels: [] as Pending<{ width: number, height: number, bitmap: unknown }>[],
  /** Repairs and pictures, decoded when the test says so. */
  pictures: new Map<string, unknown>(),
  decoding: [] as Pending<unknown>[],
}))

vi.mock('~/utils/raster/engine/pictures', () => ({
  keepPictures: () => {},
  pictureAt: (url: string) => asked.pictures.get(url),
  wantPicture: (url: string) => new Promise((resolve) => asked.decoding.push({
    key: url,
    resolve: (bitmap: unknown) => {
      asked.pictures.set(url, bitmap)
      resolve(bitmap)
    },
  })),
}))

vi.mock('~/utils/raster/decoder', () => ({
  Cancelled: class extends Error {},
  cancelScan: () => {},
  releaseScan: () => {},
  scanTile: () => new Promise(() => {}),
  scanSize: (key: string) => new Promise((resolve) => asked.sizes.push({ key, resolve })),
  scanLevel: (key: string) => new Promise((resolve) => asked.levels.push({ key, resolve })),
}))

const bitmap = (width: number, height: number) => ({ width, height, close: () => {} })

const scan = (name: string, width: number, height: number) => ({
  url: `blob:${name}`,
  file: new File([], name),
  width,
  height,
  hash: `hash-${name}`,
})

const VIEW: ScanView = { x: 0, y: 0, w: 400, h: 560, sheet: { w: 400, h: 560 }, zoom: 1, crisp: false }

/** happy-dom's canvas has no 2D context; one that records what is drawn is enough here. */
const platform = { getContext: HTMLCanvasElement.prototype.getContext }
const drawn: { canvas: HTMLCanvasElement, image: unknown }[] = []

/** What was drawn onto one component's canvas — earlier tests' components are still mounted. */
const drawnOn = (wrapper: { find: (selector: string) => { element: Element } }) => drawn
  .filter((one) => one.canvas === wrapper.find('canvas').element)
  .map((one) => one.image)

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Mounted, and unmounted after the test. A component left mounted keeps asking
 * for the same scans as the next test's, and a request settled by the test
 * could be its rather than the one under test.
 */
const mounted: { unmount: () => void }[] = []

async function mount (props: InstanceType<typeof CanvasEngine>['$props']) {
  const wrapper = await mountSuspended(CanvasEngine, { props })

  mounted.push(wrapper)

  return wrapper
}

describe('drawing a page from its scan', () => {
  beforeEach(() => {
    asked.sizes.length = 0
    asked.levels.length = 0
    asked.pictures.clear()
    asked.decoding.length = 0
    drawn.length = 0
    // The engine's pictures outlive a mount, as they must between page turns —
    // so between tests they are let go of by hand.
    keepFits(new Set())

    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return {
        setTransform: () => {},
        clearRect: () => {},
        drawImage: (image: unknown) => drawn.push({ canvas: this, image }),
        canvas: this,
      }
    } as unknown as typeof platform.getContext

    const comic = useComic()

    comic.reset()
    comic.room.value = { w: 448, h: 608 }
    comic.pages.value = [
      { id: 'scan:1.png', name: '1.png', blocks: [], scan: scan('1.png', 0, 0) },
      { id: 'scan:11.png', name: '11.png', blocks: [], scan: scan('11.png', 0, 0) },
    ] as unknown as ComicPage[]
  })

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    HTMLCanvasElement.prototype.getContext = platform.getContext
  })

  it('ignores a size that arrives for the page it was showing before', async () => {
    const { pages } = useComic()
    const wrapper = await mount({ page: pages.value[0]!, view: VIEW })

    await wrapper.setProps({ page: pages.value[1]! })

    // Page one's decode finishes only now, the canvas already on page eleven.
    asked.sizes.find((one) => one.key === 'blob:1.png')!.resolve({ width: 2874, height: 4041 })
    await wait()

    expect(pages.value[1]!.scan).toMatchObject({ width: 0, height: 0 })
  })

  it('still measures a page from its own scan', async () => {
    const { pages } = useComic()

    await mount({ page: pages.value[1]!, view: VIEW })

    asked.sizes.find((one) => one.key === 'blob:11.png')!.resolve({ width: 2681, height: 4047 })
    await wait()

    expect(pages.value[1]!.scan).toMatchObject({ width: 2681, height: 4047 })
  })

  it('keeps the size a page already has, whatever a decode says later', async () => {
    const { pages } = useComic()

    pages.value[1]!.scan!.width = 2681
    pages.value[1]!.scan!.height = 4047

    await mount({ page: pages.value[1]!, view: VIEW })

    // A page with a known size is never measured at all.
    expect(asked.sizes).toHaveLength(0)
    expect(pages.value[1]!.scan).toMatchObject({ width: 2681, height: 4047 })
  })

  /**
   * The stand-in — the page's thumbnail — shows until this says the page is
   * drawn. Said too early, the reader sees an empty box; said on another
   * page's picture, the reader sees the wrong page.
   */
  it('says it has drawn only once its own page is on the canvas', async () => {
    const { pages } = useComic()

    pages.value[1]!.scan!.width = 2681
    pages.value[1]!.scan!.height = 4047

    const wrapper = await mount({ page: pages.value[1]!, view: VIEW })

    expect(wrapper.emitted('drawn')).toBeUndefined()

    const level = asked.levels.find((one) => one.key === 'blob:11.png')!
    const picture = bitmap(400, 604)

    level.resolve({ width: 2681, height: 4047, bitmap: picture })

    // Drawn on the next frame, with the picture that was asked for.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await wait()

    expect(wrapper.emitted('drawn')).toHaveLength(1)
    expect(drawnOn(wrapper)).toContain(picture)
  })

  /**
   * The report: every page turn showed the printed lettering first and the
   * cleaned balloons a moment later. A page with repairs is shown only once
   * its scan and every repair are in hand — and then all of it at once.
   */
  describe('with repairs over it', () => {
    const ROWS: RunRow[] = [
      { key: 'art', kind: 'art', visible: true, opacity: 1, adjust: [] },
      { key: 'clean', kind: 'clean', visible: true, opacity: 1, adjust: [] },
    ]

    /** Long enough for anything the engine would draw to have been drawn. */
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        await wait()
      }
    }

    beforeEach(() => {
      const { pages } = useComic()
      const page = pages.value[1]!

      page.scan!.width = 2681
      page.scan!.height = 4047
      page.blocks = [{ id: 'block:1' }] as unknown as ComicPage['blocks']

      usePatchMap().value = {
        [page.id]: { 'block:1': { url: 'blob:repair', x: 10, y: 10, w: 5, h: 5, from: { x: 0, y: 0, w: 1, h: 1 }, scan: 'hash-11.png' } },
      } as unknown as ReturnType<typeof usePatchMap>['value']
    })

    it('is not shown while a repair is still decoding, and is shown whole once it is', async () => {
      const { pages } = useComic()
      const wrapper = await mount({ page: pages.value[1]!, view: VIEW, rows: ROWS })
      const scanPicture = bitmap(400, 604)
      const repairPicture = bitmap(134, 202)

      asked.levels.find((one) => one.key === 'blob:11.png')!.resolve({ width: 2681, height: 4047, bitmap: scanPicture })
      await settle()

      // The scan alone would be the printed lettering: nothing yet.
      expect(wrapper.emitted('drawn')).toBeUndefined()
      expect(drawnOn(wrapper)).not.toContain(scanPicture)

      asked.decoding.find((one) => one.key === 'blob:repair')!.resolve(repairPicture)
      await settle()

      expect(wrapper.emitted('drawn')).toHaveLength(1)
      expect(drawnOn(wrapper)).toContain(scanPicture)
      expect(drawnOn(wrapper)).toContain(repairPicture)
    })

    it('is shown with what it has once the wait is up, rather than kept blank', async () => {
      const { pages } = useComic()
      const wrapper = await mount({ page: pages.value[1]!, view: VIEW, rows: ROWS })
      const scanPicture = bitmap(400, 604)

      asked.levels.find((one) => one.key === 'blob:11.png')!.resolve({ width: 2681, height: 4047, bitmap: scanPicture })

      // The repair never decodes.
      await new Promise((resolve) => setTimeout(resolve, 450))
      await settle()

      expect(wrapper.emitted('drawn')).toHaveLength(1)
      expect(drawnOn(wrapper)).toContain(scanPicture)
    })
  })
})
