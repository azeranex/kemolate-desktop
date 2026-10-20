/**
 * Where the brush is hovering, in the page's own pixels.
 *
 * Shared state rather than each brush drawing its own ring, because the ring
 * has to be drawn somewhere neither brush can reach. A plate is faded by its
 * row in the layer stack, and the paint canvas lives inside one — so a cursor
 * drawn there would come out at fifty-five per cent over a half-faded plate,
 * which is not how a cursor behaves. It belongs above the whole pile, with the
 * block handles, and that is `Board`'s to place.
 *
 * So the brush that knows where the pointer is puts the position here, and the
 * one element that is in the right part of the stack reads it.
 *
 * ## Not a `useState`, though nearly everything else shared is one
 *
 * This is the one piece of shared state written on every pointer move, and a
 * `useState` lives in Nuxt's payload — which, in development, Nuxt DevTools
 * watches *deeply*: its client plugin re-reads the whole payload after any
 * write to it. So every move of the ring walked every page, every block and
 * every point of every mask correction the chapter holds. Measured on the test
 * chapter, a hover move cost 2.7 ms with that watcher running and 0.24 ms with
 * it paused, and the cost grows with the chapter: fifteen thousand numbers more
 * in the payload made it 7 ms, sixty thousand 19 ms — a whole frame on every
 * move. Every brush paid it. The mask brush is where it was felt, because
 * corrections are what piles up while somebody works the mask — every point of
 * every stroke, for every page — so its ring slowed the longer it was used. The
 * ring itself was never the cost: it is one small component, re-rendered.
 *
 * Out here the position is invisible to that watcher and to anything else that
 * walks the payload. Module scope is safe for this value in particular: only a
 * pointer writes it and the server has none, so no request can see another's.
 * A `shallowRef`, because each point replaces the last whole — there is nothing
 * inside one to watch.
 */
/** The pointer, in page pixels, or nothing when it is off the page. */
const at = shallowRef<{ x: number, y: number } | null>(null)

export function useBrushCursor () {
  /** Put the cursor down and take it up again — the pair every brush needs. */
  const show = (point: { x: number, y: number } | null) => { at.value = point }
  const hide = () => { at.value = null }

  return { at, show, hide }
}
