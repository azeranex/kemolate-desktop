import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'

import { shareInFlight } from '~/composables/useMaskEdits'

// What a changed correction asks for — see "a local workspace opening", below.
const { cleanSoon } = vi.hoisted(() => ({ cleanSoon: vi.fn() }))

mockNuxtImport('useClean', () => () => ({ cleanBlockSoon: cleanSoon }))

/**
 * The rule that stops a cold open asking the server the same question a dozen
 * times.
 *
 * `useClean.restore` walks every page and every block and asks each block for
 * its corrections before it can work out what its repair is called. The chain
 * it sits in hangs off a watcher counting hashed pages, and hashing runs one
 * page at a time in the background — so a ten-page chapter runs the whole walk
 * about eleven times, overlapping, and every run asked again. Hundreds of
 * requests for an answer that did not change.
 *
 * What is tested here is the narrow promise this makes and the narrower one it
 * refuses: callers overlapping in time share a request, and nothing is
 * remembered once it settles. The second half is the important one — a block's
 * corrections are somebody else's to change, and an entry that outlived its
 * request would serve a stale list to the next reader.
 */
describe('shareInFlight', () => {
  it('asks once for callers that overlap', async () => {
    const held = new Map<string, Promise<string>>()
    let settle = (_: string) => {}
    const start = vi.fn(() => new Promise<string>((resolve) => { settle = resolve }))

    const first = shareInFlight(held, 'a', start)
    const second = shareInFlight(held, 'a', start)

    expect(start).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)

    settle('strokes')

    expect(await first).toBe('strokes')
    expect(await second).toBe('strokes')
  })

  it('keeps different keys apart', () => {
    const held = new Map<string, Promise<string>>()
    const start = vi.fn(() => Promise.resolve('strokes'))

    shareInFlight(held, 'page:one', start)
    shareInFlight(held, 'page:two', start)

    expect(start).toHaveBeenCalledTimes(2)
  })

  it('forgets a settled request, so the next caller asks again', async () => {
    const held = new Map<string, Promise<string>>()
    const start = vi.fn(() => Promise.resolve('strokes'))

    await shareInFlight(held, 'a', start)

    expect(held.size).toBe(0)

    await shareInFlight(held, 'a', start)

    expect(start).toHaveBeenCalledTimes(2)
  })

  /**
   * A rejection must not be what every later caller gets. Left in the map it
   * would be a cached failure, from a thing whose whole point is that it caches
   * nothing — and the block would be unaskable for the life of the page.
   */
  it('forgets a request that threw', async () => {
    const held = new Map<string, Promise<string>>()
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('strokes')

    await expect(shareInFlight(held, 'a', start as () => Promise<string>)).rejects.toThrow('offline')
    expect(held.size).toBe(0)

    await expect(shareInFlight(held, 'a', start as () => Promise<string>)).resolves.toBe('strokes')
  })
})

/**
 * A local workspace's corrections, kept in this browser.
 *
 * They used to be kept only on the server, so on a local workspace the mask
 * brush drew, the plate showed it, and the clean that followed read nothing and
 * put the old repair straight back. These pin the round trip the fix depends
 * on: a correction drawn is a correction read, and one taken back — which is
 * what undo does to a local stroke, through `usePaintCache.retract` — is gone
 * from what the next clean reads.
 */
describe('corrections on a local workspace', () => {
  const HASH = 'f'.repeat(64)

  function setUp () {
    useState('workspace-shared').value = null

    const block = { id: 'read:ab12cd34:0', type: 'bubble', x: 10, y: 10, w: 20, h: 10, source: '', translation: '', confidence: 90, hidden: false } as Block
    const page = { id: 'scan:1.png', name: '1.png', blocks: [block], scan: { url: '', file: new File([], '1.png'), width: 600, height: 900, hash: HASH } } as unknown as ComicPage

    return { page, block }
  }

  it('reads back a correction drawn on it', async () => {
    const { page, block } = setUp()
    const { add, load } = useMaskEdits()

    await add(page, block, { kind: 'add', points: [100, 100, 120, 110], size: 12, hardness: 1 })
    // `add` sends without waiting; the stroke lands in the log a tick later.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const read = await load(page, block)

    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ kind: 'add', size: 12 })
    expect(usePaintCache().on(`${HASH}:mask-${block.id}`)).toHaveLength(1)
  })

  it('drops a correction taken back, as undo takes it back', async () => {
    const { page, block } = setUp()
    const { load } = useMaskEdits()
    const paint = usePaintCache()
    const [stroke] = paint.on(`${HASH}:mask-${block.id}`)

    expect(stroke).toBeDefined()
    expect(stroke!.id).toBeLessThan(0)

    paint.retract(stroke!.id, true)

    expect(await load(page, block)).toHaveLength(0)
  })
})

/**
 * Reading a block's corrections is not a correction.
 *
 * The report: opening a local workspace cleaned the chapter. `useClean.restore`
 * reads the corrections of every block it has not shown a repair for, each read
 * files an entry in the paint cache — empty, for a block nobody corrected — and
 * the watcher that re-cleans a block when its corrections change counted every
 * new entry as a change. So every such block was queued for a clean nobody
 * asked for: inference for each one never cleaned, and today's model over
 * repairs made with another.
 *
 * Seam: the paint cache and the watcher, with `useClean` replaced by a spy on
 * what the watcher asks it for. A hash of its own, because the cache is shared
 * with the tests above.
 */
describe('a local workspace opening', () => {
  const HASH = 'e'.repeat(64)

  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  function setUp () {
    useState('workspace-shared').value = null

    const block = { id: 'read:ef56ab78:0', type: 'bubble', x: 10, y: 10, w: 20, h: 10, source: '', translation: '', confidence: 90, hidden: false } as Block
    const page = { id: 'scan:2.png', name: '2.png', blocks: [block], scan: { url: '', file: new File([], '2.png'), width: 600, height: 900, hash: HASH } } as unknown as ComicPage

    useComic().pages.value = [page]
    cleanSoon.mockClear()

    return { page: useComic().pages.value[0]!, block }
  }

  it('does not clean a block because its corrections were read', async () => {
    const { page, block } = setUp()
    const { load } = useMaskEdits()

    await load(page, block)
    await settle()

    expect(cleanSoon).not.toHaveBeenCalled()
  })

  it('still cleans a block whose corrections change', async () => {
    const { page, block } = setUp()
    const { add } = useMaskEdits()

    await add(page, block, { kind: 'add', points: [100, 100, 120, 110], size: 12, hardness: 1 })
    await settle()

    expect(cleanSoon).toHaveBeenCalled()
  })
})
