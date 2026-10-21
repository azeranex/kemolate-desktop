import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockCache } from '~/composables/useBlockCache'
import { useComic } from '~/composables/useComic'

/**
 * A local workspace's other tabs, keeping up with each other's reading.
 *
 * A local workspace has no server to hear from, so two tabs on one chapter each
 * held the reading they opened with — and the next edit either made wrote its
 * whole page back over the other's. Now a tab that writes a page says so over a
 * `BroadcastChannel`, and the others read that page back from the shared store.
 *
 * Seam: `useBlockCache` in one tab; the other tab is a second channel posting
 * what its cache would, and the store is a map.
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

const block = (id: string, source: string) => ({ id, type: 'bubble', x: 10, y: 10, w: 20, h: 10, source }) as Block

/** Another tab, saying what its cache says after a write. */
const otherTab = new BroadcastChannel('kemolate-local')

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('a local workspace\'s reading across tabs', () => {
  beforeEach(() => {
    memory.clear()
    useState('workspace-shared').value = null

    const { pages } = useComic()

    pages.value = [{ id: 'scan:1.png', name: '1.png', blocks: [], scan: { url: 'blob:1', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'h1' } }] as unknown as ComicPage[]
  })

  it('takes up a page another tab wrote', async () => {
    const scope = effectScope()

    scope.run(() => useBlockCache())

    memory.set('blocks:ws-a:h1', { v: 1, blocks: [block('text:a', 'from the other tab')] })
    otherTab.postMessage({ workspace: 'ws-a', scope: 'blocks', key: 'h1' })
    await settle()

    expect(useComic().pages.value[0]!.blocks.map((one) => one.source)).toEqual(['from the other tab'])

    scope.stop()
  })

  it('keeps this tab\'s own edit while its write is still waiting — that is the newer one', async () => {
    const scope = effectScope()

    scope.run(() => useBlockCache())

    memory.set('blocks:ws-a:h1', { v: 1, blocks: [block('text:a', 'first')] })
    otherTab.postMessage({ workspace: 'ws-a', scope: 'blocks', key: 'h1' })
    await settle()

    // Typed here: the write waits out its settle.
    useComic().setBlocks('scan:1.png', [block('text:a', 'typed here')])
    await nextTick()

    memory.set('blocks:ws-a:h1', { v: 1, blocks: [block('text:a', 'older, from the other tab')] })
    otherTab.postMessage({ workspace: 'ws-a', scope: 'blocks', key: 'h1' })
    await settle()

    expect(useComic().pages.value[0]!.blocks.map((one) => one.source)).toEqual(['typed here'])

    scope.stop()
  })

  it('ignores another workspace, and another kind of change', async () => {
    const scope = effectScope()

    scope.run(() => useBlockCache())

    memory.set('blocks:ws-b:h1', { v: 1, blocks: [block('text:b', 'elsewhere')] })
    otherTab.postMessage({ workspace: 'ws-b', scope: 'blocks', key: 'h1' })
    otherTab.postMessage({ workspace: 'ws-a', scope: 'layers', key: 'h1' })
    await settle()

    expect(useComic().pages.value[0]!.blocks).toEqual([])

    scope.stop()
  })
})
