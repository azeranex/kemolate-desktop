import { describe, expect, it, vi } from 'vitest'
import { nextTick, watch } from 'vue'

import { useBrushCursor } from '~/composables/useBrushCursor'

/**
 * Where the brush ring is, kept out of Nuxt's payload.
 *
 * The position is written on every pointer move, and in development Nuxt
 * DevTools watches the payload deeply — so while it was a `useState`, every
 * move of the ring re-read every page, block and mask correction the chapter
 * held. Measured on the test chapter: 2.7 ms a hover move, and 19 ms with sixty
 * thousand more numbers in the payload, against 0.1 ms with the position out of
 * it. The mask brush's ring was the one reported stuttering, because
 * corrections are what piles up while somebody works the mask.
 *
 * Seam: a deep watcher on the payload, standing in for DevTools' own — the
 * thing that paid for every move — and the ring's reading of the position.
 *
 * Desktop: only the second half. There is no payload here, and no DevTools
 * walking one, so the test of keeping out of it did not come across.
 */
describe('the brush cursor', () => {
  it('is one position for every brush, and the ring hears it move', async () => {
    const brush = useBrushCursor()
    const ring = useBrushCursor()
    const heard = vi.fn()
    const stop = watch(ring.at, heard)

    brush.show({ x: 12, y: 34 })
    await nextTick()

    expect(ring.at.value).toEqual({ x: 12, y: 34 })
    expect(heard).toHaveBeenCalledTimes(1)

    brush.hide()
    await nextTick()
    stop()

    expect(ring.at.value).toBeNull()
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
