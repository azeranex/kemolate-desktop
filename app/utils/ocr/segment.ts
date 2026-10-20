/**
 * A learned answer to "which pixels are lettering" — the question Otsu in
 * `mask.ts` answers by threshold, asked of a model instead.
 *
 * The model is dmMaze's comic-text-detector, manga-trained, in mayocream's
 * ONNX export — the segmentation half of the pipeline koharu shipped. It
 * reads the whole page at once and returns, among other heads, `seg`: a
 * per-pixel text probability. A threshold is not a segmenter — it can only
 * split light from dark, so screentone shades into lettering and bursts
 * count as ink — where a model trained on manga has seen all of that and
 * marks the glyphs alone.
 *
 * Benched before being trusted: on synthetic pages it segments balloon
 * lettering cleanly — no outline, no furigana clutter — and under-responds
 * to invented sound effects, which may be the model or may be the invention.
 * That is what the lab's Segment run exists to settle, on real pages.
 *
 * Settled on page 4 of Eclipse 2, which is where the threshold's two worst
 * cases live: a five-line info balloon whose faintest line Otsu leaves
 * untouched, and a bold title on a dark banner Otsu inverts — masking the
 * fill and leaving the letters, so the repair hands back a black blob. The
 * segmenter marks the glyphs in both. The sound-effect weakness is real
 * though, which is why the cleaning falls back to the threshold per block
 * rather than replacing it (`learnedInk` in `mask.ts`), and why the mask
 * source is opt-in and named in every patch key.
 *
 * Whole-page on purpose, unlike everything else in this folder. The model
 * was trained on full pages and its receptive field wants the layout; it is
 * also one inference for the page rather than one per block, which at this
 * size is the difference between five seconds and a minute.
 */

// By name, so a dev server that is already running picks the new export up.
import { isOnGpu } from '~/utils/ocr/onnx'
import { jobKey, scanJob } from '~/utils/raster/decoder'

/** The square the model reads. Pages are scaled to fit and padded black. */
const EDGE = 1024

const SEGMENT_MODEL = 'https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/main/comic-text-detector.onnx'

/** One page's text mask, in the model's own square until `intoPage` maps it. */
export interface Segmented {
  /** Nought to one per pixel, EDGE × EDGE, row-major. */
  seg: Float32Array
  /**
   * The DBNet head's text-line probability, same square. The model has three
   * heads and the app used one; this is the second — a scene-text *line*
   * detector, which is the part that knows which way lettering runs. See
   * `detLines`, which is what it exists for.
   */
  det: Float32Array
  /** What one model pixel is worth in page pixels. */
  scale: number
}

let loading: Promise<InferenceSession> | null = null

/** Set once a WebGPU session has failed mid-run in this tab — see `segmenterOnce`. */
let gpuFailed = false

/**
 * The segmenter's session, once per tab, on WebGPU where it will open.
 *
 * Measured on a 2654×4025 page: 5.4 s a page on single-threaded wasm, 0.24 s
 * on WebGPU (0.77 s the first time), and the two agree to the pixel — not one
 * value of `seg` or `det` lands on the other side of 0.5. At 5.4 s it was the
 * larger half of cleaning a page once LaMa moved to the GPU, and it is paid
 * per page, not once. See `sessionFor` for why wasm is single-threaded here.
 */
function segmenterOnce (onProgress?: MangaProgress): Promise<InferenceSession> {
  loading ??= sessionFor(SEGMENT_MODEL, onProgress, { gpu: !gpuFailed }).catch((error) => {
    loading = null
    throw error
  })

  return loading
}

/**
 * Read one page's lettering mask.
 *
 * The page is scaled so its longest side fits the model's square and padded
 * bottom-right with black — padding rather than stretching, because the
 * model's sense of what a glyph looks like includes its proportions.
 */
/**
 * Segmentations by the very Blob they were read from.
 *
 * `segmentedPage` files answers by scan hash, but a reading engine holds a
 * `Readable` — file and width, no hash — so it cannot ask that cache. This
 * one is keyed by the File object itself, which the engines and the cleanup
 * share via `useComic`, and it exists for exactly one call pattern: "use the
 * segmentation if somebody already paid for it, never pay for one yourself."
 * A Read must not cost a model download; better geometry is a bonus of
 * having segmented, not a toll on reading. Weak, so a closed chapter's pages
 * take their answers with them.
 */
const byBlob = new WeakMap<Blob, Promise<Segmented>>()

/** The segmentation somebody else already started for this file, or null. */
export function segmentedAlready (file: Blob): Promise<Segmented> | null {
  return byBlob.get(file) ?? null
}

export function segmentPage (page: Readable, onProgress?: MangaProgress): Promise<Segmented> {
  // One inference per File however many callers ask, and the answer is
  // discoverable by anyone holding the same Blob -- see `segmentedAlready`.
  const going = byBlob.get(page.file)

  if (going) return going

  const made = readPageMask(page, onProgress).catch((error) => {
    byBlob.delete(page.file)

    throw error
  })

  byBlob.set(page.file, made)

  return made
}

async function readPageMask (page: Readable, onProgress?: MangaProgress): Promise<Segmented> {
  const session = await segmenterOnce(onProgress)

  onProgress?.('Reading the lettering mask…')

  // Drawn and read back on the background thread — the page shrunk onto the
  // model's square, black where it does not reach, exactly as it was drawn
  // here — so a page being read costs the reader's tab no frames for it.
  const drawn = await scanJob(jobKey('segment'), page.file, {
    what: 'pixels',
    canvas: { width: EDGE, height: EDGE },
    draw: { edge: EDGE },
    fill: '#000',
    smoothing: 'high',
    readable: true,
  })

  if (!drawn?.pixels) throw new Error('The page could not be drawn — no 2d context.')

  const scale = EDGE / Math.max(drawn.width, drawn.height)
  const data = drawn.pixels
  const plane = EDGE * EDGE
  const image = new Float32Array(3 * plane)

  for (let i = 0; i < plane; i++) {
    image[i] = data[i * 4]! / 255
    image[plane + i] = data[i * 4 + 1]! / 255
    image[2 * plane + i] = data[i * 4 + 2]! / 255
  }

  const ort = await ortOnce()
  const out = await session.run({ images: new ort.Tensor('float32', image, [1, 3, EDGE, EDGE]) }).catch((error: unknown) => {
    // A GPU that failed after opening — a lost device, a sleeping tab. This
    // page fails as it would have; the next one opens a wasm session.
    if (isOnGpu(session)) {
      console.warn('[kemolate] the segmenter failed on WebGPU — the next page runs on WebAssembly.', error)
      gpuFailed = true
      loading = null
    }

    throw error
  })

  // `det` is [1, 2, EDGE, EDGE] — DBNet's probability map and its learned
  // threshold map. Only the probability is kept: the binarisation here is
  // a fixed cut, and carrying the second plane would double four megabytes
  // per held page for a refinement nothing reads.
  return {
    seg: out.seg!.data as Float32Array,
    det: (out.det!.data as Float32Array).slice(0, EDGE * EDGE),
    scale,
  }
}

/**
 * How many pages' masks are held at once.
 *
 * Two, and the number is a size rather than a guess: a `Segmented` is
 * EDGE × EDGE floats, four megabytes, and the only reason to keep more than
 * the page being worked on is that turning a page and turning back must not
 * cost another inference. Two covers that and nothing else.
 */
const KEEP = 2

const held = new Map<string, Promise<Segmented>>()

/**
 * One page's mask, read once and kept under the scan's content hash.
 *
 * The whole argument for this file is that the model reads a *page* — one
 * inference for the layout rather than one per balloon, which at this size is
 * the difference between five seconds and a minute. That saving is thrown
 * away the moment a caller cleans block by block, which is exactly what the
 * brush does: every correction re-cleans one balloon, and each of those would
 * segment the page again.
 *
 * So the answer is filed against the scan rather than against the run.
 * Content-addressed like everything else derived from a page — the same scan
 * found again anywhere is the same reading — which is also why a promise is
 * cached rather than a result: two blocks asking at once must wait on one
 * inference, not start two.
 *
 * A failed read is dropped so the next ask retries it; a fetch that failed
 * once is not a fact about the page.
 */
export function segmentedPage (page: Readable, scan: string, onProgress?: MangaProgress): Promise<Segmented> {
  const already = held.get(scan)

  if (already) {
    // Re-inserted, so the page in front of somebody is the last one evicted.
    held.delete(scan)
    held.set(scan, already)

    return already
  }

  const made = segmentPage(page, onProgress).catch((error) => {
    held.delete(scan)

    throw error
  })

  held.set(scan, made)

  for (const oldest of held.keys()) {
    if (held.size <= KEEP) break

    held.delete(oldest)
  }

  return made
}

/**
 * The mask for one region of the page, at the region's own size.
 *
 * Nearest-neighbour on the way up, deliberately: the mask is a probability
 * field about to be thresholded, and interpolating it first blurs the very
 * edge the threshold is trying to find.
 */
export function segFor (whole: Segmented, region: Region): Float32Array {
  const w = Math.max(1, Math.round(region.w))
  const h = Math.max(1, Math.round(region.h))
  const out = new Float32Array(w * h)

  for (let y = 0; y < h; y++) {
    const sy = Math.min(EDGE - 1, Math.round((region.y + y) * whole.scale))

    for (let x = 0; x < w; x++) {
      const sx = Math.min(EDGE - 1, Math.round((region.x + x) * whole.scale))

      out[y * w + x] = whole.seg[sy * EDGE + sx]!
    }
  }

  return out
}

/** One text line the det head found: an oriented box in page pixels. */
export interface DetLine {
  /** The middle of the line. */
  cx: number
  cy: number
  /**
   * The drawn rectangle's own sides at `lean` — `w` along its x-axis, the
   * contract `tiltedQuad` renders by. For a vertical column that makes `w`
   * the *narrow* side, same as the ink path after its fold.
   */
  w: number
  h: number
  /** Degrees, positive clockwise, folded into ±45 — `Box.angle`'s convention. */
  lean: number
  /** Model pixels the line covered — bigger is better evidence. */
  weight: number
}

/**
 * Where the probability map counts as a line.
 *
 * A fixed cut rather than the model's own threshold plane (not kept — see
 * `segmentPage`), chosen where the ECLIPSE pages' lines all survive and the
 * screentone does not.
 */
const DET_CUT = 0.3

/** Components below this many model pixels are speckle, not lines. */
const DET_FLOOR = 60

/**
 * The text lines on a page, with the direction each one runs.
 *
 * This is the geometry the rest of the pipeline has been trying to
 * reconstruct from thresholded ink — and could only approximate, because a
 * balloon yields three to seven noisy cluster centres and a diagonal of
 * staggered characters is indistinguishable from a rotated column at that
 * resolution. The det head answers from dense stroke evidence instead:
 * measured on ECLIPSE page 22, it put credible magnitudes on every lean the
 * ink measurement had to snap to zero, mirror-signed the symmetric pairs,
 * and kept the straight balloons straight. It also missed one balloon
 * outright, which is why this is a *source* for geometry and not the
 * pipeline: whoever consumes it falls back to the ink measurement where no
 * line landed.
 *
 * The angle is the **long axis** of the minimum-area rectangle, folded into
 * ±45. Saying "long axis" is what makes the sign deterministic: a min-area
 * sweep returns the same rectangle at θ and θ+90 with the sides swapped, and
 * folding whichever direction the sweep happened to settle on flips the sign
 * of every other line — the first probe of this head reported the whole page
 * mirrored that way. A text line is always longer than it is thick, so the
 * long axis is always the reading direction, and the fold of *that* is the
 * lean in `Box.angle`'s own convention.
 */
export function detLines (whole: Segmented): DetLine[] {
  const on = new Uint8Array(EDGE * EDGE)

  for (let i = 0; i < EDGE * EDGE; i++) on[i] = whole.det[i]! > DET_CUT ? 1 : 0

  const seen = new Uint8Array(EDGE * EDGE)
  const stack: number[] = []
  const lines: DetLine[] = []

  for (let start = 0; start < EDGE * EDGE; start++) {
    if (!on[start] || seen[start]) continue

    const xs: number[] = []
    const ys: number[] = []

    stack.push(start)
    seen[start] = 1

    while (stack.length) {
      const at = stack.pop()!
      const x = at % EDGE
      const y = (at / EDGE) | 0

      xs.push(x)
      ys.push(y)

      if (x > 0 && on[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1) }
      if (x < EDGE - 1 && on[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; stack.push(at + 1) }
      if (y > 0 && on[at - EDGE] && !seen[at - EDGE]) { seen[at - EDGE] = 1; stack.push(at - EDGE) }
      if (y < EDGE - 1 && on[at + EDGE] && !seen[at + EDGE]) { seen[at + EDGE] = 1; stack.push(at + EDGE) }
    }

    if (xs.length < DET_FLOOR) continue

    // Sampled: a line is described by a few hundred of its pixels as well as
    // by all of them, and the sweep below is ran 180 times over the sample.
    const step = Math.max(1, Math.floor(xs.length / 600))
    const sx: number[] = []
    const sy: number[] = []

    for (let i = 0; i < xs.length; i += step) {
      sx.push(xs[i]!)
      sy.push(ys[i]!)
    }

    let best = Infinity
    let along = 0

    for (let degrees = -90; degrees < 90; degrees++) {
      const radians = (degrees * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)

      let minU = Infinity
      let maxU = -Infinity
      let minV = Infinity
      let maxV = -Infinity

      for (let i = 0; i < sx.length; i++) {
        const u = sx[i]! * cos + sy[i]! * sin
        const v = -sx[i]! * sin + sy[i]! * cos

        if (u < minU) minU = u
        if (u > maxU) maxU = u
        if (v < minV) minV = v
        if (v > maxV) maxV = v
      }

      const w = maxU - minU
      const h = maxV - minV

      if (w * h < best) {
        best = w * h
        // The long axis is the reading direction — see the header.
        along = w >= h ? degrees : degrees + 90
      }
    }

    const lean = ((along % 90) + 135) % 90 - 45

    /**
     * The box's sides are measured *at the folded lean*, not carried over
     * from the sweep. `w` must be the extent along the drawn rectangle's own
     * x-axis — that is the contract `tiltedQuad` draws by, and the ink path
     * keeps it by swapping sides during its fold. The first version of this
     * kept "long axis" in `w` regardless, and every vertical column on the
     * page rendered as its own crossbar: a 177-pixel-long column drawn as a
     * 177-wide strip lying across the text at the right angle.
     */
    const leanRadians = (lean * Math.PI) / 180
    const leanCos = Math.cos(leanRadians)
    const leanSin = Math.sin(leanRadians)

    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity

    for (let i = 0; i < sx.length; i++) {
      const u = sx[i]! * leanCos + sy[i]! * leanSin
      const v = -sx[i]! * leanSin + sy[i]! * leanCos

      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }

    const width = maxU - minU
    const height = maxV - minV
    const midU = (minU + maxU) / 2
    const midV = (minV + maxV) / 2
    const cx = midU * leanCos - midV * leanSin
    const cy = midU * leanSin + midV * leanCos

    /**
     * Un-shrunk, because DBNet is trained on text polygons shrunk toward
     * their core — the probability map marks a kernel, not the lettering,
     * and boxes taken from it raw are thin strips across the middle of the
     * text. Every DB pipeline re-expands by an offset proportional to
     * area over perimeter (Vatti's approximation); 1.8 is tuned on the
     * ECLIPSE corpus, where the expanded boxes cover the glyphs without
     * swallowing the balloon.
     */
    const offset = (width * height * 1.8) / (2 * (width + height))

    lines.push({
      cx: cx / whole.scale,
      cy: cy / whole.scale,
      w: (width + 2 * offset) / whole.scale,
      h: (height + 2 * offset) / whole.scale,
      lean,
      weight: xs.length,
    })
  }

  return lines
}

/**
 * The det head's verdict on one block: the lean of the lines inside its box,
 * or null when none landed there.
 *
 * Lines are claimed by centre, weighted by size, and required to agree — a
 * block whose lines disagree by more than a few degrees is two pieces of
 * lettering sharing a box, and guessing between them is how wrong angles get
 * stored. Null hands the question to the ink measurement, which is the
 * arrangement this whole source exists under: better evidence when it is
 * there, never a worse guess when it is not.
 */
export function detLeanFor (lines: DetLine[], region: Region): number | null {
  const inside = lines.filter((line) =>
    line.cx >= region.x && line.cx <= region.x + region.w
    && line.cy >= region.y && line.cy <= region.y + region.h)

  if (!inside.length) return null

  const low = Math.min(...inside.map((line) => line.lean))
  const high = Math.max(...inside.map((line) => line.lean))

  if (high - low > 8) return null

  const total = inside.reduce((sum, line) => sum + line.weight, 0)

  return inside.reduce((sum, line) => sum + line.lean * line.weight, 0) / total
}

/**
 * The det head's oriented box for one block, or null when it saw nothing
 * there — shaped like `Upright` so the emission that already consumes the
 * ink measurement can take this instead without learning anything new.
 *
 * The same claiming and agreement rules as `detLeanFor`; the box is the
 * extent of the claimed lines measured along their common direction, which
 * for the ordinary one-line balloon is simply the line's own rectangle.
 */
/** The plain union of some lines' boxes — the level case's extent. */
function extentOf (lines: DetLine[]): { cx: number, cy: number, w: number, h: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const line of lines) {
    const r = (line.lean * Math.PI) / 180
    const c = Math.cos(r)
    const s = Math.sin(r)

    for (const [du, dv] of [[-line.w / 2, -line.h / 2], [line.w / 2, -line.h / 2],
      [line.w / 2, line.h / 2], [-line.w / 2, line.h / 2]] as const) {
      const x = line.cx + du * c - dv * s
      const y = line.cy + du * s + dv * c

      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY }
}

export function detBoxFor (
  lines: DetLine[],
  region: Region,
): { tilt: number, cx: number, cy: number, w: number, h: number } | null {
  const inside = lines.filter((line) =>
    line.cx >= region.x && line.cx <= region.x + region.w
    && line.cy >= region.y && line.cy <= region.y + region.h)

  if (!inside.length) return null

  const low = Math.min(...inside.map((line) => line.lean))
  const high = Math.max(...inside.map((line) => line.lean))

  if (high - low > 8) return null

  const total = inside.reduce((sum, line) => sum + line.weight, 0)
  const lean = inside.reduce((sum, line) => sum + line.lean * line.weight, 0) / total

  // The ink path's snap band, honoured here too: a lean of a few degrees is
  // measurement noise. But level is an *answer*, not an absence -- returning
  // null here handed the block to the ink fallback, which promptly invented
  // a -5 lean on a balloon det had just measured straight. A level det box
  // is emitted as exactly that: this block's lettering, upright.
  if (Math.abs(lean) <= 4) {
    const flat = extentOf(inside)

    return { tilt: 0, ...flat }
  }

  // Every claimed line's corners, projected onto the shared direction.
  const radians = (lean * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity

  for (const line of inside) {
    const r = (line.lean * Math.PI) / 180
    const c = Math.cos(r)
    const s = Math.sin(r)

    for (const [du, dv] of [[-line.w / 2, -line.h / 2], [line.w / 2, -line.h / 2],
      [line.w / 2, line.h / 2], [-line.w / 2, line.h / 2]] as const) {
      const x = line.cx + du * c - dv * s
      const y = line.cy + du * s + dv * c
      const u = x * cos + y * sin
      const v = -x * sin + y * cos

      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
  }

  const midU = (minU + maxU) / 2
  const midV = (minV + maxV) / 2

  return {
    tilt: lean,
    cx: midU * cos - midV * sin,
    cy: midU * sin + midV * cos,
    w: maxU - minU,
    h: maxV - minV,
  }
}
