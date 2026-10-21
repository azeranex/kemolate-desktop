import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bitmap, Canvas, fail, hold, log, release, reset } from './harness'

import { cleanPage, paddedBox } from '~/utils/ocr/clean'

/**
 * A page's balloons through the model one at a time, with the next one made
 * ready while the model has this one.
 *
 * The inference runs in the runtime's worker, and this thread used to wait it
 * out doing nothing — then, the moment it answered, cut the next balloon out of
 * the page, masked it and built its tensors while the worker sat idle. Every
 * balloon paid for its preparation, its inference and its finish one after
 * another. The runtime is replaced here by one whose runs the test can hold
 * open (see `harness.ts`), which is what lets it ask what happened *while* a run
 * was in the model rather than only what came out at the end.
 *
 * And the two rules the overlap must not bend: one run in the model at a time,
 * and tensors made for exactly one run. The stand-in session moves its inputs
 * away as the real one does, so a tensor handed to two runs throws here too.
 */

mockNuxtImport('sessionFor', async () => {
  const { session } = await import('./harness')

  return async () => session
})

mockNuxtImport('ortOnce', async () => {
  const { runtime } = await import('./harness')

  return async () => runtime
})

const W = 1000
const H = 1000

/** Three balloons far enough apart that no two crops share a left edge. */
const regions = [
  { x: 100, y: 100, w: 120, h: 80 },
  { x: 400, y: 300, w: 120, h: 80 },
  { x: 700, y: 500, w: 120, h: 80 },
]

/** The log line for the n-th balloon being cut out of the page. */
const crop = (n: number) => `crop ${paddedBox(regions[n]!, W, H).x}`

const page = () => ({ file: new File(['page'], 'page.jpg'), width: W })

describe('cleanPage, one balloon ahead of the model', () => {
  beforeEach(() => {
    reset()
    vi.stubGlobal('OffscreenCanvas', Canvas)
    vi.stubGlobal('createImageBitmap', async () => bitmap(W, H))
  })

  afterEach(() => {
    release()
    vi.unstubAllGlobals()
  })

  it('cuts out, masks and makes the tensors of the next balloon while the model has this one', async () => {
    hold()

    const cleaning = cleanPage(page(), regions, undefined, 'aot')

    // The first balloon's two tensors and the second's, with the first run
    // still unanswered. Before, the second balloon was not touched until the
    // first had come back and been finished.
    await vi.waitFor(() => expect(log.filter((line) => line === 'tensor')).toHaveLength(4))

    expect(log).toContain('run 1')
    expect(log).toContain(crop(1))
    expect(log).not.toContain('ran 1')

    release()

    expect(await cleaning).toHaveLength(3)
  })

  it('never has two balloons in the model at once', async () => {
    const patches = await cleanPage(page(), regions, undefined, 'aot')
    const runs = log.filter((line) => line.startsWith('run') || line.startsWith('ran'))

    expect(patches).toHaveLength(3)
    // Strictly one after another: each run answered before the next is handed anything.
    expect(runs).toEqual(['run 1', 'ran 1', 'run 2', 'ran 2', 'run 3', 'ran 3'])
    // And each balloon cut out once, in order.
    expect(log.filter((line) => line.startsWith('crop'))).toEqual([crop(0), crop(1), crop(2)])
  })

  it('goes on to the balloon it made ready when a run fails, with tensors no run has had', async () => {
    // The GPU falling over mid-page: the session is dropped and the next balloon
    // opens another. The balloon behind the failure was made ready while it ran,
    // and its tensors must reach the next run untouched — the stand-in session
    // throws on one that was already handed over.
    fail(1)

    const skipped: number[] = []
    const patches = await cleanPage(page(), regions, undefined, 'aot', { onSkip: (index) => skipped.push(index) })

    expect(skipped).toEqual([0])
    expect(patches).toHaveLength(2)
    expect(log.filter((line) => line.startsWith('run'))).toEqual(['run 1', 'run 2', 'run 3'])
  })

  it('runs nothing more once called off, the balloon made ready included', async () => {
    hold()

    const stop = new AbortController()
    const cleaning = cleanPage(page(), regions, undefined, 'aot', { signal: stop.signal })

    await vi.waitFor(() => expect(log).toContain('run 1'))
    // Long enough for the balloon behind it to be made ready.
    await new Promise((resolve) => setTimeout(resolve, 0))

    stop.abort()
    release()

    await expect(cleaning).rejects.toThrow()
    // Called off while the first was in the model: its answer is dropped, and
    // the second — cut out and given its tensors meanwhile — is never run.
    expect(log.filter((line) => line.startsWith('run'))).toEqual(['run 1'])
  })
})
