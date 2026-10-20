/**
 * The size and the edge, set on the page with the right button held.
 *
 * The gesture every editor has, and the reason it is worth having: a brush is
 * adjusted between two marks, with the hand already where the marks are going.
 * Leaving the page for the bar to change a number and coming back is the part
 * that gets counted in hundreds over a chapter.
 *
 * ## Why it lives here rather than in a brush
 *
 * It was the mask brush's, written into that component — and the paint brush
 * simply did not have it, while the bar's tooltip promised it for every tool.
 * A person who learned the gesture on one brush found it dead on the other, and
 * nothing said why. One definition, both brushes, and a third brush gets it by
 * asking.
 *
 * A caller keeps its own pointer handling and hands the events over: `begin`
 * says whether it took the press, `move` whether it consumed the move, and both
 * answer false when this gesture is not the one happening — so a component's
 * own drag logic reads as an `if` rather than as a flag it has to maintain.
 *
 * State per caller rather than shared, deliberately: two brushes are never
 * being dragged at once, and a component that unmounts mid-gesture should take
 * its own half-finished drag with it rather than leave it for the next one.
 */

/** Pixels of vertical drag that carry the edge from crisp to gone. */
const SOFTNESS_THROW = 220

/**
 * How far a drag has to go before it decides which axis it is on.
 *
 * One axis at a time, because no hand drags in a straight line: reaching out
 * for a wider brush drifted down a few pixels on the way and softened it too,
 * so a gesture aimed at one setting quietly changed two. Whichever direction
 * leads once the pointer has moved this far wins for the rest of the drag, and
 * the other setting is left exactly as it was found.
 *
 * Small enough to feel immediate, large enough that the first two or three
 * jittery pixels of a press do not get to choose.
 */
const AXIS_LOCK = 6

export function useBrushGesture () {
  const { size, softness } = usePaintSettings()

  let sizing: {
    x: number
    y: number
    size: number
    softness: number
    axis: 'size' | 'softness' | null
  } | null = null

  /**
   * Whether a drag is running — shared, unlike the drag itself.
   *
   * The numbers belong to the brush being dragged and nobody else needs them.
   * The *fact* is different: the cursor is drawn by another component
   * altogether, and it has to know. Alt is the sampling modifier as well as the
   * one named in the tooltip for this gesture, so holding it turned the rings
   * into a pipette's target — while a size drag is the one moment the rings are
   * the entire point of looking. See `BrushCursor`.
   */
  const adjusting = useState('brush-adjusting', () => false)

  /*
   * A component that goes away mid-drag takes the drag with it, and the flag
   * has to go too — otherwise the cursor is left describing a gesture that
   * nobody is making and alt never draws a target again.
   */
  onScopeDispose(() => {
    if (!sizing) return

    sizing = null
    adjusting.value = false
  }, true)

  /**
   * The right button, taken.
   *
   * Alt is not asked for, though the tooltip names it: the right button alone
   * has nothing else to do over a canvas, and a modifier that is optional in
   * practice should not be a rule in the code.
   */
  function begin (event: PointerEvent): boolean {
    if (event.button !== 2) return false

    sizing = {
      x: event.clientX,
      y: event.clientY,
      size: size.value,
      softness: softness.value,
      axis: null,
    }

    adjusting.value = true

    // Synthetic pointers have no capturable id, and losing capture only costs
    // the drag ending at the window's edge — not worth failing the gesture for.
    try {
      (event.target as HTMLElement).setPointerCapture(event.pointerId)
    } catch { /* nothing to capture */ }

    event.preventDefault()

    return true
  }

  /**
   * `scale` is screen pixels per page pixel, so a pixel of drag is a pixel of
   * diameter on the page and the ring grows at the speed the hand moves. The
   * edge has no size to keep pace with, so it is measured against the window.
   */
  function move (event: PointerEvent, scale: number): boolean {
    if (!sizing) return false

    const dx = event.clientX - sizing.x
    const dy = event.clientY - sizing.y

    if (!sizing.axis && Math.hypot(dx, dy) >= AXIS_LOCK) {
      sizing.axis = Math.abs(dx) >= Math.abs(dy) ? 'size' : 'softness'
    }

    if (sizing.axis === 'size') size.value = clampSize(sizing.size + dx / Math.max(scale, 0.05))

    // Down softens, up sharpens — the direction a finger already means when it
    // is smudging something.
    if (sizing.axis === 'softness') {
      softness.value = Math.min(1, Math.max(0, sizing.softness + dy / SOFTNESS_THROW))
    }

    return true
  }

  /** The release, whoever hears it. True when there was a drag to end. */
  function end (): boolean {
    const was = sizing !== null

    sizing = null
    adjusting.value = false

    return was
  }

  return { adjusting, begin, move, end }
}
