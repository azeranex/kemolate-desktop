/**
 * The board's view as arithmetic: where a point on the page lands on screen,
 * and where a point on screen lands on the page.
 *
 * The stage wears one transform — translate by the pan, then scale about the
 * top left — over a sheet that is centred in the room before either says
 * anything. The chrome is drawn outside that transform (see `Board`, which says
 * why a hairline cannot survive inside it), so everything the chrome places has
 * to do the transform by hand, and a pointer arriving in window coordinates has
 * to be taken back through it.
 *
 * The second half used to be a `getBoundingClientRect` of the sheet on every
 * pointer move of a rubber band or a turn. Read straight after the previous
 * move's render had written to the page, that is the browser laying the page out
 * again to answer, once a move. Worked out from the pan and the zoom it costs
 * nothing, and it stays right when the view moves mid-gesture — a captured
 * rectangle would not.
 *
 * One function and its inverse, pure, so the drawing and the pointer cannot
 * drift apart and both can be tested without a page.
 */

/** Where the view stands. Every length is in screen pixels. */
export interface BoardView {
  /** The stage's translation. */
  pan: { x: number, y: number }
  /** The stage's scale. */
  zoom: number
  /** The canvas the page is shown in — the board's viewport. */
  room: { w: number, h: number }
  /** The sheet's laid-out size, zoom aside. */
  sheet: { w: number, h: number }
}

interface Point { x: number, y: number }

/** Where the sheet's top left sits in the stage before the transform: centred in the room. */
export function sheetCorner (view: Pick<BoardView, 'room' | 'sheet'>): Point {
  return { x: (view.room.w - view.sheet.w) / 2, y: (view.room.h - view.sheet.h) / 2 }
}

/**
 * A point on the sheet, in its own laid-out pixels, as the viewport shows it.
 *
 * Centred first, then scaled about the top left, then panned — the stage's
 * transform, in the order the stage applies it.
 */
export function sheetToView (view: BoardView, p: Point): Point {
  const corner = sheetCorner(view)

  return {
    x: view.pan.x + view.zoom * (corner.x + p.x),
    y: view.pan.y + view.zoom * (corner.y + p.y),
  }
}

/** A point in the viewport, back on the sheet — `sheetToView` run backwards. */
export function viewToSheet (view: BoardView, q: Point): Point {
  const corner = sheetCorner(view)

  return {
    x: (q.x - view.pan.x) / view.zoom - corner.x,
    y: (q.y - view.pan.y) / view.zoom - corner.y,
  }
}

/**
 * The part of the sheet the viewport shows, in the sheet's own pixels and held
 * to the sheet — the viewport's corners run back through the transform.
 *
 * `margin` widens it by that many screen pixels each side, so a pan shows no
 * undrawn edge in the frame before whatever draws this part catches up.
 */
export function sheetInView (view: BoardView, margin = 0): { x: number, y: number, w: number, h: number } {
  const from = viewToSheet(view, { x: -margin, y: -margin })
  const to = viewToSheet(view, { x: view.room.w + margin, y: view.room.h + margin })

  const x0 = Math.max(0, from.x)
  const y0 = Math.max(0, from.y)
  const x1 = Math.min(view.sheet.w, to.x)
  const y1 = Math.min(view.sheet.h, to.y)

  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}
