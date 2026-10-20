/**
 * Encoder threads for an export: a few workers, each taking one page at a time.
 *
 * Made for one export and ended with it, rather than kept for the tab's life
 * like the scan decoder (`raster/decoder.ts`): an export is rare, and a worker
 * that has just encoded a 3732 × 5197 page is holding a heap sized for one.
 * Ending it hands all of that back at once. They are started as the export
 * starts, so they load while the first page is being drawn, which takes longer.
 *
 * A worker says whether it can draw before it is given anything (`ready` in
 * `encode.ts`), because a page is *transferred* to it — the only copy there is
 * — and a thread that turns out to have no `OffscreenCanvas`, or whose script
 * never loaded, would otherwise lose the page it was handed. Where no worker
 * will take a page at all, the page is encoded on this thread by the same
 * code: slower, and the export still comes out.
 *
 * The pool bounds threads, not memory. It queues whatever it is given; keeping
 * that to a few pages is the caller's part (`pipeline.ts`), since only the
 * caller knows what else is held while it waits.
 */
import { encodePage } from './encode'

import type { Encoded, EncodeJob, EncodeReply, EncodeRequest } from './encode'

export interface Encoder {
  /** The page as a file. The bitmap is the encoder's from here, and is closed whatever happens. */
  encode: (bitmap: ImageBitmap, job: EncodeJob) => Promise<Encoded>
  /** End every thread, and turn away whatever is still waiting. */
  close: () => void
}

/** A page turned away because the export ended first — expected, not a failure. */
export class EncoderClosed extends Error {
  constructor () {
    super('The export was ended before this page was encoded.')
  }
}

interface Waiting {
  bitmap: ImageBitmap
  job: EncodeJob
  resolve: (made: Encoded) => void
  reject: (error: unknown) => void
}

interface Thread {
  worker: Worker
  /** Said it can draw — see `ready` in `encode.ts`. Nothing is sent before. */
  ready: boolean
  /** The page it holds, and the number it was sent under. */
  holding: (Waiting & { id: number }) | null
}

/** A worker of the kind the pool runs, made — or a throw, where there can be none. */
function spawnEncoder (): Worker {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('no worker with a canvas')

  return new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module', name: 'page encoder' })
}

/**
 * `size` encoder threads. `spawn` makes one — the real worker unless a test
 * says otherwise — and a throw from it means this thread does the work.
 */
export function encoderPool (size: number, spawn: () => Worker = spawnEncoder): Encoder {
  const threads: Thread[] = []
  const queue: Waiting[] = []

  let next = 0
  let closed = false

  function pump () {
    if (closed) return

    for (const thread of threads) {
      if (!queue.length) return
      if (!thread.ready || thread.holding) continue

      const waiting = queue.shift()!
      const id = ++next

      try {
        thread.worker.postMessage({ id, bitmap: waiting.bitmap, ...waiting.job } satisfies EncodeRequest, [waiting.bitmap])
        thread.holding = { ...waiting, id }
      } catch (error) {
        // A bitmap that cannot be sent — closed already, or detached — fails
        // its own page and leaves the thread free for the next.
        waiting.reject(error)
      }
    }

    // No thread left that will ever take one: they are done here instead.
    if (!threads.length) {
      for (const waiting of queue.splice(0)) encodePage(waiting.bitmap, waiting.job).then(waiting.resolve, waiting.reject)
    }
  }

  /** A thread that will do no more: gone, and the page it held lost with it. */
  function lose (thread: Thread, why: string) {
    thread.worker.terminate()
    threads.splice(threads.indexOf(thread), 1)
    thread.holding?.reject(new Error(why))
    pump()
  }

  function start () {
    let worker: Worker

    try {
      worker = spawn()
    } catch {
      return
    }

    const thread: Thread = { worker, ready: false, holding: null }

    worker.onmessage = (event: MessageEvent<EncodeReply>) => {
      const reply = event.data

      if (reply.kind === 'ready') {
        if (!reply.canvas) {
          lose(thread, 'That encoder cannot draw.')

          return
        }

        thread.ready = true
        pump()

        return
      }

      const held = thread.holding

      if (!held || held.id !== reply.id) return

      thread.holding = null

      if (reply.kind === 'done') held.resolve({ blob: reply.blob, crc: reply.crc })
      else held.reject(new Error(reply.error))

      pump()
    }

    worker.onerror = (event) => {
      event.preventDefault()
      console.warn('[kemolate] a page encoder stopped', event.message)
      lose(thread, 'The page encoder stopped.')
    }

    threads.push(thread)
  }

  for (let at = 0; at < Math.max(1, size); at++) start()

  return {
    encode (bitmap, job) {
      if (closed) {
        bitmap.close()

        return Promise.reject(new EncoderClosed())
      }

      return new Promise<Encoded>((resolve, reject) => {
        queue.push({ bitmap, job, resolve, reject })
        pump()
      })
    },

    close () {
      closed = true

      for (const thread of threads.splice(0)) {
        thread.worker.terminate()
        thread.holding?.reject(new EncoderClosed())
      }

      for (const waiting of queue.splice(0)) {
        waiting.bitmap.close()
        waiting.reject(new EncoderClosed())
      }
    },
  }
}
