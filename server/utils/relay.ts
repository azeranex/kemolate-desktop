/**
 * Showing a page to something that is not a browser — the one place image bytes
 * pass through this server, and the whole of what that means.
 *
 * ## Why this exists at all
 *
 * Everything else in kemolate holds to a simple rule: the scans stay on the
 * machines that opened them. The server records what was *found* on a page and
 * never the page. Two readers hand chapters to each other peer-to-peer, and the
 * signalling server relays sealed blobs it cannot read.
 *
 * The MCP server breaks the shape that rule was built for, because an agent in
 * somebody's editor is not a peer. It cannot be dialled, it holds no chapter,
 * and it has no swarm ticket. Reading a page with a vision model — which is
 * what "extract the OCR" and "translate with the picture" both mean — requires
 * putting the picture in front of it, and there is no route from a reader's
 * disk to an MCP client that does not pass through here.
 *
 * So it passes through here, and this file is the narrowest version of that
 * anybody could build:
 *
 * - **The server cannot obtain a page by itself.** It has no copy, no cache and
 *   no column that can hold one. All it can do is ask a browser that is *in the
 *   workspace's swarm right now and says it is holding that scan*. Close every
 *   tab and every image tool goes dark — which is the correct behaviour, not a
 *   limitation to work around later.
 * - **What travels is a rendition, not the file.** The browser bounds it to
 *   `MAX_EDGE` and encodes JPEG before it uploads — or, where the file is
 *   already smaller than that and already a JPEG, sends those bytes rather than
 *   making a worse copy of them. Either way the original stays on the reader's
 *   machine except peer-to-peer.
 * - **Nothing is stored.** The bytes live in the errand registry for the second
 *   or two between the upload and the reply that carries them, and are dropped.
 *   Not `.data/`, not the database, not a Nitro storage mount.
 * - **Only a member can cause one**, through an authenticated token, and only
 *   for a workspace they can already read.
 *
 * If a future change makes the server able to fetch a page without a browser's
 * participation, or keeps one past the request, it has broken something this
 * file was written to preserve. Read the **MCP** section of `CLAUDE.md` before
 * touching it.
 *
 * ## Why the answer comes back over HTTP
 *
 * The socket carries JSON and only JSON. Sending a rendition down it would mean
 * base64 in a frame, no body limit, and no way to refuse an oversized one until
 * it had all arrived. A POST gets the size cap, the session, the workspace
 * context and the abilities for free, all of which already work.
 *
 * ## Regions
 *
 * A whole page at `MAX_EDGE` is not enough resolution to read small vertical
 * lettering, and a model given one has no way to look closer. So a caller may
 * ask for a rectangle of the page instead, and the browser crops *before* it
 * scales, spending the whole bound on the part somebody asked about.
 *
 * What that buys is resolution, and only sometimes fewer bytes: a balloon a
 * tenth of the page across comes back small and several times sharper, while
 * half a page enlarged to the bound costs about what the whole page did. The
 * point is the sharpness. The rectangle is in the same width-normalised units
 * as a block's box, so "show me block 5" needs no arithmetic and no knowledge
 * of the page's pixel size.
 */
import { begin, finish, holders, noHolder, tell } from './errand'
import { createError } from './errors' // Desktop: the main process's own — there is no h3.

import type { SwarmServerMessage } from './swarm'

/** A page as an agent is shown it: bounded, re-encoded, and about to be dropped. */
export interface Rendition {
  bytes: Buffer
  type: string
}

/**
 * A rectangle of a page, in the units a block's box uses — fractions of the
 * page's **width**, on both axes. So `y` and `h` legitimately run past one on a
 * page taller than it is wide, and a block's own `cx`/`cy`/`w`/`h` can be
 * turned into one of these without knowing anything else about the page.
 */
export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The long edge a page is shrunk to before it is sent.
 *
 * Comfortably enough for a model to read lettering — the recognisers this app
 * runs in the browser work from far less — and small enough that a page is a
 * couple of hundred kilobytes rather than a couple of megabytes. That matters
 * twice over: it is what the reader's connection uploads, and what an agent
 * pays for in tokens.
 */
export const MAX_EDGE = 1600

/** JPEG, high but not lossless. A model reading a balloon is not inspecting grain. */
export const QUALITY = 0.85

/**
 * The most a rendition may weigh.
 *
 * A bound on what an honest browser sends at `MAX_EDGE`, with generous room —
 * not a tuning knob. Its job is to refuse something that cannot be a page.
 */
export const MAX_BYTES = 8 * 1024 * 1024

/**
 * How long the asker waits.
 *
 * A browser has to read the file off disk, decode it, draw it small and encode
 * it again, and the disk may be a spinning one holding a chapter it has not
 * touched today. Long enough for that; short enough that a tab which has gone
 * away fails the tool rather than hanging the agent's turn.
 */
const TIMEOUT = 20_000

/**
 * How many holders are asked at once.
 *
 * Usually one, because usually one person has the chapter open. Where several
 * do, asking all of them would have every one of them upload a page to answer a
 * question that needed one. Asking exactly one loses the race against a tab
 * that is closing. Three is the compromise: the first answer wins and the
 * others are turned away at the door having spent one upload each.
 */
const FANOUT = 3

/**
 * Ask whoever has this page to show it, and wait.
 *
 * Rejects rather than resolving empty when nobody is holding it, because that
 * is a thing the person asking can *fix* — open the chapter — and a tool that
 * answered "no image" would have them wondering which page was blank.
 */
export async function requestRender (
  publicId: string,
  hash: string,
  chapter: string,
  region?: Region | null,
): Promise<Rendition> {
  const asked = holders(publicId, hash).slice(0, FANOUT)

  if (!asked.length) noHolder(chapter)

  const { request, waiting } = begin<Rendition>(publicId, TIMEOUT, () => createError({
    statusCode: 504,
    statusMessage: 'The browser holding this page did not answer in time.',
  }))

  tell(asked, JSON.stringify({
    type: 'render',
    request,
    hash,
    maxEdge: MAX_EDGE,
    quality: QUALITY,
    region: region ?? null,
  } satisfies SwarmServerMessage))

  return waiting
}

/**
 * Several rectangles of one page, in one go.
 *
 * What `review_page_reading` is built on, and the reason it exists as its own
 * function rather than a loop at the call site: **one holder is asked for all
 * of them**. `requestRender` fans out to three because a single rendition is
 * cheap and the first answer wins; nine of those would be twenty-seven uploads
 * out of somebody's laptop to answer one question.
 *
 * Beyond that it *is* a loop — one errand per crop, run together. A browser
 * decodes the page once per crop, which is a few milliseconds each and not
 * worth a second upload protocol to avoid. If that ever stops being true the
 * answer is a multipart upload, not a bigger socket frame.
 *
 * Fails as a whole. A page shown with three of its nine balloons missing, and
 * no way to say which three, is worse than a plain refusal.
 */
export async function requestRenders (
  publicId: string,
  hash: string,
  chapter: string,
  regions: Region[],
): Promise<Rendition[]> {
  const [peer] = holders(publicId, hash)

  if (!peer) noHolder(chapter)

  const waits = regions.map((region) => {
    const { request, waiting } = begin<Rendition>(publicId, TIMEOUT, () => createError({
      statusCode: 504,
      statusMessage: 'The browser holding this page did not answer in time.',
    }))

    tell([peer], JSON.stringify({
      type: 'render',
      request,
      hash,
      maxEdge: MAX_EDGE,
      quality: QUALITY,
      region,
    } satisfies SwarmServerMessage))

    return waiting
  })

  return Promise.all(waits)
}

/** Why an upload was refused, or null if it was taken. */
export type RelayRefusal = 'unknown' | 'foreign' | 'oversize'

/**
 * A browser's answer, on its way to whoever is waiting for it.
 *
 * The size is checked here rather than left to the endpoint because it is a
 * fact about a *rendition* — what this file is willing to pass on — and not
 * about an HTTP body. The endpoint checks it too, so an oversized upload is
 * refused with something the browser can read instead of silently dropped.
 */
export function deliver (
  request: string,
  publicId: string,
  bytes: Buffer,
  type: string,
): RelayRefusal | null {
  if (bytes.byteLength > MAX_BYTES) return 'oversize'

  // 'unknown' covers both halves of the ordinary case: a request that timed
  // out, and the second and third holders arriving after the first one won.
  return finish<Rendition>(request, publicId, { bytes, type })
}
