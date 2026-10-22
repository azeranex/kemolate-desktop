import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SwarmPeer, SwarmSocket } from '~~/server/utils/swarm'

import { deliver, requestRender, requestRenders } from '~~/server/utils/relay'
import { swarmState } from '~~/server/utils/swarm'

/**
 * The one place image bytes pass through this server, tested for the two things
 * that are not obvious from reading it: that a request settles on exactly one
 * answer, and that an answer cannot be redirected into somebody else's.
 *
 * Not tested here: the picture itself. Nothing in this file decodes, scales or
 * looks at an image — the browser makes the rendition (`app/utils/rendition.ts`)
 * and the endpoint checks its size. What is left is a registry, and a registry
 * is exactly the sort of thing that works in development and drops one request
 * in fifty under two tabs.
 */

/** A socket that remembers what was said down it and answers nothing. */
function socketOf (sent: string[]): SwarmSocket {
  return { send: (frame: string) => sent.push(frame) } as SwarmSocket
}

function joins (workspace: string, id: string, have: string[], sent: string[]) {
  const room = swarmState.swarms.get(workspace) ?? new Map<string, SwarmPeer>()

  // Desktop: a peer is its id and its holdings — there are no people (`server/utils/swarm.ts`).
  room.set(id, { id, have })

  swarmState.swarms.set(workspace, room)
  swarmState.sockets.set(id, socketOf(sent))
}

/** The `request` id out of the frame a peer was sent. */
const askedFor = (frame: string) => (JSON.parse(frame) as { request: string }).request

beforeEach(() => {
  swarmState.swarms.clear()
  swarmState.sockets.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('requestRender', () => {
  it('refuses when nobody in the workspace is holding the page', async () => {
    joins('w1', 'peer-a', ['some-other-hash'], [])

    await expect(requestRender('w1', 'page-hash', 'Chapter')).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('refuses when the workspace has no peers at all', async () => {
    await expect(requestRender('w1', 'page-hash', 'Chapter')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('settles with the bytes the holder uploads', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRender('w1', 'page-hash', 'Chapter')

    expect(sent).toHaveLength(1)

    const refused = deliver(askedFor(sent[0]!), 'w1', Buffer.from('jpeg'), 'image/jpeg')

    expect(refused).toBeNull()
    await expect(waiting).resolves.toEqual({ bytes: Buffer.from('jpeg'), type: 'image/jpeg' })
  })

  it('asks every holder but takes only the first answer', async () => {
    const a: string[] = []
    const b: string[] = []

    joins('w1', 'peer-a', ['page-hash'], a)
    joins('w1', 'peer-b', ['page-hash'], b)

    const waiting = requestRender('w1', 'page-hash', 'Chapter')

    // Both were asked — one of them may be a tab that is closing, and a request
    // that went to it alone would wait out the whole timeout for nothing.
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)

    const request = askedFor(a[0]!)

    expect(deliver(request, 'w1', Buffer.from('first'), 'image/jpeg')).toBeNull()

    // The straggler is turned away rather than overwriting the answer already
    // handed over — which is the ordinary case whenever two tabs are open.
    expect(deliver(request, 'w1', Buffer.from('second'), 'image/jpeg')).toBe('unknown')

    await expect(waiting).resolves.toMatchObject({ bytes: Buffer.from('first') })
  })

  it('will not let one workspace answer another\'s request', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRender('w1', 'page-hash', 'Chapter')
    const request = askedFor(sent[0]!)

    // A member of both workspaces uploading against the wrong one. The endpoint
    // has already established they may write to `w2`; what it cannot know is
    // that the page waiting belongs to `w1`.
    expect(deliver(request, 'w2', Buffer.from('wrong'), 'image/jpeg')).toBe('foreign')

    // Still open afterwards, so the honest holder can still answer it.
    expect(deliver(request, 'w1', Buffer.from('right'), 'image/jpeg')).toBeNull()
    await expect(waiting).resolves.toMatchObject({ bytes: Buffer.from('right') })
  })

  it('refuses a rendition past the size cap and leaves the request open', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRender('w1', 'page-hash', 'Chapter')
    const request = askedFor(sent[0]!)

    expect(deliver(request, 'w1', Buffer.alloc(9 * 1024 * 1024), 'image/jpeg')).toBe('oversize')
    expect(deliver(request, 'w1', Buffer.from('small'), 'image/jpeg')).toBeNull()

    await expect(waiting).resolves.toMatchObject({ bytes: Buffer.from('small') })
  })

  it('gives up when the holder never answers, and forgets the request', async () => {
    vi.useFakeTimers()

    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRender('w1', 'page-hash', 'Chapter')
    const settled = expect(waiting).rejects.toMatchObject({ statusCode: 504 })

    await vi.advanceTimersByTimeAsync(21_000)
    await settled

    // An upload arriving after the timeout must find nothing waiting — a
    // pending entry left behind is a promise nobody will ever settle.
    expect(deliver(askedFor(sent[0]!), 'w1', Buffer.from('late'), 'image/jpeg')).toBe('unknown')
  })

  it('carries the region through to the holder, and null when there is none', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const region = { x: 0.4, y: 1.1, w: 0.1, h: 0.2 }

    // Caught rather than awaited: neither is going to be answered, and a
    // rejection twenty seconds from now with nothing attached to it is an
    // unhandled rejection in whatever test happens to be running then.
    requestRender('w1', 'page-hash', 'Chapter', region).catch(() => {})
    requestRender('w1', 'page-hash', 'Chapter').catch(() => {})

    // The browser crops before it scales — see `renditionOf`. A region dropped
    // on the way out is a whole page arriving where somebody asked to look
    // closely at one balloon, which reads as the zoom silently not working.
    expect(JSON.parse(sent[0]!).region).toEqual(region)
    expect(JSON.parse(sent[1]!).region).toBeNull()
  })

  it('asks only the workspace it was asked about', async () => {
    const mine: string[] = []
    const theirs: string[] = []

    joins('w1', 'peer-a', ['page-hash'], mine)

    // Somebody in a different chapter holding the same bytes. Two people's
    // copies of one page share a hash — that is what a hash is for — so the
    // holder list has to be narrowed by room and not by hash alone, or a
    // stranger's tab would be asked for a page it has no standing to send.
    joins('w2', 'peer-b', ['page-hash'], theirs)

    const waiting = requestRender('w1', 'page-hash', 'Chapter')

    expect(mine).toHaveLength(1)
    expect(theirs).toHaveLength(0)

    deliver(askedFor(mine[0]!), 'w1', Buffer.from('jpeg'), 'image/jpeg')

    await expect(waiting).resolves.toMatchObject({ bytes: Buffer.from('jpeg') })
  })
})

/**
 * Several crops of one page, in one ask — what `review_page_reading` is built
 * on.
 *
 * The property that matters is not that it works but *who it asks*.
 * `requestRender` fans out to three holders because one rendition is cheap and
 * the first answer wins; doing that per crop would be twenty-seven uploads out
 * of somebody's laptop to answer a single question about a nine-balloon page.
 */
describe('requestRenders', () => {
  it('asks one holder for every crop, each with its own rectangle', async () => {
    const a: string[] = []
    const b: string[] = []

    joins('w1', 'peer-a', ['page-hash'], a)
    joins('w1', 'peer-b', ['page-hash'], b)

    const regions = [
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { x: 0.5, y: 0.9, w: 0.2, h: 0.3 },
      { x: 0.8, y: 1.2, w: 0.1, h: 0.2 },
    ]

    const waiting = requestRenders('w1', 'page-hash', 'Chapter', regions)

    // One browser, three asks — not three browsers, nine asks.
    expect(a).toHaveLength(3)
    expect(b).toHaveLength(0)

    expect(a.map((frame) => JSON.parse(frame).region)).toEqual(regions)

    a.forEach((frame, index) => {
      deliver(askedFor(frame), 'w1', Buffer.from(`crop-${index}`), 'image/jpeg')
    })

    // In the order asked, so the reply can pair image N with block N.
    await expect(waiting).resolves.toEqual(regions.map((_, index) => ({
      bytes: Buffer.from(`crop-${index}`),
      type: 'image/jpeg',
    })))
  })

  it('refuses the whole ask when nobody is holding the page', async () => {
    await expect(requestRenders('w1', 'page-hash', 'Chapter', [{ x: 0, y: 0, w: 1, h: 1 }]))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('fails as a whole when one crop goes unanswered', async () => {
    vi.useFakeTimers()

    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRenders('w1', 'page-hash', 'Chapter', [
      { x: 0, y: 0, w: 0.1, h: 0.1 },
      { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    ])

    const settled = expect(waiting).rejects.toMatchObject({ statusCode: 504 })

    // Only the first is answered. A page shown with one of its balloons missing
    // and no way to say which is worse than a plain refusal.
    deliver(askedFor(sent[0]!), 'w1', Buffer.from('one'), 'image/jpeg')

    await vi.advanceTimersByTimeAsync(21_000)
    await settled
  })
})
