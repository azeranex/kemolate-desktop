import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StackLayer } from '#shared/utils/layers'

import { useComic } from '~/composables/useComic'
import { useLayerCache } from '~/composables/useLayerCache'

/**
 * A local workspace's layer stacks survive being opened.
 *
 * Each page's stack — its sheets, groups, adjustments and placed pictures — is
 * kept in this browser and put back when the chapter opens. The lookup is one
 * page at a time, and a page put back woke the cache's watcher while the next
 * page's lookup was still out: that page was already marked as looked-at, and
 * still held the stack every page opens on, so the watcher scheduled that as
 * its write. The saved stack landed a moment later and was agreed to without
 * the scheduled write being called off, so a quarter of a second after
 * opening, the page's saved stack on disk became the default one.
 *
 * Seam: `useLayerCache` over `useComic`'s pages, the store a map, with one
 * lookup held open where the race needs it.
 */
const { memory, held } = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
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

const PAGES = 4

/** A stack somebody made: the default plus a sheet of their own. */
const made = (at: number) => [
  ...structuredClone(DEFAULT_STACK),
  { id: `sheet-${at}`, label: `Sheet on page ${at}`, visible: true, opacity: 100, paint: true },
] as unknown as StackLayer[]

const page = (at: number) => ({
  id: `scan:${at}.png`,
  name: `${at}.png`,
  blocks: [],
  stack: structuredClone(DEFAULT_STACK),
  scan: { url: `blob:${at}`, file: new File([], `${at}.png`), width: 1000, height: 1500, hash: `h${at}` },
}) as unknown as ComicPage

/** Past the cache's settle, so a scheduled write has gone to the store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

const savedSheets = (at: number) => (memory.get(`layers:ws-a:h${at}`) as { stack: StackLayer[] } | undefined)
  ?.stack.filter((layer) => layer.id.startsWith('sheet-')).length

describe('the local layer cache, on opening a chapter', () => {
  beforeEach(() => {
    memory.clear()
    useState('workspace-shared').value = null

    for (let at = 1; at <= PAGES; at++) memory.set(`layers:ws-a:h${at}`, { v: 1, stack: made(at) })

    useComic().pages.value = Array.from({ length: PAGES }, (_, index) => page(index + 1))
  })

  afterEach(() => {
    held.clear()
  })

  it('puts every page\'s stack back and leaves every saved stack as it was', async () => {
    const scope = effectScope()
    const cache = scope.run(() => useLayerCache())!

    await cache.restore()
    await settle()

    for (let at = 1; at <= PAGES; at++) {
      expect(useComic().pages.value[at - 1]!.stack?.some((layer) => layer.id === `sheet-${at}`)).toBe(true)
      expect(savedSheets(at)).toBe(1)
    }

    scope.stop()
  })

  it('writes nothing over a page whose stack is still coming off disk when the chapter is left', async () => {
    let release = () => {}

    held.set('layers:ws-a:h2', new Promise<void>((resolve) => { release = resolve }))

    const scope = effectScope()
    const cache = scope.run(() => useLayerCache())!
    const restoring = cache.restore()

    await vi.waitFor(() => expect(useComic().pages.value[0]!.stack?.some((layer) => layer.id === 'sheet-1')).toBe(true))
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 50))

    scope.stop()
    release()
    await restoring

    expect(savedSheets(2)).toBe(1)
  })
})
