import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import type { Translated, TranslateInput } from '~/utils/openrouter'

import { useComic } from '~/composables/useComic'
import { useTranslate } from '~/composables/useTranslate'
import { forgetAgreedTranslations } from '~/composables/useTranslationSync'

/**
 * Three pages out at once, written one at a time, in page order.
 *
 * A run used to ask about a page, wait out the model, write it, and only then
 * ask about the next. It now keeps three asked and unwritten, and the promises
 * that one-at-a-time kept for free have to be kept on purpose:
 *
 * - **Written in page order**, however the answers arrive — because each page
 *   is written with what the pages before it taught, and the glossary grows
 *   first-translation-wins in that order;
 * - **asked again where that could not be true** — a page answered before the
 *   page ahead of it settled a name it uses (see `askAgain`);
 * - **ended where a refusal happened**, with nothing asked after it written;
 * - **written onto the reading it was asked about, or nowhere.**
 *
 * Seam: `translatePage`, answered by hand, so every test decides which page's
 * answer arrives when — the one thing a real provider never lets you choose.
 * The glossary is a stand-in that folds first-translation-wins the way both real
 * stores do, and the saves land on endpoints that record the order they came in.
 */

interface Ask {
  input: TranslateInput
  /** The page it is about, by its first line. */
  first: string
  answer: (translations: string[], terms?: { src: string, tr: string }[]) => void
  refuse: (why: string) => void
}

const { state, model } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    state: {
      shared: ref<unknown>(null),
      target: ref('en'),
      terms: ref<{ id: number, source: string, target: string }[]>([]),
    },
    model: { asks: [] as Ask[] },
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('useShared', () => () => ({
  shared: state.shared,
  pageRowOf: (page: { id: string }) => 100 + Number(/\d+/.exec(page.id)?.[0]),
}))
mockNuxtImport('useTargetLanguage', () => () => ({ target: state.target }))
mockNuxtImport('useProviderKeys', () => () => ({ require: async () => 'key' }))
mockNuxtImport('useAiUsage', () => () => ({ record: async () => {} }))
mockNuxtImport('useCast', () => () => ({
  ready: async () => ({ members: [], notes: '' }),
  forPrompt: () => ({ members: [], notes: '' }),
  learn: async () => {},
}))

// First translation wins, as `foldTerms` has it in both real stores.
mockNuxtImport('useGlossary', () => () => ({
  terms: state.terms,
  ready: async () => state.terms.value,
  learn: async (learned: { src?: unknown, tr?: unknown }[]) => {
    for (const { src, tr } of learned) {
      const source = String(src ?? '')
      const target = String(tr ?? '')

      if (!source || !target || state.terms.value.some((term) => term.source === source)) continue

      state.terms.value = [...state.terms.value, { id: state.terms.value.length + 1, source, target }]
    }

    return state.terms.value
  },
}))

mockNuxtImport('translatePage', () => (_key: string, input: TranslateInput) =>
  new Promise<Translated>((resolve, reject) => {
    model.asks.push({
      input,
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

/** Every save, in the order the server received them. */
const saved: { page: number, blocks: number[], batch: string | null }[] = []

for (const row of [101, 102, 103, 104, 105]) {
  registerEndpoint(`/api/workspaces/ws/pages/${row}/translations`, {
    method: 'PUT',
    handler: async (event) => {
      const body = await readBody<{ entries: { blockId: number }[], origin?: { batch: string | null } }>(event)

      saved.push({ page: row, blocks: body.entries.map((entry) => entry.blockId), batch: body.origin?.batch ?? null })

      return []
    },
  })
}

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

/** Page `n`, one balloon, saved under row `100 + n` with its block under row `n * 10`. */
const pageOf = (n: number, source: string, id = `block:${n * 10}`) => ({
  id: `scan:${n}.png`,
  name: `${n}.png`,
  blocks: [block(id, source)],
  scan: { url: 'blob:x', file: new File([], `${n}.png`), width: 1000, height: 1500, hash: `h${n}` },
})

/** What each page says now, in page order. */
const lines = () => useComic().pages.value.map((page) => page.blocks.map((each) => each.translation).join(' | '))

/** The ask about the page whose first line is this, the last one made. */
const ask = (first: string) => model.asks.findLast((each) => each.first === first)!

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe('a run of several pages', () => {
  let scope = effectScope()
  let engine: string

  beforeEach(() => {
    scope = effectScope()
    model.asks.length = 0
    saved.length = 0
    state.terms.value = []
    state.shared.value = { role: 'editor', pages: [101, 102, 103, 104, 105].map((id) => ({ id })) }
    forgetAgreedTranslations()

    const comic = useComic()

    engine = comic.translate.value.engine
    comic.translate.value.engine = 'ai-text'
    comic.reset()
  })

  afterEach(async () => {
    // A test that failed part-way leaves its run waiting on an answer, and a
    // run still going makes the next test's press a no-op. Ended here, so one
    // failure reads as one failure.
    for (const each of model.asks) each.refuse('The test is over.')
    await settle()

    scope.stop()
    state.shared.value = null
    useComic().translate.value.engine = engine as never
  })

  const open = (...pages: ReturnType<typeof pageOf>[]) => {
    const comic = useComic()

    comic.pages.value = pages as unknown as ComicPage[]
    comic.go(0)

    return scope.run(() => useTranslate())!
  }

  it('asks about three pages at once and writes them in page order, however they answer', async () => {
    const { translateAll, lastRun } = open(pageOf(1, 'いち'), pageOf(2, 'に'), pageOf(3, 'さん'), pageOf(4, 'よん'))

    const running = translateAll()

    await vi.waitFor(() => expect(model.asks).toHaveLength(3))
    expect(model.asks.map((each) => each.first)).toEqual(['いち', 'に', 'さん'])

    // The third and the second answer first. Neither is written while the
    // first is out, and the fourth is not asked: three are unwritten already.
    ask('さん').answer(['Three'])
    ask('に').answer(['Two'])
    await settle()

    expect(lines()).toEqual(['', '', '', ''])
    expect(saved).toEqual([])
    expect(model.asks).toHaveLength(3)

    ask('いち').answer(['One'])

    await vi.waitFor(() => expect(lines()).toEqual(['One', 'Two', 'Three', '']))
    await vi.waitFor(() => expect(model.asks).toHaveLength(4))

    ask('よん').answer(['Four'])
    await running

    expect(lines()).toEqual(['One', 'Two', 'Three', 'Four'])
    expect(saved.map((each) => each.page)).toEqual([101, 102, 103, 104])

    // One press, one batch — Undo still takes the whole run back.
    expect(new Set(saved.map((each) => each.batch)).size).toBe(1)
    expect(lastRun.value?.pageIds).toEqual(['scan:1.png', 'scan:2.png', 'scan:3.png', 'scan:4.png'])
  })

  /*
   * The glossary loop, with the pages out of step. Page two answers before page
   * one has settled what 宗介 is called, and spells it its own way; page three
   * proposes the same spelling for a name it never uses. Page one's spelling is
   * the one the chapter keeps, as it would have been one page at a time; page
   * two is asked again, told it; page three is not asked again, because nothing
   * it wrote could disagree.
   */
  it('learns in page order, and asks a page again when it spelled a name settled before it differently', async () => {
    const { translateAll } = open(pageOf(1, '宗介が来た'), pageOf(2, '宗介、待って'), pageOf(3, 'いいえ'))

    const running = translateAll()

    await vi.waitFor(() => expect(model.asks).toHaveLength(3))
    expect(model.asks.every((each) => !each.input.glossary?.length)).toBe(true)

    ask('宗介、待って').answer(['Sosuke, wait!'], [{ src: '宗介', tr: 'Sosuke' }])
    ask('いいえ').answer(['No.'], [{ src: '宗介', tr: 'Sosuke' }])
    await settle()

    // Nothing is learned out of order: the page that answered first is not
    // the page that comes first.
    expect(state.terms.value).toEqual([])

    ask('宗介が来た').answer(['Sousuke is here.'], [{ src: '宗介', tr: 'Sousuke' }])

    await vi.waitFor(() => expect(model.asks).toHaveLength(4))

    const again = model.asks[3]!

    expect(again.first).toBe('宗介、待って')
    expect(again.input.glossary).toEqual([{ source: '宗介', target: 'Sousuke' }])

    // Page two's first answer is never written; its second is.
    expect(lines()).toEqual(['Sousuke is here.', '', ''])

    again.answer(['Sousuke, wait!'])
    await running

    expect(lines()).toEqual(['Sousuke is here.', 'Sousuke, wait!', 'No.'])
    expect(state.terms.value.map((term) => `${term.source} → ${term.target}`)).toEqual(['宗介 → Sousuke'])
    expect(model.asks.filter((each) => each.first === 'いいえ')).toHaveLength(1)
  })

  /*
   * A page asked again is a chapter still introducing itself, and asking ahead
   * through such a stretch only buys answers that will be asked for twice. So
   * the run goes back to one page at a time — here, page five waits for page
   * four to be written — until pages land without it again.
   */
  it('goes back to one page at a time after a page had to be asked again', async () => {
    const { translateAll } = open(
      pageOf(1, '宗介が来た'),
      pageOf(2, '宗介、待って'),
      pageOf(3, 'さん'),
      pageOf(4, 'よん'),
      pageOf(5, 'ご'),
    )

    const running = translateAll()

    await vi.waitFor(() => expect(model.asks).toHaveLength(3))

    ask('宗介、待って').answer(['Sosuke, wait!'])
    ask('さん').answer(['Three'])
    ask('宗介が来た').answer(['Sousuke is here.'], [{ src: '宗介', tr: 'Sousuke' }])

    // Page one is written and page four asked, as there was room; then page
    // two is found to disagree and is asked again.
    await vi.waitFor(() => expect(model.asks.map((each) => each.first)).toEqual(['宗介が来た', '宗介、待って', 'さん', 'よん', '宗介、待って']))

    ask('宗介、待って').answer(['Sousuke, wait!'])

    await vi.waitFor(() => expect(lines()).toEqual(['Sousuke is here.', 'Sousuke, wait!', 'Three', '', '']))
    await settle()

    // Room for two more by the old measure, but the run is narrow now.
    expect(model.asks.map((each) => each.first)).not.toContain('ご')

    ask('よん').answer(['Four'])

    await vi.waitFor(() => expect(model.asks.map((each) => each.first)).toContain('ご'))

    ask('ご').answer(['Five'])
    await running

    expect(lines()).toEqual(['Sousuke is here.', 'Sousuke, wait!', 'Three', 'Four', 'Five'])
  })

  it('ends where a refusal happened, and writes nothing that was asked after it', async () => {
    const { translateAll, error, lastRun } = open(pageOf(1, 'いち'), pageOf(2, 'に'), pageOf(3, 'さん'), pageOf(4, 'よん'))

    const running = translateAll()

    await vi.waitFor(() => expect(model.asks).toHaveLength(3))

    // Page three is answered — paid for — before page two is refused.
    ask('さん').answer(['Three'])
    ask('に').refuse('OpenRouter error 402: no credit')
    ask('いち').answer(['One'])
    await running

    expect(lines()).toEqual(['One', '', '', ''])
    expect(error.value).toMatch(/402/)
    expect(model.asks).toHaveLength(3)
    expect(saved.map((each) => each.page)).toEqual([101])
    expect(lastRun.value?.pageIds).toEqual(['scan:1.png'])
  })

  /*
   * The page is read again while its translation is out — a new reading, new
   * blocks under new ids. The answer is about a reading that is gone, so none
   * of it is written, nothing is saved, and nothing it taught is kept to
   * prompt later pages with.
   */
  it('writes nothing onto a reading replaced while the page was out, and learns nothing from it', async () => {
    const { translateAll } = open(pageOf(1, '宗介が来た'))

    const running = translateAll()

    await vi.waitFor(() => expect(model.asks).toHaveLength(1))

    useComic().setBlocks('scan:1.png', [block('block:99', '宗介が来た！')] as unknown as Block[])

    ask('宗介が来た').answer(['Sousuke is here.'], [{ src: '宗介', tr: 'Sousuke' }])
    await running

    expect(lines()).toEqual([''])
    expect(saved).toEqual([])
    expect(state.terms.value).toEqual([])
  })

  /*
   * The other half of "the reading it was asked about": the same block, given
   * its row while the page was out, and renamed for it in place — which is what
   * `useBlockSync.adopt` does to a block read before its page had a row. An
   * answer now carries the name its block had when asked, and a lookup by that
   * name alone would miss it; the block itself is what it is matched to first.
   */
  it('lands on a block that was given its row while the page was out', async () => {
    const { translateAll } = open(pageOf(1, 'いち', 'read:abc:0'))

    const running = translateAll()

    await vi.waitFor(() => expect(model.asks).toHaveLength(1))

    useComic().pages.value[0]!.blocks[0]!.id = 'block:57'

    ask('いち').answer(['One'])
    await running

    expect(lines()).toEqual(['One'])
    expect(saved).toEqual([{ page: 101, blocks: [57], batch: expect.any(String) }])
  })
})
