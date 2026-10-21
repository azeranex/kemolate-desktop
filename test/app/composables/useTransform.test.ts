import { beforeEach, describe, expect, it } from 'vitest'

import { useComic } from '~/composables/useComic'
import { useTransform } from '~/composables/useTransform'

/**
 * The Transform panel's numbers, and what setting one does to the blocks.
 *
 * The panel is the board's handles said in figures, so these check the figures
 * against the boxes: read in scan pixels, written back as the handles write
 * (same box, same patch rule), and — the one that is easy to get wrong — a zero
 * that actually clears what was there, since a box's turn and lean are left off
 * it when they are nought and a patch is merged into the block.
 *
 * Seam: `useTransform` over `useComic`'s own state — a page of known size, and
 * blocks put straight into the selection.
 */
const block = (id: string, box: Partial<Block> = {}): Block => ({
  id,
  type: 'bubble',
  x: 10,
  y: 20,
  w: 30,
  h: 5,
  source: 'こんにちは',
  translation: '',
  ...box,
}) as Block

function open (blocks: Block[]) {
  const comic = useComic()

  comic.pages.value = [{
    id: 'scan:1.png',
    name: '1.png',
    blocks,
    // 1000 × 2000: a percentage of the width is ten pixels, of the height twenty.
    scan: { url: 'blob:1', file: new File([], '1.png'), width: 1000, height: 2000, hash: 'h1' },
  }] as unknown as ComicPage[]
  comic.at.value = 0
  comic.selection.value = blocks.map((one) => one.id)
  comic.framing.value = 'lettering'

  return comic
}

const onPage = (id: string) => useComic().pages.value[0]!.blocks.find((one) => one.id === id)!

describe('the Transform panel', () => {
  beforeEach(() => {
    useTransform().locked.value = false
  })

  it('reads a box in the scan\'s pixels, from its left and top', () => {
    open([block('a')])

    const { values } = useTransform()

    expect(values.value).toMatchObject({ x: 100, y: 400, w: 300, h: 100, angle: 0, skewX: 0, skewY: 0 })
  })

  it('moves a box without changing its size', () => {
    open([block('a')])
    useTransform().set('x', 250)

    expect(onPage('a')).toMatchObject({ x: 25, w: 30, y: 20, h: 5 })
  })

  it('widens a box from its left edge, and keeps the proportion when it is locked', () => {
    open([block('a'), block('b')])

    const transform = useTransform()

    transform.set('w', 600)
    expect(onPage('a')).toMatchObject({ x: 10, w: 60, h: 5 })

    transform.locked.value = true
    transform.set('w', 300)

    // Half as wide, so half as tall: 100 px of 200 is 5% of the height → 2.5%.
    expect(onPage('a').w).toBeCloseTo(30)
    expect(onPage('a').h).toBeCloseTo(2.5)
    expect(onPage('a').y).toBe(20)
  })

  it('turns a box, and turning it back to nought clears the turn', () => {
    open([block('a', { angle: 30, skewX: 10 })])

    const transform = useTransform()

    transform.set('angle', 400)
    expect(onPage('a').angle).toBe(40)

    transform.set('angle', 0)
    expect(onPage('a').angle ?? 0).toBe(0)
    // Only the turn: the lean it did not touch is still there.
    expect(onPage('a').skewX).toBe(10)
  })

  it('stops a lean at the edge-on limit', () => {
    open([block('a')])
    useTransform().set('skewY', 120)

    expect(onPage('a').skewY).toBe(75)
  })

  it('moves the lettering frame of a translated block, and leaves the reading where it was', () => {
    open([block('a', { translation: 'Hello' })])
    useTransform().set('x', 500)

    expect(onPage('a')).toMatchObject({ x: 10, w: 30 })
    expect(onPage('a').letter).toMatchObject({ x: 50, w: 30 })
  })

  it('moves the reading itself when the framing is on it', () => {
    const comic = open([block('a', { translation: 'Hello' })])

    comic.framing.value = 'reading'
    useTransform().set('x', 500)

    expect(onPage('a').x).toBe(50)
    expect(onPage('a').letter).toBeUndefined()
  })

  it('says a field is mixed where the selection disagrees, and sets it on every block', () => {
    open([block('a'), block('b', { w: 50 })])

    const transform = useTransform()

    expect(transform.values.value.w).toBeNull()
    expect(transform.values.value.x).toBe(100)

    transform.set('w', 200)

    expect([onPage('a').w, onPage('b').w]).toEqual([20, 20])
    expect(transform.values.value.w).toBe(200)
  })

  it('straightens pulled corners, and resets turn, lean and corners together', () => {
    open([block('a', { angle: 12, skewY: -8, quad: [5, 0, 0, 0, 0, 0, 0, 3] })])

    const transform = useTransform()

    expect(transform.distorted.value).toBe(true)

    transform.straighten()
    expect(onPage('a').quad).toBeUndefined()
    expect(onPage('a').angle).toBe(12)

    transform.reset()
    expect([onPage('a').angle ?? 0, onPage('a').skewX ?? 0, onPage('a').skewY ?? 0]).toEqual([0, 0, 0])
    expect(transform.transformed.value).toBe(false)
    // Position and size are not what Reset is for.
    expect(onPage('a')).toMatchObject({ x: 10, y: 20, w: 30, h: 5 })
  })
})
