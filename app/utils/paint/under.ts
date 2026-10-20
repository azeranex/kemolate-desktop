/**
 * What a paint surface's sampling tools read: the page as it shows under the
 * surface — "current and below", as Photoshop calls it.
 *
 * Clone, heal and the picker read the page *flattened*, and until now that was
 * the scan and the one surface being painted, nothing else. On a cleaned page
 * that is the page before it was cleaned: the picker lifted the black of the
 * printed lettering from the middle of a white balloon, heal took its colour
 * from a ring of it, and a clone from a cleaned balloon stamped the lettering
 * back. Retouching is done on cleaned pages — it is what a clean missed — so
 * the tools were wrong exactly where they were used.
 *
 * So the page under a surface is every row below it in the pile that is
 * showing, drawn as the page engine draws it (`canvas2d.ts`, at the scan's own
 * size): the scan, placed pictures, the Clean plate's repairs and retouching,
 * and blank sheets. For the retouching itself, its own plate's repairs are
 * under it too. What it leaves out, and why:
 *
 * - Anything a surface does not draw: the mask (an editing aid) and the
 *   lettering (HTML — there is no pixel of it to read).
 * - Adjustments. They are a lookup over every pixel, which is a third of a
 *   second here; and an adjustment above the surface reaches the paint as well
 *   as what it was sampled from, so the colour picked is still the one that
 *   shows.
 *
 * A clone stroke is replayed by copying from this, so when it changes — a
 * repair lands, a sheet below is painted — a surface holding clone strokes
 * draws them again. That is the meaning chosen: a clone copies what is below
 * it, as it is. No stroke in either real chapter was a clone when this changed.
 */
import type { Drawn } from '#shared/utils/layers'
import type { Quad } from '~/utils/raster/engine/gpu'
import type { Over } from '~/utils/raster/engine/overs'

import { draw2d } from '~/utils/raster/engine/canvas2d'
import { placedOver } from '~/utils/raster/engine/overs'

/** One picture in the page under a surface, and where it lies in scan pixels. */
export type UnderPart =
  | { from: 'scan' }
  | { from: 'url', over: Over }
  | { from: 'surface', surface: string }

/** One row of the page under a surface, bottom first. */
export interface UnderLayer {
  opacity: number
  parts: UnderPart[]
}

/** Which row a surface is: the Clean plate's retouching, or a blank sheet's own. */
export const isRowOf = (surface: string) => (drawn: Drawn) => surface === 'bg'
  ? drawn.kind === 'plate' && drawn.plate === 'clean'
  : drawn.kind === 'paint' && drawn.layer === surface

/**
 * The rows under a surface, as pictures to draw. `pile` is bottom first;
 * `surfaceName` names a surface as `surfaces.ts` does, and `urlFor` a placed
 * picture's bytes. Null when the surface is not in the pile.
 */
export function underPlan (
  pile: Drawn[],
  surface: string,
  page: { width: number, height: number },
  repairs: Over[],
  surfaceName: (surface: string) => string,
  urlFor: (image: NonNullable<Drawn['image']>) => string | null,
): UnderLayer[] | null {
  const at = pile.findIndex(isRowOf(surface))

  if (at < 0) return null

  const layers: UnderLayer[] = []
  const repairParts = repairs.map((over): UnderPart => ({ from: 'url', over }))

  for (const drawn of pile.slice(0, at)) {
    if (!drawn.visible || drawn.opacity <= 0) continue

    const parts: UnderPart[] = drawn.kind === 'image'
      ? (() => {
          const url = drawn.image ? urlFor(drawn.image) : null
          const over = url && drawn.image ? placedOver(page, drawn.image, url) : null

          return over ? [{ from: 'url' as const, over }] : []
        })()
      : drawn.kind === 'paint'
        ? [{ from: 'surface', surface: surfaceName(drawn.layer) }]
        : drawn.plate === 'art'
          ? [{ from: 'scan' }]
          : drawn.plate === 'clean'
            ? [...repairParts, { from: 'surface', surface: surfaceName('bg') }]
            : []

    if (parts.length) layers.push({ opacity: drawn.opacity, parts })
  }

  // The retouching's own plate: its repairs are under it.
  const own = pile[at]!

  if (surface === 'bg' && repairParts.length && own.opacity > 0) layers.push({ opacity: own.opacity, parts: repairParts })

  return layers
}

/**
 * The page under a surface, drawn at the scan's size. `scan` is the decoded
 * scan where the plan wants it, `pictures` the decoded repairs and placed
 * pictures by URL, `surfaceOf` the canvas of each surface named. A picture
 * that did not decode is left out — the page as far as it can be had.
 */
export function composeUnder (
  size: { width: number, height: number },
  plan: UnderLayer[],
  scan: ImageBitmap | null,
  pictures: Map<string, ImageBitmap>,
  surfaceOf: (surface: string) => HTMLCanvasElement | undefined,
): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas')

  canvas.width = size.width
  canvas.height = size.height

  const layers = plan.map((layer) => ({
    opacity: layer.opacity,
    luts: [],
    quads: layer.parts.flatMap((part): Quad[] => {
      if (part.from === 'scan') return scan ? [{ bitmap: scan, sx: 0, sy: 0, sw: size.width, sh: size.height }] : []

      if (part.from === 'url') {
        const bitmap = pictures.get(part.over.url)

        return bitmap ? [{ bitmap, sx: part.over.sx, sy: part.over.sy, sw: part.over.sw, sh: part.over.sh }] : []
      }

      // Not `surface` on the quad: that would take the engine's record of what
      // changed, and the engine would then not upload it.
      const surface = surfaceOf(part.surface)

      return surface?.width ? [{ bitmap: surface, sx: 0, sy: 0, sw: size.width, sh: size.height }] : []
    }),
  }))

  draw2d(canvas, { layers, scale: 1, shift: { x: 0, y: 0 }, crisp: false })

  return canvas
}

/** Every URL a plan draws — the pictures to decode before composing it. */
export const underUrls = (plan: UnderLayer[]) =>
  [...new Set(plan.flatMap((layer) => layer.parts.flatMap((part) => part.from === 'url' ? [part.over.url] : [])))]

/** Whether a plan draws the scan anywhere. */
export const underScan = (plan: UnderLayer[]) => plan.some((layer) => layer.parts.some((part) => part.from === 'scan'))
