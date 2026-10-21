import { describe, expect, it } from 'vitest'

import type { Block } from '~/composables/useComic'
import type { StoredBlock } from '~/utils/ocr/blocks'
import type { DetectedText } from '~/utils/ocr/detectors'

/**
 * What a page holds when it is read back — the half of `toBlocks` that picks a
 * block's translation and its lettering out of the rows hanging off it.
 *
 * `toBlocks` is not imported: `utils/ocr` is an auto-imported family (see
 * `imports.dirs`), and this project stands the real module graph up so the tests
 * reach it the way the app does. The type is imported, because a type is not.
 *
 * A square scan, so the aspect is one and the boxes are arithmetic anybody can
 * check by eye — the coordinate spaces are `transform`'s to argue about, not
 * this file's.
 */
const SCAN = { width: 100, height: 100 }

function row (translations?: StoredBlock['translations']): StoredBlock {
  return {
    id: 7,
    position: 0,
    kind: 'bubble',
    cx: 0.5,
    cy: 0.5,
    w: 0.2,
    h: 0.2,
    angle: 0,
    source: 'おはよう',
    confidence: 90,
    hidden: false,
    ...(translations ? { translations } : {}),
  }
}

describe('toBlocks', () => {
  it('puts the chapter’s own language on the page', () => {
    const [block] = toBlocks([row([
      { locale: 'en', text: 'Good morning' },
      { locale: 'id', text: 'Selamat pagi' },
    ])], SCAN, 'id')

    expect(block?.translation).toBe('Selamat pagi')
  })

  /**
   * Taking the first row when nobody named a language would put Indonesian on a
   * page being worked in English the moment somebody translated a chapter twice.
   */
  it('says nothing when no language was asked for', () => {
    const [block] = toBlocks([row([{ locale: 'id', text: 'Selamat pagi' }])], SCAN)

    expect(block?.translation).toBe('')
    expect(block?.style).toBeUndefined()
  })

  it('leaves a block untranslated when nothing was said in that language', () => {
    const [block] = toBlocks([row([{ locale: 'id', text: 'Selamat pagi' }])], SCAN, 'en')

    expect(block?.translation).toBe('')
  })

  /**
   * The point of the whole path, and it is asserted against `verticalOf` rather
   * than against the field alone, because the field alone was never the bug.
   *
   * This block is the case that bites: four wide characters in a square box, so
   * `readsVertical` guesses down the page. A reload that dropped the pin handed
   * the block back to that guess — which, under a frame Transpose had already
   * turned a quarter, is the turn exactly cancelled.
   */
  it('brings a chosen direction back, over the guess it overrides', () => {
    const [block] = toBlocks(
      [row([{ locale: 'en', text: '', style: { vertical: false, bold: true } }])],
      SCAN,
      'en',
    )

    const box = { w: 20, h: 20 }

    expect(block?.style).toEqual({ vertical: false, bold: true })
    expect(readsVertical(block!.source, box)).toBe(true)
    expect(verticalOf(letteringOf(block!.style), block!, box)).toBe(false)
  })

  /**
   * Absent rather than `{}` — the rule `Block.style` states. A block carrying an
   * empty object is one that has been styled with nothing to say, which survives
   * a change of what the defaults are; a block carrying nothing follows them.
   */
  it('carries no settings for a block nobody has lettered', () => {
    const [none] = toBlocks([row([{ locale: 'en', text: 'Morning' }])], SCAN, 'en')
    const [empty] = toBlocks([row([{ locale: 'en', text: 'Morning', style: {} }])], SCAN, 'en')

    expect(none).not.toHaveProperty('style')
    expect(empty).not.toHaveProperty('style')
  })

  /**
   * A balloon is the object and its columns are only boxes and readings — see
   * `blocks.parentId`. Hydrating a column would draw the line twice.
   */
  it('leaves a balloon’s columns to the balloon', () => {
    const parent = {
      ...row([{ locale: 'en', text: 'Morning' }]),
      children: [{ ...row([{ locale: 'en', text: 'Morning' }]), id: 8 }],
    }

    const [block] = toBlocks([parent], SCAN, 'en')

    expect(block?.translation).toBe('Morning')
    expect(block?.children?.[0]?.translation).toBe('')
  })

  it('still keeps the box it was already keeping', () => {
    const [block] = toBlocks([row()], SCAN, 'en')

    expect(block).toMatchObject({ id: 'block:7', x: 40, y: 40, w: 20, h: 20, source: 'おはよう' })
  })
})

/**
 * A block on the page, in the percentages the canvas speaks — `x`/`w` of the
 * page's width, `y`/`h` of its height. The numbers below are chosen in those
 * units on purpose: the function assumes the usual page proportions to judge a
 * box's shape, and a test written in pixels would be testing an assumption it
 * had quietly made itself.
 */
function block (id: string, box: [number, number, number, number], extra: Partial<Block> = {}): Block {
  const [x, y, w, h] = box

  return { id, type: 'bubble', x, y, w, h, source: 'あ', translation: '', confidence: 90, hidden: false, ...extra }
}

/** A column of a vertical balloon at `x`: narrow across, tall down. */
const column = (id: string, x: number, extra?: Partial<Block>) => block(id, [x, 10, 4, 20], extra)

/** A line of a horizontal balloon at `y`: wide across, short down. */
const line = (id: string, y: number, extra?: Partial<Block>) => block(id, [20, y, 30, 4], extra)

/** What came back, as ids, so an order can be read at a glance. */
const ids = (groups: Block[][]) => groups.map((group) => group.map((member) => member.id))

/**
 * A balloon's room on its way in and back out — the conversion `toBlocks` and
 * `toPatch` share with the box.
 *
 * On a tall page on purpose, unlike the square scan above: the room is
 * normalised by the page's *width* on both axes and the canvas's percentages by
 * its height, and a conversion that confused the two is invisible on a square.
 * That confusion is not hypothetical — boxes converted at the guessed shape
 * shrank on every refresh until `sized` stopped it.
 */
describe('a balloon\'s room', () => {
  const TALL = { width: 2209, height: 3106 }
  const room = { cx: 0.47, cy: 0.13, w: 0.19, h: 0.15 }
  const stored: StoredBlock = { ...row(), room }

  it('comes back from the canvas as it went in', () => {
    const [block] = toBlocks([stored], TALL)
    const patch = toPatch(block!, TALL)

    expect(patch.room!.cx).toBeCloseTo(room.cx, 9)
    expect(patch.room!.cy).toBeCloseTo(room.cy, 9)
    expect(patch.room!.w).toBeCloseTo(room.w, 9)
    expect(patch.room!.h).toBeCloseTo(room.h, 9)
  })

  it('is what a translation is set in when nobody has placed a frame', () => {
    const [read] = toBlocks([stored], TALL)
    const block = { ...read!, translation: 'Good morning' }

    expect(letterBoxOf(block)).toEqual(block.room)
    expect(letterBoxOf({ ...block, letter: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  /**
   * Before there is a translation the plate shows what was read, and it shows
   * it where it was read: the hit area and outline of an untranslated block are
   * its own box, so a room here drew the placeholder out in the balloon, beside
   * an empty box that was the only thing you could pick.
   */
  it('waits for a translation, and until then the words stay where they were read', () => {
    const [block] = toBlocks([stored], TALL)

    expect(block!.room).toBeDefined()
    expect(letterBoxOf(block!)).toEqual(blockBoxOf(block!))
    expect(letterBoxOf({ ...block!, translation: '' })).toEqual(blockBoxOf(block!))
  })

  it('is absent on a block that has none, and clears the column when it goes', () => {
    const [block] = toBlocks([row()], TALL)

    expect(block!.room).toBeUndefined()
    expect(letterBoxOf(block!)).toEqual(blockBoxOf(block!))
    expect(toPatch(block!, TALL).room).toBeNull()
  })
})

describe('balloonGroups', () => {
  /**
   * The case the whole thing exists for: a detector hands back one box per
   * column, and the three of them are one balloon's worth of words.
   */
  it('joins the columns of one vertical balloon', () => {
    const page = [column('c1', 50), column('c2', 45), column('c3', 40)]

    expect(ids(balloonGroups(page))).toEqual([['c1', 'c2', 'c3']])
  })

  it('leaves two balloons in one panel apart', () => {
    const page = [column('r1', 50), column('r2', 45), column('l1', 20), column('l2', 15)]

    expect(ids(balloonGroups(page))).toEqual([['r1', 'r2'], ['l1', 'l2']])
  })

  /**
   * The type is the only evidence on the page that a sound effect drawn across
   * a balloon is not one of its columns — this one sits a single column's gap
   * away and matches the columns in every other respect.
   */
  it('does not swallow a sound effect', () => {
    const page = [
      column('sfx', 55, { type: 'sfx' }),
      column('c1', 50),
      column('c2', 45),
      column('c3', 40),
    ]

    expect(ids(balloonGroups(page))).toEqual([['c1', 'c2', 'c3']])
  })

  /**
   * Idempotence, which is not a nicety: `canMerge` refuses a block that already
   * has children, so a group containing one would fail the auto run outright on
   * any page it was repeated over.
   */
  it('finds nothing on a page it has already joined', () => {
    const members = [column('c1', 50), column('c2', 45), column('c3', 40)]
    const joined = [block('balloon', [40, 10, 14, 20], { children: members }), column('c4', 10)]

    expect(balloonGroups(members)).toHaveLength(1)
    expect(balloonGroups(joined)).toEqual([])
  })

  /**
   * `merge` joins the sources in member order, so a group in any other order is
   * a scrambled sentence. The page arrives sorted; the group keeps that.
   */
  it('keeps members in the order they arrived, both ways round', () => {
    expect(ids(balloonGroups([column('c1', 50), column('c2', 45), column('c3', 40)], 'rtl')))
      .toEqual([['c1', 'c2', 'c3']])

    expect(ids(balloonGroups([column('c1', 40), column('c2', 45), column('c3', 50)], 'ltr')))
      .toEqual([['c1', 'c2', 'c3']])
  })

  it('stacks the lines of a horizontal balloon', () => {
    const page = [line('l1', 10), line('l2', 16), line('l3', 22)]

    expect(ids(balloonGroups(page, 'ltr'))).toEqual([['l1', 'l2', 'l3']])
  })

  /**
   * The same three lines on a page that reads right to left, where text runs in
   * columns and two boxes stacked are more often two balloons than one. Not a
   * refusal on principle — a tighter gap, which these three do not clear.
   */
  it('holds an adjacency across the grain to a tighter gap', () => {
    const page = [line('l1', 10), line('l2', 16), line('l3', 22)]

    expect(balloonGroups(page, 'rtl')).toEqual([])
  })

  /**
   * A chain that has run away across the panel. Four of these columns is a wide
   * balloon; five covers a quarter of the page, which no balloon does, and the
   * group is dropped whole rather than trimmed to whichever part looks better.
   */
  it('refuses a group too big to be a balloon', () => {
    const wide = [5, 14, 23, 32].map((x, i) => block(`c${i}`, [x, 20, 8, 60]))

    expect(balloonGroups(wide)).toHaveLength(1)
    expect(balloonGroups([...wide, block('c4', [41, 20, 8, 60])])).toEqual([])
  })

  /**
   * A box the reader all but disowned, in the middle of a balloon. Nothing is
   * joined rather than the two ends joined around it: they are a column and a
   * half apart, which is not a gap this will cross.
   */
  it('leaves out a box the reader disowned', () => {
    const page = [column('c1', 50), column('junk', 45, { confidence: 5 }), column('c3', 40)]

    expect(balloonGroups(page)).toEqual([])
  })
})

/**
 * Which kind a reading is filed as — the detector's label, overruled where it
 * calls somebody talking a sound effect. See `speechLike` and `labelOf`.
 *
 * Seam: `toDrafts`, with the regions a detector hands back.
 */
describe('toDrafts — bubble or sound effect', () => {
  const WIDTH = 1000
  const region = (label: DetectedText['label'], bubble = false): DetectedText => ({
    x: 400,
    y: 400,
    w: 200,
    h: 200,
    label,
    score: 0.8,
    ...(bubble ? { bubble: { x: 350, y: 350, w: 300, h: 300 } } : {}),
  })
  const read = (text: string) => ({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.2, angle: 0, text })
  const kindOf = (text: string, found: DetectedText) => toDrafts([read(text)], [found], WIDTH)[0]!.kind

  it('keeps a sound effect loose on the art', () => {
    expect(kindOf('ドンッ!', region('text_free'))).toBe('sfx')
  })

  it('files free text inside one of the detector\'s own balloons as dialogue', () => {
    expect(kindOf('ドンッ!', region('text_free', true))).toBe('bubble')
  })

  it('files free text that reads as a sentence as dialogue', () => {
    expect(kindOf('優しい人だから安心してねそれ', region('text_free'))).toBe('bubble')
  })

  it('never turns balloon text into a sound effect', () => {
    expect(kindOf('ドンッ!', region('text_bubble'))).toBe('bubble')
  })
})
