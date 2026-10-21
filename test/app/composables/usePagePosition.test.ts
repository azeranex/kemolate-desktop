import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useComic } from '~/composables/useComic'
import { usePagePosition } from '~/composables/usePagePosition'

/**
 * The canvas is not shown until the page it opens on is the right one.
 *
 * Opening a chapter puts it on page one, and the kept position turns it a
 * moment later — so every reload drew page one for a frame or two and then
 * jumped. `placing` is what the workspace hides the board behind; these pin
 * when it comes down.
 *
 * IndexedDB is swapped for a map, as elsewhere. Fake timers only for the cap.
 */
const { memory } = vi.hoisted(() => ({ memory: new Map<string, unknown>() }))

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) },
}))

const page = (id: string) => ({ id, name: id, blocks: [] }) as unknown as ComicPage

describe('placing', () => {
  // One per test: a stopped scope runs nothing, silently.
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    memory.clear()

    const { pages, at } = useComic()

    pages.value = [page('one'), page('two'), page('three')]
    at.value = 0
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  it('holds until the kept page has been turned to, and not a moment before', async () => {
    memory.set('workspace:ws:at', 'three')

    const { at } = useComic()
    const { restore, placing } = scope.run(() => usePagePosition())!

    expect(placing.value).toBe(true)

    await restore()

    expect(at.value).toBe(2)
    expect(placing.value).toBe(false)
  })

  it('comes down at once when there is nothing kept to turn to', async () => {
    const { restore, placing } = scope.run(() => usePagePosition())!

    await restore()

    expect(placing.value).toBe(false)
  })

  it('comes down on its own if nothing ever puts the page back', () => {
    vi.useFakeTimers()

    const { placing } = scope.run(() => usePagePosition())!

    vi.advanceTimersByTime(1499)
    expect(placing.value).toBe(true)

    vi.advanceTimersByTime(1)
    expect(placing.value).toBe(false)
  })
})

/**
 * The position is written by the reader turning pages, and by nothing else.
 *
 * Found on 2026-09-28: a tab opened a chapter on page one and wrote page one
 * over the page it had been kept on — `scan:1.png` where `scan:17.png` had
 * been. The writer was armed once, when the first restore settled, and stayed
 * armed through anything after it; so the page any later opening of the chapter
 * *landed* on was written down as if somebody had turned to it. And the restore
 * itself settled against a chapter it could not read the names of: the kept
 * page named by its file (`scan:<path>`) while the chapter on screen was only
 * the workspace's record of it (`page:<uid>`), so it gave up, armed the writer,
 * and let page one through.
 *
 * Seam: `usePagePosition` over `useComic`'s own state, as above.
 */
describe('writing the position', () => {
  let scope = effectScope()

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    scope = effectScope()
    memory.clear()

    const { pages, at, epoch } = useComic()

    pages.value = [page('one'), page('two'), page('three')]
    at.value = 0
    epoch.value++
  })

  afterEach(() => scope.stop())

  it('writes a page the reader turns to once the restore has settled', async () => {
    memory.set('workspace:ws:at', 'three')

    const { go } = useComic()
    const { restore } = scope.run(() => usePagePosition())!

    await restore()
    go(1)
    await settle()

    expect(memory.get('workspace:ws:at')).toBe('two')
  })

  it('does not write the page a later opening of the chapter lands on', async () => {
    memory.set('workspace:ws:at', 'three')

    const { pages, at, epoch } = useComic()
    const { restore } = scope.run(() => usePagePosition())!

    await restore()

    // The chapter opened again — a reload of the list, a folder dropped in —
    // landing on page one, as an opening does when nobody says otherwise.
    pages.value = [page('one'), page('two'), page('three')].map((one) => ({ ...one }))
    at.value = 0
    epoch.value++
    await settle()

    expect(memory.get('workspace:ws:at')).toBe('three')
  })

  it('writes again once the reader turns a page in the new opening', async () => {
    memory.set('workspace:ws:at', 'three')

    const { pages, at, epoch, go } = useComic()
    const { restore } = scope.run(() => usePagePosition())!

    await restore()

    pages.value = [page('one'), page('two'), page('three')]
    at.value = 0
    epoch.value++
    await settle()

    go(1)
    await settle()

    expect(memory.get('workspace:ws:at')).toBe('two')
  })

  it('finds a page kept by its file on a chapter that is only the workspace\'s record', async () => {
    memory.set('workspace:ws:at', 'scan:17.png')

    const { pages, at } = useComic()

    pages.value = ['1.png', '2.png', '17.png'].map((path, index) => ({ id: `page:u${index}`, uid: `u${index}`, path, name: path, blocks: [] }) as unknown as ComicPage)
    at.value = 0

    const { restore } = scope.run(() => usePagePosition())!

    await restore()
    await settle()

    expect(at.value).toBe(2)
    expect(memory.get('workspace:ws:at')).toBe('scan:17.png')
  })

  it('finds a page kept while it was only the record, once its file is here', async () => {
    memory.set('workspace:ws:at', 'page:u2')

    const { pages, at } = useComic()

    pages.value = ['1.png', '2.png', '17.png'].map((path, index) => ({ id: `scan:${path}`, uid: `u${index}`, name: path, blocks: [] }) as unknown as ComicPage)
    at.value = 0

    const { restore } = scope.run(() => usePagePosition())!

    await restore()

    expect(at.value).toBe(2)
  })
})
