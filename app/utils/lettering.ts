/**
 * Fitting type to the balloon it has to live in — measured, not reckoned.
 *
 * `estimateSize` in `shared/utils/lettering` guesses from the character count,
 * which is right often enough to draw the first frame with and never right
 * enough to letter with. The real answer means laying the words out and looking
 * at where they ended up, which only the browser can do — which is why this half
 * lives on the client.
 *
 * Two things here were got wrong first time round and are worth naming, because
 * both are the same mistake:
 *
 * - The probe was a plain block while the page sets its lettering in a flex box
 *   with a span inside. Those two report overflow differently, so the probe was
 *   measuring a layout that appears nowhere.
 * - Overflow was read off `scrollHeight`, which counts line *boxes*. Japanese
 *   glyphs are taller than a 1.15 line box, so the ink stood proud of the
 *   balloon while the arithmetic said it fitted.
 *
 * So the probe is now built exactly as the page builds it, and what is measured
 * is where the glyphs actually landed — the same thing the eye is judging.
 */
import type { FramePoint, LetterFit, TextAnchor } from '#shared/utils/lettering'

// By hand, so a dev server already running picks up exports it has not seen.
import { AUTO_LINE, LETTERING_WRAP, SQUEEZE_FLOOR, squeezed } from '#shared/utils/lettering'
import { HYPHENATE, shapeParts } from '~/utils/letterCss'

/** The probe, made once: a node appended and dropped per press would thrash. */
let probe: Probe | null = null

interface Probe {
  box: HTMLElement
  /** The plain line, for a block set in its box. */
  line: HTMLElement
  /** The shaped container and its parts, for a block wrapped into a shape — see `shapeParts`. */
  shaped: { container: HTMLElement, start: HTMLElement, end: HTMLElement, spacer: HTMLElement, text: Text }
}

/**
 * A copy of what the canvas draws — see `setStyle` in the board, which this has
 * to keep step with. Out of the document's way but still laid out, because a
 * node that is not laid out has no geometry to read and would measure as fitting
 * at any size at all; `visibility` rather than `display` for exactly that.
 *
 * Two bodies, swapped in as the block needs: the plain line a box has always
 * been set in, and the shaped container — floats, spacer, words — a shape is.
 * The box itself is the same for both, which is the frame the board draws.
 */
function borrowProbe (): Probe {
  if (probe) return probe

  const box = document.createElement('div')
  const line = document.createElement('span')

  Object.assign(box.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: '0',
    // The same rules the page sets by, or this measures a different wrap.
    ...LETTERING_WRAP,
  })
  box.setAttribute('aria-hidden', 'true')
  // `inline-size`, not `width` — see `LINE_BOX` on the board, whose value this
  // is a copy of and has to stay one. With `width` the vertical case never wraps
  // into a second column, so the search shrinks the type until one very long
  // column fits instead of finding the size that fills the balloon.
  line.style.inlineSize = '100%'
  box.append(line)
  document.body.append(box)

  const container = document.createElement('span')
  const start = document.createElement('i')
  const end = document.createElement('i')
  const spacer = document.createElement('i')
  const text = document.createTextNode('')

  container.append(start, end, spacer, text)

  probe = { box, line, shaped: { container, start, end, spacer, text } }

  return probe
}

export interface FitInput {
  text: string
  /** The balloon, in the same units the answer comes back in — scan pixels. */
  box: { w: number, h: number }
  line?: number
  spacing?: number
  bold?: boolean
  italic?: boolean
  vertical?: boolean
  /** The face it will actually be set in, so the measurement is of that face. */
  family?: string
  /** The shape the lines wrap into, or nothing for the plain box — see `shapeOutline`. */
  shape?: FramePoint[] | null
  /** Where in the shape the words sit — the board's anchor. Only a shape needs telling. */
  anchor?: TextAnchor
  /** The language being lettered, which is what hyphenation looks words up in. */
  lang?: string
}

/**
 * Faces already asked for, so a page of thirty balloons is one request each and
 * not thirty. Module-level rather than per-composable: the browser's font set is
 * one thing, and two callers asking about the same face are the same question.
 */
const asked = new Set<string>()

/**
 * Faces whose load has finished, however it went — loaded, found nothing, or
 * refused. What the browser has by then is what the lettering will be drawn
 * in, so there is nothing left to wait for.
 *
 * This, and not `check`, is what says a face is usable, because `check` is
 * about the whole *stack*: it answers true only when every family in it that
 * has faces is loaded, fallbacks included. Loading the stack fetches the first
 * family and not the rest, so a stack whose fallback nothing else on the page
 * had pulled in — Anime Ace before Shantell Sans, on a chapter lettered all in
 * Anime Ace — never checked true, and every balloon on it stayed hidden for good.
 */
const settled = new Set<string>()

/**
 * Make sure a face is in the browser before anything is measured against it,
 * and say whether it is there yet.
 *
 * A face is only fetched when something needs it, and `fitSize` needing it is
 * not enough — the probe is hidden, and a hidden node does not always start a
 * load. Until the real face lands the browser measures the fallback, which for
 * every stack here is narrower than the comic face in front of it, so the size
 * that "fits" during the first pass overflows the balloon the moment the face
 * arrives. Big enough to see, and it was seen.
 *
 * It used to measure anyway and re-measure when the face arrived, and that was
 * the second half of the lettering jumping on every open: drawn at a guess,
 * then at a size fitted in the fallback, then at the real one. So now it
 * answers whether the face is *usable*, and `useLetteringFit` does not measure
 * — and the board does not show — a block whose face is not. `done` says when
 * to ask again. Once its load has finished the face counts as usable however it
 * went — a face that will not load at all is measured in whatever the browser
 * falls back to — so no lettering stays hidden for good.
 */
export function loadFace (family: string, bold: boolean, italic: boolean, done: () => void): boolean {
  if (!import.meta.client || !document.fonts) return true

  // A font shorthand, which is what `check` and `load` parse. The size is
  // arbitrary and the weight and slant are not: a face set is per cut, and the
  // regular being loaded says nothing about the bold.
  const face = `${italic ? 'italic ' : ''}${bold ? 700 : 400} 16px ${family}`

  // `check` only as the quick answer for a face that was already in hand — see
  // `settled` for why it cannot be the only one.
  if (settled.has(face) || document.fonts.check(face)) return true

  if (!asked.has(face)) {
    asked.add(face)

    document.fonts.load(face)
      .catch(() => [])
      .finally(() => {
        settled.add(face)
        done()
      })
  }

  return false
}

/**
 * How much room the words actually took, ink and all — where the ink is,
 * against the probe's own box.
 *
 * The union of the rectangles the browser hands back for the laid-out text,
 * rather than the height of the block holding it. A line box is as tall as the
 * line height says; the glyphs in it are as tall as the face makes them, and for
 * kana and kanji that is comfortably more. Measuring the box would say a balloon
 * fits while its lettering is plainly hanging out of the bottom of it, which is
 * the bug this replaces.
 *
 * **Words, not lines.** The rectangles are taken a run of non-space characters
 * at a time, because a line's own rectangle carries the space it wrapped at —
 * and the lettering is `pre-wrap`, under which that space *hangs* past the edge
 * of the box. It is drawn nowhere and overflows nothing, but it was measured:
 * "He's a kind person, so don't worry" in a 382 px frame came out 389 px wide at
 * 25 px and 363 px at 30, so fitting stopped believing it could grow at 25 and
 * `fitSize`'s halving search, which relies on a bigger size never fitting where
 * a smaller one did not, settled on 24 — a quarter of the balloon, set tiny.
 */
function inkOf (text: Text | null, origin: DOMRect): { left: number, top: number, right: number, bottom: number } | null {
  if (!text) return null

  let top = Infinity
  let bottom = -Infinity
  let left = Infinity
  let right = -Infinity

  const range = document.createRange()

  for (const word of text.data.matchAll(/\S+/g)) {
    range.setStart(text, word.index)
    range.setEnd(text, word.index + word[0].length)

    for (const rect of range.getClientRects()) {
      if (!rect.width && !rect.height) continue

      top = Math.min(top, rect.top)
      bottom = Math.max(bottom, rect.bottom)
      left = Math.min(left, rect.left)
      right = Math.max(right, rect.right)
    }
  }

  return top === Infinity
    ? null
    : { left: left - origin.left, top: top - origin.top, right: right - origin.left, bottom: bottom - origin.top }
}

/**
 * Desktop: how much narrower a shape is measured than it is drawn, along the
 * lines.
 *
 * A shaped fit is chosen at the very edge: the largest size whose lines all
 * land inside the shape. The board then draws the same words at screen size,
 * where type is not an exact scale of the probe's — hinting, rounded advances,
 * a polygon rounded to pixels — and a line that only just went at the narrow
 * end of an oval wraps instead, and its last word is pushed past the frame and
 * cut ("HM? OH, YEAH, IT" with the "IS." gone, 2026-10-22). Measured a few
 * percent narrow, every line drawn has that much to spare.
 */
const SHAPE_SLACK = 0.04

/** How a fit is being tried: hyphenated or not, tightened or not. */
type Squeeze = Pick<LetterFit, 'hyphens' | 'tight'>

/**
 * The probe, set up to lay `input` out in its box — everything but the size and
 * the squeeze, which `layout` sets per try.
 */
function probeFor (input: FitInput) {
  const found = borrowProbe()
  const { box, line, shaped } = found
  const outline = input.shape ?? null
  const down = Boolean(input.vertical)

  // Desktop: a shape is measured a little narrower than it is drawn — see `SHAPE_SLACK`.
  const slack = outline ? 1 - SHAPE_SLACK : 1

  Object.assign(box.style, {
    width: `${input.box.w * (down ? 1 : slack)}px`,
    height: `${input.box.h * (down ? slack : 1)}px`,
    fontWeight: input.bold ? '700' : '400',
    fontStyle: input.italic ? 'italic' : 'normal',
    fontFamily: input.family ?? 'inherit',
    writingMode: down ? 'vertical-rl' : 'horizontal-tb',
  })

  if (input.lang) box.setAttribute('lang', input.lang)
  else box.removeAttribute('lang')

  if (outline) {
    const parts = shapeParts(outline, down, 0)

    // Reset before assigning: the elements are reused across blocks, and a
    // property one shape set and the next does not would stay behind.
    for (const [element, css] of [[shaped.container, parts.container], [shaped.start, parts.start], [shaped.end, parts.end], [shaped.spacer, parts.spacer]] as const) {
      element.removeAttribute('style')
      Object.assign(element.style, css)
    }

    shaped.text.data = input.text

    if (line.parentNode) line.remove()
    if (shaped.container.parentNode !== box) box.append(shaped.container)
  } else {
    line.textContent = input.text

    if (shaped.container.parentNode) shaped.container.remove()
    if (line.parentNode !== box) box.append(line)
  }

  const text = outline ? shaped.text : (line.firstChild as Text | null)

  /** Lay the words out at one size and squeeze, the spacer at `pad` percent. */
  function layout (size: number, squeeze: Squeeze, pad = 0) {
    const set = squeezed(input.line ?? AUTO_LINE, input.spacing ?? 0, size, squeeze.tight)

    Object.assign(box.style, {
      fontSize: `${size}px`,
      lineHeight: String(set.line),
      letterSpacing: `${set.spacing}px`,
      ...(squeeze.hyphens ? HYPHENATE : { hyphens: 'manual', hyphenateLimitChars: 'auto', WebkitHyphens: 'manual' }),
    })

    if (outline) shaped.spacer.style.blockSize = `${Math.max(0, pad)}%`

    return inkOf(text, box.getBoundingClientRect())
  }

  return { layout, outline, down }
}

/**
 * Whether the words fit at one size and squeeze, and — for a shape — where the
 * first line has to start for them to sit where the anchor says.
 *
 * A plain box answers in one layout: the frame's flex centring places the lines.
 * A shape cannot be centred that way — its floats are fixed to the frame, so
 * moving the words moves them into a different width of the shape, which
 * re-wraps them, which changes how tall they are. So the spacer is walked there:
 * lay out, see how far the ink's middle is from the frame's, move by that much,
 * and again, until it stops moving. Two or three passes; four at most.
 */
function tryFit (setup: ReturnType<typeof probeFor>, input: FitInput, size: number, squeeze: Squeeze): { fits: boolean, pad?: number } {
  const { w, h } = input.box
  const fits = (ink: ReturnType<typeof inkOf>) => !!ink && ink.left >= -1 && ink.top >= -1 && ink.right <= w + 1 && ink.bottom <= h + 1

  if (!setup.outline) {
    const ink = setup.layout(size, squeeze)

    // A pixel of slack on each axis: the browser reports fractions, and a line
    // that misses by a rounding error has not overflowed the drawing.
    return { fits: !ink || (ink.right - ink.left <= w + 1 && ink.bottom - ink.top <= h + 1) }
  }

  // Along the block axis, in pixels: where the lines start (`from`) and end.
  // Set down the page the block axis runs right to left.
  const total = setup.down ? w : h
  const extent = (ink: NonNullable<ReturnType<typeof inkOf>>) => (setup.down
    ? { from: w - ink.right, to: w - ink.left }
    : { from: ink.top, to: ink.bottom })

  let pad = 0
  let ink = setup.layout(size, squeeze, 0)

  if (!ink) return { fits: true, pad: 0 }

  for (let pass = 0; pass < 4; pass++) {
    const { from, to } = extent(ink)
    const target = input.anchor === 'top' ? 0 : input.anchor === 'bottom' ? total - (to - from) : (total - (to - from)) / 2
    const move = target - from

    if (Math.abs(move) < 0.5) break

    const next = Math.max(0, pad + (move / total) * 100)

    if (Math.abs(next - pad) < 0.01) break

    pad = next
    ink = setup.layout(size, squeeze, pad)

    if (!ink) break
  }

  return { fits: fits(ink), pad: Math.round(pad * 100) / 100 }
}

/**
 * How much room the words take at one size, laid out in the box they are in —
 * the inverse question to `fitSize`, and asked by "Fit bubble to text".
 *
 * The box still matters though the answer is smaller than it: it is where the
 * lines wrap, and a frame shrunk to what they take has to wrap them at the same
 * places, or the words it was fitted to are not the words it holds. Ink, not
 * line boxes, for the reason `inkOf` gives. Scan pixels in and out.
 */
export function inkSize (input: FitInput, size: number, squeeze: Squeeze = {}): { w: number, h: number } {
  if (input.box.w <= 0 || input.box.h <= 0) return { w: 0, h: 0 }

  const ink = probeFor({ ...input, shape: null }).layout(size, squeeze)

  return ink ? { w: ink.right - ink.left, h: ink.bottom - ink.top } : { w: 0, h: 0 }
}

/**
 * The largest whole size at which the words still fit the box — the fit for a
 * block the chapter's standard size does not govern, or a chapter with none.
 *
 * A halving search rather than a walk down from the top: a size either fits or
 * it does not, and fitting is monotonic in it, so eight or nine tries settle a
 * range sixty wide. Walking would be sixty layouts for the same answer. A shape
 * is *nearly* monotonic — a bigger size can wrap into a luckier line at the
 * shape's widest — so the answer is walked a few sizes on afterwards in case the
 * search stepped over one.
 *
 * Measured in scan pixels throughout — the probe is sized to the balloon's real
 * pixels, so what comes back can be written straight into `size` without being
 * scaled by whatever the page happens to be drawn at.
 */
export function fitSize (input: FitInput, range: { min: number, max: number }): LetterFit {
  if (input.box.w <= 0 || input.box.h <= 0) return { size: range.min }

  const setup = probeFor(input)
  const at = (size: number) => tryFit(setup, input, size, {})

  const floor = at(range.min)

  if (!floor.fits) return { size: range.min, pad: floor.pad, over: true }

  let low = range.min
  let high = range.max

  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)

    if (at(mid).fits) low = mid
    else high = mid
  }

  if (at(high).fits) low = high

  for (let more = 0; setup.outline && more < 3 && low < range.max && at(low + 1).fits; more++) low++

  return { size: low, pad: at(low).pad }
}

/**
 * The fit a letterer would give it, against the chapter's standard size.
 *
 * In the order a professional works through a line that will not go: the
 * standard size as it is; hyphenated; set a hair tighter; and only then smaller,
 * a size at a time, down to `SQUEEZE_FLOOR` of the standard. A line that will
 * not go even there is set at the floor and flagged `over` — the answer at that
 * point is a shorter wording, and a balloon set in type nobody can read hides
 * the question rather than answering it.
 *
 * The standard is a ceiling as well as a target. A roomy balloon does not grow
 * its words to fill itself: every ordinary line in a book is the same size, and
 * the air around the short ones is part of how that looks.
 */
export function fitStandard (input: FitInput, standard: number, range: { min: number, max: number }): LetterFit {
  const size = Math.max(range.min, Math.min(range.max, Math.round(standard)))

  if (input.box.w <= 0 || input.box.h <= 0) return { size }

  const setup = probeFor(input)
  const ladder: Squeeze[] = [{}, { hyphens: true }, { hyphens: true, tight: true }]

  for (const squeeze of ladder) {
    const tried = tryFit(setup, input, size, squeeze)

    if (tried.fits) return { size, pad: tried.pad, ...squeeze }
  }

  const floor = Math.max(range.min, Math.round(size * SQUEEZE_FLOOR))
  const squeeze = { hyphens: true, tight: true }

  for (let smaller = size - 1; smaller >= floor; smaller--) {
    const tried = tryFit(setup, input, smaller, squeeze)

    if (tried.fits) return { size: smaller, pad: tried.pad, ...squeeze }
  }

  return { size: floor, pad: tryFit(setup, input, floor, squeeze).pad, ...squeeze, over: true }
}

/**
 * A size somebody chose, laid out as it will be drawn — for a shaped block,
 * where the words have to be walked to their place in the shape whatever the
 * size (`tryFit`), and for any block, whether it overflows.
 */
export function fitAt (input: FitInput, size: number): LetterFit {
  if (input.box.w <= 0 || input.box.h <= 0) return { size }

  const tried = tryFit(probeFor(input), input, size, {})

  return { size, pad: tried.pad, ...(tried.fits ? {} : { over: true }) }
}
