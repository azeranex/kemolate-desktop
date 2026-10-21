import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import type { Shortened, ShortenInput } from '~/utils/openrouter'

import { shortenPrompt } from '#shared/utils/prompt'
import { useComic } from '~/composables/useComic'
import { useTranslate } from '~/composables/useTranslate'
import { forgetAgreedTranslations } from '~/composables/useTranslationSync'

/**
 * "Shorten to fit": the letterer sending a line back for fewer characters.
 *
 * The property that matters most is the one a person cannot see from the page:
 * a line somebody typed is pinned on the server, and a machine write does not
 * move a pinned head — so a shortening that only wrote the new words would
 * *look* applied while the server kept the long line, and the long line would
 * come back on the next reload. The press is the reader asking for this
 * wording, so the claim has to be given up before the save, and the save has to
 * carry a machine origin (engine, model, a fresh batch) so the revision list
 * names who shortened it and Undo can take it back.
 *
 * Seam: `shortenLine`, answered here, so nothing reaches a provider; and the
 * two endpoints, standing in for a server that honours `pinned` the way
 * `translations.putOnPage` does.
 *
 * Desktop: on a local workspace, the only kind there is, so the pinning above is
 * the server's and does not arise — a local line is whatever was written last.
 * The endpoints stay, and nothing calls them, so the tests that say nothing
 * reached a server still say it; the first test, which was about the server's
 * head and revisions, checks what a local run keeps instead: the words, the run
 * offered for Undo, and the spend.
 */

const { shared, target, reply, ledger } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    shared: ref<unknown>(null),
    target: ref('en'),
    reply: { next: null as null | ((input: ShortenInput) => Promise<Shortened>) },
    ledger: [] as { what?: string, model: string }[],
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('useShared', () => () => ({ shared, pageRowOf: () => 7 }))
mockNuxtImport('useTargetLanguage', () => () => ({ target }))
mockNuxtImport('useGlossary', () => () => ({
  terms: { value: [] },
  ready: async () => [{ source: '山田', target: 'Yamada' }],
  learn: async () => {},
}))
mockNuxtImport('useCast', () => () => ({
  ready: async () => ({ members: [], notes: '' }),
  forPrompt: () => ({ members: [], notes: '' }),
  learn: async () => {},
}))
mockNuxtImport('useAiUsage', () => () => ({ record: async (use: { what?: string, model: string }) => { ledger.push(use) } }))
mockNuxtImport('useProviderKeys', () => () => ({ require: async () => 'key' }))
mockNuxtImport('shortenLine', () => (_key: string, input: ShortenInput) => reply.next!(input))

interface Origin { engine: string, model: string | null, batch: string | null }

/** One line on the server: its head, whether a person has claimed it, and every wording it has had. */
const server = {
  head: '',
  pinned: false,
  revisions: [] as { text: string, origin: Origin | null }[],
  /** In the order they arrived, so "unpin before the save" is a fact about requests. */
  calls: [] as string[],
}

registerEndpoint('/api/workspaces/ws/pages/7/unpin', {
  method: 'POST',
  handler: () => {
    server.calls.push('unpin')
    server.pinned = false

    return { unpinned: 1 }
  },
})

// `putOnPage`'s rule, in miniature: a machine write always files a revision and
// moves the head only while the line is unpinned.
registerEndpoint('/api/workspaces/ws/pages/7/translations', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<{ entries: { blockId: number, text: string }[], origin?: Origin | null }>(event)

    server.calls.push(body.origin ? 'put:machine' : 'put:typing')

    for (const entry of body.entries.filter((each) => each.blockId === 40)) {
      server.revisions.push({ text: entry.text, origin: body.origin ?? null })

      if (!body.origin) server.pinned = true
      if (!body.origin || !server.pinned) server.head = entry.text
    }

    return []
  },
})

const LONG = 'Yamada, why would you ever say something like that to me?'

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

describe('shortenBlock', () => {
  let scope = effectScope()
  let engine: string
  let model: string

  beforeEach(() => {
    scope = effectScope()
    forgetAgreedTranslations()
    ledger.length = 0
    server.head = LONG
    server.pinned = true
    server.revisions = []
    server.calls = []

    const comic = useComic()

    engine = comic.translate.value.engine
    model = comic.translate.value.model
    comic.translate.value.engine = 'ai-text'

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [block(39, 'ねえ', 'Hey'), block(40, '山田、どうしてそんなことを言うの？', LONG)],
      scan: { url: 'blob:x', file: new File([], '1.png'), width: 1000, height: 1500, hash: 'h' },
    }] as unknown as ComicPage[]
    comic.go(0)
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
    useComic().translate.value.engine = engine as never
    useComic().translate.value.model = model
  })

  const line = () => useComic().pages.value[0]!.blocks[1]!

  it('replaces the line, offered for Undo as a run of its own', async () => {
    reply.next = async () => ({ text: 'Yamada, why say that?', usage: { input: 200, output: 8, reasoning: 0, cost: 0.0001 } })

    const { shortenBlock, error, lastRun } = scope.run(() => useTranslate())!

    const text = await shortenBlock(line(), 24)

    expect(text).toBe('Yamada, why say that?')
    expect(line().translation).toBe('Yamada, why say that?')
    expect(error.value).toBeNull()

    // One line, offered for Undo, and nothing sent anywhere.
    expect(lastRun.value).toEqual({ batch: expect.any(String), pageIds: ['scan:1.png'], lines: 1 })
    expect(server.calls).toEqual([])

    // Paid for, and labelled as what it was.
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.what).toBe('shorten')
  })

  it('passes the budget, the source, the glossary and the page into the prompt', async () => {
    let asked: ShortenInput | null = null

    reply.next = async (input) => {
      asked = input

      return { text: 'Why say that?', usage: null }
    }

    const { shortenBlock } = scope.run(() => useTranslate())!

    await shortenBlock(line(), 24)

    const prompt = shortenPrompt(asked!)

    expect(asked!.budget).toBe(24)
    expect(prompt).toContain('at most 24 characters')
    expect(prompt).toContain('Original: 山田、どうしてそんなことを言うの？')
    expect(prompt).toContain(`Current English: ${LONG}`)
    expect(prompt).toContain('山田 → Yamada')
    expect(prompt).toContain('  Hey')
    expect(prompt).toContain(`→ ${LONG}`)
  })

  it('refuses on Google, before anything is asked or given up', async () => {
    useComic().translate.value.engine = 'google'
    reply.next = async () => { throw new Error('should not be asked') }

    const { shortenBlock, error } = scope.run(() => useTranslate())!

    expect(await shortenBlock(line(), 24)).toBeNull()
    expect(error.value).toMatch(/needs an AI engine/)
    expect(line().translation).toBe(LONG)
    expect(server.calls).toEqual([])
  })

  it('refuses a line with no translation yet', async () => {
    reply.next = async () => { throw new Error('should not be asked') }

    const { shortenBlock, error } = scope.run(() => useTranslate())!
    const empty = line()

    empty.translation = ''

    expect(await shortenBlock(empty, 24)).toBeNull()
    expect(error.value).toMatch(/no translation yet/)
    expect(server.calls).toEqual([])
  })

  it('applies a reply still over budget, and hands it back to be measured', async () => {
    reply.next = async () => ({ text: 'Yamada, why would you say that?', usage: null })

    const { shortenBlock } = scope.run(() => useTranslate())!

    const text = await shortenBlock(line(), 10)

    expect(text).toBe('Yamada, why would you say that?')
    expect(line().translation).toBe(text)
  })

  /** Somebody retyped the line while the model thought: theirs is the newer decision. */
  it('leaves a line that changed while it was out, and keeps its claim', async () => {
    const { shortenBlock, error } = scope.run(() => useTranslate())!

    reply.next = async () => {
      line().translation = 'Why?!'

      return { text: 'Yamada, why say that?', usage: null }
    }

    expect(await shortenBlock(line(), 24)).toBeNull()
    expect(line().translation).toBe('Why?!')
    expect(error.value).toMatch(/changed while it was being shortened/)
    expect(server.calls).not.toContain('unpin')
    expect(server.calls).not.toContain('put:machine')
  })

  it('leaves the line and its claim alone when the request fails', async () => {
    reply.next = async () => { throw new Error('OpenRouter rejected the API key — check it in settings.') }

    const { shortenBlock, error, running } = scope.run(() => useTranslate())!

    expect(await shortenBlock(line(), 24)).toBeNull()
    expect(error.value).toMatch(/rejected the API key/)
    expect(line().translation).toBe(LONG)
    expect(server.calls).toEqual([])
    expect(running.value).toBe(false)
  })
})
