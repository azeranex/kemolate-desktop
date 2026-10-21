import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useClean } from '~/composables/useClean'
import { useComic } from '~/composables/useComic'

/**
 * A page's record of the repairs it last showed, and showing them from it.
 *
 * Opening a chapter drew the page and then its cleaning a second and a half
 * later, with the printed lettering under the translation for all of that time.
 * The record lets the page put its repairs up straight from disk; `restore`
 * then confirms or corrects them.
 *
 * The first version of this never wrote a record at all, and said nothing: a
 * patch's `from` is a reactive proxy by the time it is in the map, IndexedDB
 * refuses to clone one, and the failure was swallowed as "a record that cannot
 * be kept". So IndexedDB is swapped for a map that clones exactly as the real
 * store does — `structuredClone` throws on a proxy the same way — and the disk
 * for a map of blobs.
 */
const { memory, disk } = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  disk: new Map<string, Blob>(),
}))

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) },
  del: async (key: string) => { memory.delete(key) },
  keys: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix)),
}))

mockNuxtImport('readPatch', () => async (key: string) => disk.get(key) ?? null)

const HASH = '9cc28a68a077a7e5f1c0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3'
const KEY = `${HASH.slice(0, 16)}-677-916-122-232-lama-m13-seg`

describe('the repair record', () => {
  // One per test: a stopped scope runs nothing, silently.
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    memory.clear()
    // The test environment's `Blob` and its `URL` disagree about which `Blob`
    // is real; the URL is not what is under test.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shown')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    disk.clear()
    disk.set(KEY, new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))

    const { pages, at } = useComic()

    pages.value = [{
      id: 'scan:6.jpg',
      name: '6.jpg',
      blocks: [],
      scan: { url: 'blob:page', file: new File([], '6.jpg'), width: 877, height: 1240, hash: HASH },
    }] as ComicPage[]
    at.value = 0
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('keeps what a page shows, and shows it again from the record', async () => {
    const { patches, settings, keepShown, showKept } = scope.run(() => useClean())!
    const { pages } = useComic()

    settings.value = { ...settings.value, model: 'lama' }

    // As `show` files a repair: through the reactive map, `from` and all.
    patches.value = {
      'scan:6.jpg': {
        'block:1': {
          url: 'blob:repair',
          x: 73.888,
          y: 71.532,
          w: 20.752,
          h: 23.548,
          from: { x: 677.7, y: 916.5, w: 121.9, h: 232.1 },
          scan: HASH,
          key: KEY,
        },
      },
    }

    await keepShown(pages.value[0])

    // The next visit: nothing on the page yet.
    patches.value = {}

    await showKept(pages.value[0])

    const shown = patches.value['scan:6.jpg']?.['block:1']

    expect(shown).toMatchObject({
      key: KEY,
      scan: HASH,
      x: 73.888,
      from: { x: 677.7, y: 916.5, w: 121.9, h: 232.1 },
      // Until `restore` has said otherwise.
      provisional: true,
    })
  })

  it('shows nothing when the cleaner is set to None', async () => {
    const { patches, settings, keepShown, showKept } = scope.run(() => useClean())!
    const { pages } = useComic()

    settings.value = { ...settings.value, model: 'lama' }
    patches.value = {
      'scan:6.jpg': {
        'block:1': { url: 'blob:repair', x: 1, y: 1, w: 1, h: 1, from: { x: 1, y: 1, w: 1, h: 1 }, scan: HASH, key: KEY },
      },
    }

    await keepShown(pages.value[0])

    patches.value = {}
    settings.value = { ...settings.value, model: 'none' }

    await showKept(pages.value[0])

    expect(patches.value['scan:6.jpg']).toBeUndefined()
  })
})
