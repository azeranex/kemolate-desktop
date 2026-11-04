import { beforeEach, describe, expect, it } from 'vitest'

import { departed, finish, forget, heavy } from '~~/server/utils/errand'

/**
 * Readings and cleanings taking turns across tabs — desktop (`heavy`).
 *
 * Each tab has its own models on the one GPU, so an agent asking three chapters
 * to be read at once is three tabs fighting for it. These pin when the next one
 * goes: once the last is answered — even when its asker stopped waiting, since
 * a reading goes on regardless — or once its tab has gone, so a tab closed
 * mid-reading does not hold the queue for the limit.
 */

const state = (globalThis as { __kemolateErrands?: { working: unknown, queue: unknown[] } }).__kemolateErrands!

beforeEach(() => {
  state.working = null
  state.queue = []
})

describe('heavy errands', () => {
  it('sends the first at once and the next only once the first is answered', () => {
    const sent: string[] = []

    heavy('read-1', 'tab:1', () => sent.push('read-1'))
    heavy('clean-2', 'tab:2', () => sent.push('clean-2'))

    expect(sent).toEqual(['read-1'])

    finish('read-1', 'chapter', { ok: true })

    expect(sent).toEqual(['read-1', 'clean-2'])
  })

  it('waits for a reading whose asker has stopped waiting — the reading has not stopped', () => {
    const sent: string[] = []

    heavy('read-1', 'tab:1', () => sent.push('read-1'))
    heavy('read-2', 'tab:2', () => sent.push('read-2'))

    // The asker's leash ran out: it forgets, and the tab reads on.
    forget('read-1')

    expect(sent).toEqual(['read-1'])

    // The report arriving late is answered "unknown", and frees the queue all the same.
    expect(finish('read-1', 'chapter', { ok: true })).toBe('unknown')
    expect(sent).toEqual(['read-1', 'read-2'])
  })

  it('lets the next go when the tab doing the work goes, and drops what was asked of it', () => {
    const sent: string[] = []

    heavy('read-1', 'tab:1', () => sent.push('read-1'))
    heavy('read-2', 'tab:1', () => sent.push('read-2'))
    heavy('read-3', 'tab:2', () => sent.push('read-3'))

    departed('tab:1')

    expect(sent).toEqual(['read-1', 'read-3'])
  })
})
