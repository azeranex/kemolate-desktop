import { describe, expect, it } from 'vitest'

import { estimateTokens, imageTokens } from '#shared/utils/tokens'

/**
 * These numbers end up under a dollar sign, so what is checked here is not any
 * particular value — the weights are approximations and are meant to be
 * adjustable — but the *relationships* that make the estimate worth printing
 * at all. Chiefly that a Japanese page and an English page of the same
 * character count are not costed the same, which is the mistake the flat
 * four-characters-to-a-token rule makes on exactly the pages this app is for.
 */

describe('estimateTokens', () => {
  it('counts nothing for nothing', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('puts English at about four characters to the token', () => {
    // 40 characters, so about ten tokens by the familiar rule.
    const text = 'The quick brown fox jumps over the dog!!'

    expect(text).toHaveLength(40)
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(8)
    expect(estimateTokens(text)).toBeLessThanOrEqual(12)
  })

  /**
   * The whole reason this file exists. A byte-pair vocabulary is built mostly
   * on Latin text, so CJK lands near a token per character — roughly four times
   * what the English rule predicts.
   */
  it('puts CJK near a token a character, not a quarter', () => {
    const japanese = 'こんにちは世界'

    expect(japanese).toHaveLength(7)
    expect(estimateTokens(japanese)).toBeGreaterThanOrEqual(7)
  })

  it('costs a Japanese line several times an English line of the same length', () => {
    const japanese = 'どうしてこんなことになったのだろうか'
    const english = 'x'.repeat(japanese.length)

    expect(estimateTokens(japanese)).toBeGreaterThan(estimateTokens(english) * 3)
  })

  it('places Cyrillic and Thai between the two', () => {
    const russian = 'Привет мир как дела'
    const latin = 'x'.repeat(russian.length)
    const japanese = 'あ'.repeat(russian.length)

    expect(estimateTokens(russian)).toBeGreaterThan(estimateTokens(latin))
    expect(estimateTokens(russian)).toBeLessThan(estimateTokens(japanese))
  })

  /**
   * A page prompt is always both at once: CJK lettering inside English
   * instructions, which is why one rate for the whole string cannot be right.
   *
   * Additive to within the rounding — the parts round once each and the whole
   * rounds once, so an exact equality here would be asserting a coincidence.
   */
  it('adds up a mixed prompt rather than picking one rate for it', () => {
    const instructions = 'Translate this block: '
    const lettering = 'こんにちは'

    expect(estimateTokens(instructions + lettering)).toBeCloseTo(
      estimateTokens(instructions) + estimateTokens(lettering),
      -0.5,
    )
  })

  it('grows with the text', () => {
    const one = estimateTokens('a comic page of dialogue')

    expect(estimateTokens('a comic page of dialogue'.repeat(4))).toBeGreaterThan(one * 3)
  })
})

describe('imageTokens', () => {
  /** A page is shrunk to fit the square before it is sent, so that is what is costed. */
  it('costs the shrunk copy, not the scan on disk', () => {
    const scan = imageTokens(4000, 6000, 1000)
    const shrunk = imageTokens(667, 1000, 1000)

    expect(scan).toBeCloseTo(shrunk, -1)
  })

  it('never costs more than the square it is capped at', () => {
    expect(imageTokens(8000, 8000, 1000)).toBeLessThanOrEqual(Math.round((1000 * 1000) / 750))
  })

  it('leaves a small image alone rather than enlarging it', () => {
    expect(imageTokens(400, 600, 1000)).toBe(Math.round((400 * 600) / 750))
  })

  /**
   * A scan that has not been measured yet reports nought by nought — see
   * `Scan.width`. Costing that as free would under-quote the one engine that
   * sends a picture, so it errs to the full square instead.
   */
  it('assumes the worst for a scan that has not said how big it is', () => {
    expect(imageTokens(0, 0, 1000)).toBe(Math.round((1000 * 1000) / 750))
  })
})
