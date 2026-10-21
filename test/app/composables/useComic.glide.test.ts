import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useComic } from '~/composables/useComic'

/**
 * A zoom glide never goes the wrong way, and never stops on the way.
 *
 * The report: zooming in quickly, the page seemed to shrink for a moment on
 * the way. A glide's frames are timed from the frame's own timestamp, which
 * marks when the frame *began* — earlier than a glide started partway through
 * it — so the first step came out negative, and ease-out at a negative time is
 * further back than the start. Each fast notch starts the next glide from
 * wherever that left the zoom, so six notches in took the page from 1× down to
 * 0.7× on the way to 2.5×.
 *
 * Seam: `zoomAt` with a glide, and `requestAnimationFrame` driven by hand with
 * the timestamps a real frame hands over.
 */

const frames: FrameRequestCallback[] = []

describe('a zoom glide', () => {
  beforeEach(() => {
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const comic = useComic()

    comic.reset()
    comic.room.value = { w: 1000, h: 1000 }
    comic.resetView(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Run the frames waiting, stamped `at`. */
  function frame (at: number) {
    for (const callback of frames.splice(0)) callback(at)
  }

  it('does not dip below where it started on a frame that began before it', () => {
    const { zoom, zoomAt } = useComic()
    const started = performance.now()

    zoomAt(1.5, { x: 500, y: 500 }, true)

    // The next frame's stamp is its start — a few milliseconds before the
    // glide was asked for, part way through the frame before.
    frame(started - 5)

    expect(zoom.value).toBeGreaterThanOrEqual(1)
  })

  /**
   * And never stands still on its first frame. Flooring the first step at
   * nought, the first fix for the dip, left every glide's first frame where it
   * started: one stalled frame per notch, which is a hiccup in a fast zoom.
   */
  it('moves on its very first frame', () => {
    const { zoom, zoomAt } = useComic()

    zoomAt(1.5, { x: 500, y: 500 }, true)
    frame(performance.now() - 5)

    expect(zoom.value).toBeGreaterThan(1)
  })

  it('only ever moves towards where it is going across fast notches', () => {
    const { zoom, zoomAt } = useComic()
    const seen: number[] = [zoom.value ?? 1]

    for (let notch = 0; notch < 6; notch++) {
      zoomAt(1.16, { x: 500, y: 500 }, true)
      // Each notch lands mid-frame, and the frame that follows is stamped a
      // little before it.
      frame(performance.now() - 4)
      seen.push(zoom.value ?? 1)
    }

    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
  })
})
