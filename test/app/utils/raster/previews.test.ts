import { describe, expect, it } from 'vitest'

import { cleaningName, cleaningSignature, previewName, previewSize } from '~/utils/raster/previews'

/**
 * The size a page's preview is kept at, and what it is called.
 *
 * A preview stands in for the scan at the size the page is shown at, so it is
 * made at the fit's height rounded up to a step — a window resized a little
 * finds the previews it already made — and never past the scan itself. The
 * step was 512 at first, and previews came out at up to 8.7 MB against 2.4–3
 * for ones made at the fit; it is 128 now.
 *
 * Seam: the pure naming and sizing in `utils/raster/previews`.
 */

const PAGE = { width: 3732, height: 5197 }

describe('a page preview', () => {
  it('is made at the fit rounded up to the next step of 128, at the page\'s proportions', () => {
    expect(previewSize(PAGE, { width: 2009, height: 2798 })).toEqual({ width: 2022, height: 2816 })
  })

  it('is never larger than the scan', () => {
    expect(previewSize({ width: 800, height: 1200 }, { width: 800, height: 1200 })).toEqual({ width: 800, height: 1200 })
  })

  it('is found again by a window resized within the same step', () => {
    const a = previewSize(PAGE, { width: 2000, height: 2785 })
    const b = previewSize(PAGE, { width: 2014, height: 2805 })

    expect(previewName('hash', a)).toBe(previewName('hash', b))
    expect(previewName('hash', a)).toBe('hash@2816.webp')
  })
})

/*
 * A page's cleaning, beside its preview: every repair in one picture, named by
 * what is in it so that a balloon cleaned again is a new file and an old one is
 * never shown over a page it no longer matches.
 */
describe('a page\'s cleaning', () => {
  const repair = { url: 'blob:a', key: 'k1', sx: 10.2, sy: 20, sw: 30, sh: 40 }

  it('is named by the repairs\' names and places, not by this session\'s URLs', () => {
    expect(cleaningSignature([repair])).toBe(cleaningSignature([{ ...repair, url: 'blob:b' }]))
  })

  it('is another name when a repair is made again, or moved', () => {
    const was = cleaningSignature([repair])

    expect(cleaningSignature([{ ...repair, key: 'k2' }])).not.toBe(was)
    expect(cleaningSignature([{ ...repair, sx: 50 }])).not.toBe(was)
  })

  it('is nothing for a page with no repairs, and never mistaken for the scan\'s preview', () => {
    expect(cleaningSignature([])).toBe('')
    expect(cleaningName('hash', { width: 100, height: 256 }, 'abc')).toBe('hash@256~abc.webp')
    expect(cleaningName('hash', { width: 100, height: 256 }, 'abc')).not.toBe(previewName('hash', { width: 100, height: 256 }))
  })
})
