import { beforeEach, describe, expect, it } from 'vitest'

/**
 * A balloon's room is a measurement, and undo must not rewrite it.
 *
 * **Needs the nuxt project** for `useComic`'s and `useUndo`'s state.
 *
 * `room` used to be in `useUndo`'s `FIELDS`, so every edit's snapshot carried
 * the room as it was *then*. Measure balloons writes rooms outside undo, and
 * undoing or redoing an edit made before it put the old room back — nothing —
 * over the measured one; on the page on screen the sync then cleared it on the
 * server too. A room is measured, not typed, and a press of Cmd+Z is about
 * what somebody did.
 *
 * Seam: `useComic.updateMany`, which records, and `useUndo.undo`/`redo`.
 */

const ROOM = { x: 5, y: 8, w: 30, h: 14 }

function seed () {
  const comic = useComic()

  comic.reset()

  comic.pages.value = [{
    id: 'scan:1.jpg',
    name: '1.jpg',
    size: { width: 1000, height: 1400 },
    blocks: [{
      id: 'a',
      type: 'bubble' as const,
      x: 10,
      y: 10,
      w: 10,
      h: 10,
      source: 'a',
      translation: '',
      confidence: 100,
      hidden: false,
    }],
  } as unknown as ComicPage]

  comic.go(0)

  return comic
}

const block = () => useComic().pages.value[0]!.blocks[0]!

beforeEach(() => {
  useComic().reset()
})

describe('undo and a measured room', () => {
  it('leaves a room measured after an edit alone when that edit is undone and redone', async () => {
    const comic = seed()
    const undo = useUndo()

    // An edit, recorded: the block moved.
    comic.updateMany([{ id: 'a', patch: { x: 40 } }])

    // Then measured, the way Measure balloons writes it — straight onto the
    // block, outside undo.
    block().room = { ...ROOM }

    await undo.undo()

    expect(block().x).toBe(10)
    expect(block().room).toEqual(ROOM)

    await undo.redo()

    expect(block().x).toBe(40)
    expect(block().room).toEqual(ROOM)
  })
})
