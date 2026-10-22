import { describe, expect, it } from 'vitest'

import type { Block } from '~/composables/useComic'
import type { Sheet } from '~/utils/paper'

import { balloonGroups } from '~/utils/ocr/blocks'
import { balloonJudge } from '~/utils/ocr/together'

/**
 * Whether two blocks are one balloon, asked of the page — `balloonJudge` — and
 * the join that takes its word (`balloonGroups`).
 *
 * The case that made it: page 11 of the test chapter, where the comic detector
 * found two speakers' balloons as two blocks and the auto run's geometry joined
 * them, 0.087 of the page apart against an allowance of 0.088. The pages here
 * are drawn by hand, as `balloon.test.ts` draws them, because what is under
 * test is the decision and not the fill.
 */

/** A blank sheet of paper, `SIZE` square, which is also the scan's size: one pixel a pixel. */
const SIZE = 800

function page (size = SIZE): Sheet {
  return { data: new Uint8ClampedArray(size * size * 4).fill(255), w: size, h: size }
}

function put (sheet: Sheet, x: number, y: number) {
  if (x < 0 || y < 0 || x >= sheet.w || y >= sheet.h) return

  const at = (y * sheet.w + x) * 4

  sheet.data[at] = 0
  sheet.data[at + 1] = 0
  sheet.data[at + 2] = 0
}

/** A closed rectangular balloon outline, three pixels thick. */
function outline (sheet: Sheet, x0: number, y0: number, x1: number, y1: number) {
  for (let t = 0; t < 3; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) {
      put(sheet, x, y0 - t)
      put(sheet, x, y1 + t)
    }

    for (let y = y0 - t; y <= y1 + t; y++) {
      put(sheet, x0 - t, y)
      put(sheet, x1 + t, y)
    }
  }
}

/** A column of lettering: blots of ink down a strip. */
function column (sheet: Sheet, x: number, y0: number, rows: number) {
  for (let r = 0; r < rows; r++) {
    for (let y = y0 + r * 10; y < y0 + r * 10 + 6; y++) for (let dx = 0; dx < 6; dx++) put(sheet, x + dx, y)
  }
}

/** A balloon-text block over a box in the page's pixels — `Block` keeps percentages. */
function block (id: string, x: number, y: number, w: number, h: number): Block {
  return {
    id,
    type: 'bubble',
    x: (x / SIZE) * 100,
    y: (y / SIZE) * 100,
    w: (w / SIZE) * 100,
    h: (h / SIZE) * 100,
    source: id,
    translation: '',
    confidence: 100,
    hidden: false,
  } as Block
}

const ids = (groups: Block[][]) => groups.map((group) => group.map((member) => member.id))

describe('balloonJudge — the balloons the detector drew', () => {
  const fences = [{ x: 80, y: 80, w: 300, h: 400 }, { x: 392, y: 80, w: 300, h: 400 }]

  it('calls two blocks in two drawn balloons apart, however close, and two in one the same', () => {
    const judge = balloonJudge({ sheet: null, fences, width: SIZE, height: SIZE })

    const right = block('right', 400, 120, 80, 300)
    const left = block('left', 300, 120, 72, 300)
    const alsoRight = block('also', 580, 120, 60, 300)

    expect(judge(right, left)).toBe('apart')
    expect(judge(right, alsoRight)).toBe('same')
  })
})

describe('balloonJudge — the outlines in the pixels', () => {
  it('calls two touching balloons apart: the outline between them is where a fill stops', () => {
    const sheet = page()

    outline(sheet, 240, 260, 390, 500)
    outline(sheet, 396, 260, 546, 500)
    column(sheet, 350, 290, 15)
    column(sheet, 410, 290, 15)

    const judge = balloonJudge({ sheet, fences: null, width: SIZE, height: SIZE })

    expect(judge(block('a', 350, 290, 6, 146), block('b', 410, 290, 6, 146))).toBe('apart')
  })

  it('calls two columns of one wide balloon the same, however far apart', () => {
    const sheet = page()

    outline(sheet, 240, 260, 560, 500)
    column(sheet, 500, 290, 15)
    column(sheet, 300, 290, 15)

    const judge = balloonJudge({ sheet, fences: null, width: SIZE, height: SIZE })

    expect(judge(block('a', 500, 290, 6, 146), block('b', 300, 290, 6, 146))).toBe('same')
  })

  it('cannot say for lettering with no balloon round it', () => {
    const sheet = page()

    column(sheet, 350, 290, 15)
    column(sheet, 370, 290, 15)

    const judge = balloonJudge({ sheet, fences: null, width: SIZE, height: SIZE })

    expect(judge(block('a', 350, 290, 6, 146), block('b', 370, 290, 6, 146))).toBeNull()
  })
})

describe('balloonGroups with the page\'s word', () => {
  // Page 11's two blocks, as stored (normalised by the width, 2961 × 4142),
  // put back into page percentages: x and w of the width, y and h of the height.
  const aspect = 2961 / 4142
  const stored = (id: string, cx: number, cy: number, w: number, h: number): Block => ({
    id,
    type: 'bubble',
    x: (cx - w / 2) * 100,
    y: (cy - h / 2) * 100 * aspect,
    w: w * 100,
    h: h * 100 * aspect,
    source: id,
    translation: '',
    confidence: 100,
    hidden: false,
  }) as Block

  const page11 = [
    stored('というか…', 0.8075, 0.9881, 0.1260, 0.2394),
    stored('あぁ、魔法で…', 0.5710, 1.0214, 0.1745, 0.2918),
  ]

  it('joins page 11\'s two balloons on geometry alone — the bug', () => {
    expect(balloonGroups(page11, 'rtl')).toHaveLength(1)
  })

  it('leaves them apart when the page says they are two balloons', () => {
    expect(balloonGroups(page11, 'rtl', () => 'apart')).toEqual([])
  })

  it('joins what the page says is one balloon, past the geometry\'s reach', () => {
    const far = [block('a', 300, 90, 6, 146), block('b', 100, 90, 6, 146)]

    expect(balloonGroups(far, 'rtl')).toEqual([])
    expect(ids(balloonGroups(far, 'rtl', () => 'same'))).toEqual([['a', 'b']])
  })

  it('drops a chain that joins two blocks the page said were apart', () => {
    const [a, b, c] = [block('a', 200, 90, 6, 146), block('b', 190, 90, 6, 146), block('c', 180, 90, 6, 146)]
    const said = (x: Block, y: Block) => ((x === a && y === c) || (x === c && y === a) ? 'apart' : null)

    expect(balloonGroups([a!, b!, c!], 'rtl')).toHaveLength(1)
    expect(balloonGroups([a!, b!, c!], 'rtl', said)).toEqual([])
  })
})
