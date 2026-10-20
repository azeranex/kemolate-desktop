import { describe, expect, it } from 'vitest'

import type { CastEntry } from '#shared/utils/cast'

import { foldCast, normaliseCast } from '#shared/utils/cast'

/**
 * How a page's proposals change the cast — shared by a cloud workspace's server
 * and a local workspace's browser. The rule with history is pinning: a member a
 * person has looked at is never argued with by a later page.
 */
function member (extra: Partial<CastEntry> = {}): CastEntry {
  return { source: '宗介', names: { en: 'Sousuke' }, gender: 'unknown', tags: [], pinned: false, ...extra }
}

describe('foldCast', () => {
  it('leaves a pinned member alone', () => {
    const pinned = member({ pinned: true })

    expect(foldCast([pinned], [{ name: '宗介', tr: 'Sosuke', gender: 'male' }], 'en')).toEqual({ made: [], changed: [] })
  })

  it('fills only the blanks of an unpinned member', () => {
    const row = member()
    const { changed } = foldCast([row], [{ name: '宗介', tr: 'Sosuke', gender: 'male' }, { name: '宗介', tr: 'Sōsuke' }], 'en')

    // The English spelling was already there; the gender was not.
    expect(changed).toEqual([{ row, values: { gender: 'male' } }])
  })

  it('finds a member by a spelling as well as by source', () => {
    const row = member()
    const { made, changed } = foldCast([row], [{ name: 'Sousuke', gender: 'male', tr: '' }], 'en')

    expect(made).toEqual([])
    expect(changed[0]?.row).toBe(row)
  })

  it('makes one member of one person proposed twice in a reply', () => {
    const { made } = foldCast([], [{ name: '宗介', tr: 'Sousuke' }, { name: 'Sousuke', gender: 'male' }], 'en')

    expect(made).toHaveLength(1)
  })
})

describe('normaliseCast', () => {
  it('drops empty and repeated names', () => {
    expect(normaliseCast([{ source: '' }, { source: '宗介' }, { source: ' 宗介 ' }]).map((row) => row.source)).toEqual(['宗介'])
  })

  it('reads an unknown gender as unknown', () => {
    expect(normaliseCast([{ source: '宗介', gender: 'dragon' }])[0]?.gender).toBe('unknown')
  })
})
