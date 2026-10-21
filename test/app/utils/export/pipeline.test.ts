import { describe, expect, it, vi } from 'vitest'

import { pipeline } from '~/utils/export/pipeline'

/**
 * The shape of an export: pages drawn one at a time on the main thread, and
 * encoded several at once elsewhere.
 *
 * The two promises it makes are the ones a wrong version would break without
 * anything failing loudly. **Order**: pages are encoded side by side and finish
 * in whatever order their encoders do, and a zip or a PDF with page 3 before
 * page 2 is still a valid file — somebody reads the chapter out of order. And
 * **a bound on what is in flight**: every page handed on is a whole bitmap, 78
 * MB at the largest size, and a drawer that runs ahead of its encoders fills
 * memory with them until the tab dies — on the long chapters nobody tests with.
 *
 * Seam: `pipeline`, with `make` and `finish` as stubs whose timing each test
 * holds in its hands — no canvas, no worker.
 */

/** A promise and the means to settle it from outside. */
function deferred<T> () {
  let settle!: { resolve: (value: T) => void, reject: (error: unknown) => void }

  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject }
  })

  return { promise, ...settle }
}

/** Let every settled promise's callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A make and a finish whose every call is recorded and held open until the
 * test lets it go — and a count of how many finishes are running at once.
 */
function harness () {
  const events: string[] = []
  const finishing = new Map<number, ReturnType<typeof deferred<string>>>()

  let running = 0
  let most = 0

  const make = vi.fn(async (index: number) => {
    events.push(`make ${index}`)

    return `page ${index}`
  })

  const finish = vi.fn((made: string, index: number) => {
    events.push(`finish ${index}`)
    running++
    most = Math.max(most, running)

    const held = deferred<string>()

    finishing.set(index, held)

    return held.promise.finally(() => { running-- })
  })

  return {
    events,
    make,
    finish,
    most: () => most,
    /** Let finish `index` end, with `made` + " done", or with an error. */
    end: async (index: number, error?: Error) => {
      const held = finishing.get(index)!

      if (error) held.reject(error)
      else held.resolve(`page ${index} done`)

      await flush()
    },
  }
}

describe('order', () => {
  it('hands the results back in page order, whatever order they finished in', async () => {
    const h = harness()
    const running = pipeline(4, { inFlight: 4, make: h.make, finish: h.finish })

    await flush()

    // Last first — as a small page's encoder beats a large one's.
    for (const index of [3, 1, 2, 0]) await h.end(index)

    expect(await running).toEqual(['page 0 done', 'page 1 done', 'page 2 done', 'page 3 done'])
  })

  it('makes one page at a time, in order', async () => {
    const h = harness()
    const running = pipeline(3, { inFlight: 3, make: h.make, finish: h.finish })

    await flush()
    for (const index of [0, 1, 2]) await h.end(index)
    await running

    expect(h.make.mock.calls.map(([index]) => index)).toEqual([0, 1, 2])
  })

  it('leaves a gap where there was nothing to make, and finishes nothing for it', async () => {
    const h = harness()
    const make = vi.fn(async (index: number) => (index === 1 ? null : `page ${index}`))
    const running = pipeline(3, { inFlight: 2, make, finish: h.finish })

    await flush()
    await h.end(0)
    await h.end(2)

    expect(await running).toEqual(['page 0 done', null, 'page 2 done'])
    expect(h.finish.mock.calls.map(([, index]) => index)).toEqual([0, 2])
  })
})

describe('the bound on pages in flight', () => {
  it('never has more finishing at once than it was allowed', async () => {
    const h = harness()
    const running = pipeline(10, { inFlight: 3, make: h.make, finish: h.finish })

    for (let index = 0; index < 10; index++) {
      await flush()
      await h.end(index)
    }

    await running

    expect(h.most()).toBe(3)
  })

  it('draws no further ahead than one page waiting for a place', async () => {
    const h = harness()
    const running = pipeline(6, { inFlight: 2, make: h.make, finish: h.finish })

    await flush()

    // Two finishing, and the third made and waiting — nothing more.
    expect(h.events).toEqual(['make 0', 'finish 0', 'make 1', 'finish 1', 'make 2'])

    await h.end(0)

    expect(h.events.slice(5)).toEqual(['finish 2', 'make 3'])

    for (const index of [1, 2, 3, 4, 5]) {
      await h.end(index)
      await flush()
    }

    await running
  })

  it('draws the next page while the last is still being finished, even one at a time', async () => {
    const h = harness()
    const running = pipeline(2, { inFlight: 1, make: h.make, finish: h.finish })

    await flush()

    // Page 1 is drawn before page 0's encoding has ended: that overlap is the
    // point of the whole arrangement.
    expect(h.events).toEqual(['make 0', 'finish 0', 'make 1'])

    await h.end(0)
    await h.end(1)

    expect(await running).toEqual(['page 0 done', 'page 1 done'])
  })
})

describe('stopping', () => {
  it('makes nothing more, lets what was handed on finish, and hands back nothing', async () => {
    const h = harness()

    let stop = false

    const running = pipeline(5, { inFlight: 2, make: h.make, finish: h.finish, stopped: () => stop })

    await flush()
    stop = true
    await h.end(0)
    await h.end(1)

    expect(await running).toBeNull()
    expect(h.make.mock.calls.map(([index]) => index)).toEqual([0, 1, 2])
    expect(h.finish.mock.calls.map(([, index]) => index)).toEqual([0, 1])
  })

  it('gives back a page that was made but will not now be finished', async () => {
    const h = harness()
    const drop = vi.fn()

    let stop = false

    const running = pipeline(3, { inFlight: 1, make: h.make, finish: h.finish, drop, stopped: () => stop })

    await flush()

    // Page 1 is made and waiting for page 0's place when the stop comes.
    stop = true
    await h.end(0)

    expect(await running).toBeNull()
    expect(drop).toHaveBeenCalledExactlyOnceWith('page 1')
  })
})

describe('failing', () => {
  it('throws a finish\'s failure only once everything handed on has settled', async () => {
    const h = harness()
    const running = pipeline(4, { inFlight: 2, make: h.make, finish: h.finish })

    let settled = false

    running.catch(() => {}).finally(() => { settled = true })

    await flush()
    await h.end(0, new Error('encoder stopped'))

    // Page 1 is still being finished, so the failure waits for it.
    expect(settled).toBe(false)

    await h.end(1)

    await expect(running).rejects.toThrow('encoder stopped')
    expect(h.make.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('throws a make\'s failure once what was already handed on has settled', async () => {
    const h = harness()
    const make = vi.fn(async (index: number) => {
      if (index === 1) throw new Error('lettering tainted')

      return `page ${index}`
    })

    const running = pipeline(3, { inFlight: 2, make, finish: h.finish })

    let settled = false

    running.catch(() => {}).finally(() => { settled = true })

    await flush()

    expect(settled).toBe(false)

    await h.end(0)

    await expect(running).rejects.toThrow('lettering tainted')
    expect(make).toHaveBeenCalledTimes(2)
  })
})

describe('settling', () => {
  it('is told once, when everything is made and only finishing is left', async () => {
    const h = harness()
    const settling = vi.fn()
    const running = pipeline(2, { inFlight: 2, make: h.make, finish: h.finish, settling })

    await flush()

    expect(settling).toHaveBeenCalledOnce()

    await h.end(0)
    await h.end(1)
    await running

    expect(settling).toHaveBeenCalledOnce()
  })
})
