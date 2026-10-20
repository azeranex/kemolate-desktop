import { describe, expect, it } from 'vitest'

import type { Cast, PromptInput, ShortenPromptInput } from '#shared/utils/prompt'

import { batchPagePrompt, jsonFrom, LANGUAGE_OPTIONS, LANGUAGES, nameOf, pagePrompt, regionPrompt, shortenPrompt, shortLineFrom, standingPrompt } from '#shared/utils/prompt'

/**
 * The prompt is the whole of what makes a translation good or wrong, and it is
 * a pure function precisely so that it can be checked for nothing rather than
 * by spending a request. This is that check.
 *
 * Not a snapshot. A snapshot of a prompt fails on every reworded sentence and
 * says nothing about which of them mattered, so it gets updated unread — which
 * is the opposite of what it is for. What is asserted here instead is the small
 * set of things a *model* acts on: the numbering, the count it is told to
 * return, which language it is asked for by name, and the four blocks that
 * either appear or do not.
 */

const input = (over: Partial<PromptInput> = {}): PromptInput => ({
  blocks: ['こんにちは', 'どうして……', '行こう'],
  target: 'id',
  ...over,
})

const cast = (over: Partial<Cast> = {}): Cast => ({
  members: [{
    source: '山田',
    names: { id: 'Yamada' },
    gender: 'female',
    tags: ['classmate'],
  }],
  notes: '',
  ...over,
})

describe('pagePrompt', () => {
  it('numbers the blocks from one and asks for that many back', () => {
    const prompt = pagePrompt(input())

    expect(prompt).toContain('1. こんにちは')
    expect(prompt).toContain('3. 行こう')
    expect(prompt).toContain('with exactly 3 translations')
  })

  /**
   * The failure this replaced: the picker offered twenty-six languages and the
   * prompt knew fourteen, so choosing Brazilian Portuguese sent a model the
   * instruction to translate into "pt-BR" and the only sign of it was in the
   * answer.
   */
  it('asks for every language the picker offers by name, never by code', () => {
    for (const { value, label } of LANGUAGE_OPTIONS) {
      const prompt = pagePrompt(input({ target: value }))

      expect(prompt).toContain(`into ${label}`)
      expect(prompt).not.toContain(`into ${value}.`)
    }
  })

  it('keeps a code it was not given a name for, rather than inventing one', () => {
    expect(nameOf('xx')).toBe('xx')
    expect(Object.keys(LANGUAGES)).toContain('pt-BR')
  })

  describe('the glossary block', () => {
    it('is absent when there is nothing settled yet', () => {
      expect(pagePrompt(input())).not.toContain('Reuse them exactly')
    })

    it('lists what the chapter has settled on', () => {
      const prompt = pagePrompt(input({ glossary: [{ source: '山田', target: 'Yamada' }] }))

      expect(prompt).toContain('Reuse them exactly')
      expect(prompt).toContain('山田 → Yamada')
    })
  })

  describe('the cast block', () => {
    it('is absent when nobody has been established', () => {
      expect(pagePrompt(input())).not.toContain('CAST OF THIS COMIC')
    })

    /**
     * The whole reason the cast exists: a source that drops its pronouns leaves
     * gender to be worked out from the line, and worked out afresh each page it
     * comes out differently each page.
     */
    it('states each member\'s gender as a fact, in the target language', () => {
      const prompt = pagePrompt(input({ cast: cast() }))

      expect(prompt).toContain('山田 → Yamada (female; classmate)')
      expect(prompt).toContain('established facts, not suggestions')
      // The instruction has to name the language, or "every word that agrees
      // with them" is an instruction about nothing.
      expect(prompt).toContain('every word of Indonesian that agrees with them')
    })

    it('spells "unknown" as an instruction rather than as a gap to fill', () => {
      const unsure = cast({
        members: [{ source: '???', names: {}, gender: 'unknown', tags: [] }],
      })

      expect(pagePrompt(input({ cast: unsure }))).toContain('gender unestablished')
    })

    it('carries the translator\'s standing note above its own reading', () => {
      const prompt = pagePrompt(input({ cast: cast({ notes: 'Everyone is very formal.' }) }))

      expect(prompt).toContain('this outranks your own reading')
      expect(prompt).toContain('Everyone is very formal.')
    })
  })

  describe('honorifics', () => {
    it('asks for them kept by default', () => {
      expect(pagePrompt(input())).toContain('Keep honorifics')
    })

    it('asks for them dropped when the reader has said so', () => {
      const prompt = pagePrompt(input({ honorifics: false }))

      expect(prompt).toContain('Drop honorifics')
      expect(prompt).not.toContain('Keep honorifics')
    })
  })

  describe('one block at a time', () => {
    /**
     * `only` still sends the whole page, and the instruction has to say both
     * halves: answer for this one, read the rest. A block that breaks off
     * part-way is usually the opening of the one that follows it.
     */
    it('sends the whole page and asks for one line of it', () => {
      const prompt = pagePrompt(input({ only: 1 }))

      expect(prompt).toContain('3. 行こう')
      expect(prompt).toContain('Translate ONLY block 2')
      expect(prompt).toContain('with exactly one translation')
      expect(prompt).toContain('breaks off part-way')
    })

    it('ignores an index that is not on the page', () => {
      for (const only of [-1, 3, 99]) {
        expect(pagePrompt(input({ only }))).toContain('with exactly 3 translations')
      }
    })
  })

  it('says the page is attached only when it is', () => {
    expect(pagePrompt(input({ hasImage: true }))).toContain('The attached image is a comic page')
    expect(pagePrompt(input())).not.toContain('The attached image')
  })
})

/**
 * The same prompt, arranged for a batch — what `prepare_page_translation` hands
 * an agent for twenty pages at once.
 *
 * The property worth pinning is the one that cannot be seen by reading either
 * half alone: nothing is lost in the split. Every standing sentence the page
 * prompt carries is in the standing half, said once, and nothing but the page's
 * own lines and count is in the page half, said per page. A sentence that
 * slipped into the wrong half would either be repeated twenty times — the bill
 * this exists to stop — or never said at all.
 */
describe('a batch', () => {
  const standing = {
    target: 'id',
    glossary: [{ source: '宗介', target: 'Sousuke' }],
    cast: cast({ notes: 'Everyone is very formal.' }),
    honorifics: false,
    hasImage: false,
  }

  const whole = pagePrompt(input(standing))
  const shared = standingPrompt(standing)
  const own = batchPagePrompt(input(standing))

  it('says what every page shares once, in the standing half', () => {
    for (const said of [
      '宗介 → Sousuke',
      '山田 → Yamada (female; classmate)',
      'Everyone is very formal.',
      'Drop honorifics',
      'Silently fix obvious OCR errors',
      'In "glossary", list only recurring',
      'In "cast", list characters',
      '"source_language"',
    ]) {
      expect(whole).toContain(said)
      expect(shared).toContain(said)
      expect(own).not.toContain(said)
    }
  })

  it('keeps each page to its own lines and its own count', () => {
    expect(own).toContain('1. こんにちは')
    expect(own).toContain('3. 行こう')
    expect(own).toContain('with exactly 3 translations')
    expect(own).toContain('into Indonesian')
    expect(shared).not.toContain('こんにちは')
  })

  /*
   * Which line of a page is wanted, and that the rest of it is context, is a
   * fact about that page. Said once for the batch it would be applied to pages
   * that asked for every line.
   */
  it('keeps a one-line ask with its page, whole', () => {
    const one = batchPagePrompt(input({ ...standing, only: 1 }))

    expect(one).toContain('Translate ONLY block 2')
    expect(one).toContain('breaks off part-way')
    expect(one).toContain('with exactly one translation')
    expect(shared).not.toContain('Translate ONLY')
  })

  it('says the page is attached, page by page, only when it is', () => {
    expect(batchPagePrompt(input({ hasImage: true }))).toContain('The attached image is a comic page')
    expect(standingPrompt({ target: 'id', hasImage: true })).toContain('Use the artwork for context')
    expect(standingPrompt({ target: 'id' })).not.toContain('Use the artwork for context')
  })
})

/**
 * The region ask does two jobs in one request, and the things worth pinning are
 * the ones that make it two rather than one and a half.
 */
describe('regionPrompt', () => {
  /**
   * The failure that decides the shape of the reply. A model that answers only
   * with the translation leaves the block claiming an empty source — which
   * downstream is not "unknown" but "nothing was printed here" — and every later
   * ask about that block is an ask about a blank. So the source is named in the
   * shape and asked for first.
   */
  it('asks for what is printed as well as what it should say', () => {
    const prompt = regionPrompt({ target: 'id' })

    expect(prompt).toContain('"source"')
    expect(prompt).toContain('"translation"')
    expect(prompt.indexOf('"source"')).toBeLessThan(prompt.indexOf('"translation"'))
  })

  it('asks for the target language by name, like every other ask', () => {
    expect(regionPrompt({ target: 'pt-BR' })).toContain('Portuguese (Brazil)')
  })

  /**
   * The one thing about a crop that cannot be seen in the crop. A model left to
   * guess reverses roughly half of them, and a reversed balloon reads as a
   * plausible sentence rather than as an error.
   */
  it('says which end the columns start at', () => {
    expect(regionPrompt({ target: 'id', direction: 'rtl' })).toContain('right to left')
    expect(regionPrompt({ target: 'id', direction: 'ltr' })).toContain('left to right')
  })

  /**
   * A region is a line of the same chapter. Translated outside the loop it calls
   * a character by a name the rest of the volume does not use — the exact
   * failure the glossary and the cast exist to prevent, arriving by a new door.
   */
  it('carries the chapter\'s glossary and cast', () => {
    const prompt = regionPrompt({
      target: 'id',
      glossary: [{ source: '日蝕', target: 'Gerhana' }],
      cast: cast({ notes: 'Keep it terse.' }),
    })

    expect(prompt).toContain('日蝕 → Gerhana')
    expect(prompt).toContain('山田 → Yamada')
    expect(prompt).toContain('female')
    expect(prompt).toContain('Keep it terse.')
  })

  it('takes the honorifics switch the page ask takes', () => {
    expect(regionPrompt({ target: 'id' })).toContain('Keep honorifics')
    expect(regionPrompt({ target: 'id', honorifics: false })).toContain('Drop honorifics')
  })

  /**
   * `pagePrompt` says the opposite — "silently fix obvious OCR errors" — and is
   * right to: it is reading a machine's output. Here the model *is* the machine,
   * and a source corrected on the way out cannot be checked against the page.
   */
  it('forbids the tidying the page ask asks for', () => {
    expect(regionPrompt({ target: 'id' })).toContain('Do not correct, tidy or complete')
    expect(pagePrompt(input())).toContain('Silently fix obvious OCR errors')
  })
})

describe('jsonFrom', () => {
  const shape = '{"translations":["halo"]}'

  it('reads a bare object', () => {
    expect(jsonFrom(shape)).toEqual({ translations: ['halo'] })
  })

  /** Every provider does this, despite being told not to. */
  it('digs the object out of fences and preamble', () => {
    expect(jsonFrom(`Sure! Here you go:\n\`\`\`json\n${shape}\n\`\`\``)).toEqual({ translations: ['halo'] })
  })

  it('refuses in the reader\'s words when there is no object at all', () => {
    expect(() => jsonFrom('I cannot help with that.')).toThrow(/not JSON/)
  })
})

describe('shortenPrompt', () => {
  const shorten = (over: Partial<ShortenPromptInput> = {}): ShortenPromptInput => ({
    source: '山田さん、どうしてそんなことを言うの？',
    translation: 'Yamada-san, why would you ever say something like that to me?',
    budget: 30,
    target: 'en',
    ...over,
  })

  /** The number is the whole of the ask; a model that is not told it cannot meet it. */
  it('states the budget as a ceiling, in characters, and names the language', () => {
    const prompt = shortenPrompt(shorten({ budget: 24 }))

    expect(prompt).toContain('at most 24 characters')
    expect(prompt).toContain('in English')
  })

  it('rounds a fractional budget down and never asks for fewer than one', () => {
    expect(shortenPrompt(shorten({ budget: 24.9 }))).toContain('at most 24 characters')
    expect(shortenPrompt(shorten({ budget: 0 }))).toContain('at most 1 character,')
  })

  /**
   * Shortening from the draft alone is rewording a rewording; the source keeps
   * the cut pointed at what the balloon says.
   */
  it('shows the source and the line being shortened', () => {
    const prompt = shortenPrompt(shorten())

    expect(prompt).toContain('Original: 山田さん、どうしてそんなことを言うの？')
    expect(prompt).toContain('Current English: Yamada-san, why would you ever say')
  })

  it('says it is lettering that has to fit a balloon', () => {
    expect(shortenPrompt(shorten())).toMatch(/comic lettering[\s\S]*fit inside its speech balloon/)
  })

  /**
   * A shortening is exactly where a name gets clipped and a rewording picks a
   * different pronoun back up — the two failures the glossary and the cast
   * exist to stop, so both travel here as they do on a page.
   */
  it('carries the glossary and the cast, so a name and a gender survive the cut', () => {
    const prompt = shortenPrompt(shorten({
      target: 'id',
      glossary: [{ source: '日蝕', target: 'Gerhana' }],
      cast: cast({ notes: 'Keep it terse.' }),
    }))

    expect(prompt).toContain('日蝕 → Gerhana')
    expect(prompt).toContain('山田 → Yamada')
    expect(prompt).toContain('female')
    expect(prompt).toContain('Keep it terse.')
    expect(prompt).toContain('Spell every name and term exactly as listed above')
  })

  /** "-san" is the cheapest four characters on the line, and not padding. */
  it('keeps forms of address under the keep setting, and adds none under the drop one', () => {
    expect(shortenPrompt(shorten())).toContain('Keep every honorific and form of address the current wording has')
    expect(shortenPrompt(shorten({ honorifics: false }))).toContain('Do not introduce honorifics')
  })

  it('asks for the bare line, with a way out that is not cutting meaning', () => {
    const prompt = shortenPrompt(shorten())

    expect(prompt).toContain('Respond with ONLY the new line')
    expect(prompt).toContain('the shortest version that still says all of it')
    expect(prompt).not.toContain('JSON')
  })

  /** A line that breaks off keeps breaking off only if the model can see what it runs into. */
  it('marks the line among the page when the page is given, and says nothing of one otherwise', () => {
    const page = ['H—', 'How could I...', '']
    const prompt = shortenPrompt(shorten({ translation: 'How could I...', page, at: 1 }))

    expect(prompt).toContain('→ How could I...')
    expect(prompt).toContain('  H—')
    expect(prompt).toContain('(not translated yet)')

    expect(shortenPrompt(shorten())).not.toContain('The page it sits on')
    expect(shortenPrompt(shorten({ page, at: 7 }))).not.toContain('The page it sits on')
  })
})

describe('shortLineFrom', () => {
  it('trims, and joins a line the model broke', () => {
    expect(shortLineFrom('  Why say that?\n  To me?  ')).toBe('Why say that? To me?')
  })

  it('takes off one pair of wrapping quotes', () => {
    expect(shortLineFrom('"Why say that?"')).toBe('Why say that?')
    expect(shortLineFrom('“Why say that?”')).toBe('Why say that?')
    expect(shortLineFrom('「なぜ？」')).toBe('なぜ？')
  })

  /** Quotes the line had before are the lettering, not the model's wrapping. */
  it('keeps quotes the line it replaces was wrapped in', () => {
    expect(shortLineFrom('"Closed"', '"Closed for the day"')).toBe('"Closed"')
  })

  it('leaves two quoted phrases side by side alone', () => {
    expect(shortLineFrom('"Wait!" "No!"')).toBe('"Wait!" "No!"')
  })

  it('answers empty for an empty reply, which the caller refuses', () => {
    expect(shortLineFrom('  ""  ')).toBe('')
    expect(shortLineFrom('   ')).toBe('')
  })
})
