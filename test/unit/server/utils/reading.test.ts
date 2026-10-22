import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SwarmPeer, SwarmSocket } from '~~/server/utils/swarm'

import { finish } from '~~/server/utils/errand'
import { requestRead } from '~~/server/utils/reading'
import { swarmState } from '~~/server/utils/swarm'

/**
 * Asking a browser to read a page with its own detector.
 *
 * Two properties carry the design and neither is visible from the call site.
 *
 * **Exactly one browser is asked.** The relay beside this fans out to three
 * because a rendition is cheap and the first answer wins; a reading is a minute
 * of somebody's processor ending in a `replace` of the page's blocks, and three
 * of those race each other to decide what the page says.
 *
 * **Giving up waiting does not cancel the work.** The browser writes its blocks
 * through the ordinary endpoint whatever happens here, so the timeout has to
 * answer `working` rather than throw — and it has to stop listening, or the
 * report that arrives two minutes later settles a promise nobody holds.
 */

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

const asked = (frame: string) => JSON.parse(frame) as { type: string, request: string, pageIds: number[] }

beforeEach(() => {
  swarmState.swarms.clear()
  swarmState.sockets.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('requestRead', () => {
  it('refuses when nobody in the workspace is holding the page', async () => {
    joins('w1', 'peer-a', ['another-hash'], [])

    await expect(requestRead('w1', [{ hash: 'page-hash', pageId: 7 }], 'Chapter')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('asks exactly one holder, however many there are', async () => {
    const a: string[] = []
    const b: string[] = []
    const c: string[] = []

    joins('w1', 'peer-a', ['page-hash'], a)
    joins('w1', 'peer-b', ['page-hash'], b)
    joins('w1', 'peer-c', ['page-hash'], c)

    const waiting = requestRead('w1', [{ hash: 'page-hash', pageId: 7 }], 'Chapter')

    // Three browsers each spending a minute on the same page, each replacing
    // the others' blocks, is the failure this guards.
    expect([a, b, c].filter((sent) => sent.length)).toHaveLength(1)

    const sent = [a, b, c].find((frames) => frames.length)!
    const frame = asked(sent[0]!)

    expect(frame.type).toBe('read')
    expect(frame.pageIds).toEqual([7])

    finish(frame.request, 'w1', { ok: true, read: 1, blocks: 11 })

    await expect(waiting).resolves.toEqual({ status: 'read', read: 1, blocks: 11 })
  })

  it('passes a browser\'s refusal back in its own words', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRead('w1', [{ hash: 'page-hash', pageId: 7 }], 'Chapter')

    finish(asked(sent[0]!).request, 'w1', { ok: false, error: 'Already reading a page.' })

    await expect(waiting).resolves.toEqual({ status: 'refused', reason: 'Already reading a page.' })
  })

  it('reads a page that honestly holds nothing as nothing, not as a failure', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRead('w1', [{ hash: 'page-hash', pageId: 7 }], 'Chapter')

    finish(asked(sent[0]!).request, 'w1', { ok: true, read: 1, blocks: 0 })

    await expect(waiting).resolves.toEqual({ status: 'read', read: 1, blocks: 0 })
  })

  it('answers "working" when the leash runs out, and forgets the errand', async () => {
    vi.useFakeTimers()

    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRead('w1', [{ hash: 'page-hash', pageId: 7 }], 'Chapter', 5_000)

    await vi.advanceTimersByTimeAsync(6_000)

    // Not a rejection: the browser is still reading and will still save.
    await expect(waiting).resolves.toEqual({ status: 'working' })

    // And the report that eventually arrives finds nothing waiting, rather than
    // an entry left behind in the registry for good.
    expect(finish(asked(sent[0]!).request, 'w1', { ok: true, read: 1, blocks: 11 })).toBe('unknown')
  })

  it('will not let one workspace answer another\'s reading', async () => {
    const sent: string[] = []

    joins('w1', 'peer-a', ['page-hash'], sent)

    const waiting = requestRead('w1', [{ hash: 'page-hash', pageId: 7 }], 'Chapter')
    const { request } = asked(sent[0]!)

    expect(finish(request, 'w2', { ok: true, read: 1, blocks: 99 })).toBe('foreign')
    expect(finish(request, 'w1', { ok: true, read: 1, blocks: 3 })).toBeNull()

    await expect(waiting).resolves.toEqual({ status: 'read', read: 1, blocks: 3 })
  })
})
