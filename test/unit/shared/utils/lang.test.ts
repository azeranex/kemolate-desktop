import { describe, expect, it } from 'vitest'

import { needsTranslation, pageScript, scriptForLang, scriptOf } from '#shared/utils/lang'

/**
 * `needsTranslation` is the one place in the pipeline that decides not to spend
 * money, and both ways of being wrong cost something a reader would notice: a
 * false "no" leaves a balloon untranslated on a finished page, and a false
 * "yes" pays a model to tell us that a logo says what it says.
 *
 * So the cases below are the arguments its comments make, written as pages. The
 * shape that matters is that a block is judged *against the page it is on* —
 * every case here therefore states a whole page, not a string.
 */

/** A Japanese page with an English logo on somebody's shirt. */
const JAPANESE = ['こんにちは', 'どうして……', 'ECLIPSE', '!?']

describe('scriptOf', () => {
  it('reads kana beside han as one language, not as two scripts', () => {
    expect(scriptOf('日本語を話します')).toBe('kana')
  })

  it('leaves genuinely mixed writing unnamed, so it goes to the model', () => {
    expect(scriptOf('OK、行こう')).toBe(null)
  })

  it('names nothing in writing that has no letters in it', () => {
    expect(scriptOf('!?')).toBe(null)
    expect(scriptOf('……')).toBe(null)
    expect(scriptOf('123')).toBe(null)
  })

  /**
   * The hand-written ranges this replaced stopped at Latin Extended-B, so a
   * Vietnamese line read as no script at all and was skipped as punctuation.
   */
  it('reads Latin past the ranges the earlier build knew about', () => {
    expect(scriptOf('Chào bạn, khỏe không?')).toBe('latin')
  })
})

describe('pageScript', () => {
  it('is what the most blocks agree on, ignoring the ones in no script', () => {
    expect(pageScript(JAPANESE)).toBe('kana')
  })

  it('is null for a page with nothing word-forming on it at all', () => {
    expect(pageScript(['!?', '...', '42'])).toBe(null)
  })
})

describe('scriptForLang', () => {
  it('knows every language the picker offers', () => {
    expect(scriptForLang('ja')).toBe('kana')
    expect(scriptForLang('ko')).toBe('hangul')
    expect(scriptForLang('zh-TW')).toBe('han')
    expect(scriptForLang('ru')).toBe('cyrillic')
    expect(scriptForLang('uk')).toBe('cyrillic')
    expect(scriptForLang('ar')).toBe('arabic')
    expect(scriptForLang('th')).toBe('thai')
    // Hindi is on this app's list and was not on the earlier build's, so it is
    // the one entry that had nowhere to come from.
    expect(scriptForLang('hi')).toBe('devanagari')
    expect(scriptForLang('pt-BR')).toBe('latin')
  })

  it('falls back to Latin for a code from outside the picker', () => {
    // The safe direction: a wrong "latin" pays for a block that need not have
    // been sent, where a wrong anything-else leaves one untranslated.
    expect(scriptForLang('xx-YY')).toBe('latin')
  })
})

describe('needsTranslation', () => {
  const page = pageScript(JAPANESE)

  it('sends the dialogue', () => {
    expect(needsTranslation('こんにちは', 'en', page)).toBe(true)
  })

  it('leaves the shirt logo alone — already the target script, odd one out', () => {
    expect(needsTranslation('ECLIPSE', 'en', page)).toBe(false)
  })

  it('leaves writing with no letters in it alone', () => {
    expect(needsTranslation('!?', 'en', page)).toBe(false)
    expect(needsTranslation('   ', 'en', page)).toBe(false)
  })

  /**
   * The trap the script test would fall into on its own: English into French is
   * Latin either way, so "already in the target's script" would skip the whole
   * page. It is the page it is on that saves it.
   */
  it('sends a whole Latin page into another Latin language', () => {
    const english = ['WHAT ARE YOU DOING', 'Nothing.', 'ECLIPSE']

    for (const line of english) {
      expect(needsTranslation(line, 'fr', pageScript(english))).toBe(true)
    }
  })

  /** The same page read the other way: the logo is now the page's own script. */
  it('sends the logo when the logo is what the page is written in', () => {
    const english = ['WHAT ARE YOU DOING', 'Nothing.', 'ECLIPSE']

    expect(needsTranslation('ECLIPSE', 'ja', pageScript(english))).toBe(true)
  })

  it('sends a block in two scripts, because only a reader can settle it', () => {
    expect(needsTranslation('OK、行こう', 'en', page)).toBe(true)
  })

  /**
   * A Japanese page carried into Chinese. Han is not kana, so the dialogue goes.
   *
   * And so does the logo, which is the rule being deliberately narrow rather
   * than the rule being wrong: skipping means "this already says what you asked
   * for", and "ECLIPSE" is not Chinese. A Chinese edition may well want 日蝕
   * there, and only a model looking at it can say. The skip is reserved for the
   * one case where no judgement is needed.
   */
  it('skips only what is already in the target script, not merely foreign to the page', () => {
    expect(needsTranslation('こんにちは', 'zh', page)).toBe(true)
    expect(needsTranslation('ECLIPSE', 'zh', page)).toBe(true)
    // The same logo, the same page, read into English: now it is skipped.
    expect(needsTranslation('ECLIPSE', 'en', page)).toBe(false)
  })
})
