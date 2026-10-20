/**
 * The selected blocks' boxes as numbers — position, size, turn and lean — and
 * the writing of them, for the Transform panel.
 *
 * Everything here is what the canvas handles already do, said in figures: the
 * same box (the one the board's handles are on — `framedBox`, which follows the
 * Lettering / Reading framing), the same write (`updateMany` through the same
 * `boxPatch` rule the board uses: a lettering frame replaced whole, a block's
 * own box patched), and so the same undo and the same sync. A value typed here
 * and a handle dragged to it are one edit.
 *
 * ## In the scan's pixels
 *
 * A box is stored as percentages of the page, which are right for storage and
 * mean nothing to somebody typing: 12.37% of what? So the fields read and write
 * scan pixels, via `toOriented` / `toBoxed`, exactly as the board's drags do.
 * X and Y are the box's left and top before it is turned — the corner the
 * numbers were measured from, not wherever a rotation has carried it.
 *
 * ## Several blocks
 *
 * A field shows a value only where every selected block has it, and nothing —
 * "mixed" — otherwise; a value set is set on every one of them. The Lettering
 * panel's rule, for the reason it gives: a field showing the first block's
 * value reads as "they are all this", and editing it would then be the only way
 * to find out they were not.
 *
 * ## Zeros have to be written, not left out
 *
 * `toBoxed` leaves a turn or lean of nought off the box, which is right for a
 * box being made and wrong for one being *changed*: the patch is merged into
 * the block, so an absent `angle` leaves the old angle where it was. Every
 * write here says all four — angle, both leans and the corners — explicitly.
 */
import type { Oriented } from '#shared/utils/transform'
import type { Block, LetterBox } from './useComic'

export type TransformField = 'x' | 'y' | 'w' | 'h' | 'angle' | 'skewX' | 'skewY'

export const TRANSFORM_FIELDS: TransformField[] = ['x', 'y', 'w', 'h', 'angle', 'skewX', 'skewY']

/** Below this a box is a line, and no longer something that can hold a word. */
const SMALLEST = 1

/** A field's value as shown: whole pixels, and degrees to a tenth. */
const shown = (field: TransformField, value: number) => (field === 'angle' || field === 'skewX' || field === 'skewY'
  ? Math.round(value * 10) / 10
  : Math.round(value))

function read (box: Oriented, field: TransformField): number {
  switch (field) {
    case 'x': return box.cx - box.w / 2
    case 'y': return box.cy - box.h / 2
    case 'w': return box.w
    case 'h': return box.h
    default: return box[field]
  }
}

export function useTransform () {
  const { page, selected, selection, framedBox, writesLetter, updateMany } = useComic()

  /** Keep W and H in proportion when either is set — this browser's choice, for the session. */
  const locked = useState('transform-locked', () => false)

  const size = computed(() => (page.value ? pageSize(page.value) : { width: 0, height: 0 }))

  /** Each selected block with the box its handles are on, in scan pixels. Empty on an unmeasured page. */
  const boxes = computed(() => {
    const scan = size.value

    if (!scan.width || !scan.height) return []

    return selected.value.map((block) => ({ block, box: toOriented(framedBox(block), scan) }))
  })

  /** Each field's value, or null where the selected blocks disagree (or there are none). */
  const values = computed(() => Object.fromEntries(TRANSFORM_FIELDS.map((field) => {
    const all = boxes.value.map(({ box }) => shown(field, read(box, field)))

    return [field, all.length && all.every((one) => one === all[0]) ? all[0]! : null]
  })) as Record<TransformField, number | null>)

  /** Whether any selected box has had its corners pulled about. */
  const distorted = computed(() => boxes.value.some(({ box }) => isDistorted(box)))

  /** Whether any selected box is turned, leaning or distorted — anything Reset would undo. */
  const transformed = computed(() => boxes.value.some(({ box }) => box.angle || box.skewX || box.skewY || isDistorted(box)))

  /** A box as a patch for its block, with every zero said out loud — see the header. */
  function patchFor (block: Block, next: Oriented): Partial<Block> {
    const plain: LetterBox = {
      angle: undefined,
      skewX: undefined,
      skewY: undefined,
      quad: undefined,
      ...toBoxed(next, size.value),
    }

    if (!writesLetter(block)) return plain

    // A lettering frame is replaced whole, and carried without the undefined
    // keys, which would otherwise ride along into every copy of it.
    const letter = Object.fromEntries(Object.entries({ ...letterBoxOf(block), ...plain })
      .filter(([, value]) => value !== undefined)) as unknown as LetterBox

    return { letter }
  }

  /** Change every selected box, one edit — `merge` folds a run of them into one undo step. */
  function write (change: (box: Oriented) => Oriented, merge: string) {
    const moves = boxes.value.map(({ block, box }) => ({ id: block.id, patch: patchFor(block, change({ ...box })) }))

    if (moves.length) updateMany(moves, undefined, `transform:${selection.value.join()}:${merge}`)
  }

  /** Set one field on every selected block. */
  function set (field: TransformField, value: number) {
    if (!Number.isFinite(value)) return

    write((box) => {
      const left = box.cx - box.w / 2
      const top = box.cy - box.h / 2

      switch (field) {
        case 'x':
          return { ...box, cx: value + box.w / 2 }
        case 'y':
          return { ...box, cy: value + box.h / 2 }
        case 'w': {
          // The left and top edges stay where they are, as a field in any
          // drawing program leaves them; the proportion follows if it is locked.
          const w = Math.max(SMALLEST, value)
          const h = locked.value && box.w ? Math.max(SMALLEST, (box.h * w) / box.w) : box.h

          return { ...box, w, h, cx: left + w / 2, cy: top + h / 2 }
        }
        case 'h': {
          const h = Math.max(SMALLEST, value)
          const w = locked.value && box.h ? Math.max(SMALLEST, (box.w * h) / box.h) : box.w

          return { ...box, w, h, cx: left + w / 2, cy: top + h / 2 }
        }
        case 'angle':
          return { ...box, angle: wrapDeg(value) }
        case 'skewX':
          return { ...box, skewX: clampDeg(value) }
        case 'skewY':
          return { ...box, skewY: clampDeg(value) }
      }
    }, field)
  }

  /** Put pulled corners back where the box's own rectangle has them. */
  function straighten () {
    write((box) => ({ ...box, quad: null }), 'straighten')
  }

  /** Turn, lean and corners all back to nothing; position and size are kept. */
  function reset () {
    write((box) => ({ ...box, angle: 0, skewX: 0, skewY: 0, quad: null }), 'reset')
  }

  return { boxes, values, locked, distorted, transformed, set, straighten, reset }
}
