/**
 * What a repair needs of a browser, without the browser: a canvas that paints
 * a known page, and a runtime whose runs a test can hold open.
 *
 * `cleanPage` cuts each balloon out of the page on an `OffscreenCanvas`, masks
 * it, builds the model's tensors with `ortOnce`'s runtime and hands them to a
 * session from `sessionFor`. None of that exists under test, and what is worth
 * testing is exactly what happens *between* them — which balloon is being cut
 * out while which run is in the model, and whether any run is ever handed a
 * tensor another run has had. So each is replaced at its seam, and each writes
 * what it did to one ordered log:
 *
 * - `crop <x>` — a balloon cut out of the page, named by its crop's left edge;
 * - `tensor` — one of the model's two inputs made;
 * - `run <n>` / `ran <n>` — the n-th inference handed its tensors, and answering.
 *
 * The session treats its inputs as the runtime does (see `ortOnce`): each
 * buffer is *transferred* as `run` is called, so a tensor handed to a second
 * run throws here exactly as it does in the browser.
 *
 * The page it paints is lettering over screentone: a dark stroke every eighth
 * column, over two greys fifty levels apart. Every balloon has ink for the
 * threshold to find, and a ring of tone the flat-paper fill refuses — so every
 * one goes to the model, which is the path under test.
 *
 * Used as the stand-in for `sessionFor` and `ortOnce` through `mockNuxtImport`,
 * and for `OffscreenCanvas` and `createImageBitmap` through `vi.stubGlobal`.
 */

/** Everything the stand-ins did, in order — see the header. */
export const log: string[] = []

/** Runs answering only when the test says so, by number — see `hold`. */
const waiting = new Map<number, () => void>()

let holding = false
let runs = 0

/** Numbers of the runs that should throw, as a GPU that fell over would. */
const failing = new Set<number>()

/** Back to nothing logged, nothing held and nothing failing, counting runs from one again. */
export function reset () {
  log.length = 0
  waiting.clear()
  failing.clear()
  holding = false
  runs = 0
}

/** Keep every run from answering until `release` lets it. */
export function hold () {
  holding = true
}

/** Let every held run answer, and every later one answer at once. */
export function release () {
  holding = false

  for (const answer of waiting.values()) answer()

  waiting.clear()
}

/** Make the n-th run throw instead of answering. */
export function fail (n: number) {
  failing.add(n)
}

/** Stand-in for `ort.Tensor`: a type, a buffer and a shape — and a line in the log. */
class Tensor {
  constructor (readonly type: string, readonly data: Float32Array | Uint8Array, readonly dims: readonly number[]) {
    log.push('tensor')
  }
}

/** What `ortOnce` resolves to, as far as `cleanPage` reads it. */
export const runtime = { Tensor }

/** Stand-in for an inpainter's session from `sessionFor`. */
export const session = {
  async run (feeds: Record<string, Tensor>) {
    const n = ++runs

    // Moved into the worker, as the runtime's proxy moves them: a buffer some
    // earlier run was already given is detached, and cloning it throws.
    for (const tensor of Object.values(feeds)) {
      structuredClone(tensor.data.buffer, { transfer: [tensor.data.buffer as ArrayBuffer] })
    }

    log.push(`run ${n}`)

    if (holding) await new Promise<void>((resolve) => waiting.set(n, resolve))

    log.push(`ran ${n}`)

    if (failing.has(n)) throw new Error(`run ${n} fell over`)

    const [, , h, w] = feeds.image!.dims

    return { output: { data: new Float32Array(3 * w! * h!) } }
  },
}

/** Stand-in for a decoded page — all `cleanPage` reads of one is its size. */
export const bitmap = (width: number, height: number) => ({ width, height, close () {} })

/** The screentone and lettering every crop comes out as — see the header. */
function paint (canvas: Canvas) {
  const { width, height, pixels } = canvas

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const value = x % 8 < 2 ? 10 : (x + y) % 2 ? 200 : 250

      pixels[at] = value
      pixels[at + 1] = value
      pixels[at + 2] = value
      pixels[at + 3] = 255
    }
  }
}

class Context {
  imageSmoothingQuality = 'low'

  constructor (private readonly canvas: Canvas) {}

  drawImage (source: unknown, x: number) {
    // A crop off the page, as against a finished tile resampled onto another canvas.
    if (!(source instanceof Canvas)) log.push(`crop ${x}`)

    paint(this.canvas)
  }

  getImageData (_x: number, _y: number, w: number, h: number) {
    return { data: this.canvas.pixels.slice(0, w * h * 4), width: w, height: h }
  }

  createImageData (w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  }

  putImageData () {}
}

/** Stand-in for `OffscreenCanvas`. Its PNG is eight bytes of signature, which is all anything downstream checks. */
export class Canvas {
  readonly pixels: Uint8ClampedArray

  constructor (readonly width: number, readonly height: number) {
    this.pixels = new Uint8ClampedArray(width * height * 4)
  }

  getContext () {
    return new Context(this)
  }

  async convertToBlob () {
    return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
  }
}
