/**
 * Finding lettering with PP-OCRv6, entirely in the browser.
 *
 * A second opinion to the comic detector in `detector.ts`, and a differently
 * shaped one. That model was taught what a page is made of — balloons, the
 * text inside them, the text loose on the art — and answers in those terms.
 * This one was taught nothing about comics at all. It is a segmentation
 * detector: it paints a probability over every pixel of the page saying "this
 * looks like writing", and the boxes are whatever that paint is then cut into.
 *
 * Which makes its strengths and its failures the opposite ones. It has no
 * concept of a balloon, so it returns *lines* — a four-line balloon comes back
 * as four boxes, and vertical Japanese as one box per column. It is also
 * script-agnostic in principle, responding to the texture of writing rather
 * than to any alphabet, which is why it reads vertical columns and tilted sound
 * effects without being told they exist. In practice the paint is only as even
 * as the training mix, and hangul — low stroke density, generous leading — is
 * where it thins out. See `TUNING` for the three knobs that answer that.
 *
 * ## The graph, and what it does not do
 *
 * `inference.onnx` is the raw DB network: one input `x` at [N, 3, H, W] with
 * H and W dynamic, one output at [N, 1, H, W] straight off a Sigmoid. Every
 * step after that — threshold the map, find the blobs, box them, grow the
 * boxes back out to the ink they were shrunk from — Paddle does in Python and
 * this file does here. That is more code than a graph with the post-processing
 * inside would need, and it is the reason the thresholds are tunable at all
 * rather than baked into an export somebody else made.
 *
 * The preprocessing is fussy and load-bearing, so it is transcribed from the
 * repo's own `preprocessor_config.json` rather than guessed: BGR channel
 * order, ImageNet statistics *reversed* to match, and a resize that scales the
 * page up to a floor rather than down to a ceiling. Getting the channel order
 * wrong does not fail loudly — it just quietly finds less.
 *
 * One of two families that can find lettering — `detector.ts` is the other,
 * and `detectors.ts` is the list a caller actually chooses from.
 */
import { asideSize, jobKey, releaseAside, scanJob } from '~/utils/raster/decoder'

/** The builds on the Hub, smallest first. All fp32; there is no int8 export. */
export const PADDLE_DET_MODELS = {
  'paddle-tiny': 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
  'paddle-small': 'PaddlePaddle/PP-OCRv6_small_det_onnx',
  'paddle-medium': 'PaddlePaddle/PP-OCRv6_medium_det_onnx',
} as const

export type PaddleBuild = keyof typeof PADDLE_DET_MODELS

/**
 * The three numbers that decide what the probability map becomes.
 *
 * These are Paddle's own defaults, and they are the first thing to reach for
 * when a script comes back wrong — retraining is a last resort, not a first.
 * What each one does when the lettering is hangul rather than kanji:
 *
 * - `binarize` is where the paint counts as writing. Hangul carries less ink
 *   per unit area than kanji, so the map runs fainter over it and a threshold
 *   tuned on dense CJK cuts the strokes off at the knees. Lower this when
 *   Korean lines come back in pieces or not at all.
 * - `unclip` is how far each blob is grown back out. The network is trained to
 *   predict a *shrunk* version of each text region, so this undoes the shrink —
 *   and it is also what merges neighbouring syllable blocks into one line.
 *   Raise it when a Korean line arrives as a row of separate boxes.
 * - `boxScore` is the confidence floor, measured as the mean paint inside the
 *   finished box. A faint region can survive binarisation and still be culled
 *   here, so it is worth lowering alongside `binarize` rather than instead.
 *
 * `sideLen` is the resize floor and belongs with them: it is the resolution
 *   the page is actually looked at, and small lettering on a page scaled down
 *   to it is small lettering the network never sees.
 */
export interface PaddleTuning {
  /** Where the probability map counts as ink. Paddle's default is 0.3. */
  binarize: number
  /** The mean-paint floor a finished box must clear. Paddle's default is 0.6. */
  boxScore: number
  /** How far each blob is grown back out. Paddle's default is 1.5. */
  unclip: number
  /** Which side `sideLen` governs, and in which direction. See `fit`. */
  limit: 'min' | 'max'
  /** The pixels that side is brought to. */
  sideLen: number
}

/**
 * Paddle's own defaults — with one deliberate departure worth naming.
 *
 * The library's built-in resize is `min` at 736, a *floor*: pages larger than
 * that are looked at whole, at their own resolution. The published demo
 * instead offers `max` at 960, a *ceiling*, and that is what its screenshots
 * and its 23-line reading of a real manga page were produced with. Matching
 * the demo is worth more than matching the library here, because the demo is
 * what anybody comparing against will have run.
 *
 * The difference is not small: a 1240×1754 page is untouched under `min`/736
 * and comes down to 679×960 under `max`/960, which changes both what is found
 * and how long finding it takes.
 */
export const PADDLE_TUNING: PaddleTuning = {
  binarize: 0.3,
  boxScore: 0.6,
  unclip: 1.5,
  limit: 'max',
  sideLen: 960,
}

/**
 * What the resize may not exceed, whatever the floor implies.
 *
 * A tall spread scaled up until its short side clears the floor can reach
 * thousands of pixels on the long one, and the network is quadratic in area.
 * Paddle's own ceiling, kept for the same reason.
 */
const MAX_SIDE = 4000

/** The network's stride: both sides are rounded to a multiple of this. */
const STRIDE = 32

/**
 * ImageNet statistics in BGR order, because the preprocessor normalises before
 * it transposes and the image is BGR by then. Reversing these by accident
 * costs recall quietly rather than failing, so they are written out once here
 * and never derived.
 */
const MEAN = [0.406, 0.456, 0.485] as const
const STD = [0.225, 0.224, 0.229] as const

/** Below this many pixels on its shorter side, a blob is noise, not writing. */
const MIN_SIDE = 3

const loading = new Map<PaddleBuild, Promise<InferenceSession>>()

function loadOnce (variant: PaddleBuild, onProgress?: MangaProgress): Promise<InferenceSession> {
  const held = loading.get(variant)

  if (held) return held

  const url = `https://huggingface.co/${PADDLE_DET_MODELS[variant]}/resolve/main/inference.onnx`

  // `sessionFor` narrates its own download and keeps the bytes in OPFS, so
  // there is no stall guard here the way there is around the transformers.js
  // loads — a silent hang is that file's problem to report, not this one's.
  const made = sessionFor(url, onProgress).catch((error) => {
    loading.delete(variant)
    throw error
  })

  loading.set(variant, made)

  return made
}

/** The page at the size the network wants to see it, and the scale that cost. */
interface Fitted {
  width: number
  height: number
  /** Multiply a map coordinate by this to land back on the original page. */
  scaleX: number
  scaleY: number
}

/**
 * How large to look at the page.
 *
 * Two rules, and they are opposites, which is why Paddle names them rather
 * than picking one. `min` is a *floor* on the shorter side: a small scan is
 * scaled up until its lettering is big enough to segment, and a page already
 * past the floor is left at its own resolution. `max` is a *ceiling* on the
 * longer side: a large scan is brought down to it, and a small one is scaled
 * up to meet it. `MAX_SIDE` sits above both, to stop a long spread exploding.
 */
function fit (width: number, height: number, sideLen: number, limit: 'min' | 'max'): Fitted {
  // Each rule only ever moves the page one way: `max` shrinks a page past the
  // ceiling and leaves a smaller one alone, `min` grows a page under the floor
  // and leaves a larger one alone. Neither scales in both directions, which is
  // easy to write by accident and quietly changes what is found.
  const side = limit === 'max' ? Math.max(width, height) : Math.min(width, height)

  let ratio = limit === 'max'
    ? (side > sideLen ? sideLen / side : 1)
    : (side < sideLen ? sideLen / side : 1)

  if (Math.max(width, height) * ratio > MAX_SIDE) ratio = MAX_SIDE / Math.max(width, height)

  const round = (side: number) => Math.max(STRIDE, Math.round((side * ratio) / STRIDE) * STRIDE)

  const fittedW = round(width)
  const fittedH = round(height)

  // The rounding to the stride is not the same on both axes, so the two scales
  // are worked out from what the resize actually did rather than from `ratio`.
  return { width: fittedW, height: fittedH, scaleX: width / fittedW, scaleY: height / fittedH }
}

/**
 * The page as the tensor this network eats: BGR, normalised, NCHW — from its
 * pixels at `size`, drawn on the background thread (see `detectWithPaddle`).
 */
function pageTensor (
  ort: Awaited<ReturnType<typeof ortOnce>>,
  data: Uint8ClampedArray,
  size: Fitted,
): OrtTensor {
  const plane = size.width * size.height
  const pixels = new Float32Array(3 * plane)

  for (let i = 0; i < plane; i++) {
    // Channel 0 is blue, not red — see `MEAN`.
    pixels[i] = (data[i * 4 + 2]! / 255 - MEAN[0]) / STD[0]
    pixels[plane + i] = (data[i * 4 + 1]! / 255 - MEAN[1]) / STD[1]
    pixels[2 * plane + i] = (data[i * 4]! / 255 - MEAN[2]) / STD[2]
  }

  return new ort.Tensor('float32', pixels, [1, 3, size.height, size.width])
}

/**
 * A rotated rectangle, in map pixels — OpenCV's `minAreaRect` by another name.
 *
 * This is what PaddleOCR's boxes actually are, and getting it wrong was the
 * difference between reading a tilted sound effect and reading the artwork
 * around it. `angle` is anticlockwise from horizontal, in radians.
 */
interface Rect {
  cx: number
  cy: number
  w: number
  h: number
  angle: number
}

/** A blob of paint, as the outline points a rectangle is fitted to. */
interface Blob {
  xs: number[]
  ys: number[]
}

/**
 * Every connected run of ink in the thresholded map, as its outline.
 *
 * Eight-connected, matching the contour finding Paddle does with OpenCV — four
 * would cut a diagonal stroke into beads. The walk is an explicit stack rather
 * than recursion because a full-page blob is deeper than the call stack is
 * tall, and a sound effect spanning a spread is exactly that blob.
 *
 * Only edge pixels are kept — a pixel with a background neighbour. The
 * rectangle fitted below is decided entirely by the outline, so keeping the
 * filled interior would multiply the work by the area and change nothing.
 */
function blobs (map: Float32Array, width: number, height: number, threshold: number): Blob[] {
  const seen = new Uint8Array(width * height)
  const stack = new Int32Array(width * height)
  const found: Blob[] = []

  const ink = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && map[y * width + x]! >= threshold

  for (let start = 0; start < map.length; start++) {
    if (seen[start] || map[start]! < threshold) continue

    let top = 0

    stack[top++] = start
    seen[start] = 1

    const blob: Blob = { xs: [], ys: [] }

    while (top > 0) {
      const at = stack[--top]!
      const x = at % width
      const y = (at / width) | 0

      if (!ink(x - 1, y) || !ink(x + 1, y) || !ink(x, y - 1) || !ink(x, y + 1)) {
        blob.xs.push(x)
        blob.ys.push(y)
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy

        if (ny < 0 || ny >= height) continue

        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx

          if (nx < 0 || nx >= width) continue

          const next = ny * width + nx

          if (seen[next] || map[next]! < threshold) continue

          seen[next] = 1
          stack[top++] = next
        }
      }
    }

    found.push(blob)
  }

  return found
}

/** The outline's convex hull, anticlockwise — Andrew's monotone chain. */
function hull (blob: Blob): number[][] {
  const points = blob.xs.map((x, i) => [x, blob.ys[i]!] as number[])

  points.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)

  if (points.length < 3) return points

  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!)

  const half = (source: number[][]) => {
    const out: number[][] = []

    for (const point of source) {
      while (out.length > 1 && cross(out[out.length - 2]!, out[out.length - 1]!, point) <= 0) out.pop()

      out.push(point)
    }

    out.pop()

    return out
  }

  return [...half(points), ...half([...points].reverse())]
}

/**
 * The smallest rectangle containing the blob, at any angle.
 *
 * Rotating calipers, in the form that needs no calipers: the minimum-area
 * rectangle around a convex polygon always has a side flush with one of the
 * polygon's edges, so trying every edge's angle and keeping the smallest is
 * both exact and short. This is `cv2.minAreaRect`, which is what PaddleOCR
 * fits and what makes its boxes quads rather than upright rectangles.
 */
function minAreaRect (blob: Blob): Rect | null {
  const points = hull(blob)

  if (points.length < 2) return null

  let best: Rect | null = null

  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    const angle = Math.atan2(b[1]! - a[1]!, b[0]! - a[0]!)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity

    for (const point of points) {
      const u = point[0]! * cos + point[1]! * sin
      const v = -point[0]! * sin + point[1]! * cos

      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }

    const w = maxU - minU
    const h = maxV - minV

    if (best && w * h >= best.w * best.h) continue

    // The centre is found in the rotated frame and turned back, which is why
    // it is not simply the mean of the hull's points.
    const midU = (minU + maxU) / 2
    const midV = (minV + maxV) / 2

    best = { cx: midU * cos - midV * sin, cy: midU * sin + midV * cos, w, h, angle }
  }

  return best
}

/**
 * A rectangle's four corners as top-left, top-right, bottom-right, bottom-left.
 *
 * The ordering is the whole point, and it is the tail of PaddleOCR's
 * `get_mini_boxes` rather than an invention. A minimum-area rectangle has no
 * canonical parameterisation: the same rectangle comes back as 329 by 24 at
 * ninety degrees from one blob and 24 by 329 at nought from the next, both
 * correct and both describing the same four points. Nothing downstream cares
 * until something asks which edge is the top one — and the recogniser asks
 * exactly that, taking the crop's angle and its length from the first two
 * corners. Fed an unordered quad it rotates half the lines by a right angle
 * and swaps their sides, which reads as a broken model and is a broken sort.
 *
 * So the corners are placed by where they actually are: leftmost two by x, the
 * higher of them is the top-left, and the same on the right.
 */
function corners (rect: Rect): Vertex[] {
  const cos = Math.cos(rect.angle)
  const sin = Math.sin(rect.angle)
  const hw = rect.w / 2
  const hh = rect.h / 2

  const points = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => ({
    x: rect.cx + u! * cos - v! * sin,
    y: rect.cy + u! * sin + v! * cos,
  }))

  points.sort((a, b) => a.x - b.x)

  const [left, alsoLeft, right, alsoRight] = points as [Vertex, Vertex, Vertex, Vertex]

  const topLeft = alsoLeft.y > left.y ? left : alsoLeft
  const bottomLeft = alsoLeft.y > left.y ? alsoLeft : left
  const topRight = alsoRight.y > right.y ? right : alsoRight
  const bottomRight = alsoRight.y > right.y ? alsoRight : right

  return [topLeft, topRight, bottomRight, bottomLeft]
}

/**
 * The mean paint inside the rectangle — Paddle's `box_score_fast`.
 *
 * The *rectangle*, not its upright extent, and the difference is the whole
 * reason tilted lettering survives. A sound effect running across a panel at
 * thirty degrees fills barely half of the upright box around it, so averaging
 * that box averages in a panel's worth of white and the score falls under the
 * 0.6 threshold — the box is then dropped, and the reading with it. Masking to
 * the rectangle measures the paint that is actually there.
 */
function paint (map: Float32Array, width: number, height: number, rect: Rect): number {
  const quad = corners(rect)
  const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x))))
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...quad.map((p) => p.x))))
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))))

  const cos = Math.cos(rect.angle)
  const sin = Math.sin(rect.angle)
  const hw = rect.w / 2
  const hh = rect.h / 2

  let total = 0
  let count = 0

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Inside the rotated rectangle is a question asked in its own frame,
      // where it is two comparisons rather than a polygon fill.
      const dx = x - rect.cx
      const dy = y - rect.cy

      if (Math.abs(dx * cos + dy * sin) > hw) continue
      if (Math.abs(-dx * sin + dy * cos) > hh) continue

      total += map[y * width + x]!
      count++
    }
  }

  return count ? total / count : 0
}

/**
 * The lettering on a page, as PP-OCRv6 sees it.
 *
 * Every region carries both shapes. `quad` is the rotated rectangle the network
 * actually drew, and the `x`/`y`/`w`/`h` around it are that quad's upright
 * extent — the contract `detector.ts` keeps and the shape every consumer
 * downstream is built on. A recogniser that can straighten a tilted crop should
 * take the quad; everything else can ignore it and lose nothing it had before.
 *
 * Every box is labelled `text_line` and means it: this network cannot tell a
 * balloon from a caption, and a caller that needs to know must work it out from
 * the geometry or ask the other detector.
 *
 * `tuning` is this family's alone and is why it is an argument rather than a
 * field on the registry entry: the bench sweeps it by calling here directly,
 * and `detectWith` never has to carry a parameter half its entries ignore.
 */
export async function detectWithPaddle (
  page: Readable,
  onProgress?: MangaProgress,
  variant: PaddleBuild = 'paddle-small',
  tuning: PaddleTuning = PADDLE_TUNING,
): Promise<DetectedText[]> {
  const session = await loadOnce(variant, onProgress)
  const ort = await ortOnce()

  onProgress?.('Finding the lettering…')

  // The page's size first, because the size it is drawn at depends on it;
  // then drawn at that size and read back — both on the background thread,
  // from one decode held between the two asks. Here, the drawing was a frame
  // of 50 ms on a large page.
  const key = jobKey('paddle')

  try {
    const bitmap = await asideSize(key, page.file)
    const size = fit(bitmap.width, bitmap.height, tuning.sideLen, tuning.limit)
    const drawn = await scanJob(key, page.file, {
      what: 'pixels',
      canvas: { width: size.width, height: size.height },
      smoothing: 'high',
      readable: true,
    })

    if (!drawn?.pixels) throw new Error('The page could not be measured — no 2d context.')

    const input = pageTensor(ort, drawn.pixels, size)

    const out = await session.run({ [session.inputNames[0]!]: input })
    const probability = out[session.outputNames[0]!]!

    const map = probability.data as Float32Array
    const [, , mapH, mapW] = probability.dims as number[] as [number, number, number, number]

    const found: DetectedText[] = []

    for (const blob of blobs(map, mapW, mapH, tuning.binarize)) {
      const rect = minAreaRect(blob)

      if (!rect || Math.min(rect.w, rect.h) < MIN_SIDE) continue

      // Scored before it is grown, as Paddle scores it — the threshold is
      // calibrated against the shrunk region the network actually predicts.
      const score = paint(map, mapW, mapH, rect)

      if (score < tuning.boxScore) continue

      // The network predicts a *shrunk* region, so this grows it back. Paddle
      // offsets the polygon with Vatti; for a rectangle that reduces exactly to
      // moving each side out by the same distance, area times ratio over
      // perimeter, which is why no clipping library is wanted here.
      const grow = (rect.w * rect.h * tuning.unclip) / (2 * (rect.w + rect.h))
      const grown: Rect = { ...rect, w: rect.w + grow * 2, h: rect.h + grow * 2 }

      // Paddle re-measures after growing and asks for two pixels more than
      // before, which drops the slivers that only cleared the first check by
      // being long.
      if (Math.min(grown.w, grown.h) < MIN_SIDE + 2) continue

      const quad = corners(grown).map((point) => ({
        x: Math.min(bitmap.width, Math.max(0, point.x * size.scaleX)),
        y: Math.min(bitmap.height, Math.max(0, point.y * size.scaleY)),
      }))

      const x = Math.min(...quad.map((p) => p.x))
      const y = Math.min(...quad.map((p) => p.y))
      const w = Math.max(...quad.map((p) => p.x)) - x
      const h = Math.max(...quad.map((p) => p.y)) - y

      if (w < 2 || h < 2) continue

      found.push({ x, y, w, h, label: 'text_line', score, quad })
    }

    // Surest first, which is the order `detector.ts` hands its boxes over in
    // and the order anything deduplicating them downstream expects.
    return found.sort((a, b) => b.score - a.score)
  } finally {
    // Already gone if the drawing ran; not if asking for the size failed.
    releaseAside(key)
  }
}
