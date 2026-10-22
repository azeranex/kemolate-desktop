/**
 * Asking a browser to read a page with its own eyes.
 *
 * The counterpart to `relay.ts` and, wherever it applies, the better half of
 * the pair. The relay sends a *picture* out so that something else can guess at
 * where the lettering is; this sends a *request* in so that the machine already
 * holding the scan runs the detector and recogniser that were built for it. One
 * costs a page image and produces boxes traced round columns of source text;
 * the other costs a few hundred bytes and produces the boxes the app's own Read
 * page button would.
 *
 * Nothing about a page crosses the wire here in either direction. The blocks
 * are written by the browser through the ordinary endpoint, under the ordinary
 * ability, and this only learns that they were.
 *
 * ## One holder, not three
 *
 * `relay.ts` asks up to three peers because a rendition is cheap and the first
 * answer wins. A reading is neither: three browsers would each spend a minute
 * on the same page and each `replace` the other's blocks, and the last one to
 * finish would win by accident. So exactly one is asked, and a browser that is
 * busy says so at once rather than queueing — see `useReadErrands`.
 *
 * ## Giving up waiting is not cancelling
 *
 * A first reading on a machine downloads a couple of hundred megabytes of model
 * before it starts, which is longer than any MCP client will hold a request
 * open. So the wait is a convenience with a short leash and the work is not on
 * it: when the leash runs out this stops listening and says the reading is
 * still going, and the browser saves what it finds regardless. The next
 * `read_page` picks it up.
 */
import { begin, forget, holders, noHolder, tell } from './errand'

import type { SwarmServerMessage } from './swarm'

/** What a browser says when it has finished, or given up. */
export interface ReadReport {
  ok: boolean
  /** How many pages it actually held and read, which may be fewer than asked. */
  read?: number
  /** Blocks found across all of them. */
  blocks?: number
  error?: string
}

/** How the ask turned out, from the point of view of whoever waited. */
export type ReadOutcome =
  /** It finished while we watched, and this is what it found. */
  | { status: 'read', read: number, blocks: number }
  /** The browser refused or failed, and said why. */
  | { status: 'refused', reason: string }
  /** Still going. The blocks will land; nobody is waiting for them any more. */
  | { status: 'working' }

/**
 * The default leash, in milliseconds.
 *
 * Comfortably longer than a warm page — a few seconds — and comfortably shorter
 * than a cold one, which is the case the `working` answer exists for.
 */
export const WAIT = 60_000

export const MAX_WAIT = 240_000

export async function requestRead (
  publicId: string,
  pages: { hash: string, pageId: number }[],
  chapter: string,
  wait = WAIT,
): Promise<ReadOutcome> {
  /*
   * One holder for the whole batch — see the header — and it has to be one that
   * holds the *first* page, since a browser part-way through fetching a chapter
   * may hold some of it and not the rest. It drops the hashes it does not have
   * and reports how many it actually read, which is a better answer than
   * splitting the batch across two browsers that would then race each other.
   */
  const [peer] = holders(publicId, pages[0]!.hash)

  if (!peer) noHolder(chapter)

  const { request, waiting } = begin<ReadReport>(
    publicId,
    Math.min(wait, MAX_WAIT),
    () => new Error('still working'),
  )

  tell([peer], JSON.stringify({
    type: 'read',
    request,
    hashes: pages.map((page) => page.hash),
    pageIds: pages.map((page) => page.pageId),
  } satisfies SwarmServerMessage))

  try {
    const report = await waiting

    return report.ok
      ? { status: 'read', read: report.read ?? 0, blocks: report.blocks ?? 0 }
      : { status: 'refused', reason: report.error ?? 'The browser could not read those pages.' }
  } catch {
    // The leash, not a failure. Stop holding a promise nobody will settle; the
    // browser is still reading and will still save.
    forget(request)

    return { status: 'working' }
  }
}
