import { describe, expect, it } from 'vitest'

import { askOf, jobToken } from '~~/server/utils/brief'

/**
 * The token that makes a positional save safe.
 *
 * `prepare_page_translation` numbers a page's lines and hands out this token;
 * `save_page_translations` may then be given a bare ordered list of
 * translations, which is far less for an agent to carry than nine block ids
 * copied by hand. The whole safety of that rests here: the save recomputes the
 * token from the page *as it is now* and refuses if it differs.
 *
 * What it is guarding against is specific and silent. Between a brief and its
 * answer the page can be re-read, two balloons joined, or a block hidden — and
 * a list of strings written positionally onto a changed page puts every line on
 * the wrong balloon with nothing to notice it. So the properties below are not
 * hash trivia; each is a way that failure could get through.
 *
 * `linesFor`, and the brief and the save it sits between, are tested against a
 * real schema in `brief.save.test.ts`; this file is the token alone.
 */
describe('jobToken', () => {
  it('is the same for the same page, language and lines', () => {
    expect(jobToken(7, 'en', [1, 2, 3])).toBe(jobToken(7, 'en', [1, 2, 3]))
  })

  it('changes when a block is added, dropped or reordered', () => {
    const base = jobToken(7, 'en', [1, 2, 3])

    // A re-read that found a fourth balloon.
    expect(jobToken(7, 'en', [1, 2, 3, 4])).not.toBe(base)

    // One hidden, or joined into a compound.
    expect(jobToken(7, 'en', [1, 2])).not.toBe(base)

    // Sorted since the brief — the case that would land every line one out
    // while every id involved is still perfectly valid.
    expect(jobToken(7, 'en', [3, 2, 1])).not.toBe(base)
  })

  it('changes with the page and with the language', () => {
    // Two pages of a chapter read the same way would otherwise share a token,
    // and a batch that mixed up its pages would write one onto the other.
    expect(jobToken(8, 'en', [1, 2, 3])).not.toBe(jobToken(7, 'en', [1, 2, 3]))

    // The same lines translated into two languages are two different jobs.
    expect(jobToken(7, 'fr', [1, 2, 3])).not.toBe(jobToken(7, 'en', [1, 2, 3]))
  })

  it('does not confuse ids that share digits across the join', () => {
    // `1,23` and `12,3` flatten to the same characters without a separator, and
    // the ids on a page really are consecutive integers of varying length.
    expect(jobToken(7, 'en', [1, 23])).not.toBe(jobToken(7, 'en', [12, 3]))
  })

  /*
   * "Fill the gaps" and "again" number the same lines on a whole-page chapter
   * and ask different questions of them. A token that could not tell them
   * apart left the save guessing, and it always guessed "again" — writing the
   * lines a gap-filling brief had only shown as context.
   */
  it('changes with the question asked of the page', () => {
    const gaps = jobToken(7, 'en', [1, 2, 3])

    expect(jobToken(7, 'en', [1, 2, 3], { force: true })).not.toBe(gaps)
    expect(jobToken(7, 'en', [1, 2, 3], { blockId: 2 })).not.toBe(gaps)
    expect(jobToken(7, 'en', [1, 2, 3], { blockId: 2 })).not.toBe(jobToken(7, 'en', [1, 2, 3], { blockId: 3 }))
  })

  it('is short enough to travel in every brief', () => {
    expect(jobToken(7, 'en', [1, 2, 3])).toMatch(/^gaps\.[0-9a-f]{16}$/)
    expect(jobToken(7, 'en', [1, 2, 3], { blockId: 41 })).toMatch(/^b41\.[0-9a-f]{16}$/)
  })
})

/**
 * The half of the token that is read rather than compared: which question the
 * brief asked, which the save needs before it can check anything else.
 */
describe('askOf', () => {
  it('reads back the question each token was handed out for', () => {
    expect(askOf(jobToken(7, 'en', [1, 2, 3]))).toEqual({ force: false })
    expect(askOf(jobToken(7, 'en', [1, 2, 3], { force: true }))).toEqual({ force: true })
    expect(askOf(jobToken(7, 'en', [1, 2, 3], { blockId: 2 }))).toEqual({ blockId: 2 })
  })

  it('knows nothing of a token this server did not write', () => {
    // One from before the question was in it — sixteen hex characters bare.
    expect(askOf('6788b9ef99dd7a6b')).toBeNull()
    expect(askOf('everything.6788b9ef99dd7a6b')).toBeNull()
  })

  /*
   * The readable half is covered by the digest, so editing it into another
   * question does not make a different token — it makes one that fails.
   */
  it('cannot be edited into a different question', () => {
    const gaps = jobToken(7, 'en', [1, 2, 3])
    const edited = gaps.replace(/^gaps/, 'all')

    expect(askOf(edited)).toEqual({ force: true })
    expect(jobToken(7, 'en', [1, 2, 3], askOf(edited)!)).not.toBe(edited)
  })
})
