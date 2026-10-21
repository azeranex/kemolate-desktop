import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, watch } from 'vue'

import { useComic } from '~/composables/useComic'
import { useThumbs } from '~/composables/useThumbs'

/**
 * A thumbnail is made for a page that comes back, even when its first making
 * was thrown away.
 *
 * The report: switch chapters while the Pages panel is still filling in, come
 * back, and one page stays blank for the rest of the session. The queue marks
 * a hash as dealt with *before* it waits for the picture, and when the chapter
 * has gone by the time the picture arrives the picture is dropped — rightly,
 * an object URL nobody can reach is a leak — but the mark stayed. The page is
 * then "dealt with" and never asked about again.
 *
 * Seam: `useThumbs` over `useComic`'s pages, with the thumbnail maker held
 * open so the chapter can close in the middle of a making.
 */
const { made, instant } = vi.hoisted(() => ({
  made: [] as { hash: string, release: () => void }[],
  /** Answer at once, as a thumbnail already on disk does. */
  instant: { on: false },
}))

vi.mock('~/utils/thumbs', () => ({
  thumbFor: (hash: string) => new Promise<Blob>((resolve) => {
    const release = () => resolve(new Blob([`thumb ${hash}`], { type: 'image/webp' }))

    made.push({ hash, release })

    if (instant.on) release()
  }),
}))

vi.mock('~/utils/resources', async (original) => ({
  ...await original<typeof import('~/utils/resources')>(),
  backgroundDecoders: () => 3,
}))

mockNuxtImport('useWorkspaces', () => () => ({ cover: async () => {} }))

const page = (hash: string) => ({
  id: `scan:${hash}.png`,
  name: `${hash}.png`,
  blocks: [],
  scan: { url: `blob:${hash}`, file: new File(['x'], `${hash}.png`), width: 100, height: 150, hash },
}) as unknown as ComicPage

describe('the thumbnail queue', () => {
  it('makes a thumbnail again for a page whose chapter closed mid-making', async () => {
    // The test DOM has no object URLs of its own; the queue only needs one back.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb')

    const comic = useComic()
    const { urls } = useThumbs()

    comic.pages.value = [page('h1')]
    await vi.waitFor(() => expect(made).toHaveLength(1))

    // The chapter goes while the picture is on its way; the picture is dropped.
    comic.pages.value = []
    made[0]!.release()
    await nextTick()
    await vi.waitFor(() => expect(urls.value.h1).toBeUndefined())

    // Opened again: the page has to be asked about again, and filled in.
    comic.pages.value = [page('h1')]
    await vi.waitFor(() => expect(made).toHaveLength(2))
    made[1]!.release()

    await vi.waitFor(() => expect(urls.value.h1).toMatch(/^blob:/))
  })
})

/*
 * `urls` is one object, replaced whole, and it was replaced once per thumbnail:
 * every replacement copied every URL already there and woke every picture in
 * the panel, so a chapter's thumbnails cost the square of its length — paid in
 * one burst by a chapter opened again, whose thumbnails come off the disk a few
 * milliseconds apart.
 */
describe('writing the thumbnails', () => {
  afterEach(() => {
    instant.on = false

    for (const one of made) one.release()
  })

  it('writes thumbnails that arrive together in one write, not one per thumbnail', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as Blob).size}`)

    const comic = useComic()
    const { urls } = useThumbs()
    const hashes = Array.from({ length: 12 }, (_, index) => `many-${index}`)

    let writes = 0

    const stop = watch(urls, () => { writes++ }, { flush: 'sync' })

    instant.on = true
    comic.pages.value = hashes.map(page)

    await vi.waitFor(() => expect(Object.keys(urls.value)).toEqual(expect.arrayContaining(hashes)))
    stop()

    expect(writes).toBe(1)
  })

  it('asks for as many thumbnails at once as there are background decoders, and shows the first without waiting for the rest', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb')

    const comic = useComic()
    const { urls } = useThumbs()

    made.length = 0
    comic.pages.value = ['few-1', 'few-2', 'few-3', 'few-4', 'few-5'].map(page)

    await vi.waitFor(() => expect(made).toHaveLength(3))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(made.map((one) => one.hash)).toEqual(['few-1', 'few-2', 'few-3'])

    made[0]!.release()

    await vi.waitFor(() => expect(urls.value['few-1']).toBe('blob:thumb'))
    expect(made.map((one) => one.hash)).toEqual(['few-1', 'few-2', 'few-3', 'few-4'])
  })
})
