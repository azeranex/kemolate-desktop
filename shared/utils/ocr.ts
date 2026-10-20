/**
 * Turning what a text detector saw into blocks a comic can use.
 *
 * Ported from the earlier build's `server/ocr.ts`, and deliberately separated
 * from the thing that does the detecting. Almost none of this is about Google
 * Vision: it is about what lettering in a comic *is* — that a line break inside
 * a balloon is layout rather than meaning, that a vertical CJK balloon reads
 * right to left whatever order the detector listed its columns in, and that a
 * slanted sound effect is a rotated box and not a huge upright one. Those stay
 * true whether the reading was done by a cloud API, a model in the browser, or
 * a person drawing a box by hand.
 *
 * So this lives in `shared/` and takes a neutral `Detection` rather than a
 * Vision response. Whatever we end up detecting with — and that decision is
 * still open — plugs in by producing that shape.
 *
 * ## On the coordinates
 *
 * Everything here is normalised by the image's **width**, on both axes. That
 * looks wrong and is not: dividing x by width and y by height squashes the
 * space unevenly, and in a squashed space a rotation is no longer a rotation —
 * a tilted box comes back with the wrong angle and the wrong proportions.
 * Width on both keeps it square, at the cost of `cy` and `h` running past 1 on
 * a page taller than it is wide. Which they do, and that is fine.
 */

/** Anything in one of the CJK blocks, for deciding how lines join. */
export const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/g

/** What a detector's line-break markers mean as characters. */
export const BREAKS: Record<string, string> = {
  SPACE: ' ',
  SURE_SPACE: ' ',
  EOL_SURE_SPACE: '\n',
  LINE_BREAK: '\n',
  HYPHEN: '',
}

/** A corner, in image pixels. Four of them, clockwise from the top left. */
export interface Vertex {
  x: number
  y: number
}

/**
 * One run of text a detector found, in the neutral shape this module works in.
 *
 * `text` arrives raw — with the detector's own line breaks still in it — because
 * deciding how those breaks read is `tidyText`'s job and it needs to see them.
 */
export interface Detection {
  quad: Vertex[]
  text: string
  /** Nought to one, where the detector reports it. */
  confidence?: number
  /** The paragraphs it was read from. A balloon's columns, for a CJK page. */
  paragraphs?: Detection[]
}

/** An oriented box, in the width-normalised space described above. */
export interface Box {
  cx: number
  cy: number
  w: number
  h: number
  /** Degrees. */
  angle: number
}

/**
 * Whether a reading is a sentence somebody says rather than a sound.
 *
 * The comic detector's `text_free` is its word for lettering loose on the art,
 * which becomes a sound effect — and it hands that label to speech often
 * enough to matter: a line set borderless beside a face, the tail end of a
 * balloon cut off by the panel edge. Its three builds do not even agree which
 * lines those are (on the test chapter `fast`, `accurate` and `full` each filed
 * a different set of the same page's dialogue as free text). A wrong label is
 * not cosmetic: the line is set in the sound-effect face, in bold, on the
 * Sound effects plate, and never gets a balloon's room.
 *
 * So the reading gets a say, on the two things a sound effect almost never
 * has:
 *
 * - **Sentence punctuation** — `…`, `...`, `?`, `、`, `。`. A sound ends in `!`
 *   or `ッ` or a heart; "ロ…ローションか…" and "うおっ!?" are somebody talking.
 *   `!`, `♡` and `～` are deliberately not on the list: sounds wear all three.
 * - **Length, with variety.** Eight letters or more is a sentence — unless it
 *   is the same few letters over and over, which is exactly what a long sound
 *   effect is (ドキドキドキドキ, 啪啪啪啪啪啪啪啪).
 *
 * Deliberately one-sided. A short line with no punctuation stays whatever the
 * detector said, because short exclamations and sounds genuinely look alike
 * and a wrong "speech" is the same size of mistake as a wrong "sound".
 */
export function speechLike (text: string): boolean {
  const letters = [...text].filter((char) => /[\p{L}\p{N}]/u.test(char))

  if (letters.length < 2) return false
  if (/[?？…‥、。，,]|\.{2,}/u.test(text)) return true

  return letters.length >= SPEECH_LETTERS && new Set(letters).size > SOUND_VARIETY
}

/** How many letters make a line a sentence rather than a sound — see `speechLike`. */
const SPEECH_LETTERS = 8

/** At most this many different letters, however long, is a sound repeated. */
const SOUND_VARIETY = 3

/** A block as the rest of the app wants it — a box, and what it says. */
export interface ReadBlock extends Box {
  text: string
  confidence?: number
  /** Kept so a block covering two balloons can later be split at a real edge. */
  paragraphs?: (Box & { text: string })[]
}

/**
 * Collapse a detector's line breaks the way lettering actually reads.
 *
 * A balloon is broken into lines to fit the balloon, not to mean anything, so
 * the breaks have to go. What replaces them depends on the script: CJK sets
 * without spaces between characters, so joining its lines with a space inserts
 * gaps that were never there; everything else needs the space or the words run
 * together.
 *
 * The test is a quarter of the characters rather than any — a Japanese balloon
 * with a stray latin "OK" in it is still a Japanese balloon.
 */
export function tidyText (raw: string): string {
  let text = raw.trim()

  const cjk = text.match(CJK)?.length ?? 0
  const joiner = cjk >= Math.max(1, Math.floor(text.length / 4)) ? '' : ' '

  text = text.replace(/\s*\n\s*/g, joiner)

  return text.replace(/[ \t]+/g, ' ').trim()
}

/** The axis-aligned extent of a quad, in pixels. */
function extent (quad: Vertex[]) {
  if (!quad.length) return null

  const xs = quad.map((v) => v.x)
  const ys = quad.map((v) => v.y)

  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

/**
 * Put a block's paragraphs into reading order.
 *
 * Detectors list them in the order they found them, which for a vertical CJK
 * balloon is usually left to right — the reverse of how the columns read, so
 * the sentence comes back starting in its own middle.
 *
 * Only reordered when every paragraph is clearly a column, taller than it is
 * wide by a comfortable margin. Anything else is left exactly as it came: the
 * detector understood that layout, and re-sorting it would be the new bug.
 */
function inReadingOrder (paragraphs: Detection[]): Detection[] {
  if (paragraphs.length < 2) return paragraphs

  const boxes = paragraphs.map((p) => extent(p.quad))

  if (!boxes.every((b) => b && b.y1 - b.y0 > (b.x1 - b.x0) * 1.3)) return paragraphs

  const middle = new Map(paragraphs.map((p, i) => [p, (boxes[i]!.x0 + boxes[i]!.x1) / 2]))

  return [...paragraphs].sort((a, b) => middle.get(b)! - middle.get(a)!)
}

/**
 * Four corners into an oriented box.
 *
 * A detector returns the corners already rotated for slanted text, and
 * collapsing them to a min/max rectangle inflates the box enormously — a sound
 * effect running diagonally across a panel becomes a box covering the panel. So
 * the orientation is kept: the width is the top edge, the height the left edge,
 * and the angle is however far the top edge is off level.
 *
 * Fewer than four corners is a detector that gave an axis-aligned box, and it
 * degrades to exactly that.
 */
export function boxOf (quad: Vertex[], imageWidth: number): Box {
  const v = quad.map((p) => ({ x: p.x / imageWidth, y: p.y / imageWidth }))

  if (v.length < 4) {
    const box = extent(v)

    if (!box) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 }

    return {
      cx: (box.x0 + box.x1) / 2,
      cy: (box.y0 + box.y1) / 2,
      w: box.x1 - box.x0,
      h: box.y1 - box.y0,
      angle: 0,
    }
  }

  const [tl, tr, br, bl] = v as [Vertex, Vertex, Vertex, Vertex]

  return {
    cx: (tl.x + tr.x + br.x + bl.x) / 4,
    cy: (tl.y + tr.y + br.y + bl.y) / 4,
    w: Math.hypot(tr.x - tl.x, tr.y - tl.y),
    h: Math.hypot(bl.x - tl.x, bl.y - tl.y),
    angle: (Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI,
  }
}

/**
 * A detection, read and squared up — the one call the rest of the app makes.
 *
 * Empty text is dropped by the caller rather than here: a block with no words
 * in it is a decision about what counts as lettering, and that belongs with
 * whoever asked for the reading.
 */
export function readBlock (detection: Detection, imageWidth: number): ReadBlock {
  const paragraphs = inReadingOrder(detection.paragraphs ?? [])

  return {
    ...boxOf(detection.quad, imageWidth),
    // Assembled from the paragraphs where there are any, so the column
    // reordering above actually reaches the words.
    text: tidyText(paragraphs.length ? paragraphs.map((p) => p.text).join('') : detection.text),
    ...(detection.confidence === undefined ? {} : { confidence: detection.confidence }),
    // One paragraph says nothing the block does not already say.
    ...(paragraphs.length > 1
      ? {
          paragraphs: paragraphs
            .map((p) => ({ ...boxOf(p.quad, imageWidth), text: tidyText(p.text) }))
            .filter((p) => p.text),
        }
      : {}),
  }
}

/** Everything worth keeping from one page's reading, in the order it was found. */
export function readPage (detections: Detection[], imageWidth: number): ReadBlock[] {
  return detections
    .map((detection) => readBlock(detection, imageWidth))
    .filter((block) => block.text)
}

/**
 * A block as reading order sees it: a rectangle, and nothing else.
 *
 * Structural on purpose. The canvas holds blocks as `{x, y, w, h}` in page
 * percentages and the database holds them as a width-normalised `{cx, cy, w,
 * h}`, and the ordering does not care which — it is a fact about where things
 * sit relative to each other, in whatever units they all share. Taking the
 * corner rather than the centre because that is what both the band test and
 * the right-edge tie-break actually read.
 */
export interface Placed {
  x: number
  y: number
  w: number
  h: number
}

/**
 * How much of a block's height a neighbour must share to count as beside it
 * rather than below it.
 *
 * Half, because balloons in a row are rarely level: one hangs a little lower
 * than the next and a stricter test would put them on separate lines, which
 * reads as the order jumping back up the page.
 */
export const BESIDE = 0.5

/**
 * The blocks of a page in the order somebody reads them.
 *
 * Not a sort, in the comparator sense, and it cannot be one. "Right of" and
 * "above" disagree constantly on a comic page — a balloon low on the right and
 * one high on the left each have a claim to being first — and a comparator that
 * answers case by case is not transitive, so the sort it drives depends on the
 * order it was already in. That is the bug where pressing Sort twice gives two
 * different answers.
 *
 * So the page is cut into bands first and each band ordered within itself. A
 * band is a run of blocks that overlap vertically: greedily, the topmost block
 * left starts one, and anything sharing enough of its height joins it and
 * widens it. Bands then run down the page and blocks run across each band —
 * right to left for Japanese and Korean, left to right where the workspace says
 * so. That is a total order by construction, and pressing Sort again changes
 * nothing.
 *
 * It is still a heuristic about a page, not a fact about it: a panel laid out
 * against the grid will read wrong, and the answer to that is dragging a row,
 * which is why the list has always let you.
 *
 * **In `shared/` rather than beside the canvas, which is where it used to be.**
 * Three callers need it and only one of them is a browser: a reading has to be
 * ordered as it is taken (`useOcr`), a page already stored in the wrong order
 * has to be repairable without opening the app (`sort_page_blocks`), and the
 * panel's Sort button has always used it. A second implementation on the server
 * would be a second answer to "what order is this page in", which is exactly the
 * kind of disagreement two people working one chapter would never track down.
 */
export function readingOrder<T extends Placed> (blocks: T[], direction: 'rtl' | 'ltr' = 'rtl'): T[] {
  const bands: { top: number, bottom: number, members: T[] }[] = []

  // Topmost first, so a band is always started by its own highest block and
  // never widened upwards by something found later.
  for (const block of [...blocks].sort((a, b) => a.y - b.y)) {
    const top = block.y
    const bottom = block.y + block.h

    const band = bands.find((candidate) => {
      const over = Math.min(candidate.bottom, bottom) - Math.max(candidate.top, top)

      return over >= Math.min(candidate.bottom - candidate.top, block.h) * BESIDE
    })

    if (!band) {
      bands.push({ top, bottom, members: [block] })
      continue
    }

    band.members.push(block)
    band.bottom = Math.max(band.bottom, bottom)
  }

  return bands.flatMap((band) => band.members.sort((a, b) => direction === 'rtl'
    // By the right edge, not the left: a wide balloon and a narrow one starting
    // at the same place are read from where each of them begins.
    ? (b.x + b.w) - (a.x + a.w)
    : a.x - b.x))
}

/**
 * The same ordering, for boxes held by their centre.
 *
 * `readingOrder` reads corners because that is what a band test and a
 * right-edge tie-break need; a `BlockDraft` and a `blocks` row both hold a
 * centre and a size. Rather than have every caller do the same two subtractions
 * — and get one of them wrong once — the conversion lives here, and the objects
 * handed in come back untouched in a new order.
 *
 * Note that `cy` and `h` are normalised by the page's *width*, like everything
 * else about a block. That is fine and needs no correction: the ordering only
 * ever compares these numbers with each other.
 */
export function centredReadingOrder<T extends { cx: number, cy: number, w: number, h: number }> (
  boxes: T[],
  direction: 'rtl' | 'ltr' = 'rtl',
): T[] {
  const placed = boxes.map((box) => ({
    box,
    x: box.cx - box.w / 2,
    y: box.cy - box.h / 2,
    w: box.w,
    h: box.h,
  }))

  return readingOrder(placed, direction).map((entry) => entry.box)
}
