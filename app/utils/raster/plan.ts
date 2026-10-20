/**
 * What of a scan to draw, and at what resolution, for the part of the page on
 * screen.
 *
 * The page used to be an `<img>` of the whole scan, scaled by CSS. On a chapter
 * of 3732 × 5197 pages that is 78 MB of pixels per page for a picture drawn a
 * third of that size, and — the part that hurt — the browser decoding it on the
 * main thread as the page turned: flicking through such a chapter stalled for
 * 100–220 ms a turn. The pixels now come from a worker (`decoder.ts`) at the
 * size the screen can show, and this decides what that size is.
 *
 * Two kinds of picture, and nothing else:
 *
 * - the **fit level** — the whole page at the size it is laid out at, times the
 *   device pixel ratio. Always drawn, first, as the floor: it is enough for the
 *   page at its fitted size and anything smaller, and when zoomed in it is what
 *   shows while the sharper tiles are on their way.
 * - **tiles** — squares cut from the full decode at a power-of-two level, only
 *   once the zoom asks for more pixels than the fit level has, and only the
 *   ones in view. Never finer than the scan itself: past 1:1 the tiles are the
 *   scan's own pixels, and the canvas enlarges them.
 *
 * Pure, and in page pixels throughout, so it can be read and tested without a
 * canvas or a worker anywhere near it.
 */

export interface Size {
  width: number
  height: number
}

/** A rectangle in the scan's own pixels. */
export interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The part of the page on screen, in the sheet's own CSS pixels — the page as
 * laid out, before the stage's zoom — and how it is being shown.
 */
export interface ScanView {
  x: number
  y: number
  w: number
  h: number
  /** The sheet's laid-out size, zoom aside. */
  sheet: { w: number, h: number }
  zoom: number
  /** Scan pixels drawn as blocks — from 1:1 up; see `pixelPeek` in the board. */
  crisp: boolean
}

/** One square of a level, and the bitmap size it is cut at. */
export interface Tile {
  /** Stable name within one scan — the level and the grid cell. */
  id: string
  /** Scan pixels per bitmap pixel, inverted: 1 is the scan itself, ½ half of it. */
  scale: number
  /** The scan pixels it covers. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** The bitmap it is cut to. */
  width: number
  height: number
}

/** A tile's edge in bitmap pixels. Small enough to cut in a few ms, large enough to be few. */
export const TILE = 1024

/** The page's laid-out height: the fit in the room, with the margin the canvas keeps. */
export function fittedHeight (room: { w: number, h: number }, ratio: number): number {
  const w = Math.max(0, room.w - 48)
  const h = Math.max(0, room.h - 48)

  return Math.max(120, Math.min(h, w / ratio))
}

/**
 * The fit level's size: the page laid out `sheetHeight` CSS pixels tall, at
 * `dpr` device pixels each. Never larger than the scan — a level bigger than
 * the page is the page with invented pixels.
 */
export function fitLevel (page: Size, sheetHeight: number, dpr: number): Size {
  const scale = Math.min(1, (sheetHeight * dpr) / page.height)

  return {
    width: Math.max(1, Math.round(page.width * scale)),
    height: Math.max(1, Math.round(page.height * scale)),
  }
}

/**
 * The tiles to draw over the fit level, or none.
 *
 * `density` is device pixels per scan pixel as the page is shown now. The level
 * is the coarsest power of two that still has at least that many pixels — so a
 * tile is never enlarged on the way to the screen, until the scan itself is —
 * and nothing is cut while the fit level already has enough.
 */
export function tilesFor (page: Size, view: PageRect, density: number, fit: Size): Tile[] {
  const fitScale = fit.width / page.width

  if (density <= fitScale * 1.01) return []

  const scale = Math.min(1, 2 ** Math.ceil(Math.log2(density)))

  if (scale <= fitScale) return []

  const span = TILE / scale
  const x0 = Math.max(0, Math.floor(view.x / span))
  const y0 = Math.max(0, Math.floor(view.y / span))
  const x1 = Math.min(Math.ceil(page.width / span), Math.ceil((view.x + view.w) / span))
  const y1 = Math.min(Math.ceil(page.height / span), Math.ceil((view.y + view.h) / span))

  const out: Tile[] = []

  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const sx = tx * span
      const sy = ty * span
      const sw = Math.min(span, page.width - sx)
      const sh = Math.min(span, page.height - sy)

      out.push({
        id: `${scale}:${tx}:${ty}`,
        scale,
        sx,
        sy,
        sw,
        sh,
        width: Math.max(1, Math.round(sw * scale)),
        height: Math.max(1, Math.round(sh * scale)),
      })
    }
  }

  return out
}
