/**
 * A stage of the work, laid on one page's stack — the desktop's `layers.preset`.
 *
 * In the web build a preset reaches the pages that are not on screen through
 * the server: `PUT …/layers/preset` sets the standard rows of every page's
 * stack in one statement, and the browser only arranges the page it is
 * showing. A local workspace has no server, and the desktop has nothing else,
 * so the browser arranges every page itself — and this is the rule it does it
 * by, kept apart from `useLayerPresets` so it can be checked without a chapter.
 *
 * It is the server's rule restated, not a looser one: three fields — `visible`,
 * `opacity`, `locked` — on the rows `standardUids` names, wherever they sit in
 * the tree, and nothing else. No row is inserted, removed, reordered or
 * re-parented, and a row a reader added is never named, so no arrangement can
 * cost anybody a sheet, a group, an adjustment or a placed picture. The scan's
 * lock is `fixed` and stays shut whatever a stage says.
 */
import type { LayerPreset, StackLayer } from './layers'

import { DEFAULT_STACK, standardUids } from './layers'

/**
 * Set the rows a preset names, in place, and hand the same stack back.
 *
 * In place because the stack it is given is a page's own, behind Vue's proxy:
 * changing its rows is what lets the cache see *which* page changed (see
 * `useLayerCache`), where a new array would read as a whole new stack.
 */
export function arrangeStack (stack: StackLayer[], preset: LayerPreset): StackLayer[] {
  const allowed = standardUids()

  const walk = (rows: StackLayer[]) => {
    for (const row of rows) {
      const wanted = allowed.has(row.id) ? preset.rows[row.id] : undefined

      if (wanted) {
        row.visible = wanted.visible

        if (wanted.opacity !== undefined) row.opacity = wanted.opacity

        // Left alone when the stage says nothing, which is how the scan keeps
        // the lock that is not the reader's to open — see `StackLayer.fixed`.
        if (wanted.locked !== undefined && !row.fixed) row.locked = wanted.locked
      }

      walk(row.children ?? [])
    }
  }

  walk(stack)

  return stack
}

/**
 * A page's stack under a stage: its own, arranged, or the stack every page is
 * founded with where it has none yet — a page is staged whether or not it has
 * been given its rows, or the first time it got them it would arrive outside
 * the stage the rest of the chapter is in.
 */
export function stageStack (stack: StackLayer[] | undefined, preset: LayerPreset): StackLayer[] {
  return arrangeStack(stack ?? structuredClone(DEFAULT_STACK), preset)
}
