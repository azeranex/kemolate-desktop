import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useProviderKeys } from '~/composables/useProviderKeys'

/**
 * Which key a model is spent with — `require`.
 *
 * A model of a family whose own service the reader has a key for goes there
 * (Claude to Anthropic, DeepSeek to DeepSeek); anything else, and those without
 * their own key, to OpenRouter. And the refusal names the keys that would do,
 * rather than only OpenRouter to somebody holding the family's own.
 *
 * Seam: the preload's key store, as `window.kemolate.keys`.
 */

let stored: Record<string, string> = {}

const deepseek = { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
const claude = { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' }
const gemini = { id: 'google/gemini-3-flash', label: 'Gemini 3 Flash' }

beforeEach(() => {
  stored = {}
  ;(window as unknown as { kemolate: unknown }).kemolate = {
    keys: { get: async (provider: string) => stored[provider] ?? null },
  }
  // Keys held in memory are module-level; dropped so each test reads its own.
  useProviderKeys().keys.value = {}
})

afterEach(() => {
  delete (window as unknown as { kemolate?: unknown }).kemolate
})

describe('require', () => {
  it('spends a DeepSeek key on a DeepSeek model, and only there', async () => {
    stored = { deepseek: 'sk-ds', openrouter: 'sk-or-v1-x' }

    const { require } = useProviderKeys()

    expect(await require('openrouter', deepseek)).toBe('sk-ds')
    expect(await require('openrouter', claude)).toBe('sk-or-v1-x')
    expect(await require('openrouter', gemini)).toBe('sk-or-v1-x')
  })

  it('falls back to OpenRouter for a DeepSeek model without a DeepSeek key', async () => {
    stored = { openrouter: 'sk-or-v1-x' }

    expect(await useProviderKeys().require('openrouter', deepseek)).toBe('sk-or-v1-x')
  })

  it('says which keys would do', async () => {
    const { require } = useProviderKeys()

    await expect(require('openrouter', deepseek)).rejects.toThrow('add a DeepSeek or an OpenRouter key')

    stored = { deepseek: 'sk-ds' }

    await expect(require('openrouter', gemini)).rejects.toThrow('a DeepSeek key reaches only DeepSeek. Pick a DeepSeek model')
  })

  it('still sends Claude to Anthropic', async () => {
    stored = { anthropic: 'sk-ant-x', openrouter: 'sk-or-v1-x' }

    expect(await useProviderKeys().require('openrouter', claude)).toBe('sk-ant-x')
  })
})
