import { describe, expect, it } from 'vitest'

import type { AiTotals, AiUse } from '~/composables/useAiUsage'

import { add, trim } from '~/composables/useAiUsage'

/**
 * The ledger's one job is to not be wrong about money, and the one way it can
 * be wrong without anybody noticing is here: rows age out past the cap, and if
 * what they were worth is not banked — or is banked under the wrong page — a
 * page's total quietly shrinks. It would only start doing so on the two hundred
 * and first call, by which point nobody is checking.
 *
 * So the property under test is conservation: whatever is trimmed must still be
 * counted, page by page.
 */

const NOTHING: AiTotals = { calls: 0, input: 0, output: 0, reasoning: 0, cost: 0, unpriced: 0 }

function use (over: Partial<AiUse> & { pageId: string }): AiUse {
  return {
    at: 1,
    page: over.pageId,
    model: 'Claude Sonnet 5',
    input: 100,
    output: 50,
    reasoning: 0,
    cost: 0.001,
    ...over,
  }
}

/** A page's total the way the panel works it out: carried, plus what is left. */
const totalFor = (
  pageId: string,
  entries: AiUse[],
  carried: Record<string, AiTotals>,
) => entries.filter((e) => e.pageId === pageId).reduce(add, carried[pageId] ?? NOTHING)

describe('add', () => {
  it('sums a call into a running total', () => {
    expect(add(NOTHING, use({ pageId: 'a', input: 10, output: 5, reasoning: 2, cost: 0.5 })))
      .toEqual({ calls: 1, input: 10, output: 5, reasoning: 2, cost: 0.5, unpriced: 0 })
  })

  /**
   * A provider that bills the account rather than reporting per call still used
   * tokens. Counting it as costing nothing would make the total read as though
   * the call were free, so it is counted apart and the panel shows `≥`.
   */
  it('counts an unpriced call rather than treating it as free', () => {
    const out = add(NOTHING, use({ pageId: 'a', cost: null }))

    expect(out.cost).toBe(0)
    expect(out.unpriced).toBe(1)
    expect(out.calls).toBe(1)
    expect(out.input).toBe(100)
  })
})

describe('trim', () => {
  it('leaves everything alone below the cap', () => {
    const entries = [use({ pageId: 'a' }), use({ pageId: 'b' })]
    const out = trim(entries, {}, 10)

    expect(out.entries).toBe(entries)
    expect(out.carried).toEqual({})
  })

  it('drops the oldest and keeps only the cap', () => {
    const entries = [1, 2, 3, 4, 5].map((at) => use({ pageId: 'a', at }))
    const out = trim(entries, {}, 2)

    expect(out.entries.map((e) => e.at)).toEqual([4, 5])
  })

  /** The whole point: what was dropped is still counted. */
  it('banks what it drops, so a page total does not move', () => {
    const entries = [1, 2, 3, 4, 5].map((at) => use({ pageId: 'a', at }))

    const before = totalFor('a', entries, {})
    const out = trim(entries, {}, 2)
    const after = totalFor('a', out.entries, out.carried)

    expect(after).toEqual(before)
    expect(after.calls).toBe(5)
  })

  /**
   * Banked under the page it belonged to, not into one chapter-wide sum — which
   * is what showing a page at a time forces. A single running carried figure
   * could not be attributed back, so every page's total would drop by an
   * unknowable amount the first time anything was trimmed.
   */
  it('banks each dropped row under its own page', () => {
    const entries = [
      use({ pageId: 'a', at: 1, cost: 0.01 }),
      use({ pageId: 'b', at: 2, cost: 0.02 }),
      use({ pageId: 'a', at: 3, cost: 0.04 }),
      use({ pageId: 'b', at: 4, cost: 0.08 }),
    ]

    const out = trim(entries, {}, 1)

    expect(totalFor('a', out.entries, out.carried).cost).toBeCloseTo(0.05)
    expect(totalFor('b', out.entries, out.carried).cost).toBeCloseTo(0.10)
    // And neither page has borrowed the other's calls.
    expect(totalFor('a', out.entries, out.carried).calls).toBe(2)
    expect(totalFor('b', out.entries, out.carried).calls).toBe(2)
  })

  it('adds to a page that has been trimmed before rather than replacing it', () => {
    const first = trim([1, 2, 3].map((at) => use({ pageId: 'a', at })), {}, 1)
    const second = trim([...first.entries, use({ pageId: 'a', at: 4 })], first.carried, 1)

    expect(totalFor('a', second.entries, second.carried).calls).toBe(4)
  })

  it('carries an unpriced call through the fold', () => {
    const entries = [use({ pageId: 'a', at: 1, cost: null }), use({ pageId: 'a', at: 2 })]
    const out = trim(entries, {}, 1)

    expect(totalFor('a', out.entries, out.carried).unpriced).toBe(1)
  })

  it('does not mutate what it was given', () => {
    const carried = { a: { ...NOTHING, calls: 1 } }
    const entries = [1, 2, 3].map((at) => use({ pageId: 'a', at }))

    trim(entries, carried, 1)

    expect(carried.a.calls).toBe(1)
    expect(entries).toHaveLength(3)
  })
})
