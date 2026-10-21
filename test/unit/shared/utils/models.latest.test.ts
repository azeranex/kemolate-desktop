import { describe, expect, it } from 'vitest'

import { AI_MODELS, freeModel, isFreeModel, labelFor, modelFamilyOf, newestIn } from '#shared/utils/models'

/**
 * Desktop: Claude's families always on their newest version, and OpenRouter's
 * free models offered from its catalogue — the pure half of both, in
 * `shared/utils/models.ts` (`AiModel.family`, `isFreeModel`). What `useModels`
 * does with them is `test/app/composables/useModels.test.ts`.
 */
describe('newestIn', () => {
  it('picks the highest version, part by part', () => {
    expect(newestIn('anthropic/claude-haiku', ['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5'])).toBe('anthropic/claude-haiku-5.5')
    expect(newestIn('anthropic/claude-sonnet', ['anthropic/claude-sonnet-5.9', 'anthropic/claude-sonnet-5.10'])).toBe('anthropic/claude-sonnet-5.10')
    expect(newestIn('anthropic/claude-opus', ['anthropic/claude-opus-5.5', 'anthropic/claude-opus-6'])).toBe('anthropic/claude-opus-6')
  })

  it('passes over other families, snapshots and tags', () => {
    expect(newestIn('anthropic/claude-sonnet', [
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-sonnet-6:beta',
      'anthropic/claude-sonnet-6-20270101',
      'anthropic/claude-opus-7',
    ])).toBe('anthropic/claude-sonnet-5.5')
    expect(newestIn('anthropic/claude-haiku', ['openai/gpt-6'])).toBeNull()
  })
})

describe('modelFamilyOf and labelFor', () => {
  it('know a version of a tracked family, and only those', () => {
    expect(modelFamilyOf('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku')
    expect(modelFamilyOf('anthropic/claude-sonnet-6')).toBe('anthropic/claude-sonnet')
    expect(modelFamilyOf('anthropic/claude-fable-5.1')).toBeNull()
    expect(modelFamilyOf('google/gemini-3.8-flash')).toBeNull()
    expect(modelFamilyOf(null)).toBeNull()
  })

  it('has every Claude entry tracking its family, on that family\'s id', () => {
    for (const model of AI_MODELS.filter((one) => one.id.startsWith('anthropic/'))) {
      expect(model.family && modelFamilyOf(model.id)).toBe(model.family)
    }
  })

  it('names another version as the entry would', () => {
    const haiku = AI_MODELS.find((model) => model.family === 'anthropic/claude-haiku')!

    expect(labelFor(haiku, 'anthropic/claude-haiku-6.1')).toBe('Claude Haiku 6.1')
  })
})

describe('free models', () => {
  it('are told by their id', () => {
    expect(isFreeModel('meta-llama/llama-4-maverick:free')).toBe(true)
    expect(isFreeModel('meta-llama/llama-4-maverick')).toBe(false)
    expect(isFreeModel(undefined)).toBe(false)
  })

  it('cost nothing, and are text-only until the catalogue says otherwise', () => {
    expect(freeModel('acme/tiny:free')).toMatchObject({ id: 'acme/tiny:free', label: 'tiny:free', free: true, vision: false, price: { in: 0, out: 0 } })
    expect(freeModel('acme/tiny:free', { name: 'Acme: Tiny (free)', vision: true }).label).toBe('Acme: Tiny')
  })
})
