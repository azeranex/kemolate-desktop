/**
 * Which layers the page engine draws, and which stay in the page as elements.
 *
 * The engine is one canvas, and the lettering is HTML. The two share a single
 * z-order — `paintOrder` numbers every row, plates, sheets and pictures alike,
 * so a sheet can be dragged over the Dialogue — and one canvas can only sit at
 * one height in it. So the engine draws a *run*: the rows from the bottom of
 * the pile up to the first one it does not draw. The default stack's run is
 * Original art, any placed pictures, the Clean plate — its repairs and the
 * hand retouching over them — and the mask while it is hidden, stopping at
 * the lettering: everything a cleaned page is made of below its words. That is
 * the point. They arrive together, in one frame, and the printed lettering is
 * never shown on its own on the way.
 *
 * Blank sheets are drawn too (their `CanvasPaint` hands its canvas over — see
 * `surfaces.ts`), so a sheet between the Clean plate and the lettering is in
 * the run rather than the end of it.
 *
 * A row the engine does not draw ends the run only while it is showing. Hidden,
 * it draws nothing, so going on past it changes nothing on screen — a hidden
 * mask, or a hidden lettering plate, lets the rows above it join the run.
 * Anything a reader has arranged otherwise — a sheet above the lettering, the
 * mask turned on — cuts the run there, and what is above the cut is drawn the
 * old way, as elements. Correct either way; only the run is quick.
 *
 * Adjustments are the engine's where it has a shader for them. The 2D
 * fallback has not — a lookup over every pixel of the view each frame is the
 * cost this whole thing exists to avoid — so there a row an adjustment reaches
 * ends the run, and keeps its SVG filter as an element.
 */
import type { Drawn, PlacedImage, PlateAdjust } from '#shared/utils/layers'

/** One row the engine draws. */
export interface RunRow {
  /** `Drawn.key`: the plate's id, or the row's for a picture or a sheet. */
  key: string
  kind: 'art' | 'clean' | 'image' | 'paint'
  visible: boolean
  /** Nought to one, every group's share multiplied through. */
  opacity: number
  /** Nearest above first, as `plateAdjusts` gives them. */
  adjust: PlateAdjust[]
  image?: PlacedImage
}

export interface Run {
  /** Bottom first. */
  rows: RunRow[]
  /** The keys in it, for the board to leave out of the page's elements. */
  keys: Set<string>
  /** Where the engine canvas sits in the pile — the run's lowest row. */
  z: number
}

/**
 * The run for a pile, bottom first. `shader` is whether the engine can apply
 * adjustments itself; without it, a row an adjustment reaches is not drawn.
 */
export function engineRun (pile: Drawn[], adjusts: Record<string, PlateAdjust[]>, shader: boolean): Run {
  const rows: RunRow[] = []

  for (const drawn of pile) {
    const kind = drawn.kind === 'image' && drawn.image
      ? 'image'
      : drawn.kind === 'paint'
        ? 'paint'
        : drawn.plate === 'art' || drawn.plate === 'clean' ? drawn.plate : null

    const adjust = adjusts[drawn.key] ?? []

    if (!kind || (adjust.length && !shader)) {
      // An element, then — and while it is hidden it draws nothing, so the
      // rows above it can still join the run.
      if (!drawn.visible) continue

      break
    }

    rows.push({
      key: drawn.key,
      kind,
      visible: drawn.visible,
      opacity: drawn.opacity,
      adjust,
      ...(drawn.image ? { image: drawn.image } : {}),
    })
  }

  return { rows, keys: new Set(rows.map((row) => row.key)), z: rows.length ? pile[0]!.z : 0 }
}
