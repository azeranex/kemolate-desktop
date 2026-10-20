/**
 * Oriented-box geometry: what a drag on a grip asks for. Pure arithmetic —
 * numbers in, numbers out, nothing reached for and nothing drawn.
 *
 * Everything here works in the scan's own pixels, which is the one space in
 * this app that is square. A block's stored `x`/`w` are shares of the page's
 * width and its `y`/`h` shares of its *height*, and in a space stretched
 * unevenly like that a rotation is no longer a rotation — a turned box comes
 * back with the wrong angle and the wrong proportions. So a drag converts in,
 * does its work square, and converts out. The same reasoning, and the same
 * space, as `shared/utils/lettering`.
 */

/** A box as this module works on it: a centre, a size, and how it is bent. */
export interface Oriented {
  cx: number
  cy: number
  w: number
  h: number
  /** Degrees, clockwise. */
  angle: number
  /** Degrees the box leans across, and down. */
  skewX: number
  skewY: number
  /**
   * Four corner offsets in scan pixels, north-west first and clockwise, as
   * `[x, y, x, y, …]`. Null on a box nobody has pulled a corner of, which is
   * almost all of them.
   */
  quad: number[] | null
}

/** A block's box in page percentages, which is how one is stored. */
export interface Boxed {
  x: number
  y: number
  w: number
  h: number
  angle?: number
  skewX?: number
  skewY?: number
  quad?: number[]
}

/** The scan's own size — what the two spaces are converted through. */
export interface Scan {
  width: number
  height: number
}

export const toOriented = (box: Boxed, scan: Scan): Oriented => ({
  cx: ((box.x + box.w / 2) / 100) * scan.width,
  cy: ((box.y + box.h / 2) / 100) * scan.height,
  w: (box.w / 100) * scan.width,
  h: (box.h / 100) * scan.height,
  angle: box.angle ?? 0,
  skewX: box.skewX ?? 0,
  skewY: box.skewY ?? 0,
  quad: box.quad ?? null,
})

/**
 * Back to percentages. A turn of nought is left off rather than written down,
 * so a block that has only ever been moved carries no angle at all — see the
 * note on `angle` in `Block`, which is what this keeps true.
 */
export const toBoxed = (box: Oriented, scan: Scan): Boxed => ({
  x: ((box.cx - box.w / 2) / scan.width) * 100,
  y: ((box.cy - box.h / 2) / scan.height) * 100,
  w: (box.w / scan.width) * 100,
  h: (box.h / scan.height) * 100,
  ...(box.angle ? { angle: box.angle } : {}),
  ...(box.skewX ? { skewX: box.skewX } : {}),
  ...(box.skewY ? { skewY: box.skewY } : {}),
  ...(isDistorted(box) ? { quad: box.quad! } : {}),
})

/**
 * The box's 2×2 rotation — the linear part of what the CSS transform does.
 * Dragging a turned box's grips runs this backwards, so a movement of the
 * pointer becomes a movement along the box's own edges.
 */
export type Mat = [number, number, number, number]

export const rad = (deg: number): number => (deg * Math.PI) / 180

/**
 * The box's 2×2 — rotate, then lean across, then lean down, in the order
 * `cssTransform` writes them, so the arithmetic and the drawing agree about
 * what a box's own frame is.
 */
export function matrixOf (box: Pick<Oriented, 'angle' | 'skewX' | 'skewY'>): Mat {
  const c = Math.cos(rad(box.angle))
  const s = Math.sin(rad(box.angle))
  const tx = Math.tan(rad(box.skewX))
  const ty = Math.tan(rad(box.skewY))
  const [s11, s12, s21, s22] = [1 + tx * ty, tx, ty, 1]

  return [
    c * s11 - s * s21,
    s * s11 + c * s21,
    c * s12 - s * s22,
    s * s12 + c * s22,
  ]
}

/** A point in the box's frame, mapped out into the page's. */
export const mapped = (m: Mat, x: number, y: number) => ({
  x: m[0] * x + m[2] * y,
  y: m[1] * x + m[3] * y,
})

/** The same point in the box's own frame. A degenerate matrix passes through. */
export function unmapped (m: Mat, x: number, y: number) {
  const det = m[0] * m[3] - m[1] * m[2]

  if (!det) return { x, y }

  return { x: (m[3] * x - m[2] * y) / det, y: (m[0] * y - m[1] * x) / det }
}

/** A corner index, north-west first and clockwise — the order `quad` is in. */
export const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const

/**
 * The four corners in the box's own frame, before it is turned or leant: the
 * plain rectangle, plus however far each corner has been dragged.
 */
export function cornersOf (box: Oriented) {
  const hw = box.w / 2
  const hh = box.h / 2

  return CORNERS.map(([sx, sy], i) => ({
    x: sx * hw + (box.quad?.[i * 2] ?? 0),
    y: sy * hh + (box.quad?.[i * 2 + 1] ?? 0),
  }))
}

/** Whether any corner has actually been moved — an all-nought quad is no quad. */
export const isDistorted = (box: Oriented): boolean => Boolean(box.quad?.some((v) => v !== 0))

/** Past this a box is edge-on and unreadable, so the lean stops there. */
export const clampDeg = (v: number): number => Math.max(-75, Math.min(75, Math.round(v)))

/**
 * A turn folded back into (−180°, 180°].
 *
 * Deliberately not `clampDeg` above it, which looks like the same idea and is
 * not: that one is about *lean*, where a box past 75° is edge-on and unreadable
 * and so there is a wall to stop at. A turn has no wall — every one of the 360
 * is a box somebody can read — so it wraps rather than stops.
 *
 * Wrapping is also what lets `transposed` be pressed round in a circle. Four
 * quarter turns added up land on 360, which draws identically to nought and is
 * a different number: the block would carry it for ever, and "press four times
 * to get back where you were" would be true on screen and false in the row.
 *
 * One remainder and at most one correction, rather than the usual
 * `((v % 360) + 360) % 360`. Both are right; this one is *quieter*. The textbook
 * form adds 360 and takes the remainder again even when the angle was already in
 * range, and each of those roundings shows up as drift once the same number has
 * been round the circle: on a detector's 15.838° it costs an eighth of what the
 * textbook form does. The remainder itself is exact in IEEE754, so a turn that
 * never leaves the range never moves at all.
 */
export const wrapDeg = (v: number): number => {
  const turn = v % 360

  if (turn > 180) return turn - 360
  if (turn <= -180) return turn + 360

  return turn
}

/** Which grip is which, and which way each pulls in the box's own frame. */
export const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const

export type HandleKind = typeof HANDLES[number]

/**
 * How far each grip pulls per axis: −1, 0 or +1. A corner pulls on both, a side
 * on one, and the nought is what lets the two go through one piece of
 * arithmetic instead of two.
 */
export const PULL: Record<HandleKind, readonly [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  w: [-1, 0],
  e: [1, 0],
  sw: [-1, 1],
  s: [0, 1],
  se: [1, 1],
}

/** Small enough for a one-character sound effect; nothing smaller is a box. */
const FLOOR = 4

export interface ScaleOpts {
  pull: readonly [number, number]
  /** How far the pointer has moved, already read into the box's own frame. */
  local: { x: number, y: number }
  /** Grow about the centre rather than the opposite grip — Photoshop's Alt. */
  fromCentre?: boolean
  /** Keep the box's proportions — Photoshop's Shift. */
  proportional?: boolean
}

/**
 * The size a drag on a grip asks for.
 *
 * The grip opposite the one being pulled stays put, so the box grows away from
 * it — what every transform box does, and what makes a drag track the pointer.
 * `fromCentre` pins the centre instead and grows both ways at once;
 * `proportional` lets whichever axis moved further set them both.
 */
export function scaled (box: Oriented, options: ScaleOpts): Oriented {
  const [sx, sy] = options.pull
  const grow = options.fromCentre ? 2 : 1

  let dw = sx ? options.local.x * sx * grow : 0
  let dh = sy ? options.local.y * sy * grow : 0

  // Proportional only means anything pulling a corner; a side has one axis.
  if (options.proportional && sx && sy) {
    const fw = (box.w + dw) / box.w
    const fh = (box.h + dh) / box.h
    const f = Math.abs(fw - 1) > Math.abs(fh - 1) ? fw : fh

    dw = box.w * f - box.w
    dh = box.h * f - box.h
  }

  // Kept signed, so a grip dragged past the one opposite turns the box inside
  // out rather than hitting a wall. Floored instead, an overshot drag collapses
  // that axis to a sliver and leaves the other alone — which is how a wide box
  // becomes a tall one the moment the pointer crosses its far edge, and why it
  // then sits there refusing to follow the pointer at all.
  const signedW = box.w + dw
  const signedH = box.h + dh

  const w = Math.max(FLOOR, Math.abs(signedW))
  const h = Math.max(FLOOR, Math.abs(signedH))

  if (options.fromCentre) return { ...box, w, h }

  // The edge that stayed put has to stay put on screen too, so the centre moves
  // by half of what the box grew — along the box's own axes, which is what keeps
  // a turned box tracking the pointer rather than sliding away from it. Measured
  // from the signed sizes, since that is the arithmetic that carries a mirrored
  // box across to the far side of its anchor.
  const shift = mapped(
    matrixOf(box),
    (sx * (signedW - box.w)) / 2,
    (sy * (signedH - box.h)) / 2,
  )

  return { ...box, w, h, cx: box.cx + shift.x, cy: box.cy + shift.y }
}

/**
 * The lean a drag on a side grip asks for. Top and bottom lean the box
 * sideways, left and right lean it up and down — the edge you grab is the edge
 * that moves, which is what makes the gesture read.
 */
export function skewed (box: Oriented, pull: readonly [number, number], local: { x: number, y: number }): Oriented {
  const [sx, sy] = pull

  // Against the box's own half-height or half-width, so the same drag leans a
  // small box and a large one by the same amount rather than shearing a narrow
  // one off the page.
  return sy
    ? { ...box, skewX: clampDeg(box.skewX + ((local.x * sy) / (box.h / 2)) * 45) }
    : { ...box, skewY: clampDeg(box.skewY + ((local.y * sx) / (box.w / 2)) * 45) }
}

/** Which corner a pull names, or -1 for a side grip, which has no corner. */
export const cornerAt = (pull: readonly [number, number]): number =>
  CORNERS.findIndex(([x, y]) => x === pull[0] && y === pull[1])

/**
 * One corner moved on its own — distort — or, with `perspective`, that corner
 * moved and the one sharing its top or bottom edge sent the opposite way, so the
 * box narrows toward a vanishing point instead of simply leaning.
 *
 * Only corners can do this: a side grip names no single corner to move, which is
 * why Photoshop offers distort on corners alone.
 */
export function distorted (
  box: Oriented,
  pull: readonly [number, number],
  local: { x: number, y: number },
  perspective = false,
): Oriented {
  const i = cornerAt(pull)

  if (i < 0) return box

  // Filled out rather than sparse, so every corner has a number to add to and
  // the eight the homography wants are always all there.
  const quad = Array.from({ length: 8 }, (_, at) => box.quad?.[at] ?? 0)

  quad[i * 2]! += local.x
  quad[i * 2 + 1]! += local.y

  if (perspective) {
    // The other end of this corner's horizontal edge: nw↔ne, se↔sw.
    const mate = [1, 0, 3, 2][i]!

    quad[mate * 2]! -= local.x
    quad[mate * 2 + 1]! += local.y
  }

  return { ...box, quad }
}

/**
 * A quarter turn of the box's own frame about its centre: `w` and `h` swapped
 * *and* the angle taken on ninety degrees. The rectangle on the page does not
 * move; the axis the type runs along does.
 *
 * Not a drag, and the odd one out here for that reason: the rest of this file
 * answers a pointer, and this answers a *baseline* — a line of lettering set
 * across the box it belongs in rather than along it.
 *
 * The case it exists for is a label printed sideways on the artwork: a bottle
 * whose "Duo Soda" runs up the side of the bottle. The detector's box is
 * **right** — a tall narrow rectangle sitting exactly over the sideways label —
 * and the lettering is what is wrong, because it is set along the box's local x
 * and so wraps every two letters: "Du / oS / od / a". Type climbing the page is
 * the wanted answer here, not the thing to be avoided.
 *
 * **This reverses what this function did first**, which was to swap the two
 * sizes in the box's own frame and leave the angle deliberately alone, arguing
 * that a quarter turn would send a sound effect's type climbing the page. That
 * had the case backwards. A local-frame swap keeps the baseline exactly where it
 * was and moves the *rectangle* instead — the tall box over the label comes back
 * wide and lands on artwork the label is not on, which is the bug that sent this
 * back. What the detector measured is the part worth keeping.
 *
 * The outline is kept exactly rather than nearly. A w×h box at θ+90° covers the
 * same four points an h×w box at θ covers: turning the local corner set
 * (±h/2, ±w/2) by ninety lands on (±w/2, ±h/2), which is the same four points in
 * a different order. `cx` and `cy` are untouched — that is what "about its
 * centre" means — so nothing moves, shifts or resizes.
 *
 * A leant box is the one exception, and cannot be otherwise. `skewX`/`skewY` are
 * read in the box's own frame, so a lean turns with the frame and the
 * parallelogram comes back leaning the other way; no swap of the two would fix
 * it either, since `R(-90)·S·R(90)` is not a lean in the form this module
 * stores. Nothing a detector emits carries a lean, so nobody reaches it from the
 * case above.
 *
 * **It is not its own inverse**, which the swap-only version was, and the button
 * has to say so: two presses are the same outline with the type upside down.
 * Clockwise by default, anticlockwise on `anticlockwise` — the Blocks panel puts
 * that on Shift — and either way four presses come back to exactly the numbers
 * they started at, which is what the wrap in `wrapDeg` is for.
 *
 * It has to happen in this space and cannot be done in a block's percentages.
 * There `w` is a share of the page's *width* and `h` a share of its *height*, so
 * `{ w: block.h, h: block.w }` swaps two numbers that are not in the same unit
 * and comes out as the box rescaled by the page ratio squared. On a squarish
 * page that is nearly right, which is the worst way for it to be wrong. In and
 * out through `toOriented`/`toBoxed` is the whole of the fix.
 *
 * **A distorted box is refused and comes back untouched.** Not because the
 * answer is unknowable — it is a turn now rather than an ambiguous "swap", so
 * the quad's four offsets could be turned with the frame and renumbered as the
 * corners they became. It is refused because that renumbering is four vectors
 * and four indices, nothing on screen would flag it if it were off by one, and
 * what it would quietly mangle is a shape somebody drew by eye. No detector
 * emits a quad, so nobody carrying one arrived here from the sideways label
 * anyway. Straighten the corners, then transpose.
 */
export function transposed (box: Oriented, anticlockwise = false): Oriented {
  if (isDistorted(box)) return box

  return {
    ...box,
    w: box.h,
    h: box.w,
    angle: wrapDeg(box.angle + (anticlockwise ? -90 : 90)),
  }
}

/** Gaussian elimination with partial pivoting. Null when the system is singular. */
function solve (a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])

  for (let col = 0; col < n; col++) {
    let pivot = col

    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    }

    if (Math.abs(m[pivot]![col]!) < 1e-12) return null

    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]

    for (let r = 0; r < n; r++) {
      if (r === col) continue

      const f = m[r]![col]! / m[col]![col]!

      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!
    }
  }

  return m.map((row, i) => row[n]! / m[i]![i]!)
}

/**
 * The CSS transform that carries a distorted box's rectangle onto its quad.
 *
 * Moving one corner on its own is a *projective* map, not an affine one — no
 * combination of rotate, lean and scale can produce a general quadrilateral,
 * which is exactly why distort has to be said separately from all three. The
 * eight unknowns come out of the four corner pairs and go into CSS as the 4×4
 * `matrix3d` carrying the same 3×3 homography.
 *
 * `w` and `h` are the element's own pixel size and `unit` what one scan pixel is
 * worth in them, since the corner offsets are stored in scan pixels. Empty for a
 * box nobody has distorted, which is most of them.
 */
export function quadMatrix (box: Oriented, w: number, h: number, unit: number): string {
  if (!isDistorted(box) || !unit) return ''

  const hw = w / 2
  const hh = h / 2
  const rows: number[][] = []
  const rhs: number[] = []

  // Source: the element's own corners about its centre, which is where CSS
  // applies a transform from. Destination: those corners, moved.
  CORNERS.forEach(([sx, sy], i) => {
    const x = sx * hw
    const y = sy * hh
    const u = x + (box.quad?.[i * 2] ?? 0) * unit
    const v = y + (box.quad?.[i * 2 + 1] ?? 0) * unit

    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    rhs.push(u)
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    rhs.push(v)
  })

  const s = solve(rows, rhs)

  if (!s) return ''

  const [a, b, c, d, e, f, p, q] = s as [number, number, number, number, number, number, number, number]

  // Column-major, with the projective row carried in the w column.
  return `matrix3d(${a},${d},0,${p},${b},${e},0,${q},0,0,1,0,${c},${f},0,1)`
}

/**
 * How a box is drawn: turned, then leant, then carried onto its quad — the same
 * order `matrixOf` composes, so a drag read into the box's frame lands where the
 * drawing put it.
 */
export function cssTransform (box: Oriented, size?: { w: number, h: number, unit: number }): string {
  const parts: string[] = []

  if (box.angle) parts.push(`rotate(${box.angle}deg)`)
  if (box.skewX) parts.push(`skewX(${box.skewX}deg)`)
  if (box.skewY) parts.push(`skewY(${box.skewY}deg)`)

  if (size) {
    const quad = quadMatrix(box, size.w, size.h, size.unit)

    if (quad) parts.push(quad)
  }

  return parts.join(' ')
}

/** Where a turn lands, snapped to the eighth-turns when asked. */
export const snapped = (deg: number, snap: boolean): number =>
  snap ? Math.round(deg / 45) * 45 : Math.round(deg)

/**
 * The angle from a box's centre out to a point, measured against straight up so
 * the grip stays under the pointer as it swings.
 */
export const angleTo = (centre: { x: number, y: number }, to: { x: number, y: number }): number =>
  (Math.atan2(to.y - centre.y, to.x - centre.x) * 180) / Math.PI + 90
