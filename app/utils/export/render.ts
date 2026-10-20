/**
 * One page, flattened — every layer of its stack drawn at the scan's own
 * resolution, the way the board shows it, into one canvas to export.
 *
 * The board never needed this: it draws the bottom of the pile in the page
 * engine and leaves the rest as page elements, and the browser composites
 * them. An export has no browser compositing to lean on, so the pile is walked
 * here, bottom first, by the same rules the screen uses:
 *
 * - **Rows** come from `paintOrder`, visibility and opacity multiplied through
 *   their groups. A hidden row is not drawn; the mask never is — it is an
 *   editing aid, not part of the page.
 * - **Adjustments** are applied to the row they reach, as the engine applies
 *   them (`adjustLut`, one table per adjustment, nearest first), before its
 *   opacity.
 * - **Paint** is replayed from the strokes (`PaintSession.replayRows`) — a
 *   surface is only a canvas on the page on screen, and an export is every
 *   page. A clone copies from the page *under* its surface exactly as
 *   `paint/under.ts` defines it for the screen: the raster rows below at their
 *   opacity, unadjusted, with no lettering and no mask; for the Clean plate's
 *   retouching, its own repairs as well. So `under` is kept beside the page as
 *   it is built, and is what a surface's `buildFlat` hands out.
 * - **Lettering** comes in already drawn, one canvas per plate — see
 *   `export/letters.ts`.
 *
 * Canvases are the scan's size throughout and each is given back (`width = 0`)
 * as soon as it has been laid down: a 3732 × 5197 page is 78 MB a canvas.
 */
import type { Drawn, PlateAdjust } from '#shared/utils/layers'
import type { ProjectStroke } from '~/utils/project'

import { adjustLut, applyLut } from '#shared/utils/adjust'
import { PaintSession } from '~/utils/paint/session'

/** A picture, and the rectangle of the page it is laid into, in scan pixels. */
export interface Placed {
  bitmap: ImageBitmap | HTMLCanvasElement
  sx: number
  sy: number
  sw: number
  sh: number
}

export interface PageInput {
  /** The scan's size, which everything is drawn at. */
  size: { width: number, height: number }
  scan: ImageBitmap
  /** `paintOrder(stack)` — bottom first. */
  pile: Drawn[]
  /** `plateAdjusts(stack)`, by row key. */
  adjusts: Record<string, PlateAdjust[]>
  /** The Clean plate's repairs. */
  repairs: Placed[]
  /** A placed picture's row, as a picture — or null where its bytes are not here. */
  placed: (row: Drawn) => Placed | null
  /** Every surface's live strokes, by surface key: `bg`, or a sheet's layer id. */
  paint: Record<string, ProjectStroke[]>
  /** A lettering plate, drawn at the scan's size — or null for nothing on it. */
  lettering: (plate: 'dialogue' | 'sfx') => Promise<HTMLCanvasElement | null>
}

const blank = (size: { width: number, height: number }) => {
  const canvas = document.createElement('canvas')

  canvas.width = size.width
  canvas.height = size.height

  return canvas
}

const release = (canvas: HTMLCanvasElement | null) => {
  if (canvas) canvas.width = 0
}

/** Lay pictures into a canvas, each into its rectangle. */
function lay (into: HTMLCanvasElement, pictures: Placed[]) {
  const c = into.getContext('2d')

  if (!c) return

  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'

  for (const one of pictures) {
    if (one.bitmap.width) c.drawImage(one.bitmap, one.sx, one.sy, one.sw, one.sh)
  }
}

/** Put a canvas down on another at an opacity. */
function over (into: HTMLCanvasElement, layer: HTMLCanvasElement, opacity: number) {
  const c = into.getContext('2d')

  if (!c || opacity <= 0) return

  c.globalAlpha = Math.min(1, opacity)
  c.drawImage(layer, 0, 0)
  c.globalAlpha = 1
}

/** A row's adjustments, nearest first, applied to its pixels in place. */
function adjust (layer: HTMLCanvasElement, adjusts: PlateAdjust[]) {
  if (!adjusts.length) return

  const c = layer.getContext('2d', { willReadFrequently: true })

  if (!c) return

  const pixels = c.getImageData(0, 0, layer.width, layer.height)

  for (const one of adjusts) applyLut(pixels.data, adjustLut(one.adjust, one.strength))

  c.putImageData(pixels, 0, 0)
}

/**
 * A surface's strokes, replayed onto a canvas of the page's size. `base` is
 * what is under the surface (see the header): a clone copies from it with the
 * surface's own marks laid over, as `Paint.buildFlat` builds it on screen.
 */
function replay (size: PageInput['size'], strokes: ProjectStroke[], base: HTMLCanvasElement): HTMLCanvasElement | null {
  const live = strokes.filter((row) => !row.retracted)

  if (!live.length) return null

  const surface = blank(size)

  const session = new PaintSession(surface, (region, into) => {
    const flat = region && into && into.width === size.width && into.height === size.height ? into : blank(size)
    const c = flat.getContext('2d')

    if (!c) return null

    const { x, y, w, h } = region ?? { x: 0, y: 0, w: size.width, h: size.height }

    if (w <= 0 || h <= 0) return flat

    c.clearRect(x, y, w, h)
    c.drawImage(base, x, y, w, h, x, y, w, h)
    c.drawImage(surface, x, y, w, h, x, y, w, h)

    return flat
  })

  session.replayRows(live)

  return surface
}

export async function renderPage (input: PageInput): Promise<HTMLCanvasElement> {
  const { size, pile } = input
  const page = blank(size)
  const under = blank(size)

  for (const row of pile) {
    if (!row.visible || row.opacity <= 0) continue
    if (row.kind === 'plate' && row.plate === 'mask') continue

    const adjusts = input.adjusts[row.key] ?? []

    // Lettering: drawn elsewhere, laid down here, and never part of what a
    // clone copies from.
    if (row.kind === 'plate' && (row.plate === 'dialogue' || row.plate === 'sfx')) {
      const letters = await input.lettering(row.plate)

      if (!letters) continue

      adjust(letters, adjusts)
      over(page, letters, row.opacity)
      release(letters)

      continue
    }

    const layer = blank(size)

    if (row.kind === 'plate' && row.plate === 'art') {
      lay(layer, [{ bitmap: input.scan, sx: 0, sy: 0, sw: size.width, sh: size.height }])
    } else if (row.kind === 'image') {
      const picture = input.placed(row)

      if (picture) lay(layer, [picture])
    } else if (row.kind === 'plate' && row.plate === 'clean') {
      lay(layer, input.repairs)

      // The retouching goes over the repairs, and copies from the page with
      // the repairs in it — see `underPlan`, which adds them for `bg` alone.
      const strokes = input.paint.bg ?? []

      if (strokes.length) {
        const base = blank(size)

        over(base, under, 1)
        over(base, layer, row.opacity)

        const surface = replay(size, strokes, base)

        release(base)

        if (surface) {
          over(layer, surface, 1)
          release(surface)
        }
      }
    } else if (row.kind === 'paint') {
      const surface = replay(size, input.paint[row.layer] ?? [], under)

      if (surface) {
        over(layer, surface, 1)
        release(surface)
      }
    }

    // What the next surface up copies from: this row as it stands, unadjusted.
    over(under, layer, row.opacity)

    adjust(layer, adjusts)
    over(page, layer, row.opacity)
    release(layer)
  }

  release(under)

  return page
}
