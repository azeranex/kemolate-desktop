/**
 * Lining the selected blocks up — against each other, against one of them, or
 * against the page — and spacing several of them out evenly.
 *
 * Its own composable rather than part of `useComic`, for the reason
 * `useBlockMerge` is: this is a utility *on* a selection rather than part of
 * what a selection is, and the panel is not the only thing that will ever ask
 * for it. The key object itself is not here — it belongs to the selection and
 * lives with it; see `keyed` in `useComic`.
 *
 * ## Everything is measured in the scan's own pixels
 *
 * A block is stored in percentages of the page box — `x`/`w` of its width,
 * `y`/`h` of its height — and that space is stretched unevenly, so an outline
 * cannot be measured in it. A block turned thirty degrees has a bounding box
 * whose shape depends on the page's proportions, and lining blocks up by boxes
 * measured there puts them somewhere nobody asked for; on a squarish page it
 * would be nearly right, which is the worst way for it to be wrong. So every
 * measurement converts in through `toOriented`, and the same argument
 * `shared/utils/transform` makes for drags holds here.
 *
 * Only the *move* converts back out, and as a delta on `x` or `y` rather than a
 * whole box. A block that has never been turned therefore still carries no
 * angle afterwards — writing a box back through `toBoxed` would be the ordinary
 * way to undo that, since a patch is merged onto the block.
 *
 * A page nothing has measured has no such pixels, so the controls are off until
 * the file has been read or the workspace has recorded the page's size (see
 * `pageSize`) — the same bargain `transpose` makes in the Blocks panel, rather
 * than quietly working from a page whose shape is being guessed.
 *
 * ## What moves
 *
 * Whatever a drag on the page would move — `framedBox`, the box the grips are
 * drawn on — measured there and written there. On a translated block that is
 * the *lettering frame*, not the box the words were read from.
 *
 * It used to be the block's own box on every block, which on a translated page
 * was wrong both ways. A block whose lettering had a frame of its own did not
 * move at all, because the text is drawn in the frame and the frame was never
 * touched — and it was lined up by an outline nobody could see. A block whose
 * lettering still sat on its box did move, but by moving the rectangle the
 * repair was cut from, which is the failure `Block.letter` exists to end. The
 * write-side rule is `writesLetter`, the same one the canvas's `writeBox` and
 * the Blocks panel's transpose follow.
 *
 * A balloon made of columns moves the way dragging it does — as the one object
 * the rest of the app sees — and the per-column boxes it was assembled from are
 * left as they were measured.
 */
import type { Block, LetterBox } from './useComic'

/** Which way the blocks are being lined up. */
export type AlignAxis = 'x' | 'y'

/** Which part of a block is being lined up: its near edge, middle, or far edge. */
export type AlignEdge = 'start' | 'centre' | 'end'

/** What they are being lined up against. */
export type AlignTo = 'selection' | 'key' | 'page'

/** The scan's size — the space all of this happens in. */
interface Size {
  width: number
  height: number
}

/** An axis-aligned extent, in the scan's own pixels. */
interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Below this a move is not one. A hundredth of a scan pixel is invisible at any
 * zoom, and writing it would file a step on the timeline whose only effect is a
 * press of Cmd+Z that appears to do nothing — which is what happens to every
 * block that was already where the alignment wanted it.
 */
const HAIR = 0.01

/**
 * What a block actually covers on the page, turned, leant and pulled about.
 *
 * The corners come out of the same `cornersOf` the drag arithmetic uses, run
 * through the same matrix — so a sound effect running diagonally across a panel
 * is lined up by the box you can see round it rather than by the upright
 * rectangle it is stored as.
 */
function boundsOf (frame: LetterBox, scan: Size): Bounds {
  const box = toOriented(frame, scan)
  const m = matrixOf(box)
  const points = cornersOf(box).map((corner) => mapped(m, corner.x, corner.y))
  const xs = points.map((p) => box.cx + p.x)
  const ys = points.map((p) => box.cy + p.y)

  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** The one number an alignment compares: where this edge of this box sits. */
function edgeAt (bounds: Bounds, axis: AlignAxis, edge: AlignEdge): number {
  const lo = axis === 'x' ? bounds.x0 : bounds.y0
  const hi = axis === 'x' ? bounds.x1 : bounds.y1

  if (edge === 'start') return lo
  if (edge === 'end') return hi

  return (lo + hi) / 2
}

/** Everything the blocks cover between them. */
function union (all: Bounds[]): Bounds {
  return {
    x0: Math.min(...all.map((b) => b.x0)),
    y0: Math.min(...all.map((b) => b.y0)),
    x1: Math.max(...all.map((b) => b.x1)),
    y1: Math.max(...all.map((b) => b.y1)),
  }
}

/** A move along one axis, back in the percentages a box is stored in. */
function shifted (frame: LetterBox, axis: AlignAxis, delta: number, scan: Size): Partial<LetterBox> {
  return axis === 'x'
    ? { x: frame.x + (delta / scan.width) * 100 }
    : { y: frame.y + (delta / scan.height) * 100 }
}

export function useAlign () {
  const { page, selected, keyed, keyBlock, updateMany, framedBox, writesLetter } = useComic()

  /** Where a block is, as far as lining up goes — see "What moves". */
  const bounds = (block: Block, size: Size) => boundsOf(framedBox(block), size)

  /**
   * One block moved, onto whichever of its boxes a drag would have moved. A
   * lettering frame is replaced whole and the block's box patched — the same
   * division `writeBox` makes on the canvas, and for the same reason.
   */
  function moved (block: Block, axis: AlignAxis, delta: number, size: Size): Partial<Block> {
    const move = shifted(framedBox(block), axis, delta, size)

    return writesLetter(block) ? { letter: { ...letterBoxOf(block), ...move } } : move
  }

  /**
   * The scan's own size, and null while nobody knows it. Through `pageSize`, so
   * a page whose file is on another machine is lined up at the size its
   * workspace recorded rather than refused.
   */
  const scan = computed<Size | null>(() => {
    const found = page.value && pageSize(page.value)

    return found?.width && found.height ? found : null
  })

  /**
   * What is chosen in the list when no key has been named.
   *
   * `useState` rather than a ref because the panel can be dragged into the
   * other dock, and being dragged unmounts it — the same reason the Blocks
   * panel keeps its own toggle there.
   */
  const preference = useState<Exclude<AlignTo, 'key'>>('align-to', () => 'selection')

  /**
   * What the alignment measures against.
   *
   * Read off whether a key has been named rather than kept beside it, and that
   * is the whole of what keeps the two from disagreeing. Naming a key *is*
   * choosing to align to it, as it is in Illustrator — there would be nothing
   * else to do with one — and choosing anything else here takes the name off,
   * because a key nothing measures from is a heavier outline on the page that
   * means nothing.
   *
   * "Key object" cannot be chosen from the list, only shown there: a key is a
   * block, and the only place to say which block is the page. The list item
   * says so rather than sitting there enabled with nothing to point at.
   */
  const alignTo = computed<AlignTo>({
    get: () => (keyBlock.value ? 'key' : preference.value),
    set: (value) => {
      if (value === 'key') return

      keyed.value = null
      preference.value = value
    },
  })

  /**
   * The blocks a press will actually move — everything picked, less the key.
   *
   * The key stays exactly where it is, which is the point of naming one: it is
   * the thing being lined up *on*, and moving it as well would leave nothing
   * standing still to line up against.
   */
  const movers = computed(() =>
    alignTo.value === 'key' ? selected.value.filter((block) => block.id !== keyed.value) : selected.value)

  /**
   * Whether lining up would mean anything.
   *
   * One block against the page does — it moves to an edge of the paper. One
   * block against *itself* does not, which is what aligning a selection of one
   * to the selection comes to.
   */
  const alignable = computed(() => Boolean(scan.value)
    && movers.value.length > 0
    && (alignTo.value !== 'selection' || selected.value.length > 1))

  /**
   * Distribute needs three. Two blocks are already evenly spaced — there is
   * nothing between them to place — and the pair at the ends is what everything
   * else is spaced between.
   */
  const distributable = computed(() => Boolean(scan.value) && selected.value.length > 2)

  /**
   * Line the selection up on one edge or middle.
   *
   * The frame is whatever "align to" names: the whole selection's extent, the
   * key's own, or the page. Aligning to the selection means aligning to the
   * outermost block on that side, which is what the union of their boxes comes
   * to and why it is measured over the selection rather than over `movers`.
   */
  function align (axis: AlignAxis, edge: AlignEdge) {
    const size = scan.value

    if (!size || !alignable.value) return

    const key = keyBlock.value
    const frame = alignTo.value === 'page'
      ? { x0: 0, y0: 0, x1: size.width, y1: size.height }
      : key
        ? bounds(key, size)
        : union(selected.value.map((block) => bounds(block, size)))

    const want = edgeAt(frame, axis, edge)

    // One step for the whole selection — see `updateMany`, which exists so that
    // one press of a button is one press of Cmd+Z.
    updateMany(movers.value.flatMap((block) => {
      const delta = want - edgeAt(bounds(block, size), axis, edge)

      if (Math.abs(delta) < HAIR) return []

      return [{ id: block.id, patch: moved(block, axis, delta, size) }]
    }))
  }

  /**
   * Space the selection out evenly along one axis, measured from the named edge
   * of each block.
   *
   * The two on the ends stay where they are and everything between them is laid
   * out at equal steps — Illustrator's Distribute Objects, which is about where
   * the blocks *are* rather than about the gaps between them. Sorted by where
   * each one sits rather than by the order they were picked, so the row keeps
   * the order it has on the page instead of being shuffled into the order
   * somebody clicked.
   *
   * The key object is deliberately not read here. It is what Distribute
   * *Spacing* uses — the other half of Illustrator's panel, which sets an exact
   * gap — and this panel does not offer that; treating the key as a fixed point
   * of this would be a different operation wearing these icons.
   */
  function distribute (axis: AlignAxis, edge: AlignEdge) {
    const size = scan.value

    if (!size || !distributable.value) return

    const row = selected.value
      .map((block) => ({ block, at: edgeAt(bounds(block, size), axis, edge) }))
      .sort((a, b) => a.at - b.at)

    const first = row[0]!
    const step = (row[row.length - 1]!.at - first.at) / (row.length - 1)

    updateMany(row.flatMap(({ block, at }, index) => {
      const delta = first.at + index * step - at

      if (Math.abs(delta) < HAIR) return []

      return [{ id: block.id, patch: moved(block, axis, delta, size) }]
    }))
  }

  return { alignTo, alignable, distributable, keyBlock, measured: computed(() => Boolean(scan.value)), align, distribute }
}
