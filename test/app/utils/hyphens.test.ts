import { describe, expect, it } from 'vitest'

import { hyphenationReady, withHyphens } from '~/utils/hyphens'

/**
 * Soft hyphens put in by hand — desktop. Chromium on Windows has no
 * hyphenation dictionary in Electron, so `hyphens: auto` breaks nothing and a
 * long word held its whole balloon small ("NEIGHBORHOOD...", 2026-10-22).
 */

/** Wait for a language's patterns, as the fit does. */
const loaded = (lang: string) => new Promise<void>((resolve) => {
  if (hyphenationReady(lang, resolve)) resolve()
})

const shown = (text: string) => text.replaceAll('­', '·')

describe('withHyphens', () => {
  it('breaks a long English word once, near its middle, and leaves short ones whole', async () => {
    await loaded('en')

    expect(shown(withHyphens('First, let me show you around the neighborhood...', 'en')))
      .toBe('First, let me show you around the neighbor·hood...')
  })

  it('hands the text back unchanged before its patterns arrive, and for a language never hyphenated', () => {
    expect(withHyphens('neighborhood', 'ja')).toBe('neighborhood')
    expect(hyphenationReady('ja', () => {})).toBe(true)
    expect(withHyphens('neighborhood', undefined)).toBe('neighborhood')
  })

  it('takes a region\'s language from its own patterns, or the language without the region', async () => {
    await loaded('pt-BR')

    expect(withHyphens('extraordinariamente', 'pt-BR')).toContain('­')
  })

  it('never changes the words themselves, only where they may break', async () => {
    await loaded('en')

    const text = 'Wait, is that what you call a "car"? Unbelievable!'

    expect(withHyphens(text, 'en').replaceAll('­', '')).toBe(text)
  })
})

describe('one break to a word', () => {
  it('keeps only the break nearest the middle, so no fragment is left on a line of its own', async () => {
    await loaded('en')

    for (const word of ['neighborhood', 'unbelievable', 'international', 'extraordinarily']) {
      const breaks = withHyphens(word, 'en').split('­')

      expect(breaks.length).toBeLessThanOrEqual(2)
      if (breaks.length === 2) expect(Math.min(breaks[0]!.length, breaks[1]!.length)).toBeGreaterThanOrEqual(3)
    }
  })
})
