import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import type { Translated, TranslateInput } from '~/utils/openrouter'

import { useAutoRun } from '~/composables/useAutoRun'
import { useComic } from '~/composables/useComic'
import { forgetAgreedTranslations } from '~/composables/useTranslationSync'

/**
 * The auto run translates one page while it reads and cleans the next.
 *
 * It used to run the four stops strictly in turn, so a page cost its reading
 * plus its translation, and the GPU sat idle while a model thought. Now the
 * translation is handed to one run for the whole press and the auto run goes on
 * to the next page. What that must not change:
 *
 * - translations still land in page order;
 * - a stop asks for nothing more, lets what is out land, and the run is not
 *   over until it has;
 * - and what lands is written only onto the reading it was asked about — a
 *   stop is exactly when a page gets read again while its translation is out.
 *
 * Seam: the engines. Reading and cleaning are stand-ins that take a moment and
 * say what they did (and can be held); the model is `translatePage`, answered
 * by hand. The translation run and everything it writes through are real.
 *
 * Desktop: on a local workspace, the only kind there is. The web build's ran on
 * a cloud one and also checked the order the saves reached the server; here
 * the order is what the pages say, which every test still checks.
 */

interface Ask {
  first: string
  answer: (translations: string[], terms?: { src: string, tr: string }[]) => void
  refuse: (why: string) => void
}

const { state, model, engines } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    state: {
      shared: ref<unknown>(null),
      target: ref('en'),
      terms: ref<{ id: number, source: string, target: string }[]>([]),
      /** Whether this reader has no OpenRouter key to hand. */
      keyless: false,
    },
    model: { asks: [] as Ask[] },
    engines: {
      /** What the stand-ins did, in order: `read 2.png`, `clean 2.png`. */
      done: [] as string[],
      /** Pages whose reading is held until the test lets it go. */
      held: new Map<string, Promise<void>>(),
      /** And how to let each go, for a test that fails before it does. */
      releases: [] as (() => void)[],
      read: async () => {},
      clean: async () => {},
    },
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('useShared', () => () => ({
  shared: state.shared,
  pageRowOf: (page: { id: string }) => 100 + Number(/\d+/.exec(page.id)?.[0]),
}))
mockNuxtImport('useTargetLanguage', () => () => ({ target: state.target }))
mockNuxtImport('useProviderKeys', () => () => ({
  require: async () => {
    if (state.keyless) throw new Error('No OpenRouter key yet — add one in settings.')

    return 'key'
  },
}))
mockNuxtImport('useAiUsage', () => () => ({ record: async () => {} }))
mockNuxtImport('useReadingDirection', () => () => ({ direction: { value: 'rtl' } }))
mockNuxtImport('useBlockMerge', () => () => ({ merge: async () => null }))
mockNuxtImport('useCast', () => () => ({
  ready: async () => ({ members: [], notes: '' }),
  forPrompt: () => ({ members: [], notes: '' }),
  learn: async () => {},
}))
mockNuxtImport('useGlossary', () => () => ({
  terms: state.terms,
  ready: async () => state.terms.value,
  learn: async (learned: { src?: unknown, tr?: unknown }[]) => {
    for (const { src, tr } of learned) {
      if (!state.terms.value.some((term) => term.source === src)) {
        state.terms.value = [...state.terms.value, { id: state.terms.value.length + 1, source: String(src), target: String(tr) }]
      }
    }

    return state.terms.value
  },
}))

mockNuxtImport('useOcr', () => () => ({
  canRead: { value: true },
  readCurrent: () => engines.read(),
  error: { value: null },
  progress: { value: null },
}))

mockNuxtImport('useClean', () => () => ({
  settings: { value: { model: 'aot' } },
  canClean: { value: true },
  cleanCurrent: () => engines.clean(),
  error: { value: null },
  progress: { value: null },
}))

mockNuxtImport('translatePage', () => (_key: string, input: TranslateInput) =>
  new Promise<Translated>((resolve, reject) => {
    model.asks.push({
      first: input.blocks[0] ?? '',
      answer: (translations, terms = []) => resolve({
        translations,
        unreadable: [],
        source: 'ja',
        usage: null,
        learnedTerms: terms,
        learnedCast: [],
      }),
      refuse: (why) => reject(new Error(why)),
    })
  }))

/** What each page's one balloon says, printed. */
const SOURCES: Record<string, string> = { '1.png': '宗介が来た', '2.png': 'どうして', '3.png': 'いいえ' }

const block = (id: string, source: string) => ({
  id,
  type: 'bubble',
  x: 10,
  y: 10,
  w: 20,
  h: 10,
  source,
  translation: '',
  confidence: 100,
  hidden: false,
})

const pageOf = (n: number) => ({
  id: `scan:${n}.png`,
  name: `${n}.png`,
  blocks: [],
  scan: { url: 'blob:x', file: new File([], `${n}.png`), width: 1000, height: 1500, hash: `h${n}` },
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What each page says now, in page order. */
const lines = () => useComic().pages.value.map((page) => page.blocks.map((each) => each.translation).join(' | '))

const ask = (first: string) => model.asks.findLast((each) => each.first === first)!

/** A reading held until the returned function is called. */
function hold (name: string): () => void {
  let release = () => {}

  engines.held.set(name, new Promise<void>((resolve) => { release = resolve }))
  engines.releases.push(() => release())

  return () => release()
}

describe('the auto run', () => {
  let scope = effectScope()
  let engine: string

  beforeEach(() => {
    scope = effectScope()
    model.asks.length = 0
    engines.done.length = 0
    engines.held.clear()
    state.terms.value = []
    state.keyless = false
    forgetAgreedTranslations()

    // Reading puts the page's one balloon on it, as the page on screen — which
    // is what the real one reads — and takes a moment about it.
    engines.read = async () => {
      const comic = useComic()
      const here = comic.page.value!

      engines.done.push(`read ${here.name}`)
      await pause(5)
      await engines.held.get(here.name)

      comic.setBlocks(here.id, [block(`block:${Number.parseInt(here.name) * 10}`, SOURCES[here.name]!)] as unknown as Block[])
      engines.done.push(`read ${here.name} done`)
    }

    engines.clean = async () => {
      engines.done.push(`clean ${useComic().page.value!.name}`)
      await pause(5)
    }

    const comic = useComic()

    engine = comic.translate.value.engine
    comic.translate.value.engine = 'ai-text'
    comic.reset()
    comic.pages.value = [pageOf(1), pageOf(2), pageOf(3)] as unknown as ComicPage[]
    comic.go(0)
  })

  afterEach(async () => {
    // A test that failed part-way leaves its run waiting on a reading or an
    // answer, and a run still going makes the next test's press a no-op.
    // Ended here, so one failure reads as one failure.
    for (const release of engines.releases) release()
    for (const each of model.asks) each.refuse('The test is over.')
    await pause(60)

    engines.releases.length = 0
    scope.stop()
    state.shared.value = null
    useComic().translate.value.engine = engine as never
  })

  const mount = () => {
    const auto = scope.run(() => useAutoRun())!

    auto.settings.value.steps = { read: true, join: false, clean: true, translate: true }
    auto.settings.value.scope = 'range'
    auto.setRange(null)

    return auto
  }

  it('reads and cleans the next page while this one is out, and still writes them in order', async () => {
    const { start, outcome } = mount()

    const running = start()

    // Page one is out, unanswered — and page two is read and cleaned meanwhile.
    await vi.waitFor(() => expect(model.asks.map((each) => each.first)).toContain('宗介が来た'))
    await vi.waitFor(() => expect(engines.done).toContain('clean 2.png'))

    expect(lines()).toEqual(['', '', ''])

    // All three out at once; the last answers first.
    await vi.waitFor(() => expect(model.asks).toHaveLength(3))

    ask('いいえ').answer(['No.'])
    ask('どうして').answer(['Why?'])
    await pause(40)

    expect(lines()).toEqual(['', '', ''])

    ask('宗介が来た').answer(['Sousuke is here.'])
    await running

    expect(lines()).toEqual(['Sousuke is here.', 'Why?', 'No.'])
    expect(outcome.value).toMatchObject({ pages: 3, error: null, stopped: false })
  })

  /*
   * The reader stops while page two is being read and page one's translation
   * is out — and page one is then read again, as a reader who stopped to fix
   * something might. The answer arrives for a reading that is gone: none of it
   * is written, nothing is saved or learned, page two is never handed over,
   * and the run is not over until the answer has arrived and been let go.
   */
  it('stops without leaving a page translated from a reading that was then replaced', async () => {
    const letGo = hold('2.png')
    const { start, stop, running, outcome } = mount()

    const run = start()

    await vi.waitFor(() => expect(model.asks).toHaveLength(1))
    await vi.waitFor(() => expect(engines.done).toContain('read 2.png'))

    stop()

    useComic().setBlocks('scan:1.png', [block('block:77', '宗介が来た！')] as unknown as Block[])

    letGo()
    await pause(40)

    // Stopped at the next stop — but still running, with page one out.
    expect(engines.done).not.toContain('clean 2.png')
    expect(running.value).toBe(true)

    ask('宗介が来た').answer(['Sousuke is here.'], [{ src: '宗介', tr: 'Sousuke' }])
    await run

    expect(running.value).toBe(false)
    expect(lines()).toEqual(['', '', ''])
    expect(state.terms.value).toEqual([])
    expect(model.asks).toHaveLength(1)
    expect(outcome.value).toMatchObject({ pages: 0, stopped: true, error: null })
  })

  /*
   * The press opens its translation run before reading anything, and asking
   * for the key there would end a run over a chapter already carried over — one
   * that never needed a model, and never used to ask.
   */
  it('asks for no key where nothing is left to carry over', async () => {
    state.keyless = true

    const comic = useComic()

    for (const page of comic.pages.value) {
      const read = block(`block:${Number.parseInt(page.name) * 10}`, SOURCES[page.name]!)

      comic.setBlocks(page.id, [{ ...read, translation: 'Done.' }] as unknown as Block[])
    }

    const { start, outcome } = mount()

    await start()

    expect(outcome.value).toMatchObject({ error: null, pages: 3 })
    expect(outcome.value?.skipped).toContain('nothing left to carry over')
    expect(model.asks).toEqual([])
  })

  it('ends at the next stop when a translation is refused while the next page is read', async () => {
    const letGo = hold('2.png')
    const { start, outcome } = mount()

    const run = start()

    await vi.waitFor(() => expect(engines.done).toContain('read 2.png'))
    await vi.waitFor(() => expect(model.asks).toHaveLength(1))

    ask('宗介が来た').refuse('OpenRouter error 402: no credit')
    await pause(20)
    letGo()
    await run

    expect(engines.done).not.toContain('clean 2.png')
    expect(outcome.value).toMatchObject({ error: expect.stringMatching(/402/), failed: 'translate', pages: 0 })
  })
})
