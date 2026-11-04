import { beforeEach, describe, expect, it } from 'vitest'

import { holders } from '~~/server/utils/errand'
import { announce, focusTab, holdIn, openChapters, swarmState } from '~~/server/utils/swarm'

/**
 * The window's tabs as the agent's errands see them — desktop.
 *
 * Each tab is a peer in its chapter's room (`holdIn`), and the tab on screen is
 * what "the open chapter" means (`focusTab`, `SwarmState.active`). These pin the
 * three things tabs changed: a chapter in a tab behind the one on screen is
 * still held, and asked; a tab that leaves takes only itself out; and an
 * agent's change is told to the tabs that have that chapter, and no other.
 */

const frames = () => {
  const sent: { publicId: string, frame: string }[] = []

  return { sent, send: (publicId: string, frame: string) => sent.push({ publicId, frame }) }
}

beforeEach(() => {
  swarmState.tabs.clear()
  focusTab(null)
})

describe('tabs in the swarm', () => {
  it('holds a chapter in a tab behind the one on screen, and asks that tab for it', () => {
    holdIn('1', 'chapter-a', ['sha-a'], () => {}, 10)
    holdIn('2', 'chapter-b', ['sha-b'], () => {}, 20)
    focusTab('2')

    expect(holders('chapter-a', 'sha-a')).toEqual(['tab:1'])
    expect(holders('chapter-b', 'sha-b')).toEqual(['tab:2'])
    expect(swarmState.active).toEqual({ publicId: 'chapter-b', pageId: 20 })
    expect(openChapters()).toEqual([
      { publicId: 'chapter-a', pageId: 10, focused: false },
      { publicId: 'chapter-b', pageId: 20, focused: true },
    ])
  })

  it('follows the tab on screen, and says nothing is open when that tab is on the list', () => {
    holdIn('1', 'chapter-a', [], () => {}, 10)
    focusTab('1')

    expect(swarmState.active?.publicId).toBe('chapter-a')

    // A new tab on the list of workspaces, put on screen.
    focusTab('3')

    expect(swarmState.active).toBeNull()
    expect(openChapters()).toEqual([{ publicId: 'chapter-a', pageId: 10, focused: false }])
  })

  it('takes out only the tab that left', () => {
    holdIn('1', 'chapter-a', ['sha-a'], () => {})
    holdIn('2', 'chapter-b', ['sha-b'], () => {})

    holdIn('1', null, [], () => {})

    expect(holders('chapter-a', 'sha-a')).toEqual([])
    expect(holders('chapter-b', 'sha-b')).toEqual(['tab:2'])
  })

  it('moves a tab that opens another chapter out of the room it was in', () => {
    holdIn('1', 'chapter-a', ['sha-a'], () => {})
    holdIn('1', 'chapter-b', ['sha-b'], () => {})

    expect(swarmState.swarms.has('chapter-a')).toBe(false)
    expect(holders('chapter-b', 'sha-b')).toEqual(['tab:1'])
  })

  it('tells an agent\'s change to the tabs with that chapter open, and to no other', () => {
    const a = frames()
    const b = frames()

    holdIn('1', 'chapter-a', [], a.send)
    holdIn('2', 'chapter-b', [], b.send)

    announce('chapter-a', { scope: 'blocks', pageId: 5 })

    expect(a.sent).toEqual([{ publicId: 'chapter-a', frame: JSON.stringify({ type: 'changed', change: { scope: 'blocks', pageId: 5 } }) }])
    expect(b.sent).toEqual([])
  })
})
