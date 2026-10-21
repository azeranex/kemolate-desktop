/**
 * Painting the original lettering out, per block, on this machine.
 *
 * The half after reading. A detector says where the lettering is and a
 * reader says what it says; this takes the same boxes and gives back the
 * artwork with the words gone — which is the thing a translated page
 * actually needs, and the thing that used to be an hour of hand retouching
 * per chapter.
 *
 * ## Why a mask and not a box
 *
 * The obvious move is to fill the block's rectangle, and it is wrong: a
 * balloon's box contains the balloon, and often art, and filling it paints
 * over both. What has to go is the *ink* — the glyph strokes and nothing
 * else — so the box is only ever a region of interest, and the mask is
 * worked out inside it. How that is done is `mask.ts`'s business; this file
 * only asks for one and is told two shapes of it, hard for the model and
 * soft for the blend.
 *
 * ## Why per block, and why a patch
 *
 * A page is far too big to inpaint whole — the model is quadratic in the
 * area it is handed, and most of a page has nothing wrong with it. So each
 * block is cropped with a margin of real artwork around it, inpainted on its
 * own, and given back as a patch: a small image, and the box it belongs in.
 *
 * That is not only a speed argument. A patch per block is exactly what the
 * `surfaces` table already is — one surface per block, unique on `blockId` —
 * so a cleaned balloon is a thing that can be stored, replaced, reverted and
 * passed between peers on its own, without the rest of the page having to
 * agree about it.
 */

// `Ink` by hand, unlike every other shape this folder shares. The name is also
// a DOM interface (`navigator.ink`), and a global always wins an auto-import —
// so left implicit this file silently types the learned mask as the browser's
// ink presenter, and the assignment fails somewhere that mentions neither.
// Desktop: it is `InkMask` here, which no global shares — see `ocr/mask.ts`.
import type { InkMask } from '~/utils/ocr/mask'
import type { OrtTensor } from '~/utils/ocr/onnx'

import { isOnGpu } from '~/utils/ocr/onnx'
// The mask brush's outward skirt, asked of the brush rather than restated here
// — a second copy of the formula is exactly how the crop and the stroke came to
// disagree. Imported by hand because only `utils/ocr` is auto-imported as a
// family — see `nuxt.config.ts`.
import { maskReach } from '~/utils/paint/stamps'

/**
 * The inpainters, and what each one wants handed to it.
 *
 * All three take an image and a mask and give back a filled image, and all
 * three disagree about nearly everything else — the range the pixels are in,
 * which way round the mask reads, whether the hole should already be blanked
 * out, and whether the tile has to be square. Those differences are data
 * here rather than branches downstream, because they are exactly the sort of
 * thing that is discovered once and then forgotten: an inpainter fed the
 * wrong convention does not fail, it quietly returns the picture unchanged.
 * (AOT did precisely that until it was given a pre-masked image.)
 *
 * The conventions are comic-translate's, which is the reference
 * implementation for all three in this setting.
 */
export type Inpainter = 'none' | 'lama' | 'aot' | 'migan'

/** The ones that are actually a model, which is what a spec below describes. */
export type InpainterModel = Exclude<Inpainter, 'none'>

/**
 * The choice that runs nothing, and why it is a cleaner rather than a switch.
 *
 * A reader with clean raws already — the lettering taken out by hand, at the
 * source resolution — does not want a worse repair computed over the top of a
 * better one. What they want to say is "this chapter's cleaning is not this
 * app's job", and the honest place to say it is the control that asks which
 * cleaner to use. A checkbox somewhere else would be a second thing to find,
 * and a thing to find is a thing to leave switched the wrong way.
 *
 * Deliberately kept out of `INPAINTERS`, which is a list of *models* and whose
 * every field — the url, the range, which way the mask reads — is a fact about
 * weights. Putting a member in there with none of them would mean five
 * optional fields and a `?? INPAINTERS[0]` fallback that quietly cleans with
 * AOT the day somebody forgets a guard. Nothing runs it because nothing can:
 * `INPAINTERS_BY_ID` has never heard of it, and every caller is gated before
 * it gets that far.
 */
export const NO_CLEANER = {
  id: 'none',
  label: 'None',
  note: 'Leaves the page alone — for pages that arrive already cleaned',
} as const

interface InpainterSpec {
  id: InpainterModel
  label: string
  note: string
  /** What it costs to fetch the first time, in bytes. */
  bytes: number
  url: string
  /** How the pixels are scaled on the way in. */
  range: 'unit' | 'signed' | 'byte'
  /** Whether the hole is blanked out of the image before the model sees it. */
  premask: boolean
  /** Whether the mask marks the hole with one, or with nought. */
  holeIsOne: boolean
  /** Some models only work on a square of a fixed size. */
  square?: number
}

export const INPAINTERS: InpainterSpec[] = [
  {
    id: 'aot',
    label: 'AOT',
    note: 'Small and quick',
    bytes: 23_068_213,
    url: 'https://huggingface.co/ogkalu/aot-inpainting/resolve/main/aot.onnx',
    range: 'signed',
    premask: true,
    holeIsOne: true,
  },
  {
    id: 'lama',
    label: 'LaMa (manga)',
    note: 'The heaviest, and the steadiest',
    bytes: 206_291_843,
    url: 'https://huggingface.co/ogkalu/lama-manga-onnx-dynamic/resolve/main/lama-manga-dynamic.onnx',
    range: 'unit',
    premask: false,
    holeIsOne: true,
  },
  {
    id: 'migan',
    label: 'MI-GAN',
    note: 'Small, and works on a fixed square',
    bytes: 28_079_181,
    url: 'https://huggingface.co/anyisalin/migan-onnx/resolve/main/onnx/migan_pipeline.onnx',
    range: 'byte',
    premask: false,
    // The one that reads the other way round: nought is the hole, and the
    // rest of the tile is marked as known.
    holeIsOne: false,
    square: 512,
  },
]

const INPAINTERS_BY_ID = new Map(INPAINTERS.map((spec) => [spec.id, spec]))

/**
 * What the panel offers: the choice that runs nothing, then the models.
 *
 * Below `INPAINTERS` rather than beside `NO_CLEANER`, because a `const` that
 * spreads another one is evaluated where it is written and would otherwise
 * read `INPAINTERS` before the module has got to it.
 */
export const CLEANERS: { id: Inpainter, label: string, note: string, bytes?: number }[] = [
  NO_CLEANER,
  ...INPAINTERS,
]

/**
 * Whether a choice actually repairs anything — asked before every run.
 *
 * A type guard rather than a boolean, so that narrowing it once at the top of a
 * run is what lets the model be handed to `cleanPage` and to `patchKey`, both
 * of which take `InpainterModel`. The alternative was a cast at each of those,
 * and a cast is a promise the compiler stops checking.
 */
export function cleanerRuns (model: Inpainter): model is InpainterModel {
  return INPAINTERS.some((spec) => spec.id === model)
}

/**
 * The size the model is worked at, in pixels of the tile.
 *
 * Rounded to a multiple of eight because the Fourier blocks want a size that
 * halves cleanly, and bounded at both ends because the model is bad outside
 * them in two different ways.
 *
 * The ceiling is speed: cost climbs with area, and a large balloon gains
 * nothing from being reconstructed at full scan resolution.
 *
 * The floor is quality, and it is the one that had to be found the hard way.
 * LaMa was trained at 256 and up; handed a small balloon at its own size —
 * a crop of a hundred pixels or so — it fills the hole with a smear that
 * looks nothing like the paper around it. Scaled up first, given room to
 * work, and scaled back after, the same balloon comes out clean. So a small
 * tile is enlarged rather than passed through as it is.
 */
const TILE_STEP = 8
const TILE_MIN = 256
const TILE_MAX = 512

/** How much real artwork to keep around a block, as a share of its size. */
const CONTEXT = 0.25

/**
 * When there is nothing to invent: how far a pixel of the artwork around a
 * block may sit from that artwork's own colour and still count as the same
 * paper, per channel, out of 255.
 *
 * ## The case this exists for
 *
 * A title set in extra bold CJK on plain white paper — no banner, no fill,
 * nothing behind it. The strokes are heavy enough to be nearly half the crop,
 * so the mask is an enormous hole and the inpainter is asked to invent
 * plausible content for it. There is no plausible content: every honest answer
 * for a hole in blank paper is the paper. What comes back instead is a grey
 * smear — measured on page 4 of Eclipse 2 at mean luminance 216 with 15% of
 * the block still near-black, where the right answer is 255 and none.
 *
 * So when the artwork *kept around* the block is near-uniform, the masked
 * pixels are filled with that colour and the model is not run at all.
 *
 * ## Why the ring, and why a median
 *
 * Judged over the context ring — the padded crop minus the block's own box —
 * because that is the real artwork the repair has to match. The whole crop is
 * mostly the lettering being removed, so measuring it would call a page of
 * black-on-white text "busy" for exactly the reason it is easy.
 *
 * The centre is the ring's median rather than its mean, and the spread is a
 * share rather than a variance, because both are asked of a rectangle that
 * often clips the corner of a panel border. A mean is dragged by that corner
 * and a variance is dominated by it; a median ignores it, and a share simply
 * counts it as one of the few pixels allowed to disagree.
 *
 * ## What moving these numbers breaks
 *
 * Too loose — a wide tolerance or a low share — and a block sitting over real
 * artwork is judged flat: the repair becomes a rectangle of one wrong colour
 * painted over the drawing, which is far more visible than the lettering was
 * and looks deliberate. That is the expensive direction.
 *
 * Too tight and this page keeps its grey smear: a scan's paper is not one
 * value, JPEG ringing around heavy glyphs alone spans several levels, so a
 * tolerance under about eight refuses genuinely blank paper.
 *
 * Twelve and 97% sit between: wide enough for scanner noise and compression
 * around bold strokes, narrow enough that screentone (which alternates between
 * two levels far further apart than this) and any line crossing the ring fail
 * it. Both are stamped into `MASK_RECIPE`, because tightening either changes
 * which blocks are filled and therefore what their patches look like.
 */
const FLAT_TOLERANCE = 12

/** What share of the ring has to be within that tolerance. */
const FLAT_SHARE = 0.97

/**
 * How many ring pixels there have to be before the ring is worth asking.
 *
 * A block clamped against the edge of the page has its margin cut away on that
 * side, and a block that fills its crop has almost no ring at all. A handful of
 * pixels will agree with their own median every time, so without a floor the
 * emptiest ring is the one most confident that the page is blank.
 */
const FLAT_MIN = 256

/** Paper with nothing on it, as the colour to fill a hole in it with. */
export interface FlatPaper {
  r: number
  g: number
  b: number
  /** How much of the ring agreed with that colour, nought to one. */
  share: number
}

/**
 * The colour of the artwork kept around a block, when it is all one colour —
 * or nothing, when there is a drawing under there to preserve.
 *
 * Pure arithmetic over the tile the repair is worked at, so it can be checked
 * without a model or a canvas; see `FLAT_TOLERANCE` for the case it exists for
 * and for what moving its numbers costs.
 *
 * `inner` is the block's own box in the tile's pixels. Everything outside it
 * and inside the tile is the ring — including, deliberately, whatever a brush
 * stroke reached out into. A stroke that ran out over a drawing puts that
 * drawing in the ring and the ring then refuses, which is the answer wanted:
 * the guard is about what is *around* the hole, not about who asked for it.
 */
export function flatContext (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  inner: { x: number, y: number, w: number, h: number },
): FlatPaper | null {
  const ring = (x: number, y: number) =>
    x < inner.x || y < inner.y || x >= inner.x + inner.w || y >= inner.y + inner.h

  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  let count = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ring(x, y)) continue

      const at = (y * w + x) * 4

      histograms[0]![data[at]!]!++
      histograms[1]![data[at + 1]!]!++
      histograms[2]![data[at + 2]!]!++
      count++
    }
  }

  if (count < FLAT_MIN) return null

  /** The level half the ring sits below — the robust centre, per channel. */
  const middle = (histogram: Uint32Array) => {
    let seen = 0

    for (let level = 0; level < 256; level++) {
      seen += histogram[level]!

      if (seen * 2 >= count) return level
    }

    return 255
  }

  const r = middle(histograms[0]!)
  const g = middle(histograms[1]!)
  const b = middle(histograms[2]!)

  let agreed = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ring(x, y)) continue

      const at = (y * w + x) * 4

      // The furthest channel, not the average of them: a colour page whose
      // luminance happens to match has a hue that does not, and a fill of the
      // wrong hue is as visible as a fill of the wrong shade.
      const far = Math.max(
        Math.abs(data[at]! - r),
        Math.abs(data[at + 1]! - g),
        Math.abs(data[at + 2]! - b),
      )

      if (far <= FLAT_TOLERANCE) agreed++
    }
  }

  const share = agreed / count

  return share >= FLAT_SHARE ? { r, g, b, share } : null
}

/**
 * One colour, in the shape `paintedFrom` gives the model's answer back in.
 *
 * Planar, three channels of nought to one, so it can be handed to the
 * composite in place of the model's output and nothing downstream has to know
 * which it got. That substitution is the whole design: the feathered edge and
 * the resample to the region's size are load-bearing and must not be written
 * twice.
 */
export function flatFill (paper: FlatPaper, plane: number): Float32Array {
  const painted = new Float32Array(3 * plane)
  const channels = [paper.r / 255, paper.g / 255, paper.b / 255]

  for (let channel = 0; channel < 3; channel++) {
    painted.fill(channels[channel]!, channel * plane, (channel + 1) * plane)
  }

  return painted
}

/**
 * The repair laid back over the original, through the soft mask.
 *
 * Only the masked pixels are taken from the repair.
 *
 * LaMa reconstructs the *whole* tile it is handed, not just the hole, and
 * what it gives back outside the mask is a good likeness rather than the
 * original — screentone comes back as grey, fine hatching as a smear. Handed
 * straight to the page that reads as a rectangle of slightly wrong artwork
 * around every balloon, which is worse than the lettering was.
 *
 * The soft mask does the blending, and is feathered by a further pixel where
 * it is still hard-edged: a step of one shade along a straight line is exactly
 * what an eye is best at finding. A brush stroke arrives soft already and
 * passes through untouched.
 *
 * `painted` is planar and nought-to-one — whatever produced it. The flat fill
 * comes through here as well as the model's output, so the feather is the same
 * feather and a filled block's edge cannot be a different edge from an
 * inpainted one's.
 */
/**
 * The soft mask, feathered by a further pixel where it is still hard-edged —
 * the weights `paintOver` blends by, and the ones a repair carries as its alpha
 * when it is laid over the page at the page's own resolution (`finishRegion`).
 */
export function featherOf (soft: Float32Array, w: number, h: number): Float32Array {
  const plane = w * h
  const blend = new Float32Array(plane)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x

      let most = soft[i]!

      for (let dy = -1; dy <= 1 && most < 1; dy++) {
        for (let dx = -1; dx <= 1 && most < 1; dx++) {
          const nx = x + dx
          const ny = y + dy

          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

          most = Math.max(most, soft[ny * w + nx]! * 0.5)
        }
      }

      blend[i] = most
    }
  }

  return blend
}

export function paintOver (
  data: Uint8ClampedArray,
  painted: Float32Array,
  soft: Float32Array,
  w: number,
  h: number,
): Uint8ClampedArray {
  const plane = w * h
  const blend = featherOf(soft, w, h)
  const out = new Uint8ClampedArray(plane * 4)

  for (let i = 0; i < plane; i++) {
    const t = blend[i]!

    for (let channel = 0; channel < 3; channel++) {
      const from = data[i * 4 + channel]!
      const to = painted[channel * plane + i]! * 255

      out[i * 4 + channel] = Math.max(0, Math.min(255, from + (to - from) * t))
    }

    out[i * 4 + 3] = 255
  }

  return out
}

/** One block's cleanup: the pixels, and where on the page they belong. */
export interface Patch {
  /** In page pixels, from the top left. */
  x: number
  y: number
  w: number
  h: number
  /**
   * The inpainted crop, at the size of the region it replaces.
   *
   * The page's own resolution, not the tile's — see the resample at the end of
   * `finishRegion` and the reason it has to be there.
   */
  image: Blob
}

/** What a block's turn needs of a model: the one call. */
export interface Runner {
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, { data: unknown }>>
}

const loading = new Map<Inpainter, Promise<Runner>>()

/**
 * The same sessions once they are open, held as the values rather than as the
 * promises of them.
 *
 * So a block's turn can be posted to the runtime in the tick it comes round —
 * see `cleanPage`. Reached through `loading` it would be one `await` later, and
 * an `await` puts the call behind whatever this thread does next, which is
 * exactly the finishing and preparing that is meant to happen while it runs.
 * Dropped with `loading` when a session fails on the GPU.
 */
const opened = new Map<Inpainter, Runner>()

/** Models whose WebGPU session failed mid-run in this tab, and so run on wasm. */
const gpuFailed = new Set<Inpainter>()

/** Models whose session in this tab is open, and where — see `repairsAreQuick`. */
const onGpuNow = new Set<Inpainter>()
const onWasmNow = new Set<Inpainter>()

/**
 * Whether a repair with this model can be started eagerly: it runs on WebGPU,
 * or it has not been opened yet and this browser has WebGPU to open it on.
 *
 * What the brush's wait is sized by, and the question is really the opposite
 * one — whether starting early could *cost* something. It can on
 * single-threaded wasm: LaMa is seconds a balloon there, and a repair started
 * mid-flurry holds the worker after the next stroke has called it off, since
 * inference cannot be interrupted (see `CleanOptions.signal`). Anywhere else a
 * repair is half a second at worst.
 *
 * Asked as "not known to be slow" rather than "known to be quick" because the
 * commonest correction never opens a model at all: a caption on blank paper is
 * filled from the paper (`flatContext`), so a rule that waited for proof of a
 * GPU session kept the long wait on exactly the pages where it bought nothing.
 */
export function repairsAreQuick (model: InpainterModel): boolean {
  if (onGpuNow.has(model)) return true
  if (onWasmNow.has(model)) return false

  return typeof navigator !== 'undefined' && 'gpu' in navigator && !gpuFailed.has(model)
}

/**
 * The inpainter's session, opened once per tab — on WebGPU where it will open
 * (see `sessionFor` for the measurements), on wasm otherwise.
 *
 * A GPU can also fail *after* opening: a lost device, a driver reset, a tab
 * put to sleep. That block is reported as failed like any other throw, and the
 * session is dropped and the model marked, so the next block opens a wasm
 * session instead of failing the same way for the rest of the chapter. Not
 * retried in place: the tensors a run is handed may already have been taken
 * (see the ONNX gotcha in CLAUDE.md), and a retry would need new ones.
 */
function sessionOnce (spec: InpainterSpec, onProgress?: MangaProgress): Promise<Runner> {
  const held = loading.get(spec.id)

  if (held) return held

  const made = sessionFor(spec.url, onProgress, { gpu: !gpuFailed.has(spec.id) }).then((session): Runner => {
    if (isOnGpu(session)) {
      onGpuNow.add(spec.id)
      onWasmNow.delete(spec.id)
    } else {
      onWasmNow.add(spec.id)
      onGpuNow.delete(spec.id)
    }

    const runner: Runner = {
      run: (feeds) => session.run(feeds).catch((error: unknown) => {
        if (isOnGpu(session)) {
          console.warn('[kemolate] the inpainter failed on WebGPU — the next block runs on WebAssembly.', error)
          gpuFailed.add(spec.id)
          onGpuNow.delete(spec.id)
          loading.delete(spec.id)
          opened.delete(spec.id)
        }

        throw error
      }),
    }

    opened.set(spec.id, runner)

    return runner
  }).catch((error) => {
    loading.delete(spec.id)
    throw error
  })

  loading.set(spec.id, made)

  return made
}

/**
 * A size the model is happy with: big enough to be good, small enough to be
 * quick. Exported because the mask plate draws at the same size the cleaning
 * will be worked at — a mask shown at one resolution and applied at another
 * is a mask that lies about which pixels it covers.
 */
export function tileSize (w: number, h: number) {
  const longest = Math.max(w, h)

  // Enlarge until the long edge reaches the floor, then shrink if it passes
  // the ceiling. In that order, so a tile that is small in both directions
  // is grown rather than left alone.
  const scale = Math.min(TILE_MAX / longest, Math.max(1, TILE_MIN / longest))
  const round = (value: number) => Math.max(TILE_STEP, Math.round((value * scale) / TILE_STEP) * TILE_STEP)

  return { w: round(w), h: round(h) }
}

/** The runtime as `ortOnce` hands it over — what a tensor is made with. */
type Runtime = Awaited<ReturnType<typeof ortOnce>>

/**
 * One tile in whatever dialect the model speaks: the two tensors one run of it
 * is handed.
 *
 * Made for exactly one run and never touched again. The runtime runs inference
 * in a worker and *transfers* each input's buffer to it (see `ortOnce`), so a
 * tensor handed to one run is detached before the next, and a second run given
 * it dies with "ArrayBuffer … is already detached", naming nothing. A balloon
 * made ready ahead of its turn (see `cleanPage`) carries a pair made for it
 * alone, and a run that fails is not retried with them — see `sessionOnce`.
 *
 * The square models are the awkward case: the tile is stretched onto their
 * square here and read back through the same stretch in `paintedFrom`, so
 * everything either side of the two can go on thinking in the tile's own shape.
 */
function feedsFor (
  spec: InpainterSpec,
  ort: Runtime,
  data: Uint8ClampedArray,
  mask: Float32Array,
  size: { w: number, h: number },
): Record<string, OrtTensor> {
  const to = spec.square ? { w: spec.square, h: spec.square } : size
  const plane = to.w * to.h

  /** Where a pixel of the model's input sits in the tile. */
  const source = (i: number) => {
    if (!spec.square) return i

    const x = Math.min(size.w - 1, Math.floor((i % to.w) * size.w / to.w))
    const y = Math.min(size.h - 1, Math.floor(Math.floor(i / to.w) * size.h / to.h))

    return y * size.w + x
  }

  const bytes = spec.range === 'byte'
  const image = bytes ? new Uint8Array(3 * plane) : new Float32Array(3 * plane)
  const holes = bytes ? new Uint8Array(plane) : new Float32Array(plane)

  for (let i = 0; i < plane; i++) {
    const at = source(i)
    const hole = mask[at]! > 0

    for (let channel = 0; channel < 3; channel++) {
      const value = data[at * 4 + channel]!

      image[channel * plane + i] = bytes
        ? value
        : (spec.premask && hole ? 0 : spec.range === 'signed' ? value / 127.5 - 1 : value / 255)
    }

    holes[i] = spec.holeIsOne ? (hole ? 1 : 0) : (hole ? 0 : 255)
  }

  return {
    image: bytes
      ? new ort.Tensor('uint8', image as Uint8Array, [1, 3, to.h, to.w])
      : new ort.Tensor('float32', image as Float32Array, [1, 3, to.h, to.w]),
    mask: bytes
      ? new ort.Tensor('uint8', holes as Uint8Array, [1, 1, to.h, to.w])
      : new ort.Tensor('float32', holes as Float32Array, [1, 1, to.h, to.w]),
  }
}

/** The model's answer, back in the tile's own shape and as plain nought-to-one channels, whatever came out. */
function paintedFrom (
  spec: InpainterSpec,
  out: Record<string, { data: unknown }>,
  size: { w: number, h: number },
): Float32Array {
  const to = spec.square ? { w: spec.square, h: spec.square } : size
  const plane = to.w * to.h
  const raw = (Object.values(out)[0]!).data as Float32Array | Uint8Array
  const painted = new Float32Array(3 * size.w * size.h)

  for (let i = 0; i < size.w * size.h; i++) {
    const at = spec.square
      ? Math.floor((i / size.w | 0) * to.h / size.h) * to.w + Math.min(to.w - 1, Math.floor((i % size.w) * to.w / size.w))
      : i

    for (let channel = 0; channel < 3; channel++) {
      const value = raw[channel * plane + at]!

      painted[channel * size.w * size.h + i] = spec.range === 'signed'
        ? (value + 1) / 2
        : spec.range === 'byte' ? value / 255 : value
    }
  }

  return painted
}

/**
 * The crop a block is cleaned in: its box, grown by the context margin and by
 * whatever was brushed onto its mask, clamped to the page.
 *
 * Exported because a patch is *filed* under this box, not under the block's
 * own — so anything reading a cached patch back has to work out the same
 * rectangle, and two copies of this arithmetic would drift the day the
 * margin changed. Given the same block, page and corrections it is exact,
 * which is what lets a patch be found again without storing its geometry
 * beside it.
 *
 * ## Why the corrections move the edge
 *
 * The crop is the only thing the repair can touch, and the mask is confined
 * to it, so a stroke that ran past the margin was silently cut off at it:
 * the brush drew the mark, and the mask came back with a hard straight edge
 * where the rectangle happened to end. Lettering does not respect a box
 * drawn around some *other* lettering — a sound effect's tail trails well
 * past the glyphs a detector boxed — and the whole reason to have a brush is
 * to say so.
 *
 * So an addition drags the edge out to cover itself, with the same margin
 * around it that the block gets, and the patch grows to match. A wipe never
 * does: it only ever takes mask away, and a crop grown to hold one would be
 * a larger repair made to do less.
 *
 * The cost is quality rather than time — `tileSize` caps the long edge, so a
 * crop stretched across half a page is inferred at the same resolution as a
 * balloon and comes back correspondingly coarse. That is the honest trade:
 * paint a mask that size and you have asked for a repair that size.
 */
export function paddedBox (
  region: Region,
  pageWidth: number,
  pageHeight: number,
  edits: MaskEdit[] = [],
): Region {
  const pad = Math.round(Math.min(region.w, region.h) * CONTEXT)

  let left = region.x - pad
  let top = region.y - pad
  let right = region.x + region.w + pad
  let bottom = region.y + region.h + pad

  for (const edit of edits) {
    if (edit.kind !== 'add') continue

    // How far the brush actually carries, plus the margin — the brush's own
    // answer rather than a copy of it kept here, which is what let the two
    // drift apart. Short of that the crop would end exactly where the stroke
    // does, leaving the model no real artwork on that side to work from.
    const far = maskReach(edit.size / 2, 1 - Math.min(1, Math.max(0, edit.hardness))) + pad

    for (let i = 0; i < edit.points.length - 1; i += 2) {
      left = Math.min(left, edit.points[i]! - far)
      top = Math.min(top, edit.points[i + 1]! - far)
      right = Math.max(right, edit.points[i]! + far)
      bottom = Math.max(bottom, edit.points[i + 1]! + far)
    }
  }

  const x = Math.max(0, Math.round(left))
  const y = Math.max(0, Math.round(top))

  return {
    x,
    y,
    w: Math.min(pageWidth - x, Math.round(right) - x),
    h: Math.min(pageHeight - y, Math.round(bottom) - y),
  }
}

/**
 * One balloon cut out, masked and made ready for its turn with the model:
 * everything a repair needs before the inference, and what it needs after.
 */
interface Prepared {
  /** The crop on the page, in page pixels — the block's box padded, and where the patch goes. */
  crop: Region
  /** The size the model is worked at — see `tileSize`. */
  size: { w: number, h: number }
  canvas: OffscreenCanvas
  context: OffscreenCanvasRenderingContext2D
  /** The soft mask: what the repair is blended by, and carries as its alpha. */
  soft: Float32Array
  /**
   * What fills the hole: the paper's own colour where there is nothing to
   * invent (see `flatContext`), or the model's input, made for the one run it
   * will be handed to (see `feedsFor`).
   */
  fill: { paper: FlatPaper } | { feeds: Record<string, OrtTensor> }
}

/**
 * One block, cropped with context and masked — the half of a repair that
 * happens before the model, done ahead of the block's turn (see `cleanPage`).
 *
 * `parts` are the block's own pieces in page pixels — a joined balloon's
 * per-line boxes — and they only ever divide the *mask*: each is thresholded
 * separately, because one Otsu level across a stack of lines misses the faint
 * ones outright (see `mask.ts`). The crop, the inference and the patch stay
 * one rectangle over the whole block, because repairing the lines separately
 * leaves strips of untouched balloon showing as seams between them.
 *
 * `report` is told why there is no patch, in the same words the console gets.
 * Returning `null` is enough for this file — the region is skipped either way
 * — but a person looking at a block that will not clean needs the sentence,
 * and the console is not where they are looking.
 *
 * `seg` is the page's learned mask, already read once for the whole page by
 * `cleanPage`. Sliced here rather than inferred here: one inference for the
 * page against one per balloon is the difference between five seconds and a
 * minute, and a per-block call would be the easiest thing in the world to
 * write by accident.
 *
 * The model's input is built here as well, so that a block's turn is the one
 * call. The session is not asked for: a block on blank paper is filled from the
 * paper (`flatContext`) and never touches the model, so a page of nothing but
 * those costs no download at all — which it did while the session was fetched
 * before the loop. It is asked for at the block's turn, and only for a block
 * that needs it.
 *
 * Everything up to the mask is synchronous, the crop included, which matters to
 * `cleanPage`: this starts while the page's bitmap is held and has finished
 * with it by the first `await`.
 *
 * One bag rather than trailing arguments, for the reason `CleanOptions` gives:
 * this grew one at a time and had reached the point where every call site was
 * counting commas.
 */
async function prepareRegion (
  spec: InpainterSpec,
  bitmap: ImageBitmap,
  region: Region,
  hand: {
    edits?: MaskEdit[]
    parts?: Region[]
    report?: (why: string) => void
    seg?: Segmented | null
    outline?: Point[] | null
  },
): Promise<Prepared | null> {
  const { edits = [], parts = [], report, seg, outline } = hand
  const { x, y, w, h } = paddedBox(region, bitmap.width, bitmap.height, edits)

  if (w < TILE_STEP || h < TILE_STEP) {
    const why = `its crop is ${w}×${h}, under the ${TILE_STEP}px a tile is made of.`

    console.warn(`[kemolate] block not cleaned: ${why}`)
    report?.(why)

    return null
  }

  const size = tileSize(w, h)
  const canvas = new OffscreenCanvas(size.w, size.h)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) return null

  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, x, y, w, h, 0, 0, size.w, size.h)

  const { data } = context.getImageData(0, 0, size.w, size.h)

  /** A box on the page, in the tile's coordinates. */
  const onTile = (box: Region) => ({
    x: Math.round(((box.x - x) / w) * size.w),
    y: Math.round(((box.y - y) / h) * size.h),
    w: Math.round((box.w / w) * size.w),
    h: Math.round((box.h / h) * size.h),
  })

  // The block's own box, and the pieces the threshold is taken over — the
  // block itself when nobody joined anything, which is nearly every block.
  const inner = onTile(region)
  const tiled = parts.map(onTile)

  /*
   * Whether there is anything here to invent.
   *
   * Decided before the mask, and from the artwork *around* the block rather
   * than from the mask's own pixels, so that it is an answer about the page
   * and not about how much lettering happened to be found — see
   * `flatContext`. Said out loud when it fires, because a repair that skipped
   * the model is a repair somebody will otherwise attribute to the model — here
   * to the console, and at the block's turn to the progress line.
   */
  const flat = flatContext(data, size.w, size.h, inner)

  if (flat) {
    console.info(`[kemolate] flat paper around this block (${Math.round(flat.share * 100)}% of the ring) — filling rather than inpainting.`)
  }

  /*
   * The learned mask for this crop, when one was asked for.
   *
   * `segFor` cuts the crop out of the model's square at the crop's own page
   * pixels — the mapping already exists and is not worth a second copy — and
   * `learnedInk` puts it on the tile, confines it to the same regions the
   * threshold would have used, and grows it the same way.
   *
   * `null` back means the model marked nothing inside this block, which is
   * its known weakness on invented sound effects. That is a block for the
   * threshold to answer, not a block to leave uncleaned — so the fallback is
   * simply not passing anything, which is today's path exactly. Said out
   * loud, because a repair quietly made from the other mask is the kind of
   * thing that makes a toggle look like it does nothing.
   */
  let learned: InkMask | null = null

  if (seg) {
    learned = learnedInk(segFor(seg, { x, y, w, h }), { w, h }, size.w, size.h, tiled.length ? tiled : [inner])

    if (!learned) {
      console.info('[kemolate] the learned mask found nothing here — falling back to the threshold for this block.')
    }
  }

  // The corrections arrive in page pixels — where they were drawn and where
  // they are stored — and are moved into this tile's own scale here, which
  // is the only place that knows what that scale turned out to be.
  const mask = effectiveMask(
    data,
    size.w,
    size.h,
    inner,
    editsForTile(edits, { x, y, w, h }, size),
    tiled,
    learned,
    // A turned block's outline, moved into this tile's pixels — see `blockOutline`.
    outline?.map((point) => ({ x: ((point.x - x) / w) * size.w, y: ((point.y - y) / h) * size.h })),
  )

  /*
   * Nothing crossed the threshold and nobody corrected it — a box the
   * detector drew over artwork rather than lettering. Left alone rather than
   * filled with a guess, and said out loud: a block that will not clean and
   * will not say why is the hardest kind of nothing to chase, and the plate
   * shows the *soft* mask, so a correction sitting under half strength looks
   * like a mask that ought to work.
   *
   * A refusal is the better answer where there was one, because it names the
   * cause rather than the symptom. It is only reached here, with the mask
   * empty: a balloon whose fifth line was refused and whose other four masked
   * fine has cleaned, and is not worth a word.
   */
  if (!mask.hard.some((value) => value > 0)) {
    const most = mask.soft.reduce((top, value) => Math.max(top, value), 0)

    const advice = most > 0
      ? ' A softer brush marks less than it shows; harden it, or go over the same place again.'
      : ' Nothing was found here and nothing was painted.'

    const why = mask.refused.length
      ? refusalNote(mask.refused, mask.read)
      : `nothing in its mask reached half strength — the strongest part is ${Math.round(most * 100)}%.${advice}`

    console.warn(`[kemolate] block not cleaned: ${why}`)
    report?.(why)

    return null
  }

  /*
   * Either the model's input, or the paper's own colour where there is nothing
   * to invent — see `flatContext`, and note that `flat` was decided before any
   * of this from the artwork around the block.
   *
   * The model gets the *hard* mask, because that is the only thing it
   * understands — see the header of `mask.ts`. Everything after the inference
   * is the same either way, which is the point: the composite feathers the edge
   * and the resample puts the patch on the page's own grid (`finishRegion`),
   * and a second path through those is a second place for them to be got wrong.
   */
  return {
    crop: { x, y, w, h },
    size,
    canvas,
    context,
    soft: mask.soft,
    fill: flat ? { paper: flat } : { feeds: feedsFor(spec, await ortOnce(), data, mask.hard, size) },
  }
}

/**
 * A block's repair made into a patch — the half after the model: the painted
 * tile laid through the soft mask, put back on the page's own grid, and
 * encoded.
 *
 * `painted` is planar and nought-to-one, the model's answer or the paper's
 * colour alike (`flatFill`), and nothing here needs to know which. Run while the
 * *next* block is in the model — see `cleanPage` — so it is this thread's work
 * and the encode's, and none of it waits on the inference.
 */
async function finishRegion (prepared: Prepared, painted: Float32Array): Promise<Patch | null> {
  const { crop: { x, y, w, h }, size, canvas, context, soft } = prepared
  const plane = size.w * size.h
  const result = context.createImageData(size.w, size.h)

  /*
   * A repair is the painted part and nothing else: its alpha is the feathered
   * mask, and where the mask is nought it is transparent.
   *
   * It used to be an opaque rectangle — the scan's own pixels outside the mask,
   * blended here. Laid straight on the page that is the same picture, but a
   * repair is not only ever laid on the page: blocks overlap, and turned ones
   * overlap a great deal. On a phone screen turned 21° the big block's repair
   * cleaned all three messages, and its two neighbours' repairs were drawn over
   * it carrying the original lettering outside their own masks, which put
   * "죽을 것" and "사랑해" straight back. Transparent, each repair changes only
   * what its own mask covers, in whatever order they are drawn.
   *
   * `paintOver` is still the arithmetic: a repair laid over its scan is exactly
   * what it computes.
   *
   * The blend is done at the page's size, not the model's. It used to be done
   * here, at the model's size, and the finished tile then resampled back —
   * which took every pixel of the rectangle through two resamples, the unmasked
   * ones included. On flat paper that is invisible. On screentone it is not:
   * the dots came back as a soft grey, measured on a phone screen at 65% of the
   * unmasked pixels changed and a mean of 50 levels along the rectangle's edge,
   * and the patch showed as a rectangle of blurred tone laid over crisp tone.
   * Only the painted part is resampled now, and the page shows through the rest.
   */
  const blend = featherOf(soft, size.w, size.h)

  for (let i = 0; i < plane; i++) {
    result.data[i * 4] = Math.round(painted[i]! * 255)
    result.data[i * 4 + 1] = Math.round(painted[plane + i]! * 255)
    result.data[i * 4 + 2] = Math.round(painted[2 * plane + i]! * 255)
    result.data[i * 4 + 3] = Math.round(blend[i]! * 255)
  }

  context.putImageData(result, 0, 0)

  // At the page's own size there is nothing to resample.
  if (size.w === w && size.h === h) return { x, y, w, h, image: await canvas.convertToBlob({ type: 'image/png' }) }

  /*
   * Back down to the size of the region it replaces, before it is stored.
   *
   * The model is worked at `tileSize` because that is where it is good — a
   * small balloon at its own size comes out a smear. But the *result* is a
   * picture of a rectangle of the scan, and storing it at any other resolution
   * means it can never be laid back down without being resampled.
   *
   * That is not a quality question, it is a matching one. The sheet asks for
   * `pixelated` from 1:1 upwards, so an enlarged scan shows its real pixels;
   * a patch on a different grid then either shows *its* pixels — blocks of a
   * different size than the artwork around them — or is exempted and smoothed,
   * which is a soft rectangle sitting in crisp line art. Both are visible
   * seams, and they are the same seam: the patch was never on the page's own
   * grid.
   *
   * One resample here, done once with smoothing, in place of one per frame
   * done by the browser at whatever the zoom is. After it the patch is the
   * page's resolution exactly, and every renderer that touches it — pixelated,
   * smoothed, printed — treats it as it treats the scan.
   */
  const out = new OffscreenCanvas(w, h)
  const oc = out.getContext('2d')

  if (!oc) return null

  oc.imageSmoothingQuality = 'high'
  oc.drawImage(canvas, 0, 0, size.w, size.h, 0, 0, w, h)

  return { x, y, w, h, image: await out.convertToBlob({ type: 'image/png' }) }
}

/**
 * What a caller knows about the regions that this file cannot work out for
 * itself, keyed by a region's place in the list.
 *
 * One bag rather than three trailing arguments: the first two arrived
 * separately and the third would have made `cleanPage` a function nobody can
 * call without counting commas. Every field is optional and an absent bag
 * means the old behaviour exactly, which is what keeps `ocr-lab` — four
 * positional arguments and no opinions — compiling untouched.
 */
export interface CleanOptions {
  /**
   * Corrections in page pixels, by their region's index. Absent for a block
   * nobody has corrected, which is most of them.
   */
  edits?: Record<number, MaskEdit[]>
  /**
   * The pieces a region is made of, in page pixels — a joined balloon's
   * per-line boxes. They split the *mask* and nothing else; see `prepareRegion`.
   */
  parts?: Record<number, Region[]>
  /**
   * Told about a region that came back with no patch, and why, in a sentence
   * meant for a person. The console hears the same thing regardless; this is
   * for whoever is looking at the page rather than at the devtools.
   */
  onSkip?: (index: number, why: string) => void
  /**
   * Read the lettering with the learned segmenter rather than with Otsu.
   *
   * Present means yes, and it carries the scan's content hash because the
   * page is read *once* and the answer filed under it — see `segmentedPage`.
   * The hash rather than a flag, so that cleaning one balloon after a brush
   * stroke reuses the page's mask instead of paying for it again.
   *
   * Absent is the threshold, which is the default and always will be: this
   * costs a model download the first time, and a page that cleans without one
   * must go on cleaning without one.
   */
  segment?: { scan: string }
  /**
   * A turned block's outline, in page pixels, by its region's index — see
   * `blockOutline`. The region is then the upright box around it, and the
   * automatic mask is kept inside the outline. Absent for an upright block.
   */
  outlines?: Record<number, Point[] | null>
  /**
   * Abandon the run: the answer is no longer wanted.
   *
   * The brush's case — a correction drawn while the repair made from the
   * previous mask is still running. That repair is a picture of a mask that no
   * longer exists, and waiting it out was what held the brush still: every
   * release queued a clean, and the next stroke had to wait for it to finish.
   *
   * And a run's case: a chapter closed or replaced while `useClean.run` is on it,
   * whose repairs nobody is going to see and must not be kept.
   *
   * Checked between steps rather than inside one. Inference runs in a worker
   * and cannot be called back once it has been handed its tensor (see `ortOnce`),
   * so an abort lands at the next seam — before the page is decoded, before each
   * balloon, just before a balloon's inference starts (the last point where the
   * expensive part can still be skipped), as each inference comes back, and once
   * the page's last repair is finished. A balloon made ready ahead of its turn
   * (see `cleanPage`) goes with the rest, never having been run. Rejects with an
   * `AbortError`, which the caller reads as "stopped", not "failed".
   */
  signal?: AbortSignal
}

/** A step's answer or its failure, held rather than thrown — see `settle`. */
type Outcome<T> = { value: T } | { error: unknown }

/**
 * A step's outcome, kept until its block's turn reads it.
 *
 * `cleanPage` has a block's preparation and another block's inference in the
 * air at once, and whichever fails first would otherwise reject with nothing
 * listening — an unhandled rejection, and the failure filed against no block.
 */
function settle<T> (work: Promise<T>): Promise<Outcome<T>> {
  return work.then((value) => ({ value }), (error: unknown) => ({ error }))
}

/**
 * Clean every given region of a page: one inference at a time, with the next
 * balloon made ready while the model works on this one.
 *
 * One inference at a time because the model takes the whole machine while it
 * runs, and because a patch that fails should cost its own block rather than
 * the page: a region that produced no mask, or threw, is skipped and the rest
 * go on.
 *
 * ## Why the next balloon is made ready early
 *
 * The inference runs in the runtime's worker (see `ortOnce`). This thread used
 * to wait it out with nothing to do, and the moment it came back, cut the next
 * crop out of the page, masked it and built its tensors — while the *worker*
 * waited. Every balloon paid for its preparation, its inference and its
 * finishing one after another. Now a block's run is posted the moment its turn
 * comes round, and this thread spends that run finishing the block before it
 * (`finishRegion`) and making ready the block after it (`prepareRegion`), so a
 * page costs its inferences plus one preparation and one finish rather than the
 * sum of all three for every balloon.
 *
 * Two rules it must not bend, and why it cannot:
 *
 * - **One run at a time.** A block's run is started only once the one before it
 *   has come back, so the session never has two in flight. `sessionOnce` has to
 *   be able to drop a session that failed mid-run and open another, and a second
 *   run already queued on the dropped one would fail for no reason of its own.
 * - **Tensors made for one run.** A block's are built when it is made ready
 *   (`feedsFor`) and handed to its run and nothing else; the block made ready
 *   behind a run that failed goes to the next session with tensors no run has
 *   touched.
 *
 * ## What it buys, measured
 *
 * On the CGu chapter — eight 3732 × 5197 pages, 55 balloons through LaMa and
 * the learned mask on WebGPU, output byte-identical to the one-at-a-time loop
 * on every balloon compared — it depends on how busy the machine is, because
 * the part the overlap takes off the critical path is mostly the finish:
 *
 * - With the machine loaded (load average ~70), "Clean all" went from a median
 *   of 37.7 s to 21.0 s. There a large balloon's PNG — a crop of up to four
 *   megapixels at the page's own resolution — took 0.6–0.7 s to encode, and
 *   the old loop waited it out before cutting the next balloon.
 * - On a quieter one it was 4%: five interleaved pairs, the new loop faster in
 *   all five, by 1.1 s in 24.7 on average. A balloon's preparation and finish
 *   come to 20–40 ms against a 200–400 ms run, and an encode that lands beside
 *   a run was seen to slow both (0.72 s and 1.34 s, against 5 ms and 0.19 s
 *   apart) — the resample canvas and the inference both go through the
 *   browser's GPU process.
 *
 * The finishes are not held to a count. Their encodes queue behind the model
 * only as fast as this thread makes them, and at most two were ever in flight
 * on that chapter, with LaMa or with AOT — about 11 megapixels of canvas.
 */
export async function cleanPage (
  page: Readable,
  regions: Region[],
  onProgress?: MangaProgress,
  // `InpainterModel` and not `Inpainter`: `none` is a thing a reader can choose
  // and not a thing this can be asked to run, and saying so in the type is what
  // stops the fallback below turning "no cleaner" into "clean it with AOT".
  model: InpainterModel = 'aot',
  options: CleanOptions = {},
): Promise<Patch[]> {
  const spec = INPAINTERS_BY_ID.get(model) ?? INPAINTERS[0]!

  /*
   * The inpainter, fetched the first time a block actually needs one.
   *
   * It used to be fetched before the loop, so that the download was reported
   * once rather than appearing to stall the first region — and it is still
   * reported, because `onProgress` goes with it. What changed is that a block
   * on blank paper is filled from the paper and never asks, so a page of
   * nothing but those now costs no download at all. Handing the whole page a
   * model it turns out not to use is a minute of somebody's connection spent
   * on nothing.
   *
   * `broken` is what keeps that from quietly becoming worse. A session that
   * will not load is not one block's problem, and the loop below swallows
   * per-block failures on purpose — left to it, an inpainter that 404s would
   * report itself once per balloon and the page would look like twelve
   * unrelated bugs. Caught here, it fails the page once, exactly as an eager
   * fetch did.
   */
  let broken: unknown = null

  const session = async (): Promise<Runner> => {
    try {
      return await sessionOnce(spec, onProgress)
    } catch (thrown) {
      broken = thrown

      throw thrown
    }
  }

  /*
   * And the page's lettering mask, for the same reason twice over: the model
   * is another download to report rather than hang on, and the inference is
   * one for the page rather than one per balloon.
   *
   * Allowed to throw, unlike a block whose mask came back empty. A segmenter
   * that will not load means every repair on this page would be made from a
   * mask nobody asked for, and quietly getting the old behaviour back is
   * precisely what a toggle exists to make visible. The inpainter's own
   * session fails the same way, for the same reason — one block later, by way
   * of `broken`, because it is no longer asked for until something needs it.
   */
  options.signal?.throwIfAborted()

  const seg = options.segment ? await segmentedPage(page, options.segment.scan, onProgress) : null

  options.signal?.throwIfAborted()

  const { bitmap, release } = await pageBitmap(page.file)

  try {
    const total = regions.length
    const made: (Patch | null)[] = []
    const finishing: Promise<void>[] = []

    // Swallowed as it always was — one bad region must not cost the page — but
    // no longer silently. A throw is the one skip that never reached the
    // console either, so it was invisible from both sides.
    const skip = (index: number, thrown: unknown) =>
      options.onSkip?.(index, `the repair failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`)

    /**
     * A block's failure, read at its turn — except the two that are about the
     * page rather than the block: an inpainter that will not load (see
     * `broken`), and being called off (see `signal`). Rethrown rather than filed
     * as a skip against whichever balloon happened to ask first.
     */
    const failed = (index: number, thrown: unknown) => {
      if (broken) throw broken
      if (options.signal?.aborted) throw thrown

      skip(index, thrown)
    }

    const prepare = (index: number) => settle(prepareRegion(spec, bitmap, regions[index]!, {
      edits: options.edits?.[index],
      parts: options.parts?.[index],
      report: (why) => options.onSkip?.(index, why),
      seg,
      outline: options.outlines?.[index] ?? null,
    }))

    /**
     * A block's turn: its inference posted — or its paper filled.
     *
     * Posted in this tick wherever the session is already open (`opened`). Sent
     * through the session's promise instead, the call would wait an `await` —
     * behind the finishing and preparing below, which is exactly what is meant
     * to happen *while* it runs.
     */
    const turn = (index: number, prepared: Prepared): Promise<Outcome<Float32Array>> => {
      if ('paper' in prepared.fill) {
        onProgress?.('Filling flat paper…', { done: index, total })

        return Promise.resolve({ value: flatFill(prepared.fill.paper, prepared.size.w * prepared.size.h) })
      }

      const { feeds } = prepared.fill
      const open = opened.get(spec.id)
      const running = open ? open.run(feeds) : session().then((runner) => runner.run(feeds))

      return settle(running.then((out) => paintedFrom(spec, out, prepared.size)))
    }

    /** A block whose inference is back, made into its patch while the next one runs. */
    const finish = (index: number, prepared: Prepared, painted: Float32Array) => {
      finishing.push(finishRegion(prepared, painted).then(
        (patch) => { made[index] = patch },
        // A page called off is dropped whole; one that was not has lost a balloon.
        (thrown: unknown) => { if (!options.signal?.aborted) skip(index, thrown) },
      ))
    }

    let ahead = total ? prepare(0) : null
    let back: { index: number, prepared: Prepared, painted: Float32Array } | null = null

    for (let index = 0; index < total; index++) {
      options.signal?.throwIfAborted()

      onProgress?.(`Cleaning ${index + 1} of ${total}…`, { done: index, total })

      const ready = await ahead!

      if ('error' in ready) failed(index, ready.error)

      const prepared = 'value' in ready ? ready.value : null

      // The last seam before the expensive part — see `CleanOptions.signal`.
      options.signal?.throwIfAborted()

      const running = prepared ? turn(index, prepared) : null

      // And while that runs: the balloon before it made into its patch, and the
      // one after it cut out, masked and given its tensors.
      if (back) finish(back.index, back.prepared, back.painted)

      back = null
      ahead = index + 1 < total ? prepare(index + 1) : null

      if (!prepared || !running) continue

      const answer = await running

      if ('error' in answer) {
        failed(index, answer.error)

        continue
      }

      // Called off while the model ran: this answer goes, and so does the
      // balloon made ready behind it, which is never run.
      options.signal?.throwIfAborted()

      back = { index, prepared, painted: answer.value }
    }

    if (back) finish(back.index, back.prepared, back.painted)

    await Promise.all(finishing)

    // Called off while the last repair was being finished: not handed back as
    // though the page had been cleaned.
    options.signal?.throwIfAborted()

    return made.filter((patch): patch is Patch => Boolean(patch))
  } finally {
    release()
  }
}

/**
 * The decoded page, kept for a moment after a clean in case another follows.
 *
 * Every clean decoded the whole scan to cut one crop out of it, which on a
 * page run is once and on the mask brush is once *per stroke*: 60–70 ms for a
 * 2654×4025 PNG on an M-series Mac, and more on a slower machine or a bigger
 * page, spent again on every correction to a caption on the same page. One
 * page is held — the one being corrected — for `KEEP_BITMAP` after its last
 * use, and closed when another page is asked for. A decoded page of that size
 * is about 40 MB, which is why it is one and why it is let go.
 *
 * Keyed by the `File` itself rather than the hash, so a page whose file is
 * replaced (linked, fetched from a peer) can never be answered with the
 * pixels of the one before it.
 */
const KEEP_BITMAP = 5000

interface HeldPage {
  file: Blob
  bitmap: Promise<ImageBitmap>
  users: number
  timer: ReturnType<typeof setTimeout> | null
}

let kept: HeldPage | null = null

const closeHeld = (held: HeldPage) => { held.bitmap.then((bitmap) => bitmap.close()).catch(() => {}) }

/**
 * The page's bitmap, and the call that says this use of it is over.
 *
 * Counted per entry, so a page that stops being the kept one while cleans are
 * still drawing from it — a page run and a brush clean overlapping — is closed
 * by the last of them rather than under the others.
 */
async function pageBitmap (file: Blob): Promise<{ bitmap: ImageBitmap, release: () => void }> {
  if (kept?.file !== file) {
    const before = kept

    if (before && !before.users) {
      if (before.timer) clearTimeout(before.timer)
      closeHeld(before)
    }

    const made: HeldPage = { file, bitmap: createImageBitmap(file), users: 0, timer: null }

    kept = made
    // A decode that fails is not kept, or every later clean of the page would
    // be handed the same rejection.
    made.bitmap.catch(() => { if (kept === made) kept = null })
  }

  const held = kept

  held.users++

  if (held.timer) {
    clearTimeout(held.timer)
    held.timer = null
  }

  const release = () => {
    held.users--

    if (held.users > 0) return

    // Replaced while in use: nothing else will close it.
    if (kept !== held) {
      closeHeld(held)

      return
    }

    held.timer = setTimeout(() => {
      if (kept !== held || held.users > 0) return

      kept = null
      closeHeld(held)
    }, KEEP_BITMAP)
  }

  try {
    return { bitmap: await held.bitmap, release }
  } catch (error) {
    release()
    throw error
  }
}
