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
import { withHyphens } from '~/utils/hyphens'
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

/** Desktop: the soft hyphen `withHyphens` puts in, which shows as "-" only where a line breaks at it. */
const SHY = '­'

/** Desktop: the lines as laid out, and how they came to break. See `breaksOf`. */
export interface DrawnLines {
  /** Each line's words as drawn, a word broken at a soft hyphen ending in "-". */
  lines: string[]
  /** Line breaks the wrap made — not at a newline somebody typed. */
  wrapped: number
  /** Words broken across two lines. */
  broken: number
  /** Whether the text carries breaks somebody typed. */
  byHand: boolean
}

/**
 * Desktop: the lines as the browser laid them out — read a word at a time, as
 * `inkOf` measures, and a word that came back in two pieces walked a character
 * at a time to find where it broke.
 *
 * A word starts a new line where it sits a line lower (a column further left,
 * set down the page) than the word before. A new line with a newline between the
 * two words is a break somebody typed; any other is the wrap's. That difference
 * is what keeps a hand-broken balloon broken where its letterer said — see
 * `keep` in `tryFit` — and what a review reports (`review_lettering`).
 */
function breaksOf (text: Text | null, down: boolean, size: number): DrawnLines {
  const data = text?.data ?? ''
  const found: DrawnLines = { lines: [], wrapped: 0, broken: 0, byHand: data.includes('\n') }

  if (!text) return found

  const range = document.createRange()
  const at = (rect: DOMRect) => (down ? -rect.right : rect.top)
  const rectsOf = (start: number, end: number) => {
    range.setStart(text, start)
    range.setEnd(text, end)

    return [...range.getClientRects()].filter((rect) => rect.width || rect.height)
  }

  let line: string[] = []
  let where: number | null = null
  let after = 0

  const breakHere = (from: number, to: number) => {
    if (line.length) found.lines.push(line.join(' '))
    line = []
    if (!data.slice(from, to).includes('\n')) found.wrapped++
  }

  for (const word of data.matchAll(/\S+/g)) {
    const start = word.index
    const end = start + word[0].length
    const rects = rectsOf(start, end)

    if (!rects.length) continue

    const first = at(rects[0]!)

    if (where !== null && Math.abs(first - where) > size * 0.5) breakHere(after, start)

    if (rects.length === 1) {
      line.push(word[0].replaceAll(SHY, ''))
      where = first
    } else {
      // Broken inside: walk it to find where each piece starts.
      let piece = ''
      let pieceAt = first

      for (let index = start; index < end; index++) {
        const char = data[index]!
        const own = rectsOf(index, index + 1)

        // Its last rectangle: a character just after a break can also report an empty one at the end of the line before.
        if (own.length && Math.abs(at(own.at(-1)!) - pieceAt) > size * 0.5) {
          line.push(piece.endsWith(SHY) ? `${piece.slice(0, -1)}-` : piece)
          found.lines.push(line.join(' '))
          found.broken++
          line = []
          piece = ''
          pieceAt = at(own.at(-1)!)
        }

        piece += char
      }

      line.push(piece.replaceAll(SHY, ''))
      where = pieceAt
    }

    after = end
  }

  if (line.length) found.lines.push(line.join(' '))

  return found
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
 * cut ("HM? OH, YEAH, IT" with the "IS." gone, 2026-10-22). Measured a hair
 * narrow, every line drawn has that much to spare.
 *
 * A hair, and no more: the slack is also a difference between the probe and the
 * page. At 4% the probe wrapped lines the page did not, so its block of words
 * was taller than the one drawn, and the pad that centres them (`tryFit`) was
 * worked out for the taller block — the drawn words sat at the top of the oval
 * with a third of it empty below, and a bottom anchor pushed them out of the
 * frame altogether (2026-10-22). Rounding is under a pixel in a line; one
 * percent covers it without changing where the probe wraps.
 */
const SHAPE_SLACK = 0.01

/**
 * Desktop: how much larger breaking a long word has to make the type before a
 * fit with no standard size does it. One long word — "NEIGHBORHOOD..." in a
 * balloon set in Anime Ace — otherwise holds the whole balloon to the size that
 * word fits across at; a letterer breaks the word before shrinking the balloon,
 * but never for a pixel or two.
 */
const HYPHEN_GAIN = 1.25

/**
 * Desktop: how far from even a shaped line anchored in the middle may sit and
 * still count as fitting, as a share of the frame — and how far above the
 * middle one anchored at the bottom may. See `tryFit`.
 */
const ANCHOR_SLACK = 0.06

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

    // Desktop: the words with their breaks put in by hand when hyphenating —
    // `hyphens: auto` alone does nothing here. See `utils/hyphens`.
    const words = squeeze.hyphens ? withHyphens(input.text, input.lang) : input.text

    if (text && text.data !== words) text.data = words

    if (outline) shaped.spacer.style.blockSize = `${Math.max(0, pad)}%`

    return inkOf(text, box.getBoundingClientRect())
  }

  /** Desktop: the lines as the last `layout` set them — see `breaksOf`. */
  const breaks = (size: number) => breaksOf(text, down, size)

  return { layout, breaks, outline, down }
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
function tryFit (setup: ReturnType<typeof probeFor>, input: FitInput, size: number, squeeze: Squeeze, keep = false): { fits: boolean, pad?: number } {
  const { w, h } = input.box
  // Desktop: with `keep`, a layout that wrapped a line somebody broke by hand does not count — see `keepsBreaks`.
  const kept = () => !keep || setup.breaks(size).wrapped === 0
  const fits = (ink: ReturnType<typeof inkOf>) => !!ink && ink.left >= -1 && ink.top >= -1 && ink.right <= w + 1 && ink.bottom <= h + 1 && kept()

  if (!setup.outline) {
    const ink = setup.layout(size, squeeze)

    // A pixel of slack on each axis: the browser reports fractions, and a line
    // that misses by a rounding error has not overflowed the drawing.
    return { fits: !ink || (ink.right - ink.left <= w + 1 && ink.bottom - ink.top <= h + 1 && kept()) }
  }

  // Along the block axis, in pixels: where the lines start (`from`) and end.
  // Set down the page the block axis runs right to left.
  const total = setup.down ? w : h
  const extent = (ink: NonNullable<ReturnType<typeof inkOf>>) => (setup.down
    ? { from: w - ink.right, to: w - ink.left }
    : { from: ink.top, to: ink.bottom })

  /*
   * Desktop: where the spacer puts the words, found by search rather than by
   * nudging. The nudging was the web build's: move by however far the words
   * were from where the anchor wants them, up to four times. In a shape every
   * move re-wraps the lines — down into an oval's wide middle a line merges
   * away, further into its narrow foot one comes back — so the block's height
   * jumps as it moves, the nudges overshoot, and four of them stopped wherever
   * they were: "This photo's going to be a family heirloom...!" was set with 10
   * px above it and 110 below in a 280 px oval, its anchor "middle" (2026-10-22),
   * and a bottom anchor could be pushed out of the frame altogether.
   *
   * What does hold is that the words sit lower the larger the pad, jumps and
   * all. So the pad is halved towards the answer: for the middle, where the
   * room above stops being less than the room below — keeping whichever pad
   * measured nearest even, among those that fit; for the bottom, the largest
   * pad at which the words still fit. Seven halvings settle it to under a
   * percent of the frame.
   */
  const place = (pad: number) => {
    const ink = setup.layout(size, squeeze, pad)

    if (!ink) return null

    const { from, to } = extent(ink)

    return { pad, ink, above: from, below: total - to, fits: fits(ink) }
  }

  const first = place(0)

  if (!first) return { fits: true, pad: 0 }
  if (input.anchor === 'top') return { fits: first.fits, pad: 0 }

  let low = 0
  let high = 100
  let best = first

  /** Nearer even, and fitting before not fitting — or, for the bottom, lower and fitting. */
  const better = (one: NonNullable<ReturnType<typeof place>>) => (input.anchor === 'bottom'
    ? one.fits && (!best.fits || one.pad > best.pad)
    : (one.fits && !best.fits) || (one.fits === best.fits && Math.abs(one.above - one.below) < Math.abs(best.above - best.below)))

  for (let step = 0; step < 7; step++) {
    const mid = (low + high) / 2
    const at = place(mid)

    if (!at) break

    if (better(at)) best = at

    // Lower still to go: for the bottom while the words fit, for the middle while there is more room below than above.
    const lower = input.anchor === 'bottom' ? at.fits : at.above < at.below

    if (lower) low = mid
    else high = mid
  }

  /*
   * And a size only goes if its words sit where the anchor says. The largest
   * size that fits *somewhere* in an oval can fit in one place only — its
   * longest word across the oval's widest line, wherever that drags the rest —
   * and taking it set "This photo's going to be a family heirloom...!" at the
   * top of its balloon, anchored "middle". A letterer goes a size smaller and
   * keeps it centred; so does this, by calling such a placement not a fit.
   */
  // A bottom anchor only has to sit at the middle or lower: it sets the words as
  // low as they go, and an oval narrows to its foot — held to the foot itself,
  // "Wait, is this one of those 'car' things?" went from 32 to 17 to get there.
  const slack = total * ANCHOR_SLACK
  const placed = input.anchor === 'bottom'
    ? best.below - best.above <= slack
    : Math.abs(best.above - best.below) <= slack

  return { fits: best.fits && placed, pad: Math.round(best.pad * 100) / 100 }
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
 * Desktop: whether a fit keeps the lines where somebody broke them.
 *
 * A newline in a translation is a break a letterer typed (`LETTERING_WRAP` is
 * `pre-wrap` for exactly that), and a line of it too wide for its place in the
 * balloon used to be wrapped again by the browser — "going to be" came out
 * "GOING TO / BE", worse than no breaks at all (2026-10-23). So a hand-broken
 * line is fitted at the largest size whose lines all keep their breaks, set a
 * little smaller rather than re-broken, and only wrapped again where no size in
 * range keeps them (`rewrapped`, which a review reports). Nor is a word in it
 * hyphenated while its breaks hold: whoever broke the lines decided where the
 * words go. Only where they cannot be kept, and nothing else goes, is one broken.
 */
const keepsBreaks = (input: FitInput) => input.text.includes('\n')

/**
 * The largest size that fits with this squeeze, or the floor flagged `over` —
 * `fitSize`'s search, lifted out (desktop) so a hand-broken line can run it with `keep`.
 */
function largestIn (setup: ReturnType<typeof probeFor>, input: FitInput, range: { min: number, max: number }, squeeze: Squeeze, keep = false): LetterFit {
  const at = (size: number) => tryFit(setup, input, size, squeeze, keep)
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

  return { size: low, pad: at(low).pad, ...squeeze }
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

  // Desktop: lines broken by hand are kept as broken where any size allows — see `keepsBreaks`.
  if (keepsBreaks(input)) {
    const kept = largestIn(setup, input, range, {}, true)

    if (!kept.over) return kept

    // Wrapped again where no size keeps them; a word broken only if nothing else goes.
    const wrapped = largestIn(setup, input, range, {})

    return { ...(wrapped.over ? largestIn(setup, input, range, { hyphens: true }) : wrapped), rewrapped: true }
  }

  /** The largest size that fits with this squeeze, or the floor flagged `over` — see `largestIn`. */
  const largest = (squeeze: Squeeze): LetterFit => largestIn(setup, input, range, squeeze)

  const plain = largest({})

  // Desktop: a long word broken, where that lets the whole balloon be set much
  // larger — see `HYPHEN_GAIN` and `utils/hyphens`.
  if (!input.lang || withHyphens(input.text, input.lang) === input.text) return plain

  const broken = largest({ hyphens: true })

  return !broken.over && (plain.over || broken.size >= plain.size * HYPHEN_GAIN) ? { ...broken, hyphens: true } : plain
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

  // Desktop: lines broken by hand — tightened, then smaller, before any is wrapped again (`keepsBreaks`).
  if (keepsBreaks(input)) {
    const floor = Math.max(range.min, Math.round(size * SQUEEZE_FLOOR))

    for (const squeeze of [{}, { tight: true }] as Squeeze[]) {
      const tried = tryFit(setup, input, size, squeeze, true)

      if (tried.fits) return { size, pad: tried.pad, ...squeeze }
    }

    for (let smaller = size - 1; smaller >= floor; smaller--) {
      const tried = tryFit(setup, input, smaller, { tight: true }, true)

      if (tried.fits) return { size: smaller, pad: tried.pad, tight: true }
    }

    // No size the standard allows keeps them: wrapped again, and said so — and
    // a word broken only now, as the last thing before not fitting at all.
    for (const squeeze of [{}, { tight: true }, { hyphens: true, tight: true }] as Squeeze[]) {
      const tried = tryFit(setup, input, size, squeeze)

      if (tried.fits) return { size, pad: tried.pad, ...squeeze, rewrapped: true }
    }

    for (let smaller = size - 1; smaller >= floor; smaller--) {
      const tried = tryFit(setup, input, smaller, { hyphens: true, tight: true })

      if (tried.fits) return { size: smaller, pad: tried.pad, hyphens: true, tight: true, rewrapped: true }
    }

    return { size: floor, pad: tryFit(setup, input, floor, { hyphens: true, tight: true }).pad, hyphens: true, tight: true, rewrapped: true, over: true }
  }

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

/**
 * Desktop: the lines a fit sets, as drawn — what `review_lettering` reports, so
 * an agent can judge a balloon's breaks from its words rather than a picture.
 */
export function drawnLines (input: FitInput, fit: LetterFit): DrawnLines | null {
  if (input.box.w <= 0 || input.box.h <= 0) return null

  const setup = probeFor(input)

  setup.layout(fit.size, { hyphens: fit.hyphens, tight: fit.tight }, fit.pad ?? 0)

  return setup.breaks(fit.size)
}
