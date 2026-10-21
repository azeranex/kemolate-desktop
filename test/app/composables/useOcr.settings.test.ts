import { describe, expect, it } from 'vitest'

import { DETECTOR_DEFAULT_SINCE, heldOcrSettings } from '~/composables/useOcr'
import { DEFAULT_BUILD } from '~/utils/ocr/detectors'

/**
 * What of the OCR settings kept in this browser still stands.
 *
 * The case worth a test is the default changing under saved settings. `remember`
 * writes the whole object on any change, so every browser that ever picked a
 * reader also saved `detector: 'fast'` — the default of the day, carried along,
 * not chosen. Taken at its word, that would have kept every existing browser on
 * the old default for good, which is the opposite of changing it.
 *
 * Desktop: the readers named are Kemolate OCR and PP-OCR, Manga OCR being off
 * this build's list — and a reader remembered as Manga OCR is one of the ids
 * dropped, so the default (Kemolate OCR) stands for it.
 */
describe('heldOcrSettings', () => {
  it('lets go of a fast saved before full became the default', () => {
    expect(heldOcrSettings({ detector: 'fast', reader: 'ppocr-small' })).toEqual({ reader: 'ppocr-small' })
  })

  it('keeps a fast chosen since', () => {
    expect(heldOcrSettings({ detector: 'fast', reader: 'kemolate-beta', since: DETECTOR_DEFAULT_SINCE }))
      .toEqual({ detector: 'fast', reader: 'kemolate-beta' })
  })

  it('keeps any other detector saved before, which somebody did choose', () => {
    expect(heldOcrSettings({ detector: 'accurate', reader: 'kemolate-beta' })).toEqual({ detector: 'accurate', reader: 'kemolate-beta' })
    expect(heldOcrSettings({ detector: 'paddle-small' })).toEqual({ detector: 'paddle-small' })
  })

  it('drops ids the lists no longer hold', () => {
    expect(heldOcrSettings({ detector: 'tesseract', reader: 'paddle-v4', since: DETECTOR_DEFAULT_SINCE })).toEqual({})
    expect(heldOcrSettings({ reader: 'manga' })).toEqual({})
    expect(heldOcrSettings({ reader: 'manga-2025' })).toEqual({})
  })

  it('makes full the comic default', () => {
    expect(DEFAULT_BUILD.comic).toBe('full')
  })
})
