/**
 * Scans as bitmaps, decoded off the main thread — the one way the page asks
 * for its pixels.
 *
 * Each scan is named by its object URL, the key `Paint`, `Mask` and `usePaper`
 * already use for "this scan, as opened now". It changes on every open, so an
 * answer about a page the canvas has since left can never be taken for the
 * page it is on.
 *
 * One worker for the page, and a few for everything else (see `decoders`), for
 * the life of the tab and each made when first needed. Where a worker cannot
 * be had — no `Worker`, or one the page is not allowed to start — the same
 * host runs here, which is the old cost but the same answers.
 */
import { backgroundDecoders } from '../resources'

import { decodeHost } from './decode'

import type { DecodeReply, DecodeRequest } from './decode'
import type { Job, JobResult } from './jobs'

/** The page's own size, and the bitmap asked for. */
export interface Decoded {
  width: number
  height: number
  bitmap: ImageBitmap
}

/** A request withdrawn before it ran — expected, not a failure. */
export class Cancelled extends Error {
  constructor () {
    super('cancelled')
  }
}

type Waiting = { key: string, resolve: (reply: DecodeReply) => void }

type Ask = DecodeRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never

/**
 * One decoder thread and the requests waiting on it. The page is drawn from one
 * of its own, and everything else — previews (`previews.ts`), thumbnails, the
 * paper sampler's small copy (`scanAside`), a model's input — goes to the
 * background decoders (`decoders`), so that nothing but the page itself ever
 * stands between a page turned to and its pixels.
 *
 * Measured: with the sampler on the page's own thread, a turn to a page with a
 * preview on disk took 207–265 ms rather than the preview's 40, because the
 * sampler's request, sent a moment earlier, decoded the whole scan first. The
 * page's thread stays one, and withdraws what a reader flicked past (`cancel`)
 * before any of it starts; only the background work is shared out.
 */
function decoder (name: string) {
  let post: ((request: DecodeRequest) => void) | null = null
  let next = 0
  const waiting = new Map<number, Waiting>()

  /** Working on the page's own thread, for want of a worker. */
  let here = false

  function receive (reply: DecodeReply) {
    const one = waiting.get(reply.id)

    if (!one) {
      // Answered after it stopped mattering. The bitmap is ours to free.
      if (reply.ok) reply.bitmap?.close()

      return
    }

    waiting.delete(reply.id)
    one.resolve(reply)
  }

  function connect (): (request: DecodeRequest) => void {
    if (post) return post

    try {
      if (typeof Worker === 'undefined') throw new Error('no Worker')

      const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module', name })

      worker.onmessage = (event: MessageEvent<DecodeReply>) => receive(event.data)
      worker.onerror = (event) => {
        console.warn(`[kemolate] the ${name} worker stopped; working on this thread from now on`, event.message)
        worker.terminate()

        // Everything in flight is lost with it — ask again, here.
        post = decodeHost((reply) => receive(reply))
        here = true

        for (const [id, one] of waiting) {
          waiting.delete(id)
          one.resolve({ id, ok: false, error: 'decoder stopped' })
        }
      }

      post = (request) => worker.postMessage(request)
    } catch (error) {
      console.warn(`[kemolate] no ${name} worker; falling back to this thread`, error)
      post = decodeHost((reply) => receive(reply))
      here = true
    }

    return post
  }

  function ask (request: Ask): Promise<DecodeReply & { ok: true }> {
    const send = connect()
    const id = ++next

    return new Promise((resolve, reject) => {
      waiting.set(id, {
        key: request.key,
        resolve: (reply) => {
          if (reply.ok) resolve(reply)
          else reject(reply.error === 'cancelled' ? new Cancelled() : new Error(reply.error))
        },
      })
      send({ ...request, id } as DecodeRequest)
    })
  }

  /** Withdraw everything still waiting for this page that has not started. */
  function cancel (key: string) {
    const ids = [...waiting].filter(([, one]) => one.key === key).map(([id]) => id)

    if (ids.length) connect()({ kind: 'cancel', ids })
  }

  /** Let the page's full decode go, if it is the one held. */
  function release (key: string) {
    if (post) post({ kind: 'release', key })
  }

  return { ask, cancel, release, local: () => here }
}

/** Whether a request leaves its page's full decode held on the thread that ran it (`decode.ts`). */
const holds = (request: Ask) => request.kind === 'size' || request.kind === 'tile' || (request.kind === 'level' && request.keep)

/**
 * The background decoders: up to `width` threads (`backgroundDecoders`), each
 * sent one request at a time from a queue kept here, urgent ahead of the rest.
 *
 * It was one thread, and one thread made every preview, thumbnail and model
 * input in turn: eight previews of the CGu chapter's 3732 × 5197 pages took
 * 4.7 s however many callers asked at once, and a thumbnail asked for in the
 * meantime waited out whichever preview was running.
 *
 * The queue is here rather than in the threads because a thread knows only what
 * it has been sent. Handed their shares up front, one would sit on a backlog
 * while another stood idle, and an urgent request would wait behind whatever
 * its own thread happened to hold. So a thread is sent one request, and the
 * next when it answers, and the first thread free takes the next in line.
 *
 * A page stays with its thread while it has work there. `asideSize` leaves the
 * page's full decode held on the thread that made it, for the `scanJob` under
 * the same key that follows — the whole of what that pair is for, and a job
 * sent to another thread would decode the scan again. So a key with a request
 * in flight, or a decode held, goes where it went before; a new key goes to a
 * free thread holding nothing somebody is about to use; and a thread is only
 * started when every one there is busy. Nothing is kept about a key once its
 * work is done: a job lets the decode go on its way out, and `release` does.
 *
 * One where there is no `Worker`, or a thread would not start: several hosts
 * on the page's own thread would only take turns with one another.
 */
function decoders (name: string, width: number) {
  interface Lane {
    ask: ReturnType<typeof decoder>['ask']
    release: (key: string) => void
    local: () => boolean
    busy: boolean
  }

  interface Waiting {
    request: Ask
    resolve: (reply: DecodeReply & { ok: true }) => void
    reject: (error: unknown) => void
  }

  /** Which thread a key's work is on, how much of it is in flight, and whether its decode is held there. */
  interface Tie { lane: Lane, open: number, holds: boolean }

  const most = typeof Worker === 'undefined' ? 1 : Math.max(1, width)
  const lanes: Lane[] = []
  const queue: Waiting[] = []
  const ties = new Map<string, Tie>()

  function start (): Lane {
    const { ask, release, local } = decoder(lanes.length ? `${name} ${lanes.length + 1}` : name)
    const lane: Lane = { ask, release, local, busy: false }

    lanes.push(lane)

    return lane
  }

  /** The thread a request for `key` goes to now, or null for it to wait. */
  function laneFor (key: string): Lane | null {
    const tie = ties.get(key)

    if (tie) return tie.lane.busy ? null : tie.lane

    const holding = new Set([...ties.values()].filter((one) => one.holds).map((one) => one.lane))
    const free = lanes.filter((lane) => !lane.busy)

    // No thread started beside one that turned out to be this one.
    const more = lanes.length < most && !lanes.some((lane) => lane.local())

    return free.find((lane) => !holding.has(lane)) ?? (more ? start() : free[0] ?? null)
  }

  function done (lane: Lane, request: Ask, ok: boolean) {
    lane.busy = false

    const tie = ties.get(request.key)

    if (tie) {
      tie.open--

      if (request.kind === 'job') tie.holds = false
      else if (ok && holds(request)) tie.holds = true

      if (!tie.open && !tie.holds) ties.delete(request.key)
    }

    pump()
  }

  function send (lane: Lane, { request, resolve, reject }: Waiting) {
    const tie = ties.get(request.key) ?? { lane, open: 0, holds: false }

    tie.open++
    ties.set(request.key, tie)
    lane.busy = true

    lane.ask(request).then(
      (reply) => {
        done(lane, request, true)
        resolve(reply)
      },
      (error: unknown) => {
        done(lane, request, false)
        reject(error)
      },
    )
  }

  function pump () {
    for (let at = 0; at < queue.length;) {
      const lane = laneFor(queue[at]!.request.key)

      if (!lane) {
        at++

        continue
      }

      send(lane, queue.splice(at, 1)[0]!)
    }
  }

  function ask (request: Ask): Promise<DecodeReply & { ok: true }> {
    return new Promise((resolve, reject) => {
      const waiting: Waiting = { request, resolve, reject }

      // Urgent ahead of anything that is not, and in the order asked among itself.
      if (request.urgent) {
        const at = queue.findIndex((one) => !one.request.urgent)

        queue.splice(at === -1 ? queue.length : at, 0, waiting)
      } else {
        queue.push(waiting)
      }

      pump()
    })
  }

  /** Let this page's full decode go, from whichever thread holds it. */
  function release (key: string) {
    const tie = ties.get(key)

    if (!tie) return

    tie.lane.release(key)
    tie.holds = false

    if (!tie.open) ties.delete(key)
  }

  return { ask, release }
}

const pages = decoder('scan decoder')
const aside = decoders('background decoder', backgroundDecoders())

const ask = pages.ask

/**
 * The whole page at `width` × `height`. `keep` for the page on screen, whose
 * full decode is held for the tiles a zoom will want; a neighbour asked ahead
 * of a turn leaves nothing behind.
 */
export async function scanLevel (key: string, file: Blob, width: number, height: number, options: { keep: boolean, urgent: boolean, quality?: ResizeQuality }): Promise<Decoded> {
  const reply = await ask({ kind: 'level', key, file, width, height, ...options })

  return { width: reply.width, height: reply.height, bitmap: reply.bitmap! }
}

/** A piece of the page — scan pixels `sx, sy, sw, sh` — cut to `width` × `height`. */
export async function scanTile (key: string, file: Blob, tile: { sx: number, sy: number, sw: number, sh: number, width: number, height: number }): Promise<ImageBitmap> {
  const reply = await ask({ kind: 'tile', key, file, ...tile, urgent: true })

  return reply.bitmap!
}

/** The page's own size, from a full decode — for a page whose header would not say. */
export async function scanSize (key: string, file: Blob): Promise<{ width: number, height: number }> {
  const reply = await ask({ kind: 'size', key, file, urgent: true })

  return { width: reply.width, height: reply.height }
}

/** Withdraw everything still waiting for this page that has not started. */
export function cancelScan (key: string) {
  pages.cancel(key)
}

/** Let the page's full decode go, if it is the one held. */
export function releaseScan (key: string) {
  pages.release(key)
}

/**
 * The page at `width` × `height` as a lossless WebP, made on a background
 * decoder — see `previews.ts`. Nothing is kept there between pages.
 */
export async function scanPreview (key: string, file: Blob, width: number, height: number): Promise<Blob> {
  const reply = await aside.ask({ kind: 'preview', key, file, width, height, urgent: false })

  aside.release(key)

  return reply.blob!
}

/**
 * The whole page at a size, on a background decoder — for a reader that must
 * never hold up the page being drawn (`paper.ts`). Nothing is kept.
 */
export async function scanAside (key: string, file: Blob, width: number, height: number, quality: ResizeQuality = 'high'): Promise<ImageBitmap> {
  const reply = await aside.ask({ kind: 'level', key, file, width, height, keep: false, urgent: false, quality })

  return reply.bitmap!
}

/**
 * A job on a background decoder — a thumbnail, a copy to send, a model's
 * input — see `jobs.ts` for which, and why only these. Ahead of previews and
 * the paper sampler, which nobody is waiting on; `urgent: false` for a job
 * that is itself only getting ahead of things. Null where the browser would
 * not draw it.
 *
 * `key` names the page for the full decode a job may share: ask `asideSize`
 * under the same key first and the job uses that decode rather than making a
 * second. Nothing is held after the job.
 */
export async function scanJob (key: string, file: Blob, job: Job, urgent = true): Promise<JobResult | null> {
  const reply = await aside.ask({ kind: 'job', key, file, job, urgent })

  if (reply.empty) return null

  return {
    width: reply.width,
    height: reply.height,
    ...(reply.blob ? { blob: reply.blob } : {}),
    ...(reply.pixels ? { pixels: reply.pixels } : {}),
    ...(reply.same ? { same: true } : {}),
  }
}

/** Let a background decoder's full decode go — after an `asideSize` no job followed. */
export function releaseAside (key: string) {
  aside.release(key)
}

let jobs = 0

/** A name for one job's page that no other job shares. */
export const jobKey = (what: string) => `${what}:${++jobs}`

/**
 * The page's own size, from a full decode on a background decoder — held on
 * that thread for the `scanJob` under the same key that follows, which is
 * sent to the same thread (see `decoders`) and lets it go.
 */
export async function asideSize (key: string, file: Blob): Promise<{ width: number, height: number }> {
  const reply = await aside.ask({ kind: 'size', key, file, urgent: true })

  return { width: reply.width, height: reply.height }
}
