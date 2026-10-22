import { describe, expect, it } from 'vitest'

import { formatBytes } from '~/utils/bytes'
import { detectorBytes, DETECTORS_BY_ID } from '~/utils/ocr/detectors'
import { readerBytes, READERS_BY_ID } from '~/utils/ocr/readers'

/**
 * What a reader's label says it will fetch.
 *
 * Manga OCR's said "200 MB" to every browser and fetched 460 on WebGPU, where
 * its encoder is the fp32 build. The figure has to follow the build the machine
 * will read with — q8, fp32 or fp16 — for the readers whose files do, and stay
 * put for the rest.
 *
 * Desktop: asked of Kemolate OCR rather than Manga OCR, which is off this
 * build's list (`READERS`); it has the same three builds, so the same three
 * figures to tell apart. The one-build reader is PP-OCRv6 Small for the same
 * reason — Manga OCR 2025 went with it.
 */
const WASM = { gpu: false, half: false }
const GPU = { gpu: true, half: false }
const HALF = { gpu: true, half: true }

describe('readerBytes', () => {
  const kemolate = READERS_BY_ID.get('kemolate-beta')!

  it('gives WebAssembly the q8 figure', () => {
    expect(readerBytes(kemolate, WASM)).toBe(kemolate.bytes)
    expect(formatBytes(readerBytes(kemolate, WASM)!)).toBe('119 MB')
  })

  it('gives a GPU without half precision the fp32 figure', () => {
    expect(readerBytes(kemolate, GPU)).toBe(kemolate.gpuBytes)
    expect(formatBytes(readerBytes(kemolate, GPU)!)).toBe('470 MB')
  })

  it('gives a GPU with half precision the fp16 figure', () => {
    expect(readerBytes(kemolate, HALF)).toBe(kemolate.halfBytes)
    expect(formatBytes(readerBytes(kemolate, HALF)!)).toBe('236 MB')
  })

  it('does not count half precision without a GPU', () => {
    expect(readerBytes(kemolate, { gpu: false, half: true })).toBe(kemolate.bytes)
  })

  it('does not move for a reader with one build', () => {
    const lighter = READERS_BY_ID.get('ppocr-small')!

    expect(readerBytes(lighter, HALF)).toBe(readerBytes(lighter, WASM))
  })

  it('says nothing for a reader that fetches nothing', () => {
    expect(readerBytes(READERS_BY_ID.get('vision')!, HALF)).toBeUndefined()
    expect(readerBytes(READERS_BY_ID.get('vision')!, WASM)).toBeUndefined()
  })

  // Desktop: the Lab reader is off the list — see `READERS`.
  it('has no Lab reader', () => {
    expect(READERS_BY_ID.has('lab')).toBe(false)
  })
})

describe('detectorBytes', () => {
  const full = DETECTORS_BY_ID.get('full')!

  it('gives the fp16 figure only where a GPU can run it', () => {
    expect(formatBytes(detectorBytes(full, HALF))).toBe('81 MB')
    expect(formatBytes(detectorBytes(full, GPU))).toBe('161 MB')
    expect(formatBytes(detectorBytes(full, WASM))).toBe('161 MB')
  })

  it('does not move for a build with one file', () => {
    const fast = DETECTORS_BY_ID.get('fast')!

    expect(detectorBytes(fast, HALF)).toBe(fast.bytes)
  })
})
