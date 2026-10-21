import { describe, expect, it } from 'vitest'

import { AI_MODELS, DEFAULT_MODEL, modelById, modelLabel, successorOf } from '#shared/utils/models'

/**
 * The curated model list, and the one rule that has to hold every time it is
 * brought up to date: a reader's remembered choice survives the family moving on.
 *
 * Needs no harness — `shared/utils/models.ts` is plain data and three functions.
 *
 * Seam: the exports, as `useComic`'s `remember` and the panels use them.
 */
describe('AI_MODELS', () => {
  it('names each model once', () => {
    const ids = AI_MODELS.map((model) => model.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the vendor prefix OpenRouter is called with', () => {
    for (const model of AI_MODELS) expect(model.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/)
  })

  it('defaults to the first entry', () => {
    expect(DEFAULT_MODEL).toBe(AI_MODELS[0]!.id)
  })
})

describe('successorOf', () => {
  /**
   * A choice remembered from before the list moved on lands on the same family
   * at the same rung. Without it `remember` refused the id and put the reader on
   * the first entry — Opus back to Sonnet, the cheapest model to one costing
   * twenty times as much.
   */
  it('moves a retired id to the entry that replaced it', () => {
    expect(successorOf('anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5.5')
    expect(successorOf('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5.5')
    expect(successorOf('openai/gpt-5.6-luna')).toBe('openai/gpt-6-luna')
  })

  it('leaves a current id and an unknown one alone', () => {
    // Desktop: Haiku 5.5, Haiku 4.5 having been replaced by it here.
    expect(successorOf('anthropic/claude-haiku-5.5')).toBe('anthropic/claude-haiku-5.5')
    expect(successorOf('someone/else')).toBe('someone/else')
  })

  /**
   * The two ways the table goes stale as the list is edited: a successor that
   * has itself since been replaced, or an id brought back onto the list that
   * still points away from itself.
   */
  it('only ever points at an entry on the list, never from one', () => {
    const listed = new Set(AI_MODELS.map((model) => model.id))
    const retired = ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'google/gemini-3.6-flash',
      'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna', 'qwen/qwen3-vl-235b-a22b-instruct']

    for (const id of retired) {
      expect(listed.has(id)).toBe(false)
      expect(listed.has(successorOf(id))).toBe(true)
    }

    for (const id of listed) expect(successorOf(id)).toBe(id)
  })
})

describe('modelById and modelLabel', () => {
  it('fall back differently for an id not on the list', () => {
    expect(modelById('anthropic/claude-opus-5').id).toBe(DEFAULT_MODEL)
    // A caption says what wrote the line, even when it is no longer offered.
    expect(modelLabel('anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5')
    expect(modelLabel('anthropic/claude-opus-5.5')).toBe('Claude Opus 5.5')
  })
})
