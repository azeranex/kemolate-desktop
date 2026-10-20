/**
 * The paint surfaces the page engine can draw — each page's retouching and
 * blank sheets, handed over by `CanvasPaint` as the canvases they already are.
 *
 * A surface is painted at the scan's full resolution, as it always was: the
 * brush, the stroke replay, clone and heal all work on that canvas and none of
 * it changed. What changed is where it is shown. While the engine draws its
 * row, the canvas is not on the page at all — it would be a 3732 × 5197
 * element the browser scales every frame at 5× — and the engine puts the part
 * on screen into its own canvas instead, along with everything below it.
 *
 * So the engine has to know what changed, and not re-read the whole surface
 * to find out: a brush stroke touches a few hundred pixels a frame of a
 * twenty-megapixel canvas. Painting reports the rectangle it touched
 * (`touchSurface`, from `PaintSession`'s `onDirty`), and the engine uploads
 * that and nothing else (`takeDirty`).
 */
import { shallowRef } from 'vue'

interface Rect { x0: number, y0: number, x1: number, y1: number }

interface Held {
  canvas: HTMLCanvasElement
  /** What changed since the engine last took it, in canvas pixels. */
  dirty: Rect | null
  /**
   * How many times it has changed — for a reader other than the engine that
   * keeps a picture made from it (`paint/under.ts`), and must know when that
   * picture is out of date without taking the engine's rectangle.
   */
  version: number
}

const surfaces = new Map<string, Held>()

/** Bumped whenever a surface changes, so the engine knows to draw. */
export const surfacesChanged = shallowRef(0)

/** A surface's name: which page, and which of its surfaces. */
export const surfaceKey = (pageId: string, surface: string) => `${pageId}|${surface}`

/** Hand a surface's canvas over, in place of any it had. The whole of it is new. */
export function holdSurface (key: string, canvas: HTMLCanvasElement) {
  surfaces.set(key, { canvas, dirty: { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height }, version: (surfaces.get(key)?.version ?? 0) + 1 })
  surfacesChanged.value++
}

/** Take a surface back — only if it is still this canvas, so a remount cannot undo the one after it. */
export function dropSurface (key: string, canvas: HTMLCanvasElement) {
  if (surfaces.get(key)?.canvas !== canvas) return

  surfaces.delete(key)
  surfacesChanged.value++
}

export function surfaceOf (key: string): HTMLCanvasElement | undefined {
  return surfaces.get(key)?.canvas
}

/** How many times a surface has changed; 0 for one not held. */
export function surfaceVersion (key: string): number {
  return surfaces.get(key)?.version ?? 0
}

/** Part of a surface has changed. Without a rectangle, all of it. */
export function touchSurface (key: string, x?: number, y?: number, w?: number, h?: number) {
  const held = surfaces.get(key)

  if (!held) return

  const whole = x === undefined || y === undefined || w === undefined || h === undefined
  const rect = whole
    ? { x0: 0, y0: 0, x1: held.canvas.width, y1: held.canvas.height }
    : { x0: Math.max(0, Math.floor(x)), y0: Math.max(0, Math.floor(y)), x1: Math.min(held.canvas.width, Math.ceil(x + w)), y1: Math.min(held.canvas.height, Math.ceil(y + h)) }

  held.version++

  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) {
    // Nothing to upload — but a surface sized down to nothing is still news:
    // its texture is 78 MB on a large page, and the engine lets it go only
    // when it draws. Without this it stayed until the view next moved.
    if (whole) surfacesChanged.value++

    return
  }

  held.dirty = held.dirty
    ? { x0: Math.min(held.dirty.x0, rect.x0), y0: Math.min(held.dirty.y0, rect.y0), x1: Math.max(held.dirty.x1, rect.x1), y1: Math.max(held.dirty.y1, rect.y1) }
    : rect
  surfacesChanged.value++
}

/** What has changed since last asked, and forget it — the engine is about to draw it. */
export function takeDirty (key: string): { x: number, y: number, w: number, h: number } | null {
  const held = surfaces.get(key)
  const dirty = held?.dirty

  if (!held || !dirty) return null

  held.dirty = null

  return { x: dirty.x0, y: dirty.y0, w: dirty.x1 - dirty.x0, h: dirty.y1 - dirty.y0 }
}

/** Every surface canvas held now — for the engine to let go of textures of any that are not. */
export function surfaceCanvases (): Set<HTMLCanvasElement> {
  return new Set([...surfaces.values()].map((held) => held.canvas))
}
