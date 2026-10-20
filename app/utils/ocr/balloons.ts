/**
 * Working out which blocks probably belong to the same balloon — and only
 * saying so.
 *
 * PP-OCRv6 finds *lines* — see `paddle.ts` — so a balloon holding three columns
 * of Japanese arrives as three blocks that say a third of a sentence each.
 * manga-ocr and Google Vision hand the balloon back whole, and a block is the
 * unit somebody translates, so the fragments want joining.
 *
 * ## Why this proposes and never applies
 *
 * The obvious move is to merge them automatically. It was written that way
 * first, and measured: on a real Japanese page every one of five multi-column
 * balloons came out correct. That is not enough, and the reason is the shape of
 * the two failures rather than how often each happens.
 *
 * An unmerged balloon fails *loudly*. `なんで` sits on the page by itself,
 * obviously a fragment, and joining it is a click. A wrongly merged one fails
 * *silently*: two balloons become one fluent sentence that reads correctly,
 * translates correctly, letters correctly, and is not what the page says.
 * Nothing downstream can tell, because there is nothing wrong with it except
 * that it is untrue. Automation earns its place when its mistakes are visible,
 * and here they are not.
 *
 * So this file computes the grouping and hands it over as a suggestion. Taking
 * one is a click; ignoring a wrong one costs nothing. The tedium goes away and
 * the silent failure does not get the chance.
 *
 * ## What holds a balloon together
 *
 * Two blocks are proposed as one when they are the same kind of thing, side by
 * side, and the same size:
 *
 * - **Same orientation.** Two columns can share a balloon; a column and a
 *   horizontal line cannot, whatever their distance.
 * - **Overlapping along their length.** Columns in one balloon start and end at
 *   about the same heights, because they were set as one block of text.
 * - **Touching across it.** Measured against the *narrower* of the two, so a
 *   wide neighbour cannot reach across a gap a narrow one could not.
 * - **The same glyph size.** The load-bearing test, and the least obvious.
 *   Column *height* varies freely inside a balloon — a column is as long as its
 *   sentence — but column *width* is the font size, and a balloon is set in one
 *   size. Measured on a real page, the columns of four balloons ran 38/44/41,
 *   49/50, 39/43/47 and 39/50/44/43 pixels: never more than 1.3x apart. The
 *   sound effect on that page was 210 pixels wide, sat 41 pixels from a balloon
 *   and overlapped it vertically along its whole length — so on the first three
 *   tests alone it merged straight into the dialogue. Size is what tells them
 *   apart.
 *
 * Each suggestion carries how safely it passed, so a caller can put the shaky
 * ones in front of somebody and leave the certain ones alone.
 */

/** How far apart, across their width, two blocks may sit and still be proposed. */
const GAP = 0.8

/** How much of the shorter block's length must lie alongside the other. */
const ALONG = 0.5

/**
 * How different two blocks' glyph sizes may be.
 *
 * Generous against what a balloon actually does — 1.3x was the worst seen —
 * and still less than half what it takes to pull a sound effect in.
 */
const SIZE = 2.5

/** Taller than this much of its width and a run of text is a column. */
const UPRIGHT = 1.3

/** A proposal: these blocks look like one balloon. */
export interface Suggestion {
  /**
   * Indices into the blocks that were passed in, already in reading order —
   * columns right to left, stacked lines top to bottom.
   */
  members: number[]
  /**
   * How safely the group held together, nought to one, taken from the weakest
   * join in it. Nought means it only just qualified and wants looking at; one
   * means the blocks overlap, sit flush and are the same size.
   */
  margin: number
}

interface Extent {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Vertical lettering — a column — rather than a horizontal line. */
  column: boolean
  /** The glyph size: a column's width, a line's height. */
  size: number
}

/**
 * A block's upright extent, and which way its lettering runs.
 *
 * Orientation is read from the box's *own* sides rather than from the extent,
 * so a sound effect running diagonally is still the column it looks like on the
 * page. Overlap and distance are measured on the upright extent, because that
 * is the only frame two differently-angled boxes share.
 */
function extentOf (box: Box): Extent {
  const radians = (box.angle * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))

  const spanX = (box.w * cos + box.h * sin) / 2
  const spanY = (box.w * sin + box.h * cos) / 2

  const column = box.h > box.w * UPRIGHT

  return {
    x0: box.cx - spanX,
    y0: box.cy - spanY,
    x1: box.cx + spanX,
    y1: box.cy + spanY,
    column,
    size: column ? box.w : box.h,
  }
}

/** How much of the shorter span lies alongside the longer, nought to one. */
function share (a0: number, a1: number, b0: number, b1: number): number {
  const over = Math.min(a1, b1) - Math.max(a0, b0)
  const shorter = Math.min(a1 - a0, b1 - b0)

  return shorter > 0 ? Math.max(0, over) / shorter : 0
}

/**
 * How safely two blocks join, nought to one — or null where they do not.
 *
 * The margin is the weakest of the three measurements rather than their
 * average, because one of them being borderline is enough to make the whole
 * proposal a guess, however comfortable the other two are.
 */
function margin (a: Extent, b: Extent): number | null {
  // A column and a line are two different pieces of lettering however close
  // they sit, and a square blob — a lone character, a page number — is neither.
  if (a.column !== b.column) return null
  if (!a.column && !(a.x1 - a.x0 > (a.y1 - a.y0) * UPRIGHT)) return null

  // Along the writing direction they must overlap; across it they must nearly
  // touch. Which axis is which is the only thing orientation changes.
  const along = a.column
    ? share(a.y0, a.y1, b.y0, b.y1)
    : share(a.x0, a.x1, b.x0, b.x1)

  if (along < ALONG) return null

  const across = a.column
    ? Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)
    : Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)

  const small = Math.min(a.size, b.size)
  const large = Math.max(a.size, b.size)

  if (small <= 0 || across > small * GAP) return null
  if (large > small * SIZE) return null

  return Math.max(0, Math.min(1, Math.min(
    (along - ALONG) / (1 - ALONG),
    // One where the blocks already overlap, falling to nought at the far edge.
    1 - Math.max(0, across) / (small * GAP),
    (SIZE - large / small) / (SIZE - 1),
  )))
}

/**
 * Which of these blocks look like they belong to the same balloon.
 *
 * Takes boxes rather than readings so it serves both sides of the app: the
 * bench, where they are fresh detections, and the workspace, where they are
 * blocks somebody may already have moved. Both are `Box`, and every threshold
 * here is a ratio, so it does not matter whether they are in pixels or in the
 * width-normalised space blocks are stored in.
 *
 * Blocks that join nothing are not returned — a suggestion of one is not a
 * suggestion. Nothing is merged, reordered or modified; the indices come back
 * in reading order and what happens next is somebody else's decision.
 */
export function suggestGroups (blocks: Box[]): Suggestion[] {
  const extents = blocks.map(extentOf)

  // Union-find, so that A beside B beside C is proposed as one balloon and not
  // as two overlapping pairs.
  const parent = blocks.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))

  const weakest = new Map<number, number>()

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const held = margin(extents[i]!, extents[j]!)

      if (held === null) continue

      const root = find(j)

      parent[find(i)] = root
      weakest.set(root, Math.min(weakest.get(root) ?? 1, held))
    }
  }

  const groups = new Map<number, number[]>()

  for (let i = 0; i < blocks.length; i++) {
    const root = find(i)

    groups.set(root, [...(groups.get(root) ?? []), i])
  }

  const found: Suggestion[] = []

  for (const [root, members] of groups) {
    if (members.length < 2) continue

    // Columns read right to left, stacked lines top to bottom.
    const sorted = [...members].sort((a, b) => extents[a]!.column
      ? (extents[b]!.x0 + extents[b]!.x1) - (extents[a]!.x0 + extents[a]!.x1)
      : (extents[a]!.y0 + extents[a]!.y1) - (extents[b]!.y0 + extents[b]!.y1))

    // The weakest join anywhere under this root, which after union-find may
    // have been recorded against a root that has since been absorbed.
    let held = 1

    for (const [at, value] of weakest) if (find(at) === root) held = Math.min(held, value)

    found.push({ members: sorted, margin: held })
  }

  return found
}
