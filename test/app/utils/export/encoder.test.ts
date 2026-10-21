import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EncodeReply, EncodeRequest } from '~/utils/export/encode'

import { EncoderClosed, encoderPool } from '~/utils/export/encoder'

/**
 * The encoder threads an export hands its pages to.
 *
 * A page is *transferred* to a worker — the only copy there is — so every way
 * this goes wrong loses a page rather than failing loudly: sent to a thread
 * that never loaded, sent to one with no canvas to draw on, answered with
 * another page's file, or left waiting forever when a thread dies. Each case
 * here is one of those, and the fallback that stands behind all of them —
 * encoding on the page's own thread where no worker will.
 *
 * Seam: `encoderPool` with a stand-in `Worker` whose every message the test
 * sends by hand, and `encodePage` (the fallback) replaced.
 */

const { encodePage } = vi.hoisted(() => ({
  encodePage: vi.fn(async (bitmap: ImageBitmap) => ({ blob: new Blob([`here ${bitmap.width}`]), crc: null })),
}))

vi.mock('~/utils/export/encode', () => ({ encodePage }))

class FakeWorker {
  posted: { message: EncodeRequest, transfer: Transferable[] }[] = []
  terminated = false
  onmessage: ((event: MessageEvent<EncodeReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  postMessage (message: EncodeRequest, transfer: Transferable[]) {
    this.posted.push({ message, transfer })
  }

  terminate () {
    this.terminated = true
  }

  say (reply: EncodeReply) {
    this.onmessage?.({ data: reply } as MessageEvent<EncodeReply>)
  }

  /** The last page sent here, answered with a file named for it. */
  answer () {
    const { message } = this.posted.at(-1)!

    this.say({ kind: 'done', id: message.id, blob: new Blob([`page ${message.bitmap.width}`]), crc: message.bitmap.width })
  }

  fail () {
    this.onerror?.(Object.assign(new Event('error'), { message: 'out of memory' }) as ErrorEvent)
  }
}

let workers: FakeWorker[] = []

const spawn = () => {
  const worker = new FakeWorker()

  workers.push(worker)

  return worker as unknown as Worker
}

/** A stand-in page; its width names it. */
const page = (width: number) => ({ width, height: 1, close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> }

const JOB = { type: 'image/png', crc: true } as const

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const text = async (made: Promise<{ blob: Blob }>) => (await made).blob.text()

beforeEach(() => {
  workers = []
  encodePage.mockClear()
})

describe('handing pages over', () => {
  it('sends nothing to a thread before it says it can draw', async () => {
    const pool = encoderPool(1, spawn)
    const one = page(1)
    const made = pool.encode(one, JOB)

    expect(workers[0]!.posted).toEqual([])

    workers[0]!.say({ kind: 'ready', canvas: true })

    expect(workers[0]!.posted).toHaveLength(1)
    expect(workers[0]!.posted[0]!.message.bitmap).toBe(one)
    // Transferred, not copied: 78 MB a page at the largest size.
    expect(workers[0]!.posted[0]!.transfer).toEqual([one])

    workers[0]!.answer()

    expect(await text(made)).toBe('page 1')

    pool.close()
  })

  it('gives each thread one page, keeps the rest waiting, and answers each page with its own file', async () => {
    const pool = encoderPool(2, spawn)

    for (const worker of workers) worker.say({ kind: 'ready', canvas: true })

    const made = [1, 2, 3].map((width) => pool.encode(page(width), JOB))

    expect(workers.map((worker) => worker.posted.length)).toEqual([1, 1])

    // The second thread finishes first; the waiting page goes to it.
    workers[1]!.answer()

    expect(await text(made[1]!)).toBe('page 2')
    expect(workers[1]!.posted.at(-1)!.message.bitmap.width).toBe(3)

    workers[0]!.answer()
    workers[1]!.answer()

    expect(await Promise.all(made.map(text))).toEqual(['page 1', 'page 2', 'page 3'])
    expect((await made[2]!).crc).toBe(3)

    pool.close()
  })

  it('ignores an answer for a page the thread is not holding', async () => {
    const pool = encoderPool(1, spawn)

    workers[0]!.say({ kind: 'ready', canvas: true })

    const made = pool.encode(page(7), JOB)
    const { id } = workers[0]!.posted[0]!.message

    workers[0]!.say({ kind: 'done', id: id + 1, blob: new Blob(['somebody else']), crc: 0 })
    workers[0]!.answer()

    expect(await text(made)).toBe('page 7')

    pool.close()
  })
})

describe('when a thread will not do', () => {
  it('lets go of one that cannot draw, and encodes here once none is left', async () => {
    const pool = encoderPool(1, spawn)

    workers[0]!.say({ kind: 'ready', canvas: false })

    expect(workers[0]!.terminated).toBe(true)

    const one = page(4)

    expect(await text(pool.encode(one, JOB))).toBe('here 4')
    expect(encodePage).toHaveBeenCalledExactlyOnceWith(one, JOB)

    pool.close()
  })

  it('encodes here where no thread can be started at all', async () => {
    const pool = encoderPool(2, () => {
      throw new Error('no Worker')
    })

    expect(await text(pool.encode(page(5), JOB))).toBe('here 5')

    pool.close()
  })

  it('loses only the page a stopped thread held, and carries on with the others', async () => {
    const pool = encoderPool(2, spawn)

    for (const worker of workers) worker.say({ kind: 'ready', canvas: true })

    const first = pool.encode(page(1), JOB)
    const second = pool.encode(page(2), JOB)
    const third = pool.encode(page(3), JOB)

    workers[0]!.fail()

    await expect(first).rejects.toThrow('The page encoder stopped.')
    expect(workers[0]!.terminated).toBe(true)

    workers[1]!.answer()
    await flush()
    workers[1]!.answer()

    expect(await text(second)).toBe('page 2')
    expect(await text(third)).toBe('page 3')

    pool.close()
  })
})

describe('closing', () => {
  it('ends every thread, turns away what is waiting and gives its bitmap back', async () => {
    const pool = encoderPool(1, spawn)

    workers[0]!.say({ kind: 'ready', canvas: true })

    const held = page(1)
    const waiting = page(2)
    const made = [pool.encode(held, JOB), pool.encode(waiting, JOB)]

    pool.close()

    expect(workers[0]!.terminated).toBe(true)
    await expect(made[0]).rejects.toBeInstanceOf(EncoderClosed)
    await expect(made[1]).rejects.toBeInstanceOf(EncoderClosed)
    expect(waiting.close).toHaveBeenCalledOnce()

    const late = page(3)

    await expect(pool.encode(late, JOB)).rejects.toBeInstanceOf(EncoderClosed)
    expect(late.close).toHaveBeenCalledOnce()
  })
})
