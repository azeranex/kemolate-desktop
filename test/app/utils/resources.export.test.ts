import { describe, expect, it } from 'vitest'

import { exportEncoders } from '~/utils/resources'

/**
 * How many pages an export encodes at once — the number that decides both how
 * fast an export is and how much memory it holds, since each page in flight is
 * a whole bitmap (170 MB all told at 3732 × 5197).
 *
 * The cases are the machines it has to be right on: the ten-core Mac it was
 * measured on, a laptop with little memory, a phone-sized device, and a
 * browser that will not say how much memory it has — Firefox and Safari never
 * do, and that must not read as "none".
 *
 * Seam: `exportEncoders`, given the two facts rather than reading them.
 */

describe('exportEncoders', () => {
  it('stops at four, where more encoders stopped paying', () => {
    expect(exportEncoders(10, 32)).toBe(4)
    expect(exportEncoders(64, 8)).toBe(4)
  })

  it('takes half the cores, since the main thread is drawing all the while', () => {
    expect(exportEncoders(6, 32)).toBe(3)
    expect(exportEncoders(4, 32)).toBe(2)
    expect(exportEncoders(2, 32)).toBe(1)
    expect(exportEncoders(1, 32)).toBe(1)
  })

  it('holds fewer pages in flight on a machine with little memory', () => {
    // An eighth of it, at 170 MB a page: 512 MB is three pages, 256 MB one.
    expect(exportEncoders(10, 4)).toBe(3)
    expect(exportEncoders(10, 2)).toBe(1)
  })

  it('never goes below one, however small the machine', () => {
    expect(exportEncoders(10, 0.5)).toBe(1)
    expect(exportEncoders(0, 0.25)).toBe(1)
  })

  it('takes two where the browser will not say how much memory there is', () => {
    expect(exportEncoders(10, undefined)).toBe(2)
    expect(exportEncoders(2, undefined)).toBe(1)
  })
})
