/**
 * A block's lettering as CSS — where it sits and how it is set — for a page of
 * a given size drawn at a given scale.
 *
 * The board computed all of this inline, against the page on screen and the
 * room it was drawn in. Exporting pages needs the same answer for any page at
 * the scan's own resolution, and a second copy of this arithmetic is exactly
 * the thing this codebase keeps having to fix: the probe that measured a
 * different layout from the one drawn (`app/utils/lettering.ts` says so at the
 * top) was that mistake once already. So it lives here, and the board and the
 * exporter both call it; the board keeps only its own guards — nothing drawn
 * before the page is measured, the line is fitted and its face has loaded.
 *
 * Everything is in terms of `unit`, what one scan pixel is worth where the
 * lettering lands: on screen, the fitted height over the page's height; in an
 * export, 1.
 */
import type { FramePoint, Inking, LetterFit, Lettering } from '#shared/utils/lettering'
import type { CSSProperties } from 'vue'
import type { LetterBox } from '~/composables/useComic'

import { faceOf, fontStack } from '#shared/utils/fonts'
import { AUTO_LINE, LETTERING_WRAP, shapeFloats, squeezed } from '#shared/utils/lettering'
import { cssTransform, isDistorted, toOriented } from '#shared/utils/transform'

/**
 * How much larger a distorted box is laid out than it is drawn.
 *
 * A projective transform cannot be re-rasterised at its finished size the way a
 * rotation can: the browser draws the element at its layout size and maps that
 * bitmap onto the quad. Where the map magnifies — which it does over most of a
 * quad that has been pulled about — the lettering is an upsampled bitmap and
 * reads like one, soft and smeared. Laying the box out three times over and
 * scaling it back down means the raster happens at nine times the pixels and is
 * shrunk into place rather than stretched out of it.
 *
 * Only distorted boxes pay for it, and a page seldom has many.
 */
export const SUPER = 3

/** The page lettering is laid out on, and what a scan pixel is worth on it. */
export interface LetterSpace {
  /** The page's own size, in scan pixels — `pageSize`. */
  page: { width: number, height: number }
  unit: number
}

/** A frame as the transform arithmetic wants it, or nothing on an unmeasured page. */
export function orientedIn (frame: LetterBox, space: LetterSpace) {
  const { width, height } = space.page

  return width && height ? toOriented(frame, space.page) : null
}

/** Whether a frame has had its corners pulled about — see `SUPER`. */
export function bentIn (frame: LetterBox, space: LetterSpace): boolean {
  const box = orientedIn(frame, space)

  return !!box && isDistorted(box)
}

/** `SUPER` for a distorted frame, 1 for any other. */
export const superIn = (frame: LetterBox, space: LetterSpace) => (bentIn(frame, space) ? SUPER : 1)

/** A box in the page's pixels at this scale, which is what a homography needs. */
export function pixelsIn (box: { w: number, h: number }, space: LetterSpace) {
  return {
    w: (box.w / 100) * space.page.width * space.unit,
    h: (box.h / 100) * space.page.height * space.unit,
  }
}

/**
 * A box placed on the page: percentages, turned and bent about its own centre.
 *
 * About its own centre, which is the default origin and the one every piece of
 * arithmetic in `shared/utils/transform` assumes. The distortion needs the
 * element's real pixel size, because a homography is not scale-free the way a
 * rotation is: it has to know how big the thing it is bending *is*.
 */
export function boxPlaced (box: LetterBox, space: LetterSpace): CSSProperties {
  const oriented = orientedIn(box, space)
  const bent = oriented ? cssTransform(oriented, { ...pixelsIn(box, space), unit: space.unit }) : ''

  return {
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: `${box.w}%`,
    height: `${box.h}%`,
    ...(bent ? { transform: bent } : {}),
  }
}

/**
 * The same, for the things made of *words*.
 *
 * A distorted one is laid out in pixels rather than percentages, because it has
 * to be laid out larger than it is drawn — see `SUPER` — and a percentage cannot
 * say that. Undistorted, this is `boxPlaced` and nothing else.
 */
export function letterPlaced (frame: LetterBox, space: LetterSpace): CSSProperties {
  const box = orientedIn(frame, space)

  if (!box || !isDistorted(box)) return boxPlaced(frame, space)

  const k = SUPER
  const size = pixelsIn(frame, space)
  const w = size.w * k
  const h = size.h * k

  return {
    left: `${box.cx * space.unit - w / 2}px`,
    top: `${box.cy * space.unit - h / 2}px`,
    width: `${w}px`,
    height: `${h}px`,
    // Shrink it back to size, then turn and lean it, then carry its corners
    // wherever they have been dragged. The corner offsets are measured in the
    // scan's own pixels, so inside an element laid out `k` times over they are
    // worth `k` times as many.
    transform: `scale(${1 / k}) ${cssTransform(box, { w, h, unit: space.unit * k })}`.trim(),
  }
}

/** What a line is set with — everything `letterSet` needs and nothing it has to look up. */
export interface LetterSetting {
  style: Lettering
  /** The block's kind, which picks the face where nobody has — see `faceOf`. */
  type: string
  /** The fitted (or chosen) size, in scan pixels. */
  size: number
  /** Whether it is set down the page — `setDown`. */
  down: boolean
  /** Ink and halo — `inkOf`. */
  ink: Inking
  /**
   * The squeeze the fit settled on — hyphenated, tightened — which the render
   * has to repeat exactly or it sets a different block of text from the one
   * that was measured. See `LetterFit`.
   */
  fit?: Pick<LetterFit, 'hyphens' | 'tight'>
}

/**
 * How a line is set, in the units the page is drawn at.
 *
 * The two placement controls have to swap the CSS they are carried by when the
 * writing mode turns. `text-align` works along the *inline* axis and
 * `align-items` across it, and a vertical writing mode swaps which of those is
 * which: set down the page, the inline axis runs top to bottom and the block
 * axis right to left. So the mapping turns with the text and the labels stay
 * literally true: the anchor puts the words at the top, middle or bottom of the
 * balloon in both modes, and the alignment puts them left, centre or right in
 * both. Only `justify` has nowhere to go when the text is vertical — it is an
 * inline-axis idea, and there the inline axis is the one the anchor is using —
 * so it reads as centred rather than pretending to do something.
 *
 * `per` is what a scan pixel is worth *on this element*: `unit`, times `SUPER`
 * for a distorted frame, which is laid out several times over and scaled back
 * down, so every length on it has to be multiplied by the same factor or it
 * arrives divided by it.
 */
export function letterSet ({ style, type, size, down, ink, fit }: LetterSetting, per: number): CSSProperties {
  const { line, spacing } = squeezed(style.line ?? AUTO_LINE, style.spacing, size, fit?.tight)

  /** Top, middle, bottom of the balloon — whichever axis that currently is. */
  const anchor = style.anchor === 'top' ? 'start' : style.anchor === 'bottom' ? 'end' : 'center'

  /** Left, centre, right of the balloon, likewise. `vertical-rl` runs right to
   *  left, so its block-start edge is the right-hand one. */
  const across = style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center'
  const acrossFlex = down
    ? (across === 'right' ? 'flex-start' : across === 'left' ? 'flex-end' : 'center')
    : 'center'

  return {
    ...LETTERING_WRAP,
    // The block's own kind decides where nobody has chosen, which is what sets
    // a sound effect in the display face without anyone asking — see `faceOf`.
    fontFamily: fontStack(faceOf(style.font, type)),
    fontSize: `${size * per}px`,
    // Unitless, so it scales itself off the size and needs no factor of its own.
    lineHeight: String(line),
    letterSpacing: `${spacing * per}px`,
    ...(fit?.hyphens ? HYPHENATE : {}),
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: style.underline ? 'underline' : 'none',
    textAlign: down ? anchor : style.align,
    alignItems: down
      ? acrossFlex
      : (style.anchor === 'top' ? 'flex-start' : style.anchor === 'bottom' ? 'flex-end' : 'center'),
    justifyContent: 'center',
    // Right to left down the page, which is how Japanese balloons are set and
    // therefore how they have to be read back while they are still Japanese.
    writingMode: down ? 'vertical-rl' : 'horizontal-tb',
    // On the box rather than the span, so the span can override it for the
    // standing-in state and inherit it for every real line — see the plates.
    color: ink.fill,
    // Painted outward from the glyph rather than through it, so an outline
    // thickens the letter instead of eating it from the inside.
    paintOrder: 'stroke fill',
    WebkitTextStrokeWidth: `${style.stroke * per}px`,
    WebkitTextStrokeColor: ink.outline,
  }
}

/**
 * The line box inside a lettering frame: the axis it is *written* on filled,
 * and only the room it needs across it.
 *
 * `inline-size` rather than `width`, which is the whole point: it is the width
 * of horizontal text and the height of vertical text, so one declaration is
 * right in both.
 */
export const LINE_BOX = { inlineSize: '100%' } as const

/**
 * Hyphenation, when a fit asks for it — never otherwise.
 *
 * `auto` needs the element's `lang`, which the board and the export both set to
 * the language being lettered; without one the browser has no dictionary and
 * this does nothing. `hyphenate-limit-chars` keeps it to long words split
 * decently — six letters at least, three either side of the break — which is
 * the professional rule a CSS default does not know.
 */
export const HYPHENATE = {
  hyphens: 'auto',
  hyphenateLimitChars: '6 3 3',
  WebkitHyphens: 'auto',
} as const

/**
 * The markup a shaped block is set in: the lines' container, the two floats
 * whose outlines carve the shape, and the spacer that centres the words in it.
 *
 * The container fills the frame, because the floats are sized against it; the
 * frame's flex centring is therefore no help, and the fit works out how far to
 * push the first line instead (`LetterFit.pad`). The spacer is an empty block
 * *after* the floats, which is the trick: floats that come first sit at the
 * frame's top, and a block does not flow around them, so the spacer pushes the
 * lines down without taking the shape down with it.
 *
 * Percentages throughout, so it is the same at every scale — including inside a
 * distorted frame laid out `SUPER` times over.
 */
export interface ShapeParts {
  container: CSSProperties
  start: CSSProperties
  end: CSSProperties
  spacer: CSSProperties
}

export function shapeParts (outline: FramePoint[], down: boolean, pad: number): ShapeParts {
  const { start, end } = shapeFloats(outline, down)
  const float = { inlineSize: '50%', blockSize: '100%' }

  return {
    container: { display: 'block', inlineSize: '100%', blockSize: '100%', flex: 'none' },
    start: { ...float, float: 'inline-start', shapeOutside: start },
    end: { ...float, float: 'inline-end', shapeOutside: end },
    spacer: { display: 'block', blockSize: `${Math.max(0, pad)}%` },
  }
}
