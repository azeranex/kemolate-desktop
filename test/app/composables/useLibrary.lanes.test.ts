import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'

import { useComic } from '~/composables/useComic'
import { useLibrary } from '~/composables/useLibrary'

/**
 * How many files are read and hashed at once: a few, never one and never all.
 *
 * `crypto.subtle` has no streaming digest, so a file being hashed is in memory
 * whole. Opening a chapter hashed its pages one at a time, the disk idle while
 * each digest ran; a drop hashed everything dropped at once, sixty 25 MB scans
 * being a gigabyte and a half before the first page was added. Both now go
 * `hashLanes` wide.
 *
 * And a page fetched from a peer is not hashed again at all: the fetch checked
 * its bytes against the hash it asked for, and hands that hash to `link`.
 *
 * Seam: `identify`, `addImages` and `link` over `useComic`'s pages, with the
 * digest (`hashFile`) replaced by one that counts how many run at once.
 */

const { hashFile, flight } = vi.hoisted(() => {
  const flight = { now: 0, most: 0 }

  return {
    flight,
    hashFile: vi.fn(async (file: File, _options?: { recall?: boolean }) => {
      flight.now++
      flight.most = Math.max(flight.most, flight.now)

      await new Promise((resolve) => setTimeout(resolve, 5))

      flight.now--

      return `hash-${file.name}`
    }),
  }
})

const shared = ref<{ pages: { uid: string, hash: string | null }[] } | null>(null)

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('hashFile', () => hashFile)
mockNuxtImport('rememberedHashes', () => async (files: File[]) => files.map(() => null))
mockNuxtImport('useShared', () => () => ({ shared, push: async () => {}, pageRowOf: () => null, forgetPage: () => {} }))

vi.mock('~/utils/resources', async (original) => ({
  ...await original<typeof import('~/utils/resources')>(),
  hashLanes: () => 3,
}))

const scan = (name: string) => ({
  id: `scan:${name}`,
  name,
  blocks: [],
  scan: { url: 'blob:x', file: new File([name], name), width: 0, height: 0, hash: null },
}) as unknown as ComicPage

beforeEach(() => {
  hashFile.mockClear()
  flight.now = 0
  flight.most = 0
  shared.value = null

  // The test DOM has no object URLs of its own; a page only needs one back.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:page')
})

describe('hashing a chapter as it opens', () => {
  it('reads three pages at a time, each once, without asking the memo again', async () => {
    const { pages } = useComic()

    pages.value = Array.from({ length: 7 }, (_, index) => scan(`${index + 1}.jpg`))

    const { identify } = effectScope().run(() => useLibrary())!

    await identify()

    expect(flight.most).toBe(3)
    expect(hashFile.mock.calls.map(([file]) => file.name).sort()).toEqual(pages.value.map((one) => one.name).sort())
    expect(pages.value.map((one) => one.scan?.hash)).toEqual(pages.value.map((one) => `hash-${one.name}`))

    // `rememberedHashes` has just said it knows none of them.
    expect(hashFile.mock.calls.every(([, options]) => options?.recall === false)).toBe(true)
  })
})

describe('hashing a drop', () => {
  it('holds three files at a time rather than the whole drop, and files each hash under its own page', async () => {
    const comic = useComic()

    comic.pages.value = [scan('open.jpg')]
    comic.open.value = true

    const { addImages } = effectScope().run(() => useLibrary())!
    const images = Array.from({ length: 10 }, (_, index) => ({ file: new File([`${index}`], `drop-${index}.jpg`), path: `drop-${index}.jpg` }))

    await addImages({ images, rest: null, handle: null, title: null })

    expect(flight.most).toBe(3)
    expect(hashFile).toHaveBeenCalledTimes(10)

    for (const { path } of images) {
      expect(comic.pages.value.find((one) => one.id === `scan:${path}`)?.scan?.hash).toBe(`hash-${path}`)
    }
  })
})

describe('linking a page whose hash is already known', () => {
  it('shows the page at once, under the hash it was fetched by, without reading it again', async () => {
    const comic = useComic()
    const absent = { id: 'page:u1', uid: 'u1', name: 'p1.png', blocks: [] } as unknown as ComicPage

    comic.pages.value = [absent]
    shared.value = { pages: [{ uid: 'u1', hash: 'fetched-hash' }] }

    const { link } = effectScope().run(() => useLibrary())!
    const file = new File(['page one'], 'p1.png')

    expect(await link('page:u1', file, { quiet: true, hash: 'fetched-hash' })).toBe('linked')

    expect(hashFile).not.toHaveBeenCalled()
    expect(comic.pages.value[0]!.scan).toEqual(expect.objectContaining({ file, hash: 'fetched-hash' }))
  })
})
