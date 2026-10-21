import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'

import { useBlockCache } from '~/composables/useBlockCache'
import { useComic } from '~/composables/useComic'

/**
 * An edit to one page costs that page, not the chapter.
 *
 * A local workspace keeps every page's reading in this browser, and the cache
 * worked out what had changed by stringifying every block of every page — and
 * then every page again — on every drag frame and every keystroke. Measured at
 * 14 ms a change on 30 pages and 125 ms on 200, which is lettering that lags
 * behind the hand on exactly the chapters worth working on locally. Now each
 * page's string is remembered until something on that page changes.
 *
 * Seam: `useBlockCache` over `useComic`'s pages, with `JSON.stringify` watched
 * for which page's blocks it is handed, and the store a map.
 */
const { memory, held } = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  // Lookups held open until released, by key — a slow disk, on demand.
  held: new Map<string, Promise<void>>(),
}))

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws-a' }, fullPath: '/w/ws-a' }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => {
    await held.get(key)

    return memory.get(key)
  },
  set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) },
  del: async (key: string) => { memory.delete(key) },
  keys: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix)),
  getMany: async (keys: string[]) => keys.map((key) => memory.get(key)),
}))

const PAGES = 40

const block = (id: string, source: string) => ({ id, type: 'bubble', x: 10, y: 10, w: 20, h: 10, source }) as Block

const page = (at: number) => ({
  id: `scan:${at}.png`,
  name: `${at}.png`,
  blocks: Array.from({ length: 10 }, (_, index) => block(`text:${at}-${index}`, `line ${index} of page ${at}`)),
  scan: { url: `blob:${at}`, file: new File([], `${at}.png`), width: 1000, height: 1500, hash: `h${at}` },
}) as unknown as ComicPage

/** Past the cache's settle, so a write has gone to the store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

describe('the local block cache, on an edit', () => {
  beforeEach(() => {
    memory.clear()
    useState('workspace-shared').value = null

    // The chapter as a local workspace opens it: pages empty, their readings
    // on disk, put back by `restore`.
    const chapter = Array.from({ length: PAGES }, (_, at) => page(at + 1))

    for (const one of chapter) memory.set(`blocks:ws-a:${one.scan!.hash}`, { v: 3, blocks: one.blocks })

    useComic().pages.value = chapter.map((one) => ({ ...one, blocks: [] }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    held.clear()
  })

  /*
   * The race that made "an arrival is not an edit" dangerous to get half
   * right. A page was marked as looked-at before its lookup came back, so the
   * page before it arriving woke the watcher, which found this one looked and
   * still empty and scheduled "no blocks" as its write — and a write still
   * waiting is run at once when the chapter is left.
   */
  it('writes nothing over a page whose reading is still coming off disk when the chapter is left', async () => {
    let release = () => {}

    held.set('blocks:ws-a:h2', new Promise<void>((resolve) => { release = resolve }))

    const scope = effectScope()
    const cache = scope.run(() => useBlockCache())!
    const restoring = cache.restore()

    // Page one comes back; page two's lookup is still out.
    await vi.waitFor(() => expect(useComic().pages.value[0]!.blocks).toHaveLength(10))
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Leaving the chapter runs whatever writes are waiting.
    scope.stop()
    release()
    await restoring

    expect((memory.get('blocks:ws-a:h2') as { blocks: Block[] }).blocks).toHaveLength(10)
  })

  it('writes nothing back for a chapter it has just put back', async () => {
    const scope = effectScope()
    const cache = scope.run(() => useBlockCache())!
    const set = vi.spyOn(memory, 'set')

    await cache.restore()
    await settle()

    expect(useComic().pages.value[39]!.blocks).toHaveLength(10)
    expect(set).not.toHaveBeenCalled()

    scope.stop()
  })

  it('serialises and writes only the page that changed', async () => {
    const scope = effectScope()
    const cache = scope.run(() => useBlockCache())!

    await cache.restore()
    await settle()
    memory.clear()

    const { pages } = useComic()
    const others = new Set(pages.value.slice(1).map((one) => toRaw(one.blocks)))
    const stringify = vi.spyOn(JSON, 'stringify')

    pages.value[0]!.blocks[0]!.source = 'typed on page one'
    await nextTick()
    await settle()

    const touchedOthers = stringify.mock.calls.filter(([value]) => others.has(toRaw(value as Block[])))

    expect(touchedOthers).toHaveLength(0)
    expect([...memory.keys()]).toEqual(['blocks:ws-a:h1'])
    expect((memory.get('blocks:ws-a:h1') as { blocks: Block[] }).blocks[0]!.source).toBe('typed on page one')

    scope.stop()
  })
})
