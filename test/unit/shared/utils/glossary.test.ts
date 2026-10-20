import { describe, expect, it } from 'vitest'

import type { CastMember } from '#shared/utils/prompt'

import { askAgain, foldTerms, MAX_TERMS } from '#shared/utils/glossary'
import { NO_CAST } from '#shared/utils/prompt'

/**
 * What a page may teach a glossary — the rule a cloud workspace's server and a
 * local workspace's browser both follow, so a run builds the same list wherever
 * the chapter is kept.
 */
describe('foldTerms', () => {
  it('keeps the first translation of a name', () => {
    // A later page proposing a new spelling for a settled name is not a rewrite.
    expect(foldTerms([{ source: '宗介' }], [{ src: '宗介', tr: 'Sousuke' }])).toEqual([])
  })

  it('takes one spelling per name from a single reply', () => {
    expect(foldTerms([], [{ src: '宗介', tr: 'Sosuke' }, { src: '宗介', tr: 'Sousuke' }]))
      .toEqual([{ source: '宗介', target: 'Sosuke' }])
  })

  it('drops a term that translates to itself, and an empty one', () => {
    expect(foldTerms([], [{ src: 'OK', tr: 'OK' }, { src: '', tr: 'x' }, { src: 'y' }])).toEqual([])
  })

  it('stops at the cap', () => {
    const current = Array.from({ length: MAX_TERMS - 1 }, (_, index) => ({ source: `s${index}` }))

    expect(foldTerms(current, [{ src: 'a', tr: 'A' }, { src: 'b', tr: 'B' }])).toHaveLength(1)
  })
})

/**
 * When a page asked in parallel with the one before it has to be asked again.
 *
 * A run has three pages out at once and writes them in order, so page six can
 * be answered without a name page five went on to settle. Writing in order
 * keeps the glossary itself honest — page five's rendering is folded in first,
 * and page six's rival spelling is refused by `foldTerms` above. What it cannot
 * fix is page six's *lines*, which is what this decides: ask again only where
 * the page's written words could disagree with what it was never told, because
 * every "yes" here is a second request somebody pays for.
 */
describe('askAgain', () => {
  const sousuke = { source: '宗介', target: 'Sousuke' }

  /** A prompt that carried nothing, and a chapter that has since learned `sousuke`. */
  const before = { terms: [], cast: NO_CAST }
  const after = { terms: [sousuke], cast: NO_CAST }

  const page = (answered: [string, string][], context: string[] = []) => ({
    shown: [...context, ...answered.map(([source]) => source)],
    answered: answered.map(([source, text]) => ({ source, text })),
  })

  it('asks again when a written line renders a name differently from what was settled', () => {
    expect(askAgain(before, after, page([['宗介、待って', 'Sosuke, wait!']]), 'en')).toBe('宗介')
  })

  it('does not when the line already uses the settled rendering, in any case', () => {
    expect(askAgain(before, after, page([['宗介、待って', 'SOUSUKE, WAIT!']]), 'en')).toBeNull()
    expect(askAgain(before, after, page([['宗介の本', 'Sousuke\'s book']]), 'en')).toBeNull()
  })

  it('does not for a name the page never mentions', () => {
    expect(askAgain(before, after, page([['いいえ', 'No.']]), 'en')).toBeNull()
  })

  /*
   * An answer for a context line is thrown away unread, so a name there can
   * disagree with nothing that will be written.
   */
  it('does not for a name that appears only in a context line', () => {
    expect(askAgain(before, after, page([['いいえ', 'No.']], ['宗介、待って']), 'en')).toBeNull()
  })

  it('does not for a term the prompt already carried', () => {
    expect(askAgain(after, after, page([['宗介、待って', 'Sosuke, wait!']]), 'en')).toBeNull()
  })

  /*
   * A person correcting a term mid-run is a term the page was not told, like
   * one a page taught — the rule compares lists, not who changed them.
   */
  it('counts a term rendered differently since as one the page was not told', () => {
    const renamed = { terms: [{ source: '宗介', target: 'Sosuke' }], cast: NO_CAST }

    expect(askAgain(renamed, after, page([['宗介、待って', 'Sosuke, wait!']]), 'en')).toBe('宗介')
  })

  it('reads full-width and half-width forms as the same name', () => {
    const latin = { terms: [{ source: 'ECLIPSE', target: 'Gerhana' }], cast: NO_CAST }

    expect(askAgain(before, latin, page([['ＥＣＬＩＰＳＥの秘密', 'The secret of Eclipse']]), 'id')).toBe('ECLIPSE')
  })

  describe('the cast', () => {
    const yamada = (over: Partial<CastMember> = {}): CastMember => ({
      source: '山田',
      names: { en: 'Yamada' },
      gender: 'female',
      tags: ['classmate'],
      ...over,
    })

    const knowing = (...members: CastMember[]) => ({ terms: [], cast: { members, notes: '' } })

    /*
     * Gender cannot be checked in the text the way a spelling can, so a page
     * that names somebody the run has learned about since is asked again even
     * when its words look fine — this is the pronoun half of the loop.
     */
    it('asks again when somebody learned since is named anywhere on the page', () => {
      expect(askAgain(knowing(), knowing(yamada()), page([['山田さん、どうしたの', 'What is wrong, Yamada?']]), 'en')).toBe('山田')

      // Named only in a context line still counts: the written line's pronouns may be about them.
      expect(askAgain(knowing(), knowing(yamada()), page([['どうして', 'Why would she…']], ['山田さん！']), 'en')).toBe('山田')
    })

    it('asks again when a member already known has since been given a gender', () => {
      const unsure = knowing(yamada({ gender: 'unknown' }))

      expect(askAgain(unsure, knowing(yamada()), page([['山田さん', 'Yamada!']]), 'en')).toBe('山田')
    })

    it('does not for somebody unchanged, or somebody not on the page', () => {
      expect(askAgain(knowing(yamada()), knowing(yamada()), page([['山田さん', 'Yamada!']]), 'en')).toBeNull()
      expect(askAgain(knowing(), knowing(yamada()), page([['いいえ', 'No.']]), 'en')).toBeNull()
    })

    it('ignores a spelling added for another language', () => {
      const spanish = knowing(yamada({ names: { en: 'Yamada', es: 'Yamada' } }))

      expect(askAgain(knowing(yamada()), spanish, page([['山田さん', 'Yamada!']]), 'en')).toBeNull()
    })
  })
})
