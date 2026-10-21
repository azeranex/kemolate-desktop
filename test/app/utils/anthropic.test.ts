import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiModel } from '#shared/utils/models'

import { translatePage } from '~/utils/openrouter'

/**
 * Claude straight from Anthropic, on an Anthropic key — desktop only.
 *
 * The errand is shared with OpenRouter's (see `ANTHROPIC` in `utils/openrouter`),
 * so what is pinned here is only what differs on the wire: where the request
 * goes and with what headers, the model's name as Anthropic spells it, a
 * thinking budget for an effort that asks for one, and the reply read back —
 * the text blocks rather than the thinking, a cut-off refused, and a cost
 * estimated where Anthropic gives only tokens.
 *
 * Seam: `fetch`, answered as Anthropic's Messages API answers.
 */

const claude: AiModel = {
  id: 'anthropic/claude-sonnet-5.5',
  label: 'Claude Sonnet 5.5',
  note: '',
  vision: true,
  price: { in: 3, out: 15 },
}

const reply = (text: string, extra: Record<string, unknown> = {}) => vi.fn(async (_url: string, _init: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => ({
    content: [{ type: 'thinking', thinking: 'mulling' }, { type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000, output_tokens: 200 },
    ...extra,
  }),
}))

const page = JSON.stringify({ source_language: 'ja', translations: ['Hello'], glossary: [], cast: [] })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an Anthropic key', () => {
  it('asks Anthropic, by its name for the model, with the headers a browser needs', async () => {
    const fetch = reply(page)

    vi.stubGlobal('fetch', fetch)

    const result = await translatePage('sk-ant-test', { blocks: ['こんにちは'], target: 'en', model: claude, effort: 'medium' })

    const [url, init] = fetch.mock.calls[0]!
    const headers = init.headers as Record<string, string>
    const body = JSON.parse(String(init.body))

    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 6_000 })
    expect(body.reasoning).toBeUndefined()

    // The text block, not the thinking one; the cost from the model's prices.
    expect(result.translations).toEqual(['Hello'])
    expect(result.usage).toEqual({ input: 1_000, output: 200, reasoning: 0, cost: (1_000 * 3 + 200 * 15) / 1_000_000 })
  })

  it('sends no thinking where the effort asks for none', async () => {
    const fetch = reply(page)

    vi.stubGlobal('fetch', fetch)

    await translatePage('sk-ant-test', { blocks: ['こんにちは'], target: 'en', model: claude, effort: 'none' })

    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).thinking).toBeUndefined()
  })

  it('refuses a reply cut off at the limit', async () => {
    vi.stubGlobal('fetch', reply('{"translations": ["Hel', { stop_reason: 'max_tokens' }))

    await expect(translatePage('sk-ant-test', { blocks: ['こんにちは'], target: 'en', model: claude })).rejects.toThrow(/cut off/)
  })

  it('names Anthropic when the key is turned away', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => '' })))

    await expect(translatePage('sk-ant-test', { blocks: ['こんにちは'], target: 'en', model: claude })).rejects.toThrow(/^Anthropic rejected the API key/)
  })

  it('leaves an OpenRouter key going to OpenRouter', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: page } }] }) }))

    vi.stubGlobal('fetch', fetch)

    await translatePage('sk-or-test', { blocks: ['こんにちは'], target: 'en', model: claude })

    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/chat/completions')
  })
})
