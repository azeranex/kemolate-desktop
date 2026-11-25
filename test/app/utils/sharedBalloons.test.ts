import { describe, expect, it } from 'vitest'

import type { Block, PageBox } from '~/composables/useComic'

import { keepsBreaks } from '~/utils/lettering'
import { bandsFor } from '~/utils/sharedBalloons'

/**
 * Several lines in one balloon — desktop. The rooms are a real page's (2026-10-23,
 * page 008: "Why...!?" / "What on earth have I done!?", and "Quiet." / "Take him
 * away, now!"), turned into page percentages on its 1062 × 1500 scan.
 */

const PAGE = { width: 1062, height: 1500 }

/** A room from the width-normalised units the database keeps, as the canvas holds it. */
const room = (cx: number, cy: number, w: number, h: number): PageBox => ({
  x: (cx - w / 2) * 100,
  y: ((cy - h / 2) * PAGE.width / PAGE.height) * 100,
  w: w * 100,
  h: (h * PAGE.width / PAGE.height) * 100,
})

/** The box a block was read from, in the same units — what decides bands or columns. */
const box = (cx: number, cy: number, w: number, h: number) => ({
  x: (cx - w / 2) * 100,
  y: ((cy - h / 2) * PAGE.width / PAGE.height) * 100,
  w: w * 100,
  h: (h * PAGE.width / PAGE.height) * 100,
})

let next = 0

function block (translation: string, own: PageBox | null, more: Partial<Block> = {}): Block {
  return {
    id: `b${next++}`,
    type: 'bubble',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    source: 'あ',
    translation,
    confidence: 90,
    hidden: false,
    ...(own ? { room: own } : {}),
    ...more,
  }
}

const overlaps = (a: PageBox, b: PageBox) =>
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)

describe('lines sharing a balloon', () => {
  const why = block('Why...!?', room(0.735, 0.490, 0.072, 0.165))
  const what = block('What on earth have I done!?', room(0.675, 0.555, 0.075, 0.219))
  const quiet = block('Quiet.', room(0.195, 0.701, 0.061, 0.155))
  const take = block('Take him away, now!', room(0.137, 0.728, 0.080, 0.222))
  const alone = block('Who would spread such a lie...!', room(0.311, 0.568, 0.103, 0.209))

  const bands = bandsFor([why, what, alone, quiet, take])

  it('shares out a balloon whose lines\' rooms overlap, and leaves a balloon of one alone', () => {
    expect([...bands.keys()].sort()).toEqual([why.id, what.id, quiet.id, take.id].sort())
    expect(bands.has(alone.id)).toBe(false)
  })

  it('keeps each line in its own room, cut back from its neighbour, none over another', () => {
    for (const [first, second] of [[why, what], [quiet, take]] as const) {
      const a = bands.get(first.id)!
      const b = bands.get(second.id)!

      expect(overlaps(a, b)).toBe(false)

      // Inside the room each was measured in — where the original sat in the balloon.
      for (const [band, own] of [[a, first.room!], [b, second.room!]] as const) {
        expect(band.x).toBeGreaterThanOrEqual(own.x - 1e-9)
        expect(band.y).toBeGreaterThanOrEqual(own.y - 1e-9)
        expect(band.x + band.w).toBeLessThanOrEqual(own.x + own.w + 1e-9)
        expect(band.y + band.h).toBeLessThanOrEqual(own.y + own.h + 1e-9)
      }
    }

    // "Why...!?" stays up in the right of its balloon, where the original was.
    expect(bands.get(why.id)!.x).toBeGreaterThan(bands.get(what.id)!.x)
  })

  it('sets a balloon measured whole as bands of its one room, in reading order', () => {
    const whole = { ...room(0.22, 0.229, 0.239, 0.167), shared: true }
    const lines = ['We have received a secret report.', 'As of this moment, you are stripped of your office.', 'Come quietly.']
      .map((text) => block(text, { ...whole }))
    const set = bandsFor(lines)
    const bandOfLine = (at: number): PageBox => set.get(lines[at]!.id)!
    const [first, second, third] = [bandOfLine(0), bandOfLine(1), bandOfLine(2)]

    expect(first.y + first.h).toBeLessThanOrEqual(second.y)
    expect(second.y + second.h).toBeLessThanOrEqual(third.y)
    expect(second.h).toBeGreaterThan(third.h)
    // Across the whole room, a hair in from its sides.
    expect(first.w).toBeGreaterThan(whole.w * 0.9)
    expect(first.x).toBeGreaterThan(whole.x)
  })

  /*
   * Two Japanese columns side by side, an utterance each — page 37 of the test
   * chapter (2026-11-26), in that page's own numbers; it has the fixture page's
   * aspect, so they convert the same way. Shared out as stacked bands, each
   * English line was laid across *both* columns and neither sat where its
   * original did.
   */
  it('sets a balloon whose lines sit side by side as columns, the first rightmost', () => {
    const whole = { ...room(0.8273, 1.1070, 0.1266, 0.0984), shared: true }
    const first = block('It\'s so hot inside my gut', { ...whole }, box(0.8719, 1.0758, 0.0376, 0.1563))
    const second = block('You still come as much as ever, huh', { ...whole }, box(0.8042, 1.1131, 0.0687, 0.1193))
    const set = bandsFor([first, second], 'rtl')
    const a = set.get(first.id)!
    const b = set.get(second.id)!

    // Columns: side by side, each running the whole height of the room.
    expect(overlaps(a, b)).toBe(false)
    expect(a.y).toBeCloseTo(b.y, 10)
    expect(a.h).toBeCloseTo(b.h, 10)
    expect(a.h).toBeGreaterThan(whole.h * 0.9)

    // In reading order: the first line is the rightmost column, as its own was.
    expect(a.x).toBeGreaterThan(b.x)

    // And the other way where the chapter reads left to right.
    const ltr = bandsFor([first, second], 'ltr')

    expect(ltr.get(first.id)!.x).toBeLessThan(ltr.get(second.id)!.x)
  })

  /* The other half of the same rule: stacked lines keep the bands they had. */
  it('still bands a balloon whose lines are stacked', () => {
    const whole = { ...room(0.22, 0.229, 0.239, 0.167), shared: true }
    const upper = block('We have received a secret report.', { ...whole }, box(0.22, 0.19, 0.2, 0.05))
    const lower = block('Come quietly.', { ...whole }, box(0.22, 0.27, 0.2, 0.05))
    const set = bandsFor([upper, lower])
    const a = set.get(upper.id)!
    const b = set.get(lower.id)!

    expect(a.y + a.h).toBeLessThanOrEqual(b.y)
    expect(a.x).toBeCloseTo(b.x, 10)
    expect(a.w).toBeCloseTo(b.w, 10)
  })

  it('leaves out a line with a frame of its own, one not translated, and a sound effect', () => {
    const framed = block('Quiet.', room(0.195, 0.701, 0.061, 0.155), { letter: { x: 1, y: 1, w: 5, h: 5 } })
    const unread = block('', room(0.137, 0.728, 0.080, 0.222))
    const sfx = block('BAM', room(0.15, 0.72, 0.08, 0.2), { type: 'sfx' })

    expect(bandsFor([framed, unread, sfx]).size).toBe(0)
  })
})

describe('which newlines are breaks to keep', () => {
  it('keeps a line broken by hand', () => {
    expect(keepsBreaks({ text: 'Hm?\nOh, yeah,\nit is.' })).toBe(true)
  })

  it('lets paragraphs wrap, a blank line between them', () => {
    expect(keepsBreaks({ text: 'We\'ve received a secret report.\n\nAs of this moment, you are stripped of your office.' })).toBe(false)
    expect(keepsBreaks({ text: 'Unbroken.' })).toBe(false)
  })

  it('keeps hand breaks inside paragraphs', () => {
    expect(keepsBreaks({ text: 'We\'ve received\na secret report.\n\nNow, come quietly.' })).toBe(true)
  })
})
