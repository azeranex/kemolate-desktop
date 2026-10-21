import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiModel } from '#shared/utils/models'

import { translatePage } from '~/utils/openrouter'

/**
 * DeepSeek straight from DeepSeek, on a DeepSeek key — desktop only.
 *
 * The errand is shared with OpenRouter's (see `DEEPSEEK` in `utils/openrouter`)
 * and so is the wire format, so what is pinned here is only what differs: where
 * the request goes, the model's name as DeepSeek spells it (both Flash entries
 * are `deepseek-flash` there), thinking switched by `thinking` rather than
 * `reasoning`, and a cost estimated where DeepSeek gives only tokens. And that
 * the key is told apart from OpenRouter's by the model and the key together.
 *
 * Seam: `fetch`, answered as DeepSeek's chat completions answer.
 */

const flash: AiModel = {
  id: 'deepseek/deepseek-v4.1-flash',
  label: 'DeepSeek V4.1 Flash',
  note: '',
  vision: true,
  price: { in: 0.3, out: 1.2 },
}

const pro: AiModel = { ...flash, id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vision: false }

const page = JSON.stringify({ source_language: 'zh', translations: ['Hello'], glossary: [], cast: [] })

const reply = () => vi.fn(async (_url: string, _init: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: page, reasoning_content: 'mulling' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1_000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 } },
  }),
}))

const bodyOf = (fetch: ReturnType<typeof reply>) => JSON.parse(String(fetch.mock.calls[0]![1].body))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a DeepSeek key', () => {
  it('asks DeepSeek, by its name for the model, and estimates what it cost', async () => {
    const fetch = reply()

    vi.stubGlobal('fetch', fetch)

    const result = await translatePage('sk-0123abcd', { blocks: ['你好'], target: 'en', model: flash, effort: 'low' })

    const [url, init] = fetch.mock.calls[0]!
    const body = bodyOf(fetch)

    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-0123abcd')
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
    expect(body.reasoning).toBeUndefined()
    expect(body.usage).toBeUndefined()

    expect(result.translations).toEqual(['Hello'])
    expect(result.usage).toEqual({ input: 1_000, output: 200, reasoning: 50, cost: (1_000 * 0.3 + 200 * 1.2) / 1_000_000 })
  })

  it('switches thinking off for Fast, and sends nothing for auto', async () => {
    const off = reply()

    vi.stubGlobal('fetch', off)
    await translatePage('sk-0123abcd', { blocks: ['你好'], target: 'en', model: pro, effort: 'none' })

    expect(bodyOf(off).model).toBe('deepseek-v4-pro')
    expect(bodyOf(off).thinking).toEqual({ type: 'disabled' })
    expect(bodyOf(off).reasoning_effort).toBeUndefined()

    const auto = reply()

    vi.stubGlobal('fetch', auto)
    await translatePage('sk-0123abcd', { blocks: ['你好'], target: 'en', model: pro, effort: 'auto' })

    expect(bodyOf(auto).thinking).toBeUndefined()
  })

  it('files the retired V4 Flash under the Flash DeepSeek serves in its place', async () => {
    const fetch = reply()

    vi.stubGlobal('fetch', fetch)
    await translatePage('sk-0123abcd', { blocks: ['你好'], target: 'en', model: { ...flash, id: 'deepseek/deepseek-v4-flash' } })

    expect(bodyOf(fetch).model).toBe('deepseek-flash')
  })

  it('names DeepSeek when the key is turned away', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => '' })))

    await expect(translatePage('sk-0123abcd', { blocks: ['你好'], target: 'en', model: flash })).rejects.toThrow(/^DeepSeek rejected the API key/)
  })

  it('leaves an OpenRouter key going to OpenRouter, for a DeepSeek model too', async () => {
    const fetch = reply()

    vi.stubGlobal('fetch', fetch)
    await translatePage('sk-or-v1-test', { blocks: ['你好'], target: 'en', model: flash })

    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(bodyOf(fetch).model).toBe('deepseek/deepseek-v4.1-flash')
  })
})
