import { describe, expect, it } from 'vitest'

import { speechLike, tidyText } from '#shared/utils/ocr'

/**
 * How two pieces of lettering become one string.
 *
 * It decides every source in the app, which makes it quietly the most
 * load-bearing function nobody had tested. A source is what the reader sees,
 * what the model is sent, and what the glossary is built from, so a wrong join
 * is not a cosmetic fault: it poisons every later translation of that line.
 *
 * The rule is one rule — a break between two pieces reads as nothing where the
 * text is CJK and as a space where it is not — and it is reached from two
 * directions that used to disagree. `useOcr.readBlock` joined multi-line
 * readings with nothing whatever the script, welding an English aside into one
 * word; `useBlockMerge` did the same when joining a balloon. Both now come
 * here, which is why this is tested here rather than at either caller.
 *
 * The threshold is **a quarter of the characters, not a majority**, and that is
 * the part worth pinning: a Japanese balloon with a stray latin "OK" in it is
 * still a Japanese balloon, so it must not start taking spaces. The scaffolded
 * name for this said "most of it", which would have been a different and wrong
 * specification — every expected value below is worked from the documented
 * quarter rule rather than from the expression that implements it.
 */

describe('tidyText — which joiner', () => {
  it('joins the columns of a CJK balloon with nothing', () => {
    expect(tidyText('本作品包含\n大量男同性戀')).toBe('本作品包含大量男同性戀')
  })

  it('joins the lines of a Latin balloon with a space', () => {
    expect(tidyText('ADULT\nONLY')).toBe('ADULT ONLY')
  })

  /**
   * The case the rule was written for. Five of these eight characters are
   * kana, which clears a quarter comfortably, so the latin word rides along
   * without turning the balloon into a spaced one.
   */
  it('keeps a CJK balloon CJK when a latin word is embedded in it', () => {
    expect(tidyText('これはOK\nです')).toBe('これはOKです')
  })

  /**
   * And the other direction, which a majority test would get wrong in the same
   * way: one CJK character among twenty-four is well under a quarter, so this
   * is a Latin line and its break is a space.
   */
  it('keeps a Latin line spaced when a single CJK character appears in it', () => {
    expect(tidyText('THE CAUSE OF THE PRISON\n本')).toBe('THE CAUSE OF THE PRISON 本')
  })

  /**
   * A quarter of three characters rounds to nothing, so without a floor of one
   * a short CJK pair would be judged Latin and come back with a space in the
   * middle of a word.
   */
  it('joins a short CJK line with nothing rather than rounding the test away', () => {
    expect(tidyText('本\n作')).toBe('本作')
  })

  it('joins a short Latin line with a space', () => {
    expect(tidyText('A\nB')).toBe('A B')
  })
})

describe('tidyText — tidying', () => {
  it('reads two breaks in a row as one', () => {
    expect(tidyText('ADULT\n\nONLY')).toBe('ADULT ONLY')
  })

  it('takes the whitespace around a break with it', () => {
    expect(tidyText('ADULT   \n   ONLY')).toBe('ADULT ONLY')
  })

  it('collapses a run of spaces and tabs', () => {
    expect(tidyText('HELLO \t  WORLD')).toBe('HELLO WORLD')
  })

  it('trims the ends', () => {
    expect(tidyText('  ADULT ONLY  ')).toBe('ADULT ONLY')
  })

  it('leaves a line that needs no joining exactly as it came', () => {
    expect(tidyText('R18')).toBe('R18')
  })

  it('answers nothing for a string with nothing in it', () => {
    expect(tidyText('   ')).toBe('')
  })
})

/**
 * Whether a reading is somebody talking — the check that overrules the comic
 * detector's `text_free` label. See `speechLike`.
 *
 * The speech cases are lines the detector filed as sound effects on the test
 * chapter (pages 010, 013 and 014), each by at least one of its three builds.
 */
describe('speechLike', () => {
  it('hears a sentence the detector called a sound', () => {
    expect(speechLike('優しい人だから安心してねそれ')).toBe(true)
    expect(speechLike('ロ…ローションか…びっくりした')).toBe(true)
    expect(speechLike('うおっ!?お')).toBe(true)
    expect(speechLike('アナ…ルにっ♡指がっ…あぁ♡')).toBe(true)
    expect(speechLike('わ...分かった')).toBe(true)
  })

  it('leaves a sound a sound', () => {
    expect(speechLike('ドンッ!')).toBe(false)
    expect(speechLike('ビクッ')).toBe(false)
    expect(speechLike('ぬぷ♡')).toBe(false)
    expect(speechLike('ズズズ～')).toBe(false)
  })

  /** Long, but the same few letters over and over — which is what a long sound is. */
  it('does not count a repeated sound as a sentence', () => {
    expect(speechLike('ドキドキドキドキ')).toBe(false)
    expect(speechLike('啪啪啪啪啪啪啪啪啪')).toBe(false)
  })

  /** Deliberately one-sided: a short plain line keeps the detector's word. */
  it('says nothing about a short line with no punctuation', () => {
    expect(speechLike('つめたっ')).toBe(false)
    expect(speechLike('!?')).toBe(false)
    expect(speechLike('')).toBe(false)
  })
})
