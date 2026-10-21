import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computed, nextTick } from 'vue'

import type { ComicPage } from '~/composables/useComic'

import { pageSize, sized, useComic } from '~/composables/useComic'
import { toBlocks, toPatch } from '~/utils/ocr/blocks'

/**
 * Measuring a page before its stored boxes are converted.
 *
 * **Needs the nuxt project** for `useComic`'s module.
 *
 * The failure this guards cost a chapter every box it had. A block is stored
 * normalised by the page's width on both axes and drawn as percentages of the
 * page box, so converting between the two needs the page's shape — and on a
 * page whose picture had not been drawn, with no size recorded for it, the
 * shape was the guessed 2:3. The boxes came out too high; once the page was
 * measured the next save sent every one of them back converted with the real
 * shape, shrinking vertical position and height by (2/3) / aspect. Every
 * refresh repeated it: 195 boxes on 38 pages, one of them shrunk six times.
 *
 * `sized` is the fix, and these pin it at the seam where it matters — the
 * round trip a stored box makes through the canvas. Revert `sized` to plain
 * `pageSize` and the measuring tests and the round trip fail together.
 */

/**
 * A PNG that is nothing but its header — all `imageDimensions` reads, and a
 * size chosen to be this chapter's own pages rather than a round number, so
 * the drift ratio below is the one that was measured on them.
 */
function pngHeader (width: number, height: number): Blob {
  const bytes = new Uint8Array(33)
  const view = new DataView(bytes.buffer)

  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)

  return new Blob([bytes], { type: 'image/png' })
}

/** A page opened off a folder but not yet drawn: a file, and no size. */
function undrawn (file: Blob): ComicPage {
  return {
    id: 'scan:002.jpg',
    name: '002.jpg',
    blocks: [],
    scan: { file, url: 'blob:test', width: 0, height: 0 },
  } as unknown as ComicPage
}

/** One stored block, as the server hands it back. */
const stored = {
  id: 1,
  kind: 'bubble',
  cx: 0.1394,
  cy: 0.3988,
  w: 0.0824,
  h: 0.105,
  angle: 0,
  skewX: 0,
  skewY: 0,
  quad: null,
  source: '에휴..차도막히고',
  confidence: 1,
  hidden: false,
  position: 0,
  parentId: null,
  translations: [],
} as unknown as Parameters<typeof toBlocks>[0][number]

describe('sized', () => {
  it('measures a scan nobody has drawn, before anything converts its boxes', async () => {
    const page = undrawn(pngHeader(2209, 3106))

    expect(await sized(page)).toEqual({ width: 2209, height: 3106 })
    expect(page.scan).toMatchObject({ width: 2209, height: 3106 })
  })

  it('leaves a size something else already measured alone', async () => {
    const page = undrawn(new Blob(['not read']))

    Object.assign(page.scan!, { width: 1000, height: 1500 })

    expect(await sized(page)).toEqual({ width: 1000, height: 1500 })
  })

  it('keeps the recorded size for a page whose picture is not here', async () => {
    const page = { id: 'page:x', name: 'x', blocks: [], size: { width: 2209, height: 3106 } } as unknown as ComicPage

    expect(await sized(page)).toEqual({ width: 2209, height: 3106 })
  })

  it('answers nought rather than a guess for a header it cannot read', async () => {
    expect(await sized(undrawn(new Blob(['not an image at all'])))).toEqual({ width: 0, height: 0 })
  })
})

describe('a stored box through the canvas and back', () => {
  it('comes back unchanged when built with the size `sized` measured', async () => {
    // Built with whatever `sized` answers, saved with the scan's real size —
    // which is what `useBlockSync` does, since it only ever sends once the page
    // is measured. Saving with `size` as well would make the round trip cancel
    // out even at the guessed shape, and pass with the fix reverted.
    const size = await sized(undrawn(pngHeader(2209, 3106)))
    const patch = toPatch(toBlocks([stored], size)[0]!, { width: 2209, height: 3106 })

    expect(patch.cy).toBeCloseTo(0.3988, 9)
    expect(patch.h).toBeCloseTo(0.105, 9)
    expect(patch.cx).toBeCloseTo(0.1394, 9)
  })

  it('shrank by (2/3) / aspect when it was converted before the page was measured', () => {
    // The incident, stated as arithmetic so the number in `sized`'s header has
    // a test behind it: built at the guessed shape, saved at the real one.
    const patch = toPatch(toBlocks([stored], { width: 0, height: 0 })[0]!, { width: 2209, height: 3106 })

    expect(patch.cy / 0.3988).toBeCloseTo((2 / 3) / (2209 / 3106), 6)
    expect(patch.cy / 0.3988).toBeCloseTo(0.9374, 4)
  })
})

/**
 * A size measured in the background has to reach what already read it.
 *
 * The report: on page 7 of Business trip grooming 2 the lettering came out in
 * the interface font at 14px — every style missing — until something unrelated
 * redrew the page. `openImages` measures the pages after the first in the
 * background, and wrote each size onto the page objects as they were *before*
 * Vue held them. Anything that had already read the page's size — the board's
 * `dims`, and through it every lettering style — was never told, and when the
 * drawn image later reported the same size through Vue, an unchanged value
 * told it nothing either. So a page turned to before its header was read kept
 * a size of nought for as long as it stayed open.
 */
describe('a page measured behind the paint', () => {
  const platform = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL }

  let issued = 0

  beforeAll(() => {
    // happy-dom hands out object URLs only for its own `Blob` — see the pages test.
    URL.createObjectURL = () => `blob:sized/${issued++}`
    URL.revokeObjectURL = () => {}
  })

  afterAll(() => {
    URL.createObjectURL = platform.createObjectURL
    URL.revokeObjectURL = platform.revokeObjectURL
  })

  it('tells what already read its size once the size is known', async () => {
    const comic = useComic()

    comic.reset()

    await comic.openImages([
      { path: '001.png', file: new File([pngHeader(1000, 1500)], '001.png', { type: 'image/png' }) },
      { path: '002.png', file: new File([pngHeader(2209, 3106)], '002.png', { type: 'image/png' }) },
    ])

    // Read before the background measure has got to it, as the board does
    // when the reader turns to the page straight away.
    const tall = computed(() => pageSize(comic.pages.value[1]!).height)

    expect(tall.value).toBe(0)

    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await nextTick()
    }

    expect(tall.value).toBe(3106)
  })
})
