import { describe, expect, it } from 'vitest'

import { blockDraftSchema, blockPatchSchema, letteringStyleSchema, translationSyncSchema } from '#shared/schemas/workspace'
import { FONTS } from '#shared/utils/fonts'
import { LETTERING } from '#shared/utils/lettering'

/**
 * The schema is the only thing standing between the editor's lettering controls
 * and the column that has to give them back, so what is tested here is the two
 * ways it can quietly stop doing that: a setting it does not know about, and a
 * null it flattens into an absence.
 */
describe('letteringStyleSchema', () => {
  /**
   * The keys, against `LETTERING` rather than against a list written out here.
   *
   * A control added to `Lettering` and forgotten in the schema is not a failure
   * anybody would see — the panel would set it, the canvas would draw it, and it
   * would be stripped on the way to the server and gone on the next reload. This
   * is the check that turns that into a red test. Both directions, because a key
   * left behind after one is removed is a column accepting something nothing
   * means.
   */
  it('accepts exactly the settings a block can carry', () => {
    expect(Object.keys(letteringStyleSchema.shape).sort()).toEqual(Object.keys(LETTERING).sort())
  })

  it('takes a whole style unchanged, defaults and all', () => {
    expect(letteringStyleSchema.parse(LETTERING)).toEqual(LETTERING)
  })

  /**
   * The distinction the whole save path exists for. `vertical: null` is "work it
   * out" and `vertical: false` is "somebody pressed H"; a schema that turned one
   * into the other — or dropped either — would hand a forced direction back to
   * `verticalOf`'s guess on every reload, which on a near-square CJK balloon is
   * a block that flips.
   */
  it('keeps a chosen direction apart from an absent one', () => {
    expect(letteringStyleSchema.parse({ vertical: false })).toEqual({ vertical: false })
    expect(letteringStyleSchema.parse({ vertical: true })).toEqual({ vertical: true })
    expect(letteringStyleSchema.parse({ vertical: null })).toEqual({ vertical: null })
    expect(letteringStyleSchema.parse({})).toEqual({})
  })

  /**
   * The face list is written out twice on purpose — once as `FONTS` and once as
   * the schema's enum, which the header there argues for. This is the price of
   * that: a face added to the list and forgotten in the enum is a font a
   * letterer can pick, see on the page, and lose on reload, and only a test
   * comparing the two can say so.
   */
  it('accepts exactly the faces the app offers', () => {
    const font = letteringStyleSchema.shape.font

    expect([...(font.unwrap().unwrap().options as string[])].sort())
      .toEqual(FONTS.map((face) => face.key).sort())
  })

  /** Auto is a face nobody chose, and it has to survive the round trip as one. */
  it('keeps an automatic face apart from a chosen one', () => {
    expect(letteringStyleSchema.parse({ font: null })).toEqual({ font: null })
    expect(letteringStyleSchema.parse({ font: 'sfx' })).toEqual({ font: 'sfx' })
    expect(letteringStyleSchema.safeParse({ font: 'Comic Sans MS' }).success).toBe(false)
  })

  /** The same three states for the two numbers that have an Auto to go back to. */
  it('keeps an automatic size and line apart from a chosen one', () => {
    expect(letteringStyleSchema.parse({ size: null, line: null })).toEqual({ size: null, line: null })
    expect(letteringStyleSchema.parse({ size: 0, line: 0 })).toEqual({ size: 0, line: 0 })
  })

  it('refuses a number that can only be a mistake', () => {
    expect(letteringStyleSchema.safeParse({ size: 1e6 }).success).toBe(false)
    expect(letteringStyleSchema.safeParse({ align: 'middle' }).success).toBe(false)
    expect(letteringStyleSchema.safeParse({ anchor: 'center' }).success).toBe(false)
  })
})

describe('translationSyncSchema', () => {
  it('takes a page of lines with their lettering', () => {
    const body = {
      locale: 'id',
      entries: [
        { blockId: 4, text: 'Selamat pagi', style: { bold: true, vertical: false } },
        { blockId: 5, text: '', style: null },
      ],
    }

    expect(translationSyncSchema.parse(body)).toEqual(body)
  })

  it('refuses a row id that is not one', () => {
    const bad = { locale: 'en', entries: [{ blockId: 0, text: 'x' }] }

    expect(translationSyncSchema.safeParse(bad).success).toBe(false)
  })

  /** Empty is a real answer — a page nobody has translated yet. */
  it('takes a page with nothing said about it', () => {
    expect(translationSyncSchema.parse({ locale: 'en', entries: [] }).entries).toEqual([])
  })

  /**
   * The lettering's own box, which is the whole point of it being on this row
   * rather than on the block: the block is where the text was *found* and what
   * the cleaning under it was measured against, so a balloon resized to fit a
   * translation must move something else.
   */
  it('takes a balloon moved off its block', () => {
    const body = {
      locale: 'fr',
      entries: [{
        blockId: 7,
        text: 'Bonjour',
        cx: 0.4,
        cy: 1.2,
        w: 0.25,
        h: 0.1,
        angle: -12,
        skewX: 8,
        skewY: 0,
        quad: [0, 0, 1, 0, 1, 1, 0, 1],
      }],
    }

    expect(translationSyncSchema.parse(body)).toEqual(body)
  })

  /**
   * The lean, which is the one part of a frame that nothing else can carry.
   * `toBoxed` writes `quad` only where a corner has been pulled, so a frame that
   * has merely been leant has no corner offsets to be rebuilt from — drop these
   * two and a leaned sound effect comes back upright on the next reload, for
   * everyone but the person who leant it.
   */
  it('takes the lean a frame can be dragged into', () => {
    const entry = { blockId: 7, text: 'DOOM', skewX: -18.5, skewY: 4 }

    expect(translationSyncSchema.parse({ locale: 'fr', entries: [entry] }).entries[0]).toEqual(entry)
  })

  /**
   * Absent is what every line sent today looks like, and it has to keep meaning
   * "the lettering sits on the block" — a schema that filled in a default would
   * be a balloon nobody moved arriving with a box, and one that refused the
   * entry would make every existing browser's page unsavable.
   */
  it('leaves a line that was never moved without a box', () => {
    const [entry] = translationSyncSchema.parse({
      locale: 'fr',
      entries: [{ blockId: 7, text: 'Bonjour' }],
    }).entries

    expect(entry).toEqual({ blockId: 7, text: 'Bonjour' })
  })

  /** Null is the same answer said out loud — putting a balloon back on its block. */
  it('takes a balloon put back on its block', () => {
    const body = {
      locale: 'fr',
      entries: [{
        blockId: 7,
        text: 'Bonjour',
        cx: null,
        cy: null,
        w: null,
        h: null,
        angle: null,
        skewX: null,
        skewY: null,
        quad: null,
      }],
    }

    expect(translationSyncSchema.parse(body)).toEqual(body)
  })

  /**
   * The same grid and the same bounds as a block's box — normalised by the
   * scan's width on both axes, so a tall page's `cy` past one is legitimate and
   * a negative `cx` is lettering bleeding off the edge. What is refused is a
   * number that can only be a mistake, and a `quad` that is not four corners.
   */
  it('bounds the box the way a block\'s is bounded', () => {
    const box = (fields: Record<string, unknown>) => translationSyncSchema.safeParse({
      locale: 'fr',
      entries: [{ blockId: 7, text: 'x', ...fields }],
    }).success

    expect(box({ cy: 1.4 })).toBe(true)
    expect(box({ cx: -0.2 })).toBe(true)
    expect(box({ cx: 11 })).toBe(false)
    expect(box({ w: -1 })).toBe(false)
    expect(box({ angle: 720 })).toBe(false)
    expect(box({ quad: [0, 0, 1, 0, 1, 1] })).toBe(false)
  })

  /**
   * Nought is a real place, and it has to arrive as one.
   *
   * Null and nought are different claims about a frame — all-null is "this
   * lettering sits on its block", and a row of numbers with zeroes among them is
   * "it has a frame of its own that happens to be square and level". The server
   * turns that into a rule a query has to obey: framed is `cx IS NOT NULL`,
   * never `cx != 0`. This is the schema's half of keeping the two apart. What it
   * refuses is the tidy-up — a `.default(0)`, or a transform that folds falsy to
   * absent — which would erase the distinction before the service ever saw it,
   * and it matters most for `cx`, because lettering may hang off the left edge
   * and a balloon centred on the page's left border honestly has one of nought.
   */
  it('keeps a nought apart from a null all the way through', () => {
    const flat = { blockId: 7, text: 'x', cx: 0, cy: 0, w: 0.5, h: 0.2, angle: 0, skewX: 0, skewY: 0 }
    const [kept] = translationSyncSchema.parse({ locale: 'fr', entries: [flat] }).entries

    expect(kept).toEqual(flat)
    expect(kept!.cx).toBe(0)
    expect(kept!.angle).toBe(0)
    // Not the same answer as a frame that was never given one.
    expect(kept!.cx).not.toBe(null)
    expect(translationSyncSchema.parse({
      locale: 'fr',
      entries: [{ blockId: 7, text: 'x', cx: null }],
    }).entries[0]!.cx).toBe(null)
  })

  /**
   * The lean takes the *block's* bound and not the drag's. `clampDeg` stops a
   * gesture at ±75 because past that a box is edge-on, but that is a rule about
   * a gesture: restating it here would be a third bound on one quantity and
   * would refuse a lean that `blockDraftSchema` accepts on the block below it.
   */
  it('bounds the lean where a block\'s is bounded, not where the drag stops', () => {
    const lean = (skewX: number) => translationSyncSchema.safeParse({
      locale: 'fr',
      entries: [{ blockId: 7, text: 'x', skewX }],
    }).success

    expect(lean(75)).toBe(true)
    expect(lean(89)).toBe(true)
    expect(lean(-320)).toBe(true)
    expect(lean(361)).toBe(false)
  })
})

/**
 * A balloon's room has to survive both roads a block takes to the server — a
 * reading's whole-page write and a single block's patch — or it is measured in
 * the browser and gone on the next load. And a patch has to be able to *clear*
 * one, which is null rather than absence: absence in a patch means "leave it".
 */
describe('a block\'s room', () => {
  const box = { kind: 'bubble' as const, cx: 0.5, cy: 1.2, w: 0.1, h: 0.2 }
  const room = { cx: 0.5, cy: 1.2, w: 0.3, h: 0.25 }

  it('rides along with a reading', () => {
    expect(blockDraftSchema.parse({ ...box, room }).room).toEqual(room)
    expect(blockDraftSchema.parse(box).room).toBeUndefined()
  })

  it('can be set, cleared or left alone by a patch', () => {
    expect(blockPatchSchema.parse({ room }).room).toEqual(room)
    expect(blockPatchSchema.parse({ room: null }).room).toBeNull()
    expect('room' in blockPatchSchema.parse({ cx: 0.4 })).toBe(false)
  })

  it('refuses a room that is not a box', () => {
    expect(blockPatchSchema.safeParse({ room: { cx: 0.5, cy: 0.5 } }).success).toBe(false)
    expect(blockPatchSchema.safeParse({ room: { ...room, w: -1 } }).success).toBe(false)
  })
})
