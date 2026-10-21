import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it } from 'vitest'

import { clearNuxtState } from '~/composables/nuxt'
import { useComic } from '~/composables/useComic'
import { useModels } from '~/composables/useModels'

/**
 * Desktop: what the catalogue does to the list — `useModels.refresh`.
 *
 * Two things, both asked for by the reader on 2026-10-21. Claude is always its
 * newest: each Claude entry tracks its family and moves to the highest version
 * OpenRouter has, taking the reader's choice with it. And OpenRouter's free
 * models are offered, from the catalogue, since they come and go by the week.
 * A free model chosen while the catalogue is out of reach must stay itself —
 * the first entry is a paid one.
 *
 * Seam: OpenRouter's public model list, answered by `registerEndpoint`.
 */

const per = (dollars: number) => String(dollars / 1_000_000)

const CATALOGUE = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', pricing: { prompt: per(2), completion: per(10) }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'anthropic/claude-sonnet-6', name: 'Anthropic: Claude Sonnet 6', pricing: { prompt: per(3), completion: per(15) }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', pricing: { prompt: per(1), completion: per(5) }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'acme/sees:free', name: 'Acme: Sees (free)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'acme/reads:free', name: 'Acme: Reads (free)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'acme/paints:free', name: 'Acme: Paints (free)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
]

let answering = true

registerEndpoint('/api/v1/models', () => {
  if (!answering) return new Response('down', { status: 503 })

  return { data: CATALOGUE }
})

describe('useModels', () => {
  beforeEach(() => {
    answering = true
    clearNuxtState('ai-models')
    clearNuxtState('ai-models-fetched')
    useComic().translate.value.model = 'anthropic/claude-sonnet-5.5'
  })

  it('moves Claude Sonnet to its newest version, and the choice with it', async () => {
    const { models, refresh } = useModels()

    await refresh()

    const sonnet = models.value.find((model) => model.family === 'anthropic/claude-sonnet')!

    expect(sonnet).toMatchObject({ id: 'anthropic/claude-sonnet-6', label: 'Claude Sonnet 6', priced: true, price: { in: 3, out: 15 } })
    expect(useComic().translate.value.model).toBe('anthropic/claude-sonnet-6')
  })

  it('answers an older version with its family\'s entry', async () => {
    const { byId, refresh } = useModels()

    await refresh()

    expect(byId('anthropic/claude-sonnet-5').id).toBe('anthropic/claude-sonnet-6')
    expect(byId('anthropic/claude-haiku-4.5').id).toBe('anthropic/claude-haiku-5.5')
  })

  it('offers the free models that write text, those that can see first', async () => {
    const { models, refresh } = useModels()

    await refresh()

    const free = models.value.filter((model) => model.free)

    expect(free.map((model) => [model.id, model.label, model.vision])).toEqual([
      ['acme/sees:free', 'Acme: Sees', true],
      ['acme/reads:free', 'Acme: Reads', false],
    ])
    expect(free.every((model) => model.price.in === 0 && model.price.out === 0)).toBe(true)
  })

  it('keeps a free choice itself when the catalogue cannot be reached — never the paid first entry', async () => {
    answering = false

    const { byId, refresh } = useModels()

    await refresh()

    expect(byId('acme/sees:free')).toMatchObject({ id: 'acme/sees:free', free: true, price: { in: 0, out: 0 } })
  })
})
