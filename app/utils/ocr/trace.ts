import type { Balloon } from './balloon'
import type { RoomReason } from './rooms'

/**
 * Drawing a balloon measurement back onto a picture of the page — the OCR lab's
 * Balloons run and the workspace's View › Balloon debug both, so the two show a
 * fill the same way and a verdict in the same colour.
 */

/**
 * The colour each verdict's fill is traced in.
 *
 * Outlines in colours no balloon is printed in, and not tints: a translated
 * chapter is often lettered in coloured balloons — istani's are blue, pink and
 * beige — and a blue tint over a blue balloon says nothing at all. Green for a
 * room kept, sky blue for one found round free text the detector drew no
 * balloon for, purple for one refused because it would cover another block,
 * red for a fill that escaped, orange for one that held but came back with less
 * room than the block already had.
 */
export const VERDICT_COLOUR: Partial<Record<RoomReason, string>> = {
  room: 'rgb(0, 200, 80)',
  found: 'rgb(0, 170, 220)',
  clear: 'rgb(0, 150, 140)',
  crowded: 'rgb(170, 0, 220)',
  escaped: 'rgb(230, 0, 0)',
  smaller: 'rgb(255, 140, 0)',
}

/**
 * A fill drawn onto a canvas: its edge traced solid, its inside hatched lightly
 * so its extent reads without hiding the art — a leak is the fill that covers
 * most, and painting it solid would hide exactly what it leaked into.
 *
 * Worked in the sheet's pixels, where the mask is, and drawn a sheet pixel at a
 * time: `size` is how many canvas pixels one sheet pixel covers, so the lab
 * passes the page's scale and the workspace, drawing onto a copy of the sheet
 * itself, a small whole number.
 */
export function traceFill (context: OffscreenCanvasRenderingContext2D, balloon: Balloon, size: number, colour = 'rgb(128, 128, 128)') {
  const { window: win, mask } = balloon
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < win.w && y < win.h && mask[y * win.w + x] === 1

  context.save()
  context.fillStyle = colour

  for (let y = 0; y < win.h; y++) {
    for (let x = 0; x < win.w; x++) {
      if (!inside(x, y)) continue

      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)

      if (edge) context.globalAlpha = 1
      else if ((x + y) % 6 === 0) context.globalAlpha = 0.35
      else continue

      context.fillRect((win.x + x) * size, (win.y + y) * size, size + 1, size + 1)
    }
  }

  context.restore()
}

/** `VERDICT_COLOUR`'s `rgb(r, g, b)` as its three numbers. */
function channels (colour: string): [number, number, number] {
  const [r = 128, g = 128, b = 128] = (colour.match(/\d+/g) ?? []).map(Number)

  return [r, g, b]
}

/**
 * `traceFill`, written straight into a picture's pixels rather than drawn a
 * rectangle at a time — the same edge and the same hatch, at the sheet's own
 * resolution.
 *
 * For the workspace's View › Balloon debug, which traces a whole page's fills
 * on the tab the reader is working in. A canvas call per edge pixel was tens of
 * thousands of them a page, all synchronous, and turning pages quickly while
 * that ran froze the tab; one pass over the masks into a buffer costs a small
 * fraction of it. The picture is scaled up where it is shown, pixelated.
 */
export function paintFill (image: ImageData, balloon: Balloon, colour = 'rgb(128, 128, 128)') {
  const { window: win, mask } = balloon
  const [r, g, b] = channels(colour)
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < win.w && y < win.h && mask[y * win.w + x] === 1

  for (let y = 0; y < win.h; y++) {
    const py = win.y + y

    if (py < 0 || py >= image.height) continue

    for (let x = 0; x < win.w; x++) {
      if (!inside(x, y)) continue

      const px = win.x + x

      if (px < 0 || px >= image.width) continue

      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)
      const alpha = edge ? 255 : (x + y) % 6 === 0 ? 90 : 0

      if (!alpha) continue

      const at = (py * image.width + px) * 4

      image.data[at] = r
      image.data[at + 1] = g
      image.data[at + 2] = b
      image.data[at + 3] = Math.max(image.data[at + 3]!, alpha)
    }
  }
}
