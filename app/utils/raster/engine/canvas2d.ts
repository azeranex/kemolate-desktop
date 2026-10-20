/**
 * The page engine on a 2D canvas — where WebGPU will not open.
 *
 * The same frames as `gpu.ts`, drawn with `drawImage`. Two differences, both
 * deliberate. It has no adjustment pass: a lookup over every pixel of the view
 * is what a shader is for, so on this path `engineRun` leaves a row an
 * adjustment reaches to the page's elements and their SVG filter. And it is
 * not redrawn on every frame of a gesture, which was measured at 17–33 ms
 * frames — see `Engine.vue`, which lets the stage carry the last drawing here.
 *
 * A layer with an opacity is drawn onto a scratch canvas and put down whole,
 * for the reason `gpu.ts` gives: an opacity belongs to the layer, not to each
 * picture in it, and tiles lie over the fit level they sharpen.
 */
import { takeDirty } from './surfaces'

import type { Frame } from './gpu'

const scratches = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>()

export function draw2d (canvas: HTMLCanvasElement, frame: Frame) {
  const context = canvas.getContext('2d')

  if (!context) return

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = 1
  context.clearRect(0, 0, canvas.width, canvas.height)

  for (const layer of frame.layers) {
    if (!layer.quads.length || layer.opacity <= 0) continue

    const whole = layer.opacity >= 1
    let into = context

    if (!whole) {
      let scratch = scratches.get(canvas)

      if (!scratch) {
        scratch = document.createElement('canvas')
        scratches.set(canvas, scratch)
      }

      scratch.width = canvas.width
      scratch.height = canvas.height

      const own = scratch.getContext('2d')

      if (!own) continue

      into = own
    }

    into.imageSmoothingEnabled = !frame.crisp
    into.imageSmoothingQuality = 'high'
    into.setTransform(frame.scale, 0, 0, frame.scale, frame.shift.x, frame.shift.y)

    for (const quad of layer.quads) {
      // A surface is drawn whole every time: this path redraws only when it
      // must, and has no texture to keep up to date. Its dirty rectangle is
      // taken all the same, so it does not grow for good.
      if (quad.surface) takeDirty(quad.surface)
      if (quad.bitmap.width) into.drawImage(quad.bitmap, quad.sx, quad.sy, quad.sw, quad.sh)
    }

    if (!whole) {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = layer.opacity
      context.drawImage(into.canvas, 0, 0)
      context.globalAlpha = 1
    }
  }
}
