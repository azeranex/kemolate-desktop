import { describe, expect, it } from 'vitest'

import type { Block, ComicPage } from '~/composables/useComic'

import { EMPHASIS_MAX, measuredEmphasis, ordinaryPitch, pitchOf } from '~/utils/emphasis'

/**
 * How loud the original lettered a line — desktop.
 *
 * Seam: blocks as the canvas holds them (page percentages) on a 1000 × 1500
 * page, so a box's pixels are easy to reckon.
 */

const PAGE = { width: 1000, height: 1500 }

let next = 0

/** A block whose box holds `chars` characters at `pitch` pixels each, in one column. */
function column (chars: number, pitch: number, type: Block['type'] = 'bubble'): Block {
  return {
    id: `b${next++}`,
    type,
    x: 10,
    y: 10,
    w: (pitch / PAGE.width) * 100,
    h: ((pitch * chars) / PAGE.height) * 100,
    source: 'あ'.repeat(chars),
    translation: 'Hello',
    confidence: 90,
    hidden: false,
  }
}

const pageOf = (blocks: Block[]) => ({ id: 'p', blocks } as unknown as ComicPage)
const sizeOf = () => PAGE

describe('the pitch of a block\'s characters', () => {
  it('is the side each character takes, as a share of the page width', () => {
    expect(pitchOf(column(8, 40), PAGE)).toBeCloseTo(0.04)
  })

  it('cannot be told from one character, or with no page size', () => {
    expect(pitchOf(column(1, 40), PAGE)).toBeNull()
    expect(pitchOf(column(8, 40), { width: 0, height: 0 })).toBeNull()
  })

  it('ignores the spaces in what was read', () => {
    const block = { ...column(4, 40), source: 'あい うえ' }

    expect(pitchOf(block, PAGE)).toBeCloseTo(0.04)
  })

  it('is measured over a joined balloon\'s parts, not the box round them', () => {
    const parts = [column(4, 40), column(4, 40)]
    // The parent's box is the union — far bigger than its two columns.
    const joined = { ...column(8, 120), source: '', children: parts }

    expect(pitchOf(joined, PAGE)).toBeCloseTo(0.04)
  })
})

describe('the chapter\'s ordinary lettering', () => {
  it('is the median over every page\'s dialogue and captions', () => {
    const pages = [
      pageOf([column(6, 40), column(6, 42), column(6, 38)]),
      pageOf([column(6, 40, 'caption'), column(6, 41), column(6, 90)]),
    ]

    expect(ordinaryPitch(pages, sizeOf)).toBeCloseTo(0.0405)
  })

  it('leaves out sound effects, rubbish and hidden blocks', () => {
    const pages = [pageOf([
      ...Array.from({ length: 6 }, () => column(6, 40)),
      column(4, 300, 'sfx'),
      column(4, 300, 'garbage'),
      { ...column(4, 300), hidden: true },
    ])]

    expect(ordinaryPitch(pages, sizeOf)).toBeCloseTo(0.04)
  })

  it('is not known from too few blocks', () => {
    expect(ordinaryPitch([pageOf([column(6, 40), column(6, 40)])], sizeOf)).toBeNull()
  })
})

describe('a line\'s emphasis', () => {
  const usual = 0.04

  it('is none for a line lettered like the rest, however big its balloon', () => {
    expect(measuredEmphasis(column(6, 44), PAGE, usual)).toBe(1)
  })

  it('is the original\'s size over the usual, to a tenth, for a line lettered clearly bigger', () => {
    expect(measuredEmphasis(column(4, 60), PAGE, usual)).toBe(1.5)
  })

  it('stops at the most a measure may raise a line', () => {
    expect(measuredEmphasis(column(2, 200), PAGE, usual)).toBe(EMPHASIS_MAX)
  })

  it('is none for a sound effect, or with no usual to measure against', () => {
    expect(measuredEmphasis(column(4, 80, 'sfx'), PAGE, usual)).toBe(1)
    expect(measuredEmphasis(column(4, 80), PAGE, null)).toBe(1)
  })
})
