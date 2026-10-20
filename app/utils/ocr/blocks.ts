/**
 * Turning a reading into blocks — the page's, and the server's.
 *
 * Three shapes meet here and it is worth being plain about which is which.
 * The engines speak `ReadBlock`: width-normalised, centre-based, angled,
 * from `shared/utils/ocr.ts`. The `blocks` table stores that same shape
 * almost exactly, which is not a coincidence — its schema note points here.
 * The canvas speaks `Block`: percentages of the page box from its top left
 * corner, upright.
 *
 * So a reading goes *out* to the server nearly untouched, and only the last
 * hop — into the canvas — reshapes it. That is the right way round: the
 * stored form keeps the angle a slanted sound effect was found at, and only
 * the drawing loses it, because the canvas has nowhere to put it yet.
 *
 * The two spaces differ on more than their origin. A reading is normalised
 * by the image's *width* on both axes — which is what keeps a rotation a
 * rotation, see the note in `shared/utils/ocr.ts` — while a block's `y` and
 * `h` are shares of the page's *height*. So the vertical numbers are scaled
 * by the aspect ratio on the way through, and a page whose scan has not been
 * measured yet falls back to the usual proportions rather than dividing by
 * nothing.
 */
// By hand, so a dev server already running picks up an export it has not seen.
import { speechLike } from '#shared/utils/ocr'

/** A block as the server stores it, before it has an id or a position. */
export interface BlockDraft {
  kind: BlockType
  cx: number
  cy: number
  w: number
  h: number
  angle: number
  /**
   * How the box has been bent since — the lean, and the corners. A reading
   * produces neither; they arrive when somebody transforms the block, and they
   * come back with it on the next load, which is why they are on the shape the
   * server speaks rather than only on the one the canvas draws.
   */
  skewX?: number
  skewY?: number
  quad?: number[] | null
  /**
   * The room inside the balloon, where a translation is set by default — see
   * `blocks.room`. Upright, in this same width-normalised space; absent or null
   * where there is no balloon to measure.
   */
  room?: RoomBox | null
  source: string
  confidence: number
  hidden: boolean
}

/** An upright box, width-normalised on both axes like a block's — see `blocks.room`. */
export interface RoomBox {
  cx: number
  cy: number
  w: number
  h: number
}

/**
 * A balloon's room in the page percentages the canvas draws in — the same
 * arithmetic `toBlocks` uses for the box, and the one copy of it for the room.
 */
export function roomBoxOf (room: RoomBox, scan: { width: number, height: number }): NonNullable<Block['room']> {
  const aspect = scan.width && scan.height ? scan.width / scan.height : PAGE_RATIO

  return {
    x: (room.cx - room.w / 2) * 100,
    y: (room.cy - room.h / 2) * aspect * 100,
    w: room.w * 100,
    h: room.h * aspect * 100,
  }
}

/**
 * What a block says in one language, and how it is set — one row of
 * `translations`, as the server hands it back.
 *
 * The lettering style lives here rather than on the block because it is a
 * property of the *rendering* and not of the reading: the same box read once can
 * be set two ways in two languages, and a column on `blocks` could only hold one
 * of them. Which is also why it comes back attached to a block rather than
 * fetched separately — a block and what it should say are read together or the
 * page is drawn twice.
 */
export interface StoredTranslation {
  locale: string
  text: string
  style?: Partial<Lettering> | null
  /**
   * Where the lettering sits, when it has been moved off the block — the row's
   * half of the split described on `Block.letter`.
   *
   * On `translations` rather than on `blocks` for exactly the reason the style
   * is: it is a property of the *rendering*. One box read once is set two ways
   * in two languages, and English wants more room than the Japanese it replaced
   * while German wants more again — a column on `blocks` could hold one of those
   * answers, and the block's box is already spoken for by the reading anyway.
   *
   * All null on a block whose lettering still sits where it was found, which is
   * every row written before this existed. See `toLetterBox`.
   */
  cx?: number | null
  cy?: number | null
  w?: number | null
  h?: number | null
  angle?: number | null
  skewX?: number | null
  skewY?: number | null
  quad?: number[] | null
}

/**
 * A lettering frame on its way back to its row — `toPatch` for the other box.
 *
 * The same two spaces and the same aspect handling, argued at the top of this
 * file: page percentages out, normalised by the scan's *width* on both axes in.
 * Written out rather than expressed through `toPatch` because that one takes a
 * whole `Block` and carries the kind, the source and whether it is hidden with
 * it, none of which a frame has or should acquire.
 *
 * **Nulls all the way down when there is no frame, and never an omission.** The
 * server treats absent and null alike and writes both — see the note on
 * `translationSyncSchema` — so this has to say "no frame" out loud or a balloon
 * somebody put back on its block would be put straight back off it.
 *
 * Which is why a frame that *exists* writes `0` for a turn or a lean nobody has
 * applied, rather than null: the two are the same picture on the page and
 * different claims about the row. All-null is "this lettering sits on its
 * block"; a row of numbers with zeroes among them is "this lettering has a frame
 * of its own, and it happens to be square". Read a stored `0` as the second, not
 * as somebody having straightened something.
 */
export function toLetterPatch (letter: LetterBox | undefined, scan: { width: number, height: number }) {
  const aspect = scan.width && scan.height ? scan.width / scan.height : PAGE_RATIO

  if (!letter) {
    return { cx: null, cy: null, w: null, h: null, angle: null, skewX: null, skewY: null, quad: null }
  }

  return {
    cx: (letter.x + letter.w / 2) / 100,
    cy: (letter.y + letter.h / 2) / 100 / aspect,
    w: letter.w / 100,
    h: letter.h / 100 / aspect,
    angle: letter.angle ?? 0,
    skewX: letter.skewX ?? 0,
    skewY: letter.skewY ?? 0,
    // The corner offsets are lengths in the scan's own pixels, so unlike the
    // angle they do not survive the change of space untouched — the same
    // division `toPatch` makes, for the same reason.
    quad: letter.quad?.some((v) => v !== 0) && scan.width
      ? letter.quad.map((v) => v / scan.width)
      : null,
  }
}

/**
 * A stored frame back into the one the canvas draws — `toLetterPatch` reversed,
 * and the read side of the same round trip.
 *
 * Undefined rather than a box matching the block when there is nothing stored,
 * because those are different claims: "no frame of its own" follows the block if
 * the detection is corrected later, and a copy of today's box does not. A width
 * of nought counts as nothing stored — a frame with no width is not a frame, and
 * a row half-written by some future partial update should not put the lettering
 * in a box no pointer could find.
 */
export function toLetterBox (
  said: StoredTranslation | undefined,
  scan: { width: number, height: number },
): LetterBox | undefined {
  if (!said || said.cx == null || said.cy == null || !said.w || !said.h) return undefined

  const aspect = scan.width && scan.height ? scan.width / scan.height : PAGE_RATIO

  return {
    x: (said.cx - said.w / 2) * 100,
    y: (said.cy - said.h / 2) * aspect * 100,
    w: said.w * 100,
    h: said.h * aspect * 100,
    ...(said.angle ? { angle: said.angle } : {}),
    ...(said.skewX ? { skewX: said.skewX } : {}),
    ...(said.skewY ? { skewY: said.skewY } : {}),
    ...(said.quad?.some((v) => v !== 0) && scan.width
      ? { quad: said.quad.map((v) => v * scan.width) }
      : {}),
  }
}

/** What comes back from the server, which is a draft that has been written. */
export interface StoredBlock extends BlockDraft {
  id: number
  position: number
  /**
   * Every language this block has been carried into, not only the one being
   * worked in — `blocks.onPage` returns the lot, and picking one is `toBlocks`'s
   * job because only the caller knows which chapter is being read.
   */
  translations?: StoredTranslation[]
}

/** What the detector called a region, in the vocabulary a block uses. */
const TYPES: Record<DetectedLabel, BlockType> = {
  bubble: 'bubble',
  text_bubble: 'bubble',
  text_free: 'sfx',
  // PP-OCRv6 cannot tell the two apart — it finds writing, not what surrounds
  // it — so its lines land on the commoner of the two and are re-typed by hand
  // where that is wrong.
  text_line: 'bubble',
}

/** Near enough to be the same box — a share of the page's width. */
const SAME = 0.01

/**
 * Which detected region a reading came out of.
 *
 * By centre rather than by index: `readPage` drops the regions that came
 * back empty, so the two lists are no longer the same length by the time
 * they get here. The centres are exact — a reading's box *is* the region it
 * was cropped from — so this is a lookup with a tolerance rather than a
 * search for something nearby.
 */
function labelOf (block: ReadBlock, regions: DetectedText[], width: number): BlockType {
  if (!regions.length || !width) return 'bubble'

  const found = regions.find((region) => {
    const cx = (region.x + region.w / 2) / width
    const cy = (region.y + region.h / 2) / width

    return Math.abs(cx - block.cx) < SAME && Math.abs(cy - block.cy) < SAME
  })

  if (!found) return 'bubble'

  // Free text the detector itself found inside one of its balloons, or that
  // reads as a sentence, is dialogue — see `speechLike` for why its label
  // cannot be taken at its word.
  if (found.label === 'text_free' && (found.bubble || speechLike(block.text))) return 'bubble'

  return TYPES[found.label]
}

/**
 * A reading, in the shape the server stores.
 *
 * `regions` is what the detector found, where a detector was involved; it
 * only decides whether a block is a bubble or a sound effect, so a reading
 * taken without one comes back as bubbles and can be corrected by hand.
 */
export function toDrafts (read: ReadBlock[], regions: DetectedText[] = [], width = 0): BlockDraft[] {
  return read.map((block) => ({
    kind: labelOf(block, regions, width),
    cx: block.cx,
    cy: block.cy,
    w: block.w,
    h: block.h,
    angle: block.angle,
    source: block.text,
    // Stored nought to a hundred; read nought to one. An engine with nothing
    // to say about its confidence is not guessing — it is an engine that does
    // not report one, which reads best as certain.
    confidence: Math.round((block.confidence ?? 1) * 100),
    hidden: false,
  }))
}

/**
 * Blocks as the canvas draws them, from the shape everything else keeps.
 *
 * One function for both a reading just taken and a chapter being read back
 * off the server, because they are the same shape by then — which is the
 * point of converting on the way *in* to the canvas rather than on the way
 * out of the engine.
 *
 * Stored blocks keep their row id, so a block drawn now and the same block
 * after a reload are recognisably the same thing.
 *
 * `locale` is which of a block's translations to put on the page — the chapter's
 * target language. A block with no row in it comes back untranslated and
 * unstyled, which is the honest answer: nothing has been said about it in that
 * language yet. Absent for a reading just taken, which has no translations to
 * choose between.
 */
export function toBlocks (
  drafts: (BlockDraft | StoredBlock | (StoredBlock & { children?: StoredBlock[] }))[],
  scan: { width: number, height: number },
  locale?: string,
): Block[] {
  // The scan's own proportions where it has been drawn, the usual page where
  // it has not — see `measure` in `useComic`.
  const aspect = scan.width && scan.height ? scan.width / scan.height : PAGE_RATIO

  return drafts.map((draft, index) => {
    // The chapter's language, out of however many the block has been carried
    // into. Nothing at all without a locale to ask for: silently taking the
    // first row would put Indonesian on a page being worked in English the
    // moment somebody translated it twice.
    const said = locale && 'translations' in draft
      ? draft.translations?.find((row) => row.locale === locale)
      : undefined

    const letter = toLetterBox(said, scan)

    return {
      id: 'id' in draft ? `block:${draft.id}` : `read:${crypto.randomUUID().slice(0, 8)}:${index}`,
      type: draft.kind,
      x: (draft.cx - draft.w / 2) * 100,
      y: (draft.cy - draft.h / 2) * aspect * 100,
      w: draft.w * 100,
      h: draft.h * aspect * 100,
      // The angles come through untouched: both spaces are square — the stored
      // one normalised by width, the canvas's in the scan's own pixels — and a
      // uniform scale between two square spaces leaves an angle alone. The corner
      // offsets are lengths, so they do not get off so lightly.
      ...(draft.angle ? { angle: draft.angle } : {}),
      ...(draft.skewX ? { skewX: draft.skewX } : {}),
      ...(draft.skewY ? { skewY: draft.skewY } : {}),
      ...(draft.quad?.some((v) => v !== 0) && scan.width
        ? { quad: draft.quad.map((v) => v * scan.width) }
        : {}),
      // The balloon's room, in the page percentages the box is in and by the
      // same arithmetic. Absent rather than null where there is none, so a
      // block read before rooms existed hydrates exactly as it did.
      ...(draft.room ? { room: roomBoxOf(draft.room, scan) } : {}),
      source: draft.source,
      translation: said?.text ?? '',
      confidence: draft.confidence,
      hidden: draft.hidden,
      // Absent rather than an empty object when nothing was stored, which is the
      // rule `Block.style` states: a block that has never been lettered carries
      // no settings, so changing what the defaults *are* changes it too. `{}`
      // would round-trip as "styled, with nothing to say", which is a different
      // claim and one that survives a change of default.
      ...(said?.style && Object.keys(said.style).length ? { style: said.style } : {}),
      // And where that line is set, where it has been moved off the block — the
      // same absent-means-on-the-block rule `Block.letter` states, so a page
      // nobody has re-lettered hydrates exactly as it did before any of this.
      ...(letter ? { letter } : {}),
      // A balloon arrives with its columns inside it — see `Block.children`. The
      // same conversion, one level down, and absent where there are none so an
      // ordinary block carries no empty array around.
      //
      // Without the locale, deliberately. A balloon holds the translation and
      // the lettering — see `blocks.parentId` — and its columns hold only the
      // per-column reading, so hydrating a child from a row that should not
      // exist would put a second copy of the line inside the one that draws it.
      ...('children' in draft && draft.children?.length
        ? { children: toBlocks(draft.children, scan) }
        : {}),
    }
  })
}

/**
 * How far apart two fragments may sit, as a share of the text's own thickness.
 *
 * Thickness rather than any absolute distance because that is the only ruler on
 * the page that scales with the lettering: the gap between two columns of a
 * balloon is a fraction of a column's width whether the scan is a web upload or
 * a 3000px raw, and whether the balloon is a whisper or a shout.
 *
 * Below about four tenths the loosest hand-lettered leading starts to split its
 * own balloon; above about one and a bit, two balloons sharing a panel begin to
 * find each other, which is the failure that costs somebody a split and a
 * re-read. Seven tenths sits with room on both sides.
 */
const GAP = 0.7

/**
 * What an adjacency across the grain of the page keeps of that allowance.
 *
 * A page read right to left is set in columns, so boxes side by side are
 * usually one balloon's columns while boxes stacked are usually two balloons;
 * a page read left to right is the other way round. So the axis the text does
 * *not* run along is held to a tighter gap.
 *
 * At 1 the prior does nothing and a caption sitting under a balloon on a manga
 * page joins it. At 0 a horizontal balloon on a Japanese page — signs, asides,
 * plenty of them — could never be joined at all. Half keeps the against-the-
 * grain case reachable while making it ask twice as clearly.
 */
const AGAINST = 0.5

/**
 * How much of the shorter box the two must share on the axis they overlap.
 *
 * Half, for the reason `BESIDE` in `shared/utils/ocr.ts` is half: a balloon's
 * last column is short and
 * its lines are rarely flush, and a stricter test drops exactly the fragment
 * whose absence is most obvious in the finished sentence. Much below half and
 * two balloons that merely graze each other start to count as overlapping.
 */
const SHARE = 0.5

/**
 * How unlike each other two fragments' thickness may be.
 *
 * Columns of one balloon are set in one size, so their widths are nearly equal
 * and so are the heights of its lines; a box twice as thick as its neighbour is
 * evidence of a second piece of lettering rather than of a second column. Kept
 * loose at two because a column of wide punctuation is genuinely fatter than
 * one of kana, and this is a sanity check rather than the test.
 */
const EVEN = 2

/**
 * How long a fragment must be, against its own thickness, to be joined along
 * the axis it is thick on.
 *
 * Columns are joined side by side and lines are stacked, and a box that is not
 * longer than it is thick is neither — it is a lone character, a stray mark, or
 * a box covering a whole balloon already. Admitting those lets a square box be
 * joined in both directions at once, which is how a caption and the balloon
 * beneath it end up welded. The cost of the rule is a one-character column left
 * out of its balloon, which is a missed join and therefore cheap.
 */
const SLIM = 1

/**
 * The largest share of the page a joined balloon is allowed to cover.
 *
 * A transitive chain that has run away across a panel is the failure this
 * catches, and it is caught on area rather than on either dimension because a
 * banner caption across the top of a page and a tall column down its side are
 * both perfectly ordinary while covering a quarter of it between them. A group
 * over the line is dropped whole rather than trimmed back to a plausible
 * subset: the grouping has already been shown to be wrong, and a second
 * heuristic guessing which part of a wrong answer to keep is not conservatism.
 */
const SPREAD = 0.25

/**
 * The confidence below which a box is not joined to anything.
 *
 * Very low is meant literally. At ten a reader has all but disowned the box —
 * it is a tone-dot cluster or a panel border read as a character — and welding
 * one into a balloon puts noise in the middle of the sentence, which is the
 * error somebody has to split and re-read to undo. Everything above it is kept,
 * including plenty the reader was unsure of, because dropping a real column out
 * of the middle of a balloon is the more expensive mistake of the two. Blocks
 * drawn by hand carry a hundred, and an engine that reports no confidence is
 * stored as certain, so on most pages this excludes nothing.
 */
const SURE = 10

/** A block's edges, with the two axes measured in the same unit — see below. */
interface Extent {
  x0: number
  x1: number
  y0: number
  y1: number
}

/**
 * A block's box in a space where a length across means what a length down does.
 *
 * `Block` is percentages of the page box, and the two axes are percentages of
 * different things — `x` and `w` of the page's width, `y` and `h` of its
 * height. Ratios within one axis are unharmed by that and every *decision*
 * below is one: a gap along an axis against a thickness along the same axis.
 * But whether a box is a column or a line is a comparison across the two, and
 * in raw percentages a square box on a portrait page reads as a wide one.
 *
 * So the vertical numbers are put back into the horizontal's unit on the way
 * in, which is `toBlocks` run backwards. The page's own proportions are not
 * known here — this takes blocks and not a scan, because the caller has a list
 * and no picture — so the usual ones are assumed, exactly as everything else in
 * this file assumes them for a scan that has not been measured. A page of some
 * other shape moves the shape gate a little, and moving it costs a missed join
 * rather than a wrong one, which is the direction to be wrong in.
 */
function squared (block: Block): Extent {
  return {
    x0: block.x,
    x1: block.x + block.w,
    y0: block.y / PAGE_RATIO,
    y1: (block.y + block.h) / PAGE_RATIO,
  }
}

/** A low and a high edge on one axis, in the space `squared` produces. */
type Edges = [number, number]

/**
 * Whether two boxes abut along one axis: near on `gap`, overlapping on `along`.
 *
 * Every comparison here is between two lengths on the same axis, which is what
 * makes the numbers above mean one thing on both. `allowed` is the share of the
 * thickness the gap may be — `GAP`, or less across the grain of the page.
 */
function abuts (gapA: Edges, gapB: Edges, alongA: Edges, alongB: Edges, allowed: number): boolean {
  const thickA = gapA[1] - gapA[0]
  const thickB = gapB[1] - gapB[0]
  const thick = Math.min(thickA, thickB)
  const long = Math.min(alongA[1] - alongA[0], alongB[1] - alongB[0])

  if (thick <= 0 || long <= 0) return false

  // Neither a lone character nor a box already covering its balloon.
  if (long < thick * SLIM) return false

  // One size of lettering, or two pieces of it.
  if (Math.max(thickA, thickB) > thick * EVEN) return false

  // Negative where they already overlap on this axis, which is allowed: two
  // readings of the same column arrive on top of each other and are still one
  // balloon's worth of words.
  const gap = Math.max(gapB[0] - gapA[1], gapA[0] - gapB[1])

  if (gap > thick * allowed) return false

  return Math.min(alongA[1], alongB[1]) - Math.max(alongA[0], alongB[0]) >= long * SHARE
}

/** Whether two boxes are fragments of one balloon, on either axis. */
function beside (a: Extent, b: Extent, direction: 'rtl' | 'ltr'): boolean {
  const across = direction === 'rtl' ? GAP : GAP * AGAINST
  const down = direction === 'rtl' ? GAP * AGAINST : GAP

  return abuts([a.x0, a.x1], [b.x0, b.x1], [a.y0, a.y1], [b.y0, b.y1], across)
    || abuts([a.y0, a.y1], [b.y0, b.y1], [a.x0, a.x1], [b.x0, b.x1], down)
}

/** A block this may join to another — see the header for why each is refused. */
function joinable (block: Block): boolean {
  return !block.children?.length
    && !block.hidden
    && block.type !== 'garbage'
    && block.confidence >= SURE
    && block.w > 0
    && block.h > 0
}

/**
 * Fragments of one balloon, decided without asking anybody.
 *
 * A detector returns one box per *column* on a vertical page and one per *line*
 * on a horizontal one, so a balloon arrives in pieces and something has to say
 * which pieces are one balloon's. By hand that is a selection and a press per
 * balloon; this is what auto mode presses instead. What it returns is the
 * argument to `useBlockMerge.merge`, one group at a time.
 *
 * The rule is one rule and not two: two boxes are neighbours when they overlap
 * along one axis and the space between them on the other is small against the
 * *thickness* of the text itself — the narrow way across a column, the short
 * way down a line. Columns side by side and lines stacked are then the same
 * sentence said about different axes, which is worth more than two special
 * cases that can disagree about a balloon set in both. Neighbours join
 * transitively, so a three-column balloon comes out whole.
 *
 * Only groups of two or more come back; a block that stays by itself is not
 * news. Members keep the order they arrived in, which the caller has already
 * put into reading order — `merge` joins sources in member order, so a group in
 * any other order is a scrambled sentence — and the groups themselves follow
 * their first member.
 *
 * What it refuses to touch is as load-bearing as what it joins:
 *
 * - **A balloon already**, meaning a block with children. `canMerge` refuses
 *   those, so handing one back would fail the whole run on a page it is being
 *   repeated over. It is also the whole of why this is idempotent: merging
 *   replaces a group with one block that has children, and the next run sees
 *   nothing it may take.
 * - **Two kinds at once.** A sound effect must not be swallowed by the balloon
 *   it is drawn across, and the type is the only evidence on the page that they
 *   are different things.
 * - **A block somebody hid, or called garbage.** Both are decisions already
 *   taken about that box, and welding it into a sentence undoes them without
 *   saying so.
 *
 * Conservative throughout, deliberately: a wrong join costs a split and a
 * re-read, a missed one costs a balloon read as two, which is what the page
 * looked like before it ran.
 */
export function balloonGroups (blocks: Block[], direction: 'rtl' | 'ltr' = 'rtl'): Block[][] {
  const parts = blocks
    .map((block, index) => ({ block, index, box: squared(block) }))
    .filter((part) => joinable(part.block))

  // Union-find rather than a sweep, because "fragment of the same balloon" has
  // to be transitive to be usable: the first and third column of a balloon are
  // not neighbours of each other, and a rule that only joined neighbours would
  // hand back two groups of the same balloon and merge it into two.
  const parent = parts.map((_, index) => index)

  function find (start: number): number {
    let root = start

    while (parent[root] !== root) root = parent[root]!

    let walk = start

    while (parent[walk] !== walk) {
      const next = parent[walk]!

      parent[walk] = root
      walk = next
    }

    return root
  }

  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!
      const b = parts[j]!

      if (a.block.type !== b.block.type) continue
      if (!beside(a.box, b.box, direction)) continue

      // Onto the lower index, so the root of a group is its first member and
      // the answer cannot depend on which pair was tested first.
      parent[find(j)] = find(i)
    }
  }

  const groups = new Map<number, Block[]>()

  // In index order, so a group's members come out in the order they arrived and
  // the map's own order is the order the groups' first members arrived in.
  for (const [index, part] of parts.entries()) {
    const root = find(index)

    groups.set(root, [...(groups.get(root) ?? []), part.block])
  }

  return [...groups.values()].filter((members) => {
    if (members.length < 2) return false

    const x = Math.min(...members.map((m) => m.x))
    const y = Math.min(...members.map((m) => m.y))
    const w = Math.max(...members.map((m) => m.x + m.w)) - x
    const h = Math.max(...members.map((m) => m.y + m.h)) - y

    // Percentages of the page on each axis, so their product is a share of the
    // page's area whatever shape the page is — no assumption needed here.
    return (w / 100) * (h / 100) <= SPREAD
  })
}

/** The row id a block came from, or null for one no server has seen. */
export const rowOf = (block: Block): number | null => {
  const found = /^block:(\d+)$/.exec(block.id)

  return found ? Number(found[1]) : null
}

/**
 * A block on its way back to the row it came from — `toBlocks` run backwards.
 *
 * Everything the canvas holds in page percentages goes back to being normalised
 * by the page's *width* on both axes, which is what the column comments in the
 * schema insist on and for the same reason: y divided by the height squashes
 * the space, and a rotation in a squashed space is not a rotation.
 *
 * The whole block every time rather than only what moved. A patch that named
 * one field would be smaller and would also be a promise this cannot keep —
 * the canvas mutates blocks in place and does not remember which fields it
 * touched, so "only what changed" would be a guess.
 */
export function toPatch (block: Block, scan: { width: number, height: number }, position?: number) {
  const aspect = scan.width && scan.height ? scan.width / scan.height : PAGE_RATIO

  return {
    kind: block.type,
    // Where it sits in the reading order, which is its place in the list and
    // nothing the block itself knows. Sent because until it was, dragging a row
    // — and later, sorting the page — rearranged the list in this browser and
    // nowhere else, and a reload put yesterday's order back.
    ...(position === undefined ? {} : { position }),
    cx: (block.x + block.w / 2) / 100,
    cy: (block.y + block.h / 2) / 100 / aspect,
    w: block.w / 100,
    h: block.h / 100 / aspect,
    angle: block.angle ?? 0,
    skewX: block.skewX ?? 0,
    skewY: block.skewY ?? 0,
    // Null rather than absent, so pulling a corner back to nothing clears the
    // column instead of leaving yesterday's distortion in it.
    quad: block.quad?.some((v) => v !== 0) && scan.width
      ? block.quad.map((v) => v / scan.width)
      : null,
    // Null rather than absent for the reason `quad` is: a patch is the whole
    // block, and a room that has gone must clear the column.
    room: block.room
      ? {
          cx: (block.room.x + block.room.w / 2) / 100,
          cy: (block.room.y + block.room.h / 2) / 100 / aspect,
          w: block.room.w / 100,
          h: block.room.h / 100 / aspect,
        }
      : null,
    source: block.source,
    hidden: block.hidden,
  }
}

/**
 * A block on its way to a row it has never had — `toPatch`, plus and minus one
 * field each.
 *
 * Expressed in terms of `toPatch` rather than written out beside it. The two
 * spaces and the aspect handling are argued once at the top of this file and
 * have to stay argued once: a second copy of that arithmetic is a copy that
 * drifts, and the one that drifts is always the one whose reader never saw the
 * header.
 *
 * `position` comes off, because the row is being appended and where it lands is
 * the server's to say. `confidence` goes on, because it is a fact about where
 * the words came from that a patch is deliberately not allowed to change — see
 * the note on `blockPatchSchema` — and so the only chance to state it is here.
 *
 * Nothing else joins it. A draft carries the box, the kind, what was read and
 * whether it is shown; the scan it was found on stays on this machine, which is
 * the one rule this whole application is arranged around.
 */
export function toDraft (block: Block, scan: { width: number, height: number }): BlockDraft {
  return { ...toPatch(block, scan), confidence: block.confidence }
}
