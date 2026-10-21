import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { useComic } from '~/composables/useComic'
import { useTranslate } from '~/composables/useTranslate'
import { agreedTranslation, forgetAgreedTranslations, translationEntry, useTranslationSync } from '~/composables/useTranslationSync'

/**
 * A run's words are filed as the run's, however long the save takes.
 *
 * The report: "Translate page" on the page on screen sent its lines twice. The
 * run saves what it wrote itself, with `origin` — engine, model, and the batch
 * that lets the whole press be taken back — and the same `updateMany` that put
 * the lines on the page woke `useTranslationSync`, which half a second later
 * sent the entries it had captured, as typing. If the run's save took longer
 * than that, or failed, the sync's copy landed first: the model's words filed
 * as `engine: 'human'`, pinned, with no revision in the batch. Undo could not
 * take them back, and no later run could move them — a machine's line wearing
 * a person's claim, which is the one thing pinning exists to rule out.
 *
 * So the property here is about the requests themselves: every PUT a run makes
 * carries its origin, and no PUT without one follows it for those lines —
 * whether the save is slow, fails once, or fails outright.
 *
 * Seam: what reaches the translations endpoint, answered by `registerEndpoint`,
 * with the real sync mounted beside the real run. Google is the engine because
 * it needs no key; its request is the one thing faked. Real timers: the settle
 * is 500 ms and the tests wait it out.
 */

const { shared, target, terms, server } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    shared: ref<unknown>(null),
    target: ref('en'),
    terms: ref([]),
    /**
     * How the endpoint treats a run's saves, set per test: how many to refuse
     * with a 503, then how many to hold for `delay` before answering.
     */
    server: { failures: 0, slow: 0, delay: 0, unpin: 0 },
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('useShared', () => () => ({ shared, pageRowOf: () => 7 }))
mockNuxtImport('useTargetLanguage', () => () => ({ target }))
mockNuxtImport('useGlossary', () => () => ({ terms, ready: async () => [], learn: async () => {} }))
mockNuxtImport('useCast', () => () => ({
  ready: async () => ({ members: [], notes: '' }),
  forPrompt: () => ({ members: [], notes: '' }),
  learn: async () => {},
}))
mockNuxtImport('useAiUsage', () => () => ({ record: async () => {} }))
mockNuxtImport('googleTranslateAll', () => async (lines: string[]) => ({
  translations: lines.map((line) => `EN ${line}`),
  failed: 0,
}))

interface Put {
  entries: { blockId: number, text: string, cx?: number | null }[]
  origin?: { engine: string, batch: string | null } | null
  /** Set here when the endpoint turned it away, so a refused try is not read as a save. */
  refused?: boolean
}

const puts: Put[] = []

/**
 * What the server ends up holding for each line — the last write to land. A
 * held request lands when its hold ends, as a request slow on the way in does,
 * which is the order that can put an older frame down over a newer one.
 */
const rows = new Map<number, Put['entries'][number]>()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

registerEndpoint('/api/workspaces/ws/pages/7/translations', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<Put>(event)

    puts.push(body)

    if (body.origin) {
      if (server.failures > 0) {
        server.failures -= 1
        body.refused = true

        throw createError({ statusCode: 503, statusMessage: 'Down for a moment' })
      }

      // Held only as many times as asked, so nothing is still in flight when a
      // test ends — a late answer would agree a line in the next test's map.
      if (server.slow > 0) {
        server.slow -= 1
        await wait(server.delay)
      }
    }

    for (const entry of body.entries) rows.set(entry.blockId, entry)

    return []
  },
})

// Giving up a line's claim before an explicit ask writes over it — held for
// `server.unpin` ms, which is the window the watcher could once send in.
registerEndpoint('/api/workspaces/ws/pages/7/unpin', {
  method: 'POST',
  handler: async () => {
    await wait(server.unpin)

    return { unpinned: 0 }
  },
})

/** Every PUT that said anything about this block. */
const about = (blockId: number) => puts.filter((put) => put.entries.some((entry) => entry.blockId === blockId))

const block = (row: number, source: string, translation = '') => ({
  id: `block:${row}`,
  type: 'bubble',
  x: 10,
  y: row - 30,
  w: 20,
  h: 10,
  source,
  translation,
  confidence: 100,
  hidden: false,
})

describe('a run on the page on screen', () => {
  let scope = effectScope()
  let engine: string

  beforeEach(() => {
    scope = effectScope()
    puts.length = 0
    rows.clear()
    server.failures = 0
    server.slow = 0
    server.delay = 0
    server.unpin = 0
    forgetAgreedTranslations()
    shared.value = { role: 'editor', pages: [{ id: 7 }] }

    const comic = useComic()

    engine = comic.translate.value.engine
    comic.translate.value.engine = 'google'

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [block(40, 'こんにちは'), block(41, 'どうして……')],
      scan: { url: 'blob:x', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'h' },
    }] as unknown as ComicPage[]
    comic.go(0)
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
    useComic().translate.value.engine = engine as never
  })

  const mount = () => scope.run(() => {
    useTranslationSync()

    return useTranslate()
  })!

  it('files a slow save as the run\'s, and sends nothing as typing', async () => {
    server.slow = 1
    server.delay = 900

    const { translateCurrent, error } = mount()

    await wait(20)
    await translateCurrent()
    await wait(700)

    // Once, and as the run's.
    expect(about(40)).toHaveLength(1)
    expect(about(40)[0]!.origin?.engine).toBe('google')
    expect(about(41)).toEqual(about(40))
    expect(error.value).toBeNull()
  })

  it('tries a failed save again under the run\'s name, not as typing', async () => {
    server.failures = 1

    const { translateCurrent, error } = mount()

    await wait(20)
    await translateCurrent()
    await wait(700)

    // Once refused, once filed — both as the run.
    expect(about(40)).toHaveLength(2)
    expect(about(40).every((put) => put.origin?.engine === 'google')).toBe(true)
    expect(new Set(about(40).map((put) => put.origin?.batch)).size).toBe(1)
    expect(error.value).toBeNull()
  })

  /*
   * The watcher still has work to do while the run's save is out — a letterer
   * can move a balloon the run has just filled — and what it sends then is the
   * model's words in a new place. Sent as typing, that move would pin them.
   */
  it('sends a balloon moved during the run\'s save under the run\'s name', async () => {
    server.slow = 1
    server.delay = 1500

    const { translateCurrent } = mount()
    const comic = useComic()

    await wait(20)

    const running = translateCurrent()

    await wait(300)
    comic.pages.value[0]!.blocks[0]!.letter = { x: 12, y: 12, w: 20, h: 10 }
    await nextTick()

    await running
    await wait(700)

    // The run's save, and the move — both the run's.
    expect(about(40)).toHaveLength(2)
    expect(about(40).every((put) => put.origin?.engine === 'google')).toBe(true)

    // And in that order: the move waits for the run's save rather than racing
    // it, so the server is left with the balloon where it was put — (12 + 20 /
    // 2)% across — not where the run's slower request found it.
    expect(rows.get(40)?.cx).toBeCloseTo(0.22)
  })

  /*
   * Not a run, but the same race by another door: asking for one line that
   * reads the same in any language answers it on the spot, then gives up the
   * line's claim, then saves — and a slow unpin used to leave the watcher's
   * settle free to send the answer first, as typing.
   */
  it('saves a line answered as itself as the engine\'s, however slow the unpin', async () => {
    server.unpin = 900

    const { translateBlock } = mount()
    const comic = useComic()

    comic.pages.value[0]!.blocks.push(block(43, '!?') as unknown as Block)
    await wait(20)

    await translateBlock('block:43')
    await wait(700)

    expect(comic.pages.value[0]!.blocks.at(-1)!.translation).toBe('!?')
    expect(about(43)).toHaveLength(1)
    expect(about(43)[0]!.origin?.engine).toBe('google')
  })

  it('says so when the save cannot be made, and later carries the lines as the run\'s', async () => {
    // Every try the run makes is refused; the server is back by the time
    // anything else is sent.
    server.failures = 3

    const { translateCurrent, error } = mount()
    const comic = useComic()

    await wait(20)
    await translateCurrent()
    await wait(700)

    expect(error.value).toMatch(/not saved/)
    expect(puts.every((put) => put.origin)).toBe(true)

    // Somebody then types a line of their own on the same page. Their line is
    // theirs; the run's lines, still owed, go with it — as the run's.
    comic.pages.value[0]!.blocks.push(block(42, 'さようなら', 'Bye') as unknown as Block)
    await nextTick()
    await wait(700)

    const typed = puts.filter((put) => !put.origin)

    expect(typed).toHaveLength(1)
    expect(typed[0]!.entries.map((entry) => entry.blockId)).toEqual([42])

    const filed = puts.filter((put) => put.origin && !put.refused)

    expect(filed).toHaveLength(1)
    expect(filed[0]!.origin?.engine).toBe('google')
    expect(filed[0]!.entries.map((entry) => entry.blockId).sort()).toEqual([40, 41])
  })
})

/**
 * A save waiting out its settle asks again when it fires.
 *
 * The settle captures what differed from the server when it was set; by the
 * time it fires, half a second later, some of that may have been agreed by
 * another road — a run's save, or a re-read after somebody else wrote the same
 * words. Sending the captured copy anyway is how a run's lines went out a
 * second time as typing, so the check is made again at the moment of sending.
 */
describe('the settle', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    puts.length = 0
    forgetAgreedTranslations()
    shared.value = { role: 'editor', pages: [{ id: 7 }] }

    const comic = useComic()

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [block(40, 'こんにちは', 'Hello')],
      scan: { url: 'blob:x', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'h' },
    }] as unknown as ComicPage[]
    comic.go(0)

    agreedTranslation('en', translationEntry(comic.pages.value[0]!.blocks[0]!, 40, { width: 1000, height: 1500 }))
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
  })

  it('does not send a line that was agreed while it waited', async () => {
    const comic = useComic()

    scope.run(() => useTranslationSync())
    await wait(20)

    const line = comic.pages.value[0]!.blocks[0]!

    line.translation = 'Hi'
    await nextTick()
    await wait(100)

    // As a re-read does when somebody else wrote the same words meanwhile.
    agreedTranslation('en', translationEntry(line, 40, { width: 1000, height: 1500 }))
    await wait(700)

    expect(puts).toEqual([])
  })

  it('still sends a line nobody else agreed', async () => {
    const comic = useComic()

    scope.run(() => useTranslationSync())
    await wait(20)

    comic.pages.value[0]!.blocks[0]!.translation = 'Hi'
    await nextTick()
    await wait(700)

    expect(puts).toHaveLength(1)
    expect(puts[0]!.origin).toBeUndefined()
  })
})
