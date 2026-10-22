/**
 * How a line is set on the page: the face it is set in, where it sits in its
 * balloon, and the four numbers a letterer actually turns.
 *
 * The numbers are in the scan's own pixels — the page as it was scanned, not as
 * it happens to be shown. That is the only unit here that is stable: a size in
 * screen pixels means something different at every zoom and every window width,
 * and a size in percent means something different on every page of a chapter
 * whose scans are not all the same height. Type set at 30px on a 1600px scan is
 * set at 30px on that scan for good, and the canvas scales it to whatever it is
 * drawing at.
 *
 * It lives in `shared/` for the reason `raster.ts` and `layers.ts` do: lettering
 * has to come out the same wherever it is set, and a bake that reckoned sizes
 * differently from the editor would show you one page and write another.
 */

// Relative, like `shared/schemas` — a file under `shared/` has to load outside
// Nuxt's auto-imports, which is what lets the unit tests reach it without
// standing a Nuxt build up first.
import { rgbOf } from './raster'

import type { FontKey } from './fonts'

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

/** Where the line sits across the balloon's short axis. */
export type TextAnchor = 'top' | 'middle' | 'bottom'

export interface Lettering {
  /**
   * The face, as a key from `FONTS` rather than a CSS family — see
   * `shared/utils/fonts`, which says why. Null is "as the page would letter
   * it": the dialogue face for a balloon, the display face for a sound effect.
   * See `faceOf`, which is where that answer comes from.
   */
  font: FontKey | null
  /**
   * Type size in scan pixels. Null is "work it out" — see `estimateSize`, and
   * the Fit button, which replaces the guess with a measurement.
   */
  size: number | null
  /** Line height as a multiple of the size. Null is the face's own. */
  line: number | null
  /** Letter spacing in scan pixels, either way from nought. */
  spacing: number
  /** How thick an outline the lettering carries, in scan pixels. */
  stroke: number
  bold: boolean
  italic: boolean
  underline: boolean
  align: TextAlign
  anchor: TextAnchor
  /**
   * Set down the page rather than across it. Null is "as it reads" — see
   * `verticalOf`, which is where the answer comes from when nobody has forced
   * one.
   */
  vertical: boolean | null
  /**
   * What the words are set in, as `#rrggbb`. Null is "read it off the page" —
   * see `inking`, which is where that answer comes from.
   */
  color: string | null
  /**
   * What the outline `stroke` paints is set in, likewise. Null is the reverse
   * of whatever the fill came out as, which is the only value an outline is
   * ever for: it exists to hold the letter apart from what is behind it.
   */
  outline: string | null
  /**
   * The shape the lines are wrapped into inside the frame. Null is "as the
   * block would be lettered" — see `shapeFor`: a balloon's words are set in a
   * soft lozenge, everything else in the plain box.
   */
  shape: LetterShape | null
  /**
   * The outline a `custom` shape wraps into: a polygon as `[x0, y0, x1, y1, …]`,
   * each a share of the frame's own width or height, nought to one. Ignored for
   * every other shape.
   */
  points: number[] | null
  /**
   * Desktop: how much louder than the chapter's standard this line is set, as a
   * multiple of it. Null is "as the original was lettered": the source's
   * characters measured against the chapter's usual ones (`emphasisOf` in
   * `app/utils/emphasis.ts`). 1 is no emphasis, whatever the original did. Only
   * a line held to a standard has anything to multiply.
   */
  emphasis: number | null
}

/**
 * What the lines of a balloon are wrapped into.
 *
 * Professional lettering is not set in a rectangle: a round balloon wants its
 * lines short, long, long, short, and the room measured inside it
 * (`Block.room`) is the *upright rectangle* in that balloon, whose top and
 * bottom corners are the first place a full-width line looks wrong.
 *
 * - `box` — the frame as it is. What every block was set in before this.
 * - `soft` — a wide ellipse clipped to the frame: full width through the
 *   middle, the corners rounded off. The default for a balloon, because it
 *   gives the lozenge without giving up much room.
 * - `oval` — the ellipse inscribed in the frame, for a frame drawn around the
 *   balloon itself rather than inside it.
 * - `diamond` — the lozenge outright, for a small or spiky balloon.
 * - `custom` — `points`, drawn by the letterer.
 */
export type LetterShape = 'box' | 'soft' | 'oval' | 'diamond' | 'custom'

export const LETTER_SHAPES: LetterShape[] = ['box', 'soft', 'oval', 'diamond', 'custom']

/**
 * What a line is set as until somebody says otherwise.
 *
 * Centred because that is what comic lettering is: a balloon is a shape drawn
 * around centred type. Regular weight: dialogue used to default to bold, on the
 * argument that it holds up against the art, and the reader asked for it not to
 * — the dialogue face is already heavy, and a bold a letterer did not choose is
 * one they have to turn off balloon by balloon. Sound effects are the exception
 * and are bold by default — see `letteringFor`. Size, line and face are left to
 * be worked out, since the right answer is a property of the balloon and of
 * what the block is, rather than a taste.
 */
export const LETTERING: Lettering = {
  font: null,
  size: null,
  line: null,
  spacing: 0,
  stroke: 0,
  bold: false,
  italic: false,
  underline: false,
  align: 'center',
  anchor: 'middle',
  vertical: null,
  color: null,
  outline: null,
  shape: null,
  points: null,
  emphasis: null,
}

/**
 * The two colours lettering is set in when nobody has chosen one.
 *
 * Not black and white. `#171717` is `neutral-900`, which is what every line on
 * the page was already being set in before any of this existed — matching it to
 * the digit means switching the automatic choice on changes nothing whatever
 * about a page that was already right, and the only balloons that move are the
 * ones that were wrong. Pure black is also a harder edge than printed ink ever
 * is, and next to a scan's own near-black it reads as a sticker.
 *
 * Two and not a spectrum, deliberately. Comic lettering is ink on paper or
 * paper on ink; a mid-grey chosen to "match" a mid-grey balloon is the one
 * answer that is unreadable against it. Anything else is the letterer's own
 * choice, which is what `color` is for.
 */
export const INK_DARK = '#171717'
export const INK_LIGHT = '#ffffff'

/** A colour off the page, in the channels a canvas hands them back in. */
export interface Paper {
  r: number
  g: number
  b: number
}

/**
 * How a line is actually coloured, once everything has had its say.
 *
 * `Inking` rather than `Ink`, which is taken: `ocr/mask` already exports one for
 * the thresholded lettering a repair is cut around, and both are auto-imported.
 */
export interface Inking {
  fill: string
  outline: string
}

/** One sRGB channel undone back to the light it stands for. */
function linear (v: number): number {
  const c = v / 255

  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * WCAG relative luminance — the green channel counting for seven times what
 * the blue one does, because that is roughly what the eye does.
 *
 * The plain average of the channels was tried first and is wrong in the case
 * this feature exists for: a saturated blue balloon averages light and looks
 * dark, so black lettering went onto it and could not be read.
 */
export function luminanceOf (paper: Paper): number {
  return 0.2126 * linear(paper.r) + 0.7152 * linear(paper.g) + 0.0722 * linear(paper.b)
}

/** How far apart two luminances are, one to twenty-one — WCAG's own ratio. */
export const contrastOf = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * Which of the two inks stands out against what is behind it.
 *
 * Whichever contrasts *more*, rather than a threshold on the paper's lightness.
 * They come to the same answer at the ends and differ in the middle, where a
 * threshold has to pick a number and defend it; asking which is further away
 * needs no number and is right by construction.
 *
 * Nothing sampled means the dark ink, which is both what the page did before
 * this existed and the honest guess: comics are printed on paper.
 */
export function inkOn (paper: Paper | null): string {
  if (!paper) return INK_DARK

  const under = luminanceOf(paper)
  const dark = contrastOf(luminanceOf(toPaper(INK_DARK)), under)
  const light = contrastOf(luminanceOf(toPaper(INK_LIGHT)), under)

  return light > dark ? INK_LIGHT : INK_DARK
}

/** The other one, for an outline: a halo is only ever the reverse of its letter. */
export const reverseOf = (ink: string) =>
  (luminanceOf(toPaper(ink)) > 0.5 ? INK_DARK : INK_LIGHT)

const toPaper = (hex: string): Paper => {
  const [r, g, b] = rgbOf(hex)

  return { r, g, b }
}

/**
 * What a line is actually coloured, the reader's choice over the page's.
 *
 * `paper` is what was found under the block — see `usePaper` — and null before
 * anything has looked, which every caller has to be able to draw with: the
 * sampling is a canvas read and the first frame happens before it.
 */
export function inking (style: Lettering, paper: Paper | null): Inking {
  const fill = style.color ?? inkOn(paper)

  return { fill, outline: style.outline ?? reverseOf(fill) }
}

/** A colour as a reader should see it named — six digits, no hash to trip on. */
export const showColour = (v: string | null) => (v === null ? 'Auto' : v.replace('#', '').toUpperCase())

/**
 * How far each slider goes, and how finely, on a page `RANGE_WIDTH` wide — the
 * base `letteringRange` scales up from. Ask that for a real page.
 */
export const LETTERING_RANGE = {
  size: { min: 10, max: 70, step: 1 },
  line: { min: 0.8, max: 2.2, step: 0.05 },
  spacing: { min: -10, max: 10, step: 0.1 },
  stroke: { min: 0, max: 8, step: 0.1 },
} as const

/** The page width `LETTERING_RANGE` was drawn for, in scan pixels. */
export const RANGE_WIDTH = 1000

export type LetteringRange = { [K in keyof typeof LETTERING_RANGE]: { min: number, max: number, step: number } }

/**
 * How far each slider goes on a page this wide.
 *
 * Size, spacing and stroke are scan pixels, and a scan is whatever size it
 * happened to be scanned at, so a fixed range is a different range on every
 * chapter. It was fixed — 70 at most — and on 3732-pixel pages that was about
 * a fifth of what a balloon holds: the slider stopped short, and so did every
 * Fit and every automatic size, which are clamped to the same range. So the
 * ceilings grow with the page, and never shrink below the base: a small scan
 * keeps the room it always had. The floors stay put — small type on a big page
 * is still type somebody may want — and line height is a ratio, so it has no
 * reason to move.
 */
export function letteringRange (width?: number): LetteringRange {
  const k = Math.max(1, (width ?? 0) / RANGE_WIDTH)
  const { size, line, spacing, stroke } = LETTERING_RANGE

  return {
    size: { ...size, max: Math.round(size.max * k) },
    line,
    spacing: { ...spacing, min: Math.round(spacing.min * k), max: Math.round(spacing.max * k) },
    stroke: { ...stroke, max: Math.round(stroke.max * k) },
  }
}

/** The line height a face is set at when nobody has chosen one. */
export const AUTO_LINE = 1.15

/**
 * The defaults for one kind of block.
 *
 * A sound effect is the one kind set bold unless told otherwise: it is display
 * lettering drawn into the art, not a line of dialogue, and the SFX layer has
 * always been set that way. Everything on the Dialogue layer — balloons,
 * captions, anything that is not `sfx` — takes `LETTERING` as it is. The kind is
 * a plain string here because `BlockType` belongs to the app, which `shared/`
 * does not import.
 */
export const letteringFor = (type?: string): Lettering => (type === 'sfx' ? { ...LETTERING, bold: true } : LETTERING)

/**
 * A block's own settings over its kind's defaults — what everything downstream
 * reads. A block that has never had a setting touched stores none, so changing
 * a default here changes every such block, which is the point.
 */
export const letteringOf = (style?: Partial<Lettering> | null, type?: string): Lettering => ({ ...letteringFor(type), ...style })

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

/**
 * Whether a run of text was set down the page rather than across it.
 *
 * Two signals. The script, because only CJK is set vertically in the first
 * place — a tall narrow balloon of English is a narrow balloon, not a vertical
 * one. And the balloon's shape, but only to rule the vertical *out*.
 *
 * That asymmetry is the whole of it, and getting it the other way round is what
 * this first did wrong. `inReadingOrder` in `shared/utils/ocr` asks whether a
 * *paragraph* is a column, and a single column is emphatically taller than it is
 * wide — a margin of 1.3 is easy for it to clear. A balloon holding three of
 * those columns is not: it is nearly square, and demanding the same margin of it
 * called half a manga page horizontal. Japanese comic lettering is vertical by
 * default and horizontal by exception, so the shape only gets to veto — a box
 * plainly wider than it is tall, which is a caption strip rather than a balloon.
 * Anything else the letterer flips with the H button, which is what it is for.
 *
 * Worked out rather than stored. The detector knows this at the moment it reads
 * a page and throws it away, and the honest choice was between plumbing it
 * through a table column or deriving it from what a block already carries.
 * Derived means a page read today and the same page loaded back tomorrow answer
 * identically, which the stored version would only manage until the first
 * migration.
 *
 * `box` is in the scan's own pixels, like everything else here — the block's
 * percentages are shares of two different axes and cannot be compared.
 */
export function readsVertical (text: string, box: { w: number, h: number }): boolean {
  const words = text.trim()

  if (!words || box.w <= 0 || box.h <= 0) return false

  const wide = (words.match(WIDE) ?? []).length

  // A quarter, matching `tidyText`: a Japanese balloon with a stray latin "OK"
  // in it is still a Japanese balloon.
  if (wide < Math.max(1, Math.floor(words.length / 4))) return false

  return box.h > box.w * WIDE_BOX
}

/**
 * How much wider than tall a balloon has to be before it reads as a horizontal
 * strip rather than a column of columns. Well under one, because the veto is
 * meant to catch caption bars and nothing else.
 */
const WIDE_BOX = 0.8

/**
 * Which way a line is actually set, once everything has had its say.
 *
 * The reader's choice first, where they have made one. Then the translation: a
 * line that has been carried over is set in the target's own direction, and
 * every language this app translates into is written across the page — so the
 * moment a balloon is translated it turns, which is exactly the shape of the
 * work. A vertical target would be handled here and nowhere else.
 *
 * And failing both, the way the source reads. That is what puts a vertical
 * Japanese balloon on screen vertically while it is still Japanese.
 */
export function verticalOf (
  style: Lettering,
  block: { source: string, translation: string },
  box: { w: number, h: number },
): boolean {
  if (style.vertical !== null) return style.vertical
  if (block.translation.trim()) return false

  return readsVertical(block.source, box)
}

/**
 * How lettering is set — every rule that decides where the glyphs land, in one
 * place.
 *
 * Exported because the measurement and the render have to agree *exactly*: a
 * probe that sets on different rules from the page measures a different block
 * of text, and the size it comes back with is right for a layout nobody sees.
 * Anything that changes a glyph's advance belongs here rather than beside one
 * of the two `writingMode`s, which is how the pair drifted before.
 *
 * `pre-wrap` rather than the browser's default, because a letterer breaks their
 * own lines — where a balloon's line ends is a choice about the drawing, not
 * something to be left to the width of the box.
 *
 * `upright` is about the vertical case and does nothing to the horizontal one,
 * which is why it can live here. Vertical text defaults to `mixed`, and mixed
 * means "turn anything that is not CJK on its side" — so a balloon reading
 * 「20代で」 came out with the 20 lying on its back, and every `!?` with it. In
 * Japanese setting a number in a column stands up, digit above digit, and that
 * is what a reader checking a reading against the page needs to see. It costs
 * the other direction nothing worth having: English set down a balloon stacks
 * letter over letter, which is how a Western balloon does it anyway.
 *
 * **No emergency breaks.** `word-break` was `break-word`, which lets the browser
 * split a word anywhere, with no hyphen, when it will not fit its line — and
 * the fit, which only asks whether the ink stays inside the frame, took that as
 * fitting. A shaped balloon's narrow first line made it routine: "CUSTOME / R".
 * With it off, a word that will not go on a line moves to the next, where a
 * shape is wider, or it overflows — which the fit sees and answers the way a
 * letterer would, by hyphenating properly (`HYPHENATE`), tightening, or setting
 * smaller. A line that still will not go is flagged, not mangled. CJK and Thai
 * are unaffected: they break between characters or dictionary words as normal.
 */
export const LETTERING_WRAP = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'normal',
  overflowWrap: 'normal',
  textOrientation: 'upright',
} as const

/**
 * Every character that is set full width: kana, kanji, and the CJK punctuation
 * and forms that go with them.
 *
 * Written as escapes rather than as the characters themselves. The first of them
 * is an ideographic space, which is invisible in a source file and reads as a
 * stray blank to anyone maintaining this.
 */
const WIDE = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g

/**
 * How wide a glyph is against its own height, for the script it is in.
 *
 * The number that made the first version of this wrong. Latin type averages
 * about half its size in advance width; kana and kanji are *full* width, square
 * by design — so a line of Japanese holds half as many characters as the same
 * measure of English, and a guess written against Latin sets it at half again
 * too large. On this app's own material that is not an edge case, it is the
 * common one.
 */
function advance (text: string): number {
  const chars = text.trim()
  const wide = (chars.match(WIDE) ?? []).length

  return 0.5 + 0.5 * (wide / Math.max(1, chars.length))
}

/**
 * A size that ought to fit, reckoned from the room and the number of characters
 * rather than measured.
 *
 * A line of n characters at size s is about n × a × s long, so it takes
 * n × a × s ÷ w lines to lay out, and each line is `line` × s tall. Setting that
 * against the height and solving for s is what is below.
 *
 * This is a guess and is meant to be: it costs nothing and it is what the first
 * frame draws with, before anything has been measured. `fitSize` measures the
 * real thing, and everything settled is measured — see `useLetteringFit`.
 */
export function estimateSize (
  text: string,
  box: { w: number, h: number },
  line = AUTO_LINE,
  range: { min: number, max: number } = LETTERING_RANGE.size,
): number {
  const chars = Math.max(1, text.trim().length)

  if (box.w <= 0 || box.h <= 0) return range.min

  const size = Math.sqrt((box.w * box.h) / (chars * advance(text) * line))

  return clamp(Math.round(size), range.min, range.max)
}

/* ---------- fitting: the standard size and how far it may give ---------- */

/**
 * How a block's lettering was fitted — what the board and the export set it
 * with, and what the panels report.
 *
 * A size used to be the whole answer. Fitting the way a letterer does — the
 * chapter's standard size first, then hyphenating, then setting a hair
 * tighter, then shrinking a little, and saying so when none of that is enough
 * — has more to hand on than a number, and every step of it changes the layout,
 * so the render has to be told which steps were taken or it sets a different
 * block of text from the one that was measured.
 */
export interface LetterFit {
  /** Type size in scan pixels. */
  size: number
  /**
   * How far a shaped block's first line is pushed along the block axis, as a
   * percentage of the frame's block size — what centres the words in a shape,
   * where the flex centring a plain box uses cannot reach. See `shapeFloats`.
   */
  pad?: number
  /** Hyphenated where a word would not otherwise go. */
  hyphens?: boolean
  /** Set a hair tighter — see `TIGHT_LINE` and `TIGHT_SPACING`. */
  tight?: boolean
  /** Does not fit even at the floor: set at it, clipped, and flagged. */
  over?: boolean
  /** Desktop: broken by hand, and no size in range kept those breaks — wrapped again. See `keepsBreaks`. */
  rewrapped?: boolean
}

/**
 * How far below the chapter's standard size a line may be squeezed before it
 * is flagged instead — professional letterers give a tight balloon ten or
 * fifteen percent, and past that the answer is fewer words, not smaller ones.
 */
export const SQUEEZE_FLOOR = 0.85

/** How much tighter the line height is set when tightening, as a multiple of the size. */
export const TIGHT_LINE = 0.1

/** How much tighter the letter spacing is set when tightening, as a share of the size. */
export const TIGHT_SPACING = 0.03

/** The line height and spacing a fit sets with, tightened or not. Scan pixels. */
export function squeezed (line: number, spacing: number, size: number, tight?: boolean) {
  return tight
    ? { line: Math.max(0.8, line - TIGHT_LINE), spacing: spacing - size * TIGHT_SPACING }
    : { line, spacing }
}

/**
 * Whether a block is fitted to the chapter's standard size at all. Sound
 * effects never are: they are display lettering drawn to the art, and their
 * size is the drawing's, not the book's.
 */
export const standardApplies = (type?: string) => type !== 'sfx'

/* ---------- shapes ---------- */

/** A point in a frame, as shares of its width and height, nought to one. */
export interface FramePoint { x: number, y: number }

/**
 * How far past the frame the `soft` ellipse's radii reach, as a share of the
 * frame's own half-width and half-height. At one it is the inscribed `oval`;
 * at √2 it passes through the corners and clips to nothing but the box. 1.25
 * rounds off roughly the outer third of each top and bottom line.
 */
const SOFT = 1.25

/** How many points an ellipse is drawn with. */
const ROUND = 36

/** Whether `points` is a polygon worth wrapping into. */
export const validPoints = (points: number[] | null | undefined): points is number[] =>
  Array.isArray(points) && points.length >= 6 && points.length % 2 === 0 && points.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)

/**
 * Which shape a block is actually wrapped into.
 *
 * Only a translation is shaped. Until then the plate shows what was *read*, in
 * the box it was read from, and a lozenge around the source would be a shape
 * nobody chose for words that are about to be replaced.
 *
 * Desktop: a line set in a round room — the balloon's own oval, not a rectangle
 * inside it (`ovalIn` in `balloon.ts`) — wraps into that oval unless somebody
 * chose a shape. Not where a letterer gave the line a frame of its own
 * (`letter`): that frame is not the balloon, and its shape is theirs to choose.
 */
export function shapeFor (
  style: Pick<Lettering, 'shape' | 'points'>,
  block: { type?: string, translation: string, room?: { round?: boolean } | null, letter?: unknown },
): LetterShape {
  if (!block.translation.trim()) return 'box'
  if (style.shape === 'custom') return validPoints(style.points) ? 'custom' : 'box'
  if (style.shape) return style.shape
  if (block.room?.round && !block.letter) return 'oval'

  return block.type === 'bubble' ? 'soft' : 'box'
}

function ellipse (radius: number): FramePoint[] {
  return Array.from({ length: ROUND }, (_, i) => {
    const t = (i / ROUND) * Math.PI * 2

    return {
      x: Math.min(1, Math.max(0, 0.5 + 0.5 * radius * Math.cos(t))),
      y: Math.min(1, Math.max(0, 0.5 + 0.5 * radius * Math.sin(t))),
    }
  })
}

/** A shape as a polygon in its frame, or null for the plain box. */
export function shapeOutline (shape: LetterShape, points?: number[] | null): FramePoint[] | null {
  switch (shape) {
    case 'box': return null
    case 'oval': return ellipse(1)
    case 'soft': return ellipse(SOFT)
    case 'diamond': return [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }]
    case 'custom': {
      if (!validPoints(points)) return null

      const out: FramePoint[] = []

      for (let i = 0; i < points.length; i += 2) out.push({ x: points[i]!, y: points[i + 1]! })

      return out
    }
  }
}

/** The points a custom shape starts from when it is first chosen: whatever was showing, as a polygon. */
export function customFrom (shape: LetterShape, points?: number[] | null): number[] {
  const outline = shapeOutline(shape === 'custom' ? 'custom' : shape, points)
    ?? [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  // An ellipse has more points than anybody wants to drag; every third is plenty.
  const kept = outline.length > 12 ? outline.filter((_, i) => i % 3 === 0) : outline

  return kept.flatMap((p) => [round(p.x), round(p.y)])
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** How finely a shape is sampled across the lines — enough that no line misses an edge by much. */
const BANDS = 48

/**
 * Where the shape is at each of `BANDS + 1` stations along the block axis: the
 * span it covers across the line, as shares of the frame, or null where it
 * covers nothing. Horizontal text reads rows (y stations, x spans); vertical
 * text reads columns (x stations, y spans).
 */
export function shapeSpans (outline: FramePoint[], down: boolean): ([number, number] | null)[] {
  const along = (p: FramePoint) => (down ? p.x : p.y)
  const across = (p: FramePoint) => (down ? p.y : p.x)

  return Array.from({ length: BANDS + 1 }, (_, i) => {
    const at = i / BANDS
    let low = Infinity
    let high = -Infinity

    for (let j = 0; j < outline.length; j++) {
      const a = outline[j]!
      const b = outline[(j + 1) % outline.length]!
      const from = along(a)
      const to = along(b)

      if ((at < Math.min(from, to)) || (at > Math.max(from, to))) continue

      const hits = from === to ? [across(a), across(b)] : [across(a) + ((at - from) / (to - from)) * (across(b) - across(a))]

      for (const hit of hits) {
        low = Math.min(low, hit)
        high = Math.max(high, hit)
      }
    }

    return low <= high ? [low, high] : null
  })
}

const pct = (v: number) => `${round(Math.min(1, Math.max(0, v)) * 100)}%`

/**
 * The two exclusions that wrap a block's lines into a shape — `shape-outside`
 * polygons for a float at each end of the lines, each a half of the frame.
 *
 * Floats because nothing else in CSS will do it: `shape-inside`, which is what
 * this wants to be, was never shipped. A float at each end of the line whose
 * outline follows the shape's edge leaves exactly the shape for the words, and
 * the browser still does all of the line breaking — hyphenation, CJK rules,
 * Thai word boundaries — which a hand-rolled breaker would have to get right
 * for every language this app translates into.
 *
 * Logical throughout (`inline-start`, `block-size`), so one pair serves both
 * writing modes; only the polygons are physical, because `shape-outside` is.
 * Returned as the CSS `polygon()` for the start float (left, or top when set
 * down the page) and the end one.
 */
export function shapeFloats (outline: FramePoint[], down: boolean): { start: string, end: string } {
  const spans = shapeSpans(outline, down)
  const stations = spans.map((span, i) => ({ at: i / BANDS, low: span?.[0] ?? 0.5, high: span?.[1] ?? 0.5 }))

  if (!down) {
    // Each float is the left or right half of the frame, full height.
    const start = ['0% 0%', ...stations.map((s) => `${pct(2 * s.low)} ${pct(s.at)}`), '0% 100%']
    const end = ['100% 0%', ...stations.map((s) => `${pct(2 * s.high - 1)} ${pct(s.at)}`), '100% 100%']

    return { start: `polygon(${start.join(', ')})`, end: `polygon(${end.join(', ')})` }
  }

  // Set down the page: each float is the top or bottom half, full width, and
  // the stations run across it.
  const back = [...stations].reverse()
  const start = ['0% 0%', '100% 0%', ...back.map((s) => `${pct(s.at)} ${pct(2 * s.low)}`)]
  const end = ['0% 100%', '100% 100%', ...back.map((s) => `${pct(s.at)} ${pct(2 * s.high - 1)}`)]

  return { start: `polygon(${start.join(', ')})`, end: `polygon(${end.join(', ')})` }
}
