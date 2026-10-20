/**
 * The last few surfaces' finished paint, kept as pixels between visits.
 *
 * A surface is drawn by replaying its stroke log, and a replay costs the stroke
 * over again: every dab, and a coverage readback over what it touched. For the
 * strokes a wide brush makes — cleaning a page's margin in one sweep — that was
 * 170 ms a stroke on a 2654×4025 page (istani, page 19), paid every time the
 * page was turned to, for pixels that had not changed since the last time.
 *
 * So when a canvas moves off a surface its pixels are kept here, filed under the
 * surface (`<scan hash>:<surface key>`, the same name the stroke cache uses)
 * with the rows they were made from. Coming back, the canvas copies them in and
 * replays only what has been added since — or everything, if the rows kept are
 * no longer where they were in the log (an undo, a retraction, a fetch that
 * reordered), because then the pixels are a picture of a log that no longer
 * exists. That check is `Paint.redraw`'s, and it is the same prefix test it
 * already made against its own last drawing.
 *
 * A surface holding a clone stroke is kept with one more fact: which page
 * under it the clones copied from (`under`). Its pixels used to be passed over
 * altogether, since a clone is a picture of that page and nothing said whether
 * it had changed — so every turn to such a page replayed every stroke on it.
 *
 * Memory only, and a few of them: a page-sized canvas is width × height × 4
 * bytes — 43 MB at that size — so this is a cache of the pages somebody is
 * moving between, not of the chapter. Persisting it would be a second copy of
 * the retouching to keep in step with the log, for a cost that is already down
 * to one image copy per page turn.
 */

/** How many surfaces' pixels are held — the oldest goes first. */
const KEEP = 3

interface Kept {
  pixels: HTMLCanvasElement
  /** The rows the pixels are a picture of, in log order — `clientId:seq`. */
  keys: string[]
  /**
   * The page under the surface its clone strokes copied from, as
   * `Paint.underKey` names it — or null where none of the rows is a clone.
   * A clone stroke is a picture of what was under it, so kept pixels holding
   * one are only still right while that has not changed.
   */
  under: string | null
}

const kept = new Map<string, Kept>()

/**
 * Keep a canvas's pixels for a surface, handing the canvas over.
 *
 * The caller must not draw on it again: it is the cache's now, and is copied
 * out rather than lent (`keptPixels`) for the same reason.
 */
export function keepPixels (surface: string, pixels: HTMLCanvasElement, keys: string[], under: string | null = null) {
  if (!pixels.width || !pixels.height || !keys.length) return

  kept.delete(surface)
  kept.set(surface, { pixels, keys: [...keys], under })

  while (kept.size > KEEP) {
    const [oldest] = kept.keys()

    if (oldest === undefined) break

    const gone = kept.get(oldest)

    kept.delete(oldest)

    // Released now rather than whenever the collector gets to it: forty
    // megabytes of canvas is worth giving back on purpose.
    if (gone) gone.pixels.width = 0
  }
}

/** What is kept for a surface, if anything — and it becomes the newest. */
export function keptPixels (surface: string): Readonly<Kept> | undefined {
  const hit = kept.get(surface)

  if (hit) {
    kept.delete(surface)
    kept.set(surface, hit)
  }

  return hit
}
