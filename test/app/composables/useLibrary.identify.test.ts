import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useComic } from '~/composables/useComic'
import { useLibrary } from '~/composables/useLibrary'

/**
 * Each page is read and hashed once, however often it is asked for.
 *
 * `identify` runs whenever the page count changes, and a PDF's pages land one
 * at a time — so it was called once per page while earlier calls were still
 * going, and every call walked every page not yet hashed. The runs overlapped
 * and read the same pages over and over, whole scans in memory at once.
 *
 * Seam: `identify` over `useComic`'s pages, with the digest (`hashFile`) and
 * the memo (`rememberedHashes`) replaced — the question is how often a page is
 * read, not what its hash is.
 */

const { hashFile } = vi.hoisted(() => ({
  hashFile: vi.fn(async (file: File) => {
    await new Promise((resolve) => setTimeout(resolve, 5))

    return `hash-${file.name}`
  }),
}))

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('hashFile', () => hashFile)
mockNuxtImport('rememberedHashes', () => async (files: File[]) => files.map(() => null))

const page = (name: string) => ({
  id: `scan:${name}`,
  name,
  blocks: [],
  scan: { url: 'blob:x', file: new File([name], name), width: 0, height: 0, hash: null },
}) as unknown as ComicPage

describe('identify', () => {
  it('reads each page once when it is asked again while it runs', async () => {
    const { pages } = useComic()

    pages.value = [page('1.jpg'), page('2.jpg')]

    const { identify } = effectScope().run(() => useLibrary())!

    const first = identify()

    // A page landing mid-run, as a PDF's do, and the call it causes.
    pages.value = [...pages.value, page('3.jpg')]

    const second = identify()
    const third = identify()

    await Promise.all([first, second, third])

    expect(hashFile.mock.calls.map(([file]) => file.name).sort()).toEqual(['1.jpg', '2.jpg', '3.jpg'])
    expect(pages.value.map((one) => one.scan?.hash)).toEqual(['hash-1.jpg', 'hash-2.jpg', 'hash-3.jpg'])
  })
})
