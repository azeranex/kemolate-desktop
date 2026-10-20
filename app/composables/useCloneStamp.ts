/**
 * Where the clone stamp is copying from, and how that answer is arrived at.
 *
 * The stamp is the one paint tool whose mark depends on somewhere *other* than
 * the pointer, which is the whole of what makes it awkward to aim: everything
 * else in the toolbar puts down what you chose, and this puts down whatever
 * happens to be at a place you set a moment ago and cannot see. Photoshop
 * solves that with three things and so does this — alt to pick the source, a
 * preview of what is under it while you hover, and an offset that stops moving
 * once you commit to it.
 *
 * ## Anchored, then pinned
 *
 * They are different moments and conflating them is the bug this replaces.
 *
 * **Anchoring** is alt-clicking a source. From then until the first stroke,
 * every press would copy from that exact point — so hovering shows the source
 * standing still while the ring moves over it, which is how you line a repair
 * up against the thing it is repairing.
 *
 * **Pinning** happens on the first ordinary click after anchoring. From then on
 * what is fixed is the *offset*, not the point: the source travels with the
 * brush, a constant distance away, so a second stroke continues the copy rather
 * than starting it again. Before this existed the offset was recomputed at
 * every press from the anchored point, which meant every stroke re-copied the
 * same patch and a repair could only ever be one stroke long.
 *
 * ## Why the page is captured as an image
 *
 * The preview is a circle of the page shown under the cursor, and it has to be
 * drawn above the whole layer stack — see `useBrushCursor`, which explains why
 * a cursor drawn beside the paint canvas comes out faded by that plate's own
 * opacity. Handing that element a canvas would mean re-cutting a disc out of it
 * on every pointer move; handing it an object URL means the browser does the
 * cutting, in CSS, for nothing. The flattened page is captured once when the
 * source is anchored, which is exactly when what it would copy is decided.
 */
import type { Point } from '#shared/utils/raster'

/** The page as it looked when the source was anchored, for the hover preview. */
interface Sheet {
  url: string
  width: number
  height: number
}

export function useCloneStamp () {
  /** The point alt-click chose, in page pixels. Null until somebody picks one. */
  const source = useState<Point | null>('clone-source', () => null)

  /**
   * Source minus the first press, once there has been one.
   *
   * Null between anchoring and that press, which is a state with its own
   * meaning rather than a missing value: it is "the next stroke copies from the
   * anchor itself", and it is what makes the preview stand still while you aim.
   */
  const offset = useState<Point | null>('clone-offset', () => null)

  /** Alt is down and the stamp is out: the next click picks rather than paints. */
  const picking = useState<boolean>('clone-picking', () => false)

  const sheet = useState<Sheet | null>('clone-sheet', () => null)

  /** Whether there is anything to copy from yet. */
  const armed = computed(() => Boolean(source.value))

  function release () {
    if (sheet.value) URL.revokeObjectURL(sheet.value.url)

    sheet.value = null
  }

  /** Forget the source entirely — another tool, another page, another chapter. */
  function clear () {
    release()
    source.value = null
    offset.value = null
    picking.value = false
  }

  /**
   * Take this point as the source, and keep a picture of the page to show from.
   *
   * The capture is deliberately of the page *now*: a clone stamp copies what was
   * there when you pointed at it, and a preview that tracked later strokes would
   * show the repair eating itself. `toBlob` rather than `toDataURL` because this
   * is a whole scan — the base64 of a 1127×1600 page is megabytes of string, and
   * an object URL is a handle.
   */
  async function anchor (at: Point, flat: HTMLCanvasElement | null) {
    release()

    source.value = { x: at.x, y: at.y }
    // A fresh source is a fresh decision; whatever was pinned to the last one
    // has nothing to do with this one.
    offset.value = null

    if (!flat) return

    const blob = await new Promise<Blob | null>((resolve) => flat.toBlob(resolve, 'image/png'))

    if (!blob) return

    // Checked again because the await let go of the thread: the tool may have
    // changed, or a second alt-click may have started its own capture, and the
    // loser of that race must not leave its URL as the winner's.
    if (!source.value || source.value.x !== at.x || source.value.y !== at.y) return

    sheet.value = { url: URL.createObjectURL(blob), width: flat.width, height: flat.height }
  }

  /**
   * The offset this press should paint with, fixing it if this is the first.
   *
   * Null when nothing is anchored, which is the caller's cue to say so rather
   * than to paint nothing quietly.
   */
  function pin (at: Point): Point | null {
    if (!source.value) return null

    offset.value ??= { x: source.value.x - at.x, y: source.value.y - at.y }

    return offset.value
  }

  /**
   * Where the source sits for a pointer here — the centre of the preview.
   *
   * The anchor itself until the offset is pinned, and the pointer plus the
   * offset afterwards. Those are the same point at the instant of pinning,
   * which is what makes the preview appear to stay put through the click that
   * changes its meaning.
   */
  function aim (at: Point): Point | null {
    if (offset.value) return { x: at.x + offset.value.x, y: at.y + offset.value.y }

    return source.value
  }

  return { source, offset, picking, sheet, armed, anchor, pin, aim, clear }
}
