/**
 * Asking a browser in a workspace to do something, and waiting for its answer.
 *
 * Two things need this and they are not alike, which is why the mechanism is
 * here and the meaning is not. `relay.ts` asks for a *picture* of a page and
 * gets bytes back. `server/mcp/tools/request-page-read.ts` asks for a page to
 * be *read* and gets a report back, the blocks themselves having been written
 * through the ordinary endpoint on the way. What the two share is the awkward
 * part: an HTTP request is waiting on work happening in somebody else's
 * browser, reached over a socket that carries no replies.
 *
 * So: a request id goes out down the socket, a promise waits on it here, and
 * the browser answers by POSTing to an endpoint named by that id. The endpoint
 * settles the promise.
 *
 * ## Three rules, each of which was a bug waiting
 *
 * - **Pinned on `globalThis`**, exactly as `swarmState` is. A dev rebuild
 *   otherwise re-imports this module with an empty map while a browser is
 *   midway through answering, and the answer arrives to find nothing waiting.
 *   The request then times out, having succeeded.
 * - **The workspace is checked on the way back in.** Both ends are workspaces
 *   the answering browser belongs to — the endpoint has established that — but
 *   a member of two chapters must not be able to answer one's errand with the
 *   other's work.
 * - **An answer that arrives late is not an error.** A timed-out errand and the
 *   second holder arriving after the first has won look identical from here,
 *   and both are ordinary. Callers report `'unknown'` and move on.
 */
import { createError } from './errors' // Desktop: the main process's own — there is no h3.
import { swarmState } from './swarm'

interface Pending {
  publicId: string
  settle: (value: never) => void
  fail: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ErrandState {
  pending: Map<string, Pending>
  /** Desktop: the heavy errand being worked on, and those waiting for it — see `heavy`. */
  working: { request: string, peer: string, timer: ReturnType<typeof setTimeout> } | null
  queue: { request: string, peer: string, start: () => void }[]
}

const errandState: ErrandState = ((globalThis as { __kemolateErrands?: ErrandState }).__kemolateErrands ??= {
  pending: new Map(),
  working: null,
  queue: [],
})

/**
 * The longest a heavy errand keeps the next one waiting when its tab never
 * answers — a tab closed mid-reading, say. A cold first read downloads its
 * models, so this is minutes, not the asker's leash.
 */
const HEAVY_LIMIT = 10 * 60_000

/** The next heavy errand, if the last one is done. */
function next (): void {
  if (errandState.working) return

  const up = errandState.queue.shift()

  if (!up) return

  const timer = setTimeout(() => done(up.request), HEAVY_LIMIT)

  timer.unref?.()
  errandState.working = { request: up.request, peer: up.peer, timer }
  up.start()
}

/**
 * A peer gone — a tab closed, or moved to another chapter. Nothing it was asked
 * will be answered, so it keeps nobody waiting for the limit.
 */
export function departed (peer: string): void {
  errandState.queue = errandState.queue.filter((entry) => entry.peer !== peer)

  if (errandState.working?.peer === peer) done(errandState.working.request)
}

/** A heavy errand answered, or given up on: the next may go. */
export function done (request: string): void {
  errandState.queue = errandState.queue.filter((entry) => entry.request !== request)

  if (errandState.working?.request !== request) return

  clearTimeout(errandState.working.timer)
  errandState.working = null
  next()
}

/**
 * Desktop: send a reading or a cleaning once no other is under way, in any tab.
 *
 * Each tab is a page of its own with its own models, all on the one GPU. Two
 * tabs reading at once each get half of it and run out of memory sooner, and an
 * agent working through three chapters asks for exactly that. So the heavy
 * errands take turns: `start` sends this one once the last has been answered —
 * whether or not anybody is still waiting for that answer, since a reading goes
 * on after its asker's leash runs out (`reading.ts`). Time spent in the queue is
 * the asker's own: its leash started at `begin`.
 */
export function heavy (request: string, peer: string, start: () => void): void {
  errandState.queue.push({ request, peer, start })
  next()
}

/** Peers in this workspace that say they are holding this scan. */
export function holders (publicId: string, hash: string): string[] {
  const room = swarmState.swarms.get(publicId)

  if (!room) return []

  return [...room.values()].filter((peer) => peer.have.includes(hash)).map((peer) => peer.id)
}

/**
 * Send a frame to some peers, best effort.
 *
 * A socket that fails to take it is one that is closing; another holder may
 * still answer, and if none does the errand's own timeout says so. Nothing
 * useful can be done here that the timeout does not already do.
 */
export function tell (peerIds: string[], frame: string): void {
  for (const id of peerIds) {
    try {
      swarmState.sockets.get(id)?.send(frame)
    } catch {
      // Deliberately silent — see above.
    }
  }
}

export interface Errand<T> {
  /** The id the browser will answer under. */
  request: string
  /** Settles when somebody answers, rejects on the timeout. */
  waiting: Promise<T>
}

/**
 * Open an errand and start its clock.
 *
 * The timeout rejects with `expired`, so each caller can say the thing its own
 * user can act on — "the browser did not answer in time" reads very differently
 * from "the page is still being read, ask again in a moment".
 */
export function begin<T> (publicId: string, timeout: number, expired: () => Error): Errand<T> {
  const request = crypto.randomUUID()

  const waiting = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      errandState.pending.delete(request)
      reject(expired())
    }, timeout)

    // So a pending errand cannot hold a shutting-down server open.
    timer.unref?.()

    errandState.pending.set(request, {
      publicId,
      settle: resolve as (value: never) => void,
      fail: reject,
      timer,
    })
  })

  return { request, waiting }
}

/** Why an answer was turned away, or null if it was taken. */
export type Refusal = 'unknown' | 'foreign'

/** Hand an answer to whoever is waiting for it. */
export function finish<T> (request: string, publicId: string, value: T): Refusal | null {
  // The work is over whoever is still listening — the next heavy errand may go.
  done(request)

  const pending = errandState.pending.get(request)

  if (!pending) return 'unknown'
  if (pending.publicId !== publicId) return 'foreign'

  clearTimeout(pending.timer)
  errandState.pending.delete(request)

  ;(pending.settle as (value: T) => void)(value)

  return null
}

/**
 * Report that the browser tried and could not.
 *
 * Distinct from letting it time out: a page the browser refuses to read has an
 * answer worth passing on immediately, and twenty seconds of silence is a worse
 * way to deliver it.
 */
export function abort (request: string, publicId: string, error: Error): Refusal | null {
  done(request)

  const pending = errandState.pending.get(request)

  if (!pending) return 'unknown'
  if (pending.publicId !== publicId) return 'foreign'

  clearTimeout(pending.timer)
  errandState.pending.delete(request)

  pending.fail(error)

  return null
}

/**
 * Stop waiting, without cancelling the work.
 *
 * For an errand whose value is the *work* rather than the answer — a page being
 * read writes its blocks through the ordinary endpoint, so a caller that has
 * given up waiting has not stopped anything. Forgetting the promise here is
 * what keeps the map from filling with entries nobody will settle.
 */
export function forget (request: string): void {
  const pending = errandState.pending.get(request)

  if (!pending) return

  clearTimeout(pending.timer)
  errandState.pending.delete(request)
}

/**
 * Refuse when nobody in the workspace can be asked.
 *
 * Named, because the agent that hits this is usually working through a chapter
 * and the person who can fix it is elsewhere: "open the chapter" is useless
 * advice if you do not say which one. The second sentence is there because the
 * first reads like a bug otherwise — this is the invariant working, not a
 * server that has lost a file.
 *
 * A collaborator who joins without the pages is *not* this case: they fetch
 * them from a seeder by themselves and announce them (`fetchPages`), and the
 * relay then finds them. This means nobody at all has the chapter open.
 *
 * Desktop: said of the window, which is the only thing that can hold a page —
 * the scans are the reader's own files, kept nowhere else.
 */
export function noHolder (chapter: string): never {
  throw createError({
    statusCode: 409,
    statusMessage: `Kemolate does not have “${chapter}” open, so its pages cannot be shown or read. ` +
      'The scans are the reader\'s own files and are kept nowhere else — pages come from the chapters open in the Kemolate window\'s tabs. ' +
      'Open it with `open_workspace` and try again, or use the tools that need no image.',
  })
}

/**
 * Whether a page can be asked for at all right now.
 *
 * So a caller can find out without provoking a failure. `list_pages` reports it
 * per page, which is what turns "the image tool keeps refusing" into something
 * an agent can plan around — read the text-only pages now, come back for the
 * pictures when somebody opens a tab.
 */
export function reachable (publicId: string, hash: string | null): boolean {
  return Boolean(hash) && holders(publicId, hash!).length > 0
}
