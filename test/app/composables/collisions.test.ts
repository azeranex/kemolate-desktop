import { describe, expect, it } from 'vitest'

import { collisions } from '~/composables/useLetteringErrands'

/** Lines lettered over each other — desktop. Boxes in scan pixels. */
describe('which lines run into which', () => {
  it('pairs lines whose ink overlaps, both ways', () => {
    const hits = collisions(new Map([
      [1, { left: 100, top: 100, right: 200, bottom: 160 }],
      [2, { left: 180, top: 140, right: 280, bottom: 220 }],
      [3, { left: 400, top: 400, right: 450, bottom: 450 }],
    ]))

    expect(hits.get(1)).toEqual([2])
    expect(hits.get(2)).toEqual([1])
    expect(hits.has(3)).toBe(false)
  })

  it('does not count lines that only touch, or overlap by a rounding error', () => {
    const hits = collisions(new Map([
      [1, { left: 0, top: 0, right: 100, bottom: 50 }],
      [2, { left: 99, top: 0, right: 200, bottom: 50 }],
      [3, { left: 0, top: 50, right: 100, bottom: 90 }],
    ]))

    expect(hits.size).toBe(0)
  })
})
