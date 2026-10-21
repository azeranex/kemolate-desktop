import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import type { Translated, TranslateInput } from '~/utils/openrouter'

import { useComic } from '~/composables/useComic'
import { useTranslate } from '~/composables/useTranslate'
import { forgetAgreedTranslations } from '~/composables/useTranslationSync'

/**
 * What a run makes of a reply that is not all lines.
 *
 * `translatePage` now reads each element of the reply as the line it is, and
 * where one is not a line at all it leaves an empty string and says which (see
 * `lineOf` in `utils/openrouter`). The half that matters here is the run's: it
 * used to call `.trim()` on whatever came back, so a single `null` in the list
 * threw — after the page had been paid for — and stopped the run. Now the good
 * lines land, the bad one stays a gap, and the reader is told.
 *
 * Seam: `translatePage`, answered here, so nothing reaches a provider; the
 * errand's own reading of a reply is `test/app/utils/openrouter.test.ts`.
 *
 * Desktop: on a local workspace, the only kind there is — the web build's ran
 * on a cloud one, whose save this app has no server to make.
 */

const { shared, target, terms, reply } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    shared: ref<unknown>(null),
    target: ref('en'),
    terms: ref([]),
    reply: { next: null as null | ((input: TranslateInput) => Promise<Translated>) },
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
mockNuxtImport('useProviderKeys', () => () => ({ require: async () => 'key' }))
mockNuxtImport('translatePage', () => (_key: string, input: TranslateInput) => reply.next!(input))

registerEndpoint('/api/workspaces/ws/pages/7/translations', { method: 'PUT', handler: () => [] })

const block = (row: number, source: string) => ({
  id: `block:${row}`,
  type: 'bubble',
  x: 10,
  y: row - 30,
  w: 20,
  h: 10,
  source,
  translation: '',
  confidence: 100,
  hidden: false,
})

const answer = (translations: string[], unreadable: number[] = []): Translated => ({
  translations,
  unreadable,
  source: 'ja',
  usage: null,
  learnedTerms: [],
  learnedCast: [],
})

describe('a reply that is not all lines', () => {
  let scope = effectScope()
  let engine: string

  beforeEach(() => {
    scope = effectScope()
    forgetAgreedTranslations()

    const comic = useComic()

    engine = comic.translate.value.engine
    comic.translate.value.engine = 'ai-text'

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [block(40, 'こんにちは'), block(41, 'どうして……'), block(42, 'さようなら')],
      scan: { url: 'blob:x', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'h' },
    }] as unknown as ComicPage[]
    comic.go(0)
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
    useComic().translate.value.engine = engine as never
  })

  it('lands the good lines, leaves the unreadable one a gap, and says so', async () => {
    reply.next = async () => answer(['Hello', '', 'Goodbye'], [1])

    const { translateCurrent, error } = scope.run(() => useTranslate())!

    await translateCurrent()

    const lines = useComic().pages.value[0]!.blocks.map((each) => each.translation)

    expect(lines).toEqual(['Hello', '', 'Goodbye'])
    expect(error.value).toMatch(/1 line came back .* as something other than text/)
  })

  it('says nothing for a reply whose lines were all lines', async () => {
    reply.next = async () => answer(['Hello', 'Why...', 'Goodbye'])

    const { translateCurrent, error } = scope.run(() => useTranslate())!

    await translateCurrent()

    expect(error.value).toBeNull()
  })

  it('says it is asking again while the errand waits out a refusal', async () => {
    const { translateCurrent, progress } = scope.run(() => useTranslate())!

    let said = ''

    reply.next = async (input) => {
      input.retrying?.(4_000)
      said = progress.value?.message ?? ''

      return answer(['Hello', 'Why...', 'Goodbye'])
    }

    await translateCurrent()

    expect(said).toMatch(/asking again in 4 s/)
  })
})
