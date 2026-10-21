import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadFace } from '~/utils/lettering'

/**
 * A face whose load has finished is usable, whatever `check` says afterwards.
 *
 * The report: every balloon on a chapter lettered in Anime Ace vanished. The
 * board hides a balloon until its face is usable, and "usable" was
 * `document.fonts.check` on the whole stack — which answers true only when
 * every family in it is loaded, fallbacks included. Loading the stack fetched
 * Anime Ace and not the Shantell Sans behind it, so the check never came true
 * and the text never came back.
 *
 * The font set is stubbed to behave exactly that way: `check` false for good,
 * `load` finding the face. Each case uses a family of its own, because
 * `loadFace` remembers what it has asked for across calls.
 */

function fonts (load: () => Promise<FontFace[]>) {
  vi.stubGlobal('document', Object.assign(Object.create(document), {
    fonts: { check: () => false, load },
  }))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('loadFace', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says a face is usable once its load has finished, though the stack never checks true', async () => {
    fonts(async () => [{} as FontFace])

    const done = vi.fn()

    expect(loadFace('"Face A", "Fallback"', false, false, done)).toBe(false)

    await settle()

    expect(done).toHaveBeenCalledOnce()
    expect(loadFace('"Face A", "Fallback"', false, false, done)).toBe(true)
  })

  it('lets a face that will not load be drawn in whatever the browser has', async () => {
    fonts(() => Promise.reject(new Error('offline')))

    const done = vi.fn()

    loadFace('"Face B"', true, false, done)
    await settle()

    expect(loadFace('"Face B"', true, false, done)).toBe(true)
  })

  it('asks for a face once, however many balloons want it', async () => {
    const load = vi.fn(async () => [{} as FontFace])

    fonts(load)

    for (let i = 0; i < 5; i++) loadFace('"Face C"', false, true, () => {})

    await settle()

    expect(load).toHaveBeenCalledOnce()
  })
})
