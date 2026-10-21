import { beforeEach, describe, expect, it } from 'vitest'

/**
 * A gesture that changed several things, undone by one press.
 *
 * **Needs the nuxt project** for `useComic`'s and `useUndo`'s state.
 *
 * `gather` exists for the region brush, which takes away every block its stroke
 * covers and puts one in their place. Recorded as it comes that is a deletion
 * per block plus a placement — four presses of Cmd+Z to undo one stroke, and
 * three of them land the page in states nobody asked for. Half-undone is the one
 * state the page must never be left in, so the whole gesture is one step.
 *
 * The subtlety worth a test is the **order**. A deletion carries the index it
 * came out of, so three of them restored front-to-back put the first one back
 * before the second has left its gap and every index after it is one out. Undo
 * runs a batch last-first for exactly that reason, and nothing about the code
 * says so loudly enough to survive a tidy-up — hence this.
 *
 * Seam: `useUndo`'s `gather`/`undo`/`redo` against `useComic`'s `addBlock` and
 * `removeBlock`, which are what actually record.
 */

/** Four blocks across the page, so an index that slips is a different block. */
function seed () {
  const comic = useComic()

  comic.reset()

  comic.pages.value = [{
    id: 'scan:1.jpg',
    name: '1.jpg',
    size: { width: 1000, height: 1400 },
    blocks: ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      type: 'bubble' as const,
      x: i * 20,
      y: 10,
      w: 10,
      h: 10,
      source: id,
      translation: '',
      confidence: 100,
      hidden: false,
    })),
  } as unknown as ComicPage]

  comic.go(0)

  return comic
}

const names = () => useComic().pages.value[0]!.blocks.map((block) => block.id)

beforeEach(() => {
  useComic().reset()
})

describe('gather', () => {
  it('files a whole gesture as one step, whatever it touched', async () => {
    const comic = seed()
    const undo = useUndo()

    undo.gather(() => {
      comic.removeBlock('b')
      comic.removeBlock('c')

      return comic.addBlock({ x: 20, y: 10, w: 30, h: 10 }, { type: 'bubble', source: 'region' })
    })

    expect(names()).toEqual(['a', 'd', expect.stringMatching(/^text:/)])

    await undo.undo()

    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })

  /**
   * The ordering test, and the reason for it: `b` and `c` were adjacent, so a
   * batch replayed front-to-back restores `b` at index 1 while `c`'s gap has not
   * been reopened, and `c` lands one place late. The page comes back with its
   * blocks in the wrong order — every number in the Blocks panel shifted, which
   * is how a letterer refers to them.
   */
  it('puts deletions back in the order that restores their indices', async () => {
    const comic = seed()
    const undo = useUndo()

    undo.gather(() => {
      comic.removeBlock('a')
      comic.removeBlock('c')
    })

    expect(names()).toEqual(['b', 'd'])

    await undo.undo()

    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('redoes the gesture as one press too', async () => {
    const comic = seed()
    const undo = useUndo()

    undo.gather(() => {
      comic.removeBlock('b')
      comic.removeBlock('c')
    })

    await undo.undo()
    await undo.redo()

    expect(names()).toEqual(['a', 'd'])
  })

  /**
   * A gesture that changed one thing is that one thing. Wrapping it would work,
   * but it would put a batch on the stack where every other path in the app puts
   * an entry, and the kinds are what `forgetBlock` and `renameBlock` switch on.
   */
  it('files a single change as itself rather than as a batch of one', () => {
    const comic = seed()
    const undo = useUndo()

    undo.gather(() => comic.removeBlock('b'))

    expect(names()).toEqual(['a', 'c', 'd'])
  })

  /** A gesture that turned out to change nothing should cost no press. */
  it('files nothing when nothing was recorded', async () => {
    const comic = seed()
    const undo = useUndo()

    comic.removeBlock('a')

    undo.gather(() => {})

    await undo.undo()

    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })
})

/**
 * A gesture over several blocks is one step, however many events it takes.
 *
 * The report: dragging three balloons, or moving a lettering slider with three
 * picked, filed a step per block per event. A step folds only into one for the
 * same block, and the three took turns on top of the stack, so nothing folded:
 * half a second of dragging filled the hundred-step history and pushed out
 * everything before it, and undo walked the drag back a block and a frame at a
 * time. The caller now names the gesture (`merge`) and its events fold.
 */
describe('a gesture over several blocks', () => {
  const xs = () => useComic().pages.value[0]!.blocks.map((block) => block.x)

  const drag = (steps: number) => {
    for (let i = 1; i <= steps; i++) {
      useComic().updateMany(['a', 'b', 'c'].map((id, n) => ({ id, patch: { x: n * 20 + i } })), undefined, 'move:a,b,c')
    }
  }

  it('takes a whole drag of three back with one press', async () => {
    seed()
    drag(50)

    expect(xs()).toEqual([50, 70, 90, 60])

    await useUndo().undo()

    expect(xs()).toEqual([0, 20, 40, 60])
  })

  it('leaves the history before the drag where it was', async () => {
    const comic = seed()

    comic.removeBlock('d')
    drag(50)

    await useUndo().undo()
    await useUndo().undo()

    expect(names()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps two presses of a button two steps', async () => {
    const comic = seed()

    comic.updateMany([{ id: 'a', patch: { x: 5 } }, { id: 'b', patch: { x: 25 } }])
    comic.updateMany([{ id: 'a', patch: { x: 6 } }, { id: 'b', patch: { x: 26 } }])

    await useUndo().undo()

    expect(xs()).toEqual([5, 25, 40, 60])
  })

  it('takes a lettering slider over several blocks back with one press', async () => {
    const comic = seed()

    comic.selection.value = ['a', 'b', 'c']

    for (let size = 10; size <= 60; size++) comic.setLettering({ size })

    expect(comic.pages.value[0]!.blocks[0]!.style?.size).toBe(60)

    await useUndo().undo()

    expect(comic.pages.value[0]!.blocks.slice(0, 3).map((block) => block.style?.size)).toEqual([undefined, undefined, undefined])
  })
})
