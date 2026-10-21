import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodeReply, DecodeRequest } from '~/utils/raster/decode'

/**
 * The background decoders: a few threads for previews, thumbnails and model
 * inputs, beside the one the page on screen is drawn from.
 *
 * There was one background thread, and every whole-page job waited its turn on
 * it: eight previews of 3732 × 5197 pages took 4.7 s however many callers asked
 * at once, and a thumbnail asked for meanwhile waited out the preview in
 * progress. The pool is what `backgroundDecoders` says, and every way it can go
 * wrong is quiet — a request sent to a thread already busy waits behind it, a
 * job sent to another thread than its `asideSize` decodes the scan twice, a
 * reply handed to the wrong caller is somebody else's picture.
 *
 * Seam: the decoder module's own functions over a stand-in `Worker` whose every
 * reply the test sends by hand, with the pool's width fixed at three.
 */

vi.mock('~/utils/resources', async (original) => ({
  ...await original<typeof import('~/utils/resources')>(),
  backgroundDecoders: () => 3,
}))

type Asked = Extract<DecodeRequest, { id: number }>

class FakeWorker {
  static all: FakeWorker[] = []

  readonly name: string
  readonly posted: DecodeRequest[] = []
  onmessage: ((event: MessageEvent<DecodeReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor (_url: URL, options: { name: string }) {
    this.name = options.name
    FakeWorker.all.push(this)
  }

  postMessage (request: DecodeRequest) {
    this.posted.push(request)
  }

  terminate () {}

  /** The work this thread has been sent, releases and cancels left out. */
  get asked () {
    return this.posted.filter((request): request is Asked => 'id' in request)
  }

  /** Answer the last request sent here with a file that names it. */
  answer () {
    const request = this.asked.at(-1)!

    this.onmessage?.({
      data: { id: request.id, ok: true, width: 10, height: 20, blob: new Blob([`made for ${request.key}`]) },
    } as MessageEvent<DecodeReply>)
  }
}

const background = () => FakeWorker.all.filter((worker) => worker.name.startsWith('background decoder'))
const scanThreads = () => FakeWorker.all.filter((worker) => worker.name === 'scan decoder')

/** A turn of the event loop, for promise chains to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const THUMB = { what: 'thumb', width: 320, type: 'image/webp', quality: 0.86 } as const
const file = new Blob(['scan'], { type: 'image/jpeg' })

/** The decoder module, fresh — its threads and queue live at module level. */
async function decoder () {
  vi.resetModules()

  return import('~/utils/raster/decoder')
}

beforeEach(() => {
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
})

describe('the background decoders', () => {
  it('run three jobs at once, one to a thread, and give the next to the first thread free', async () => {
    const { scanJob } = await decoder()

    const made = ['a', 'b', 'c', 'd', 'e'].map((key) => scanJob(key, file, THUMB))

    await settle()

    // Three threads, each with one job — not one thread with five.
    expect(background().map((worker) => worker.asked.map((request) => request.key))).toEqual([['a'], ['b'], ['c']])

    background()[1]!.answer()
    await settle()

    expect(background()[1]!.asked.map((request) => request.key)).toEqual(['b', 'd'])
    expect(background()).toHaveLength(3)

    // Answered out of order: each caller still gets its own file.
    background()[2]!.answer()
    background()[1]!.answer()
    await settle()
    background()[0]!.answer()
    await settle()
    background()[2]!.answer()

    const blobs = await Promise.all(made)

    expect(await Promise.all(blobs.map((one) => one!.blob!.text()))).toEqual(['a', 'b', 'c', 'd', 'e'].map((key) => `made for ${key}`))
  })

  it('never lend the page on screen’s thread to background work, nor start more than one of it', async () => {
    const { scanJob, scanLevel } = await decoder()

    for (const key of ['a', 'b', 'c', 'd']) scanJob(key, file, THUMB)
    for (const key of ['p1', 'p2']) scanLevel(key, file, 100, 100, { keep: true, urgent: true })

    await settle()

    expect(scanThreads()).toHaveLength(1)
    expect(scanThreads()[0]!.asked.map((request) => request.key)).toEqual(['p1', 'p2'])
    expect(background().flatMap((worker) => worker.asked.map((request) => request.key))).toEqual(['a', 'b', 'c'])
  })

  it('send an urgent job ahead of the previews already waiting', async () => {
    const { scanJob, scanPreview } = await decoder()

    for (const key of ['p1', 'p2', 'p3', 'p4', 'p5']) scanPreview(key, file, 100, 100)
    scanJob('thumb', file, THUMB)

    await settle()
    background()[0]!.answer()
    await settle()

    // p4 and p5 were asked for first; the thumbnail is what somebody is waiting on.
    expect(background()[0]!.asked.map((request) => request.key)).toEqual(['p1', 'thumb'])
  })

  it('start no second thread once one could not start, rather than run several on the page’s own', async () => {
    let tried = 0

    // A worker the page is not allowed to start: the constructor throws.
    vi.stubGlobal('Worker', function Refused () {
      tried++

      throw new Error('workers are not allowed here')
    })

    const { scanJob } = await decoder()
    const made = ['a', 'b', 'c'].map((key) => scanJob(key, file, THUMB).catch(() => null))

    await Promise.all(made)

    // This test's DOM cannot draw, so each fails; what matters is that they
    // took turns on one host rather than three.
    expect(tried).toBe(1)
  })

  it('send a job to the thread holding its page’s decode, and new pages to the others', async () => {
    const { asideSize, releaseAside, scanJob } = await decoder()

    const size = asideSize('page', file)

    await settle()
    background()[0]!.answer()
    expect(await size).toEqual({ width: 10, height: 20 })

    // The first thread is free but holds `page`'s decode for the job to come;
    // somebody else's job gets a thread of its own rather than evicting it.
    scanJob('other', file, THUMB)
    await settle()
    scanJob('page', file, THUMB)
    await settle()

    expect(background().map((worker) => worker.asked.map((request) => `${request.kind} ${request.key}`))).toEqual([
      ['size page', 'job page'],
      ['job other'],
    ])

    // An `asideSize` no job followed lets its decode go on the thread that has it.
    background()[0]!.answer()
    background()[1]!.answer()
    await settle()

    const lone = asideSize('lone', file)

    await settle()
    const holder = background().find((worker) => worker.asked.some((request) => request.key === 'lone'))!

    holder.answer()
    await lone
    releaseAside('lone')

    expect(holder.posted.at(-1)).toEqual({ kind: 'release', key: 'lone' })
  })
})
