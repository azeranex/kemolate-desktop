import { describe, expect, it } from 'vitest'

import { breakFlags } from '~~/server/utils/breaks'

/**
 * Where a balloon's lines break — desktop. The cases are the test page's own
 * balloons as Kemolate drew them at the standard size (2026-10-23).
 */
describe('a balloon\'s breaks', () => {
  it('finds a word stranded in the middle', () => {
    expect(breakFlags(['FIRST, LET', 'ME SHOW', 'YOU', 'AROUND THE', 'NEIGHBOR-', 'HOOD...'])).toEqual(['stranded-word'])
    expect(breakFlags(['THIS', 'PHOTO\'S', 'GOING TO', 'BE', 'A FAMILY', 'HEIRLOOM...!'])).toEqual(['stranded-word'])
  })

  it('finds a lone word left at the foot', () => {
    expect(breakFlags(['HM? OH,', 'YEAH, IT', 'IS.'])).toEqual(['lone-last-word'])
  })

  it('passes a balloon broken one phrase to a line', () => {
    expect(breakFlags(['HM?', 'OH, YEAH,', 'IT IS.'])).toEqual([])
    expect(breakFlags(['FIRST,', 'LET ME', 'SHOW YOU', 'AROUND THE', 'NEIGHBOR-', 'HOOD...'])).toEqual([])
    expect(breakFlags(['WAIT, IS', 'THIS ONE', 'OF THOSE', '"CAR"', 'THINGS?'])).toEqual([])
  })

  it('does not call the end of a broken word lone', () => {
    expect(breakFlags(['A FAMILY', 'HEIRLOOM-', 'S'])).toEqual([])
  })

  it('says a typed line was wrapped again', () => {
    expect(breakFlags(['HM?', 'OH, YEAH,', 'IT IS.'], true)).toEqual(['rewrapped'])
  })

  it('has nothing to say about one line', () => {
    expect(breakFlags(['HM?'])).toEqual([])
  })
})
