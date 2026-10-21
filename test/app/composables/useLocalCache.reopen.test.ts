import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import type { StackLayer } from '#shared/utils/layers'

import { useBlockCache } from '~/composables/useBlockCache'
import { useComic } from '~/composables/useComic'
import { useLayerCache } from '~/composables/useLayerCache'

/**
 * Opening a local chapter again does not write its pages empty.
 *
 * Both local caches mark a page as looked-up by its scan once its saved copy
 * has been put back, and write it on every change after that. The mark was
 * kept for as long as the workspace page was mounted — but a chapter can be
 * opened again under it: folder access granted again, the same folder picked
 * again, a hot reload in development. `openImages` hands every page back fresh,
 * with no blocks and the stack every page opens on, and bumps the epoch; the
 * scan is the same scan. So each page was "looked up" and changed, and the
 * watcher wrote the empty reading and the default stack over the saved ones —
 * and `restore`, finding the scan looked-up, never put them back. On a local
 * workspace that copy is the only one.
 *
 * Found while several agents were hot-reloading the app over the test chapter:
 * every page's saved reading went to an empty list. The same shape as the
 * `useBlockSync` epoch bug of 2026-08-09, one layer down.
 *
 * Seam: the two caches over `useComic`'s pages, re-opened the way `openImages`
 * re-opens them, with the store a map.
 */
const { memory } = vi.hoisted(() => ({ memory: new Map<string, unknown>() }))

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws-a' }, fullPath: '/w/ws-a' }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) },
  del: async (key: string) => { memory.delete(key) },
  keys: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix)),
  getMany: async (keys: string[]) => keys.map((key) => memory.get(key)),
}))

const PAGES = 3

const block = (id: string, source: string) => ({ id, type: 'bubble', x: 10, y: 10, w: 20, h: 10, source }) as Block

/** A stack somebody made: the default plus a sheet of their own. */
const made = (at: number) => [
  ...structuredClone(DEFAULT_STACK),
  { id: `sheet-${at}`, label: `Sheet on page ${at}`, visible: true, opacity: 100, paint: true },
] as unknown as StackLayer[]

/** A page as `openImages` hands it over: nothing read, the stack every page opens on. */
const fresh = (at: number) => ({
  id: `scan:${at}.png`,
  name: `${at}.png`,
  blocks: [],
  stack: structuredClone(DEFAULT_STACK),
  scan: { url: `blob:${at}`, file: new File([], `${at}.png`), width: 1000, height: 1500, hash: `h${at}` },
}) as unknown as ComicPage

/** Open the chapter the way `openImages` does: fresh pages, and a new epoch. */
function open () {
  const comic = useComic()

  comic.pages.value = Array.from({ length: PAGES }, (_, at) => fresh(at + 1))
  comic.epoch.value++
}

/** Past the caches' settle, so a scheduled write has gone to the store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

const savedBlocks = (at: number) => (memory.get(`blocks:ws-a:h${at}`) as { blocks: Block[] } | undefined)?.blocks.length

const savedSheets = (at: number) => (memory.get(`layers:ws-a:h${at}`) as { stack: StackLayer[] } | undefined)
  ?.stack.filter((layer) => layer.id.startsWith('sheet-')).length

describe('a local chapter opened again under the same page', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    memory.clear()
    useState('workspace-shared').value = null

    for (let at = 1; at <= PAGES; at++) {
      memory.set(`blocks:ws-a:h${at}`, { v: 3, blocks: [block(`text:${at}`, `line on page ${at}`)] })
      memory.set(`layers:ws-a:h${at}`, { v: 1, stack: made(at) })
    }
  })

  afterEach(() => {
    scope.stop()
  })

  it('keeps every page\'s saved reading, and puts it back', async () => {
    const cache = scope.run(() => useBlockCache())!

    open()
    await cache.restore()

    expect(useComic().pages.value.map((page) => page.blocks.length)).toEqual([1, 1, 1])

    open()
    await settle()

    expect([1, 2, 3].map(savedBlocks)).toEqual([1, 1, 1])

    await cache.restore()

    expect(useComic().pages.value.map((page) => page.blocks.length)).toEqual([1, 1, 1])
  })

  it('keeps every page\'s saved stack, and puts it back', async () => {
    const cache = scope.run(() => useLayerCache())!

    open()
    await cache.restore()

    expect(useComic().pages.value.map((page) => page.stack?.some((layer) => layer.id.startsWith('sheet-')))).toEqual([true, true, true])

    open()
    await settle()

    expect([1, 2, 3].map(savedSheets)).toEqual([1, 1, 1])

    await cache.restore()

    expect(useComic().pages.value.map((page) => page.stack?.some((layer) => layer.id.startsWith('sheet-')))).toEqual([true, true, true])
  })

  it('still saves an edit made after the chapter is opened again', async () => {
    const cache = scope.run(() => useBlockCache())!

    open()
    await cache.restore()
    open()
    await cache.restore()

    useComic().setBlocks('scan:2.png', [block('text:2', 'line on page 2'), block('text:2b', 'a second line')])
    await settle()

    expect([1, 2, 3].map(savedBlocks)).toEqual([1, 2, 1])
  })
})
