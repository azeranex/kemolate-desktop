/**
 * Finding the lettering on a page, entirely in the browser.
 *
 * This is the half of reading that manga-ocr does not do. That model reads a
 * crop and only a crop — see `manga.ts` — so something has to say where the
 * crops are, and general-purpose OCR turns out to be bad at saying it. The
 * document engines tried here merged balloons, missed vertical runs and cut
 * sound effects in half — and every reading downstream of a bad box is a bad
 * reading no matter how good the reader.
 *
 * So: a detector that only detects, trained on comics — ogkalu's RT-DETRv2
 * (`comic-text-and-bubble-detector`), the one comic-translate ships. It
 * knows three things a page can have: a balloon, the text inside a balloon,
 * and text floating free of any balloon. The int8 build is eleven megabytes,
 * runs in under a second on WebAssembly, and comes back with boxes already
 * in page pixels — which is exactly the shape `readWithMangaOcr` wants its
 * regions in.
 *
 * The export is the deployment-style graph: it takes the image and the
 * page's true size, and hands back labels, boxes and scores with the
 * post-processing already inside. That is why the session is run by hand
 * rather than through the library's object-detection pipeline — the pipeline
 * expects to do the post-processing itself, on a graph that exposes raw
 * logits, and this graph does not. transformers.js still does what it is
 * good at here: fetching, caching, and standing the session up on the right
 * backend.
 *
 * One of two families that can find lettering — `paddle.ts` is the other, and
 * `detectors.ts` is the list a caller actually chooses from. Nothing outside
 * those three should be naming this file's builds.
 */

import { transformersOnce } from './onnx'

import type { PreTrainedModel, Processor, Tensor } from '@huggingface/transformers'
import type { Backend } from '~/utils/resources'

import { jobKey, scanJob } from '~/utils/raster/decoder'
import { webGpuHalf, webGpuOffered } from '~/utils/resources'

export const DETECTOR_MODEL = 'ogkalu/comic-text-and-bubble-detector'

/**
 * The three builds in the repo, smallest first.
 *
 * `fast` answers in under a second and is right about ordinary balloons. It is
 * also the one that under-covers: on a colophon page it returned the bottom
 * three lines of a five-line paragraph and the first two were never read at
 * all, which reads as a recognition failure and is a detection one.
 *
 * `accurate` is the same architecture with four times the weights, and found
 * that paragraph whole. Both of those are int8.
 *
 * `full` is the unquantised export — fifteen times the download of `fast` — and
 * is what the training bench runs, so it is the one to reach for when the app
 * and the bench disagree about a page and the question is which of them is
 * wrong. It is also the default (`DEFAULT_BUILD`): it was thought no sensible
 * one at that size, until WebGPU made it the quickest — see `detectorBackend`.
 */
export type ComicBuild = 'fast' | 'accurate' | 'full'

const DETECTOR_FILES: Record<ComicBuild, string> = {
  fast: 'detector-v4-s_int8',
  accurate: 'detector_int8',
  full: 'detector',
}

/**
 * The `full` build at half precision, made for this app from `detector.onnx`.
 *
 * Not on the Hub, so not under ogkalu's name: it lives in this install's model
 * cache under `kemolate/`, which `/api/models` serves from and never passes
 * upstream — a copy missing here is a 404, never whatever might one day be
 * published beside the original under the same file name. Its inputs and
 * outputs are kept fp32, so it is fed and read exactly as `full` is, and so is
 * the whole post-processor behind TopK, the box scaling by the page's size
 * included — a 5197-pixel page is well inside fp16's range and well outside
 * its eleven bits of mantissa. GridSample, the layer norms and the heads are
 * fp16. Converted and checked against `full` on 46 real pages (six chapters,
 * three scripts) on CUDA: every box matched at IoU ≥ 0.9, corners within
 * 4.5 px on a 3732 × 5197 page, scores within 0.008. WebGPU drifts a little
 * further — see `fullPrecision`.
 */
export const DETECTOR_HALF_MODEL = 'kemolate/comic-text-and-bubble-detector-fp16'

/** How the `full` build's weights are held — see `DETECTOR_HALF_MODEL`. */
export type FullPrecision = 'fp32' | 'fp16'

/**
 * The precision `full` runs at on this machine, left to itself: fp16 on a GPU
 * with `shader-f16` (`half`), fp32 everywhere else — WebAssembly included,
 * which has no fp16 arithmetic to be quicker at.
 *
 * Measured on WebGPU before it was the default, on the eight pages of the
 * large-page test chapter: the same sixty boxes, each overlapping its fp32 twin
 * by at least 0.94, corners within 12 px of 5197, scores within 0.014 — and a
 * little quicker, 2.86 s for the eight pages against 2.97 and 3.03. For half the
 * download, 85 MB where fp32 is 168.
 */
export function fullPrecision (gpu: boolean, half: boolean): FullPrecision {
  return gpu && half ? 'fp16' : 'fp32'
}

/**
 * The builds whose weights are int8: dynamically quantised, so their
 * convolutions and matrix products are `ConvInteger` and `MatMulInteger`, each
 * behind a `DynamicQuantizeLinear`. `full` has none of the three.
 */
const QUANTISED: ReadonlySet<ComicBuild> = new Set(['fast', 'accurate'])

/**
 * Where a build runs — which is not simply "on the GPU where there is one".
 *
 * It used to be: every build went to WebGPU wherever the browser had it. The
 * int8 builds' integer operators are nothing WebGPU can run, so ORT split the
 * graph and ran those nodes on its CPU provider, copying to and from the GPU
 * around each. `fast` took a second a page that way, against 0.75 s on
 * WebAssembly alone, and `accurate` 3.9 s against 3.8. `full` is fp32 end to
 * end and runs whole on the GPU, in 162 ms — against 3.6 s on WebAssembly.
 * Measured in Chrome on an M-series Mac: a warm run on one 640 × 640 page.
 *
 * So the precision decides where a build runs, and the build is the reader's
 * to choose. That `full` is both the most thorough build and, on a GPU, the
 * quickest made it the default on 2026-09-30, in place of `fast`. Without
 * WebGPU it reads on WebAssembly at `accurate`'s pace, a little under four
 * seconds a page, which is the price of the default on such a machine.
 */
export function detectorBackend (build: ComicBuild, gpu: boolean): Backend {
  return gpu && !QUANTISED.has(build) ? 'webgpu' : 'wasm'
}

/**
 * What this detector was taught a page is made of, in its own label order.
 *
 * The order is the graph's, not a preference — the index a slot comes back
 * with is read straight into this array, so nothing may be inserted among
 * them. The wider vocabulary a caller sees is `DetectedLabel` in
 * `detectors.ts`, which has a word for what PP-OCRv6 finds too.
 */
const LABELS = ['bubble', 'text_bubble', 'text_free'] as const

/**
 * Below this the detector is guessing. 0.5 keeps everything it is actually
 * sure of and drops the duplicate half-hearted boxes RT-DETR pads its three
 * hundred query slots with.
 */
const MIN_SCORE = 0.5

interface OnnxSession {
  run (feeds: Record<string, unknown>): Promise<Record<string, Tensor>>
}

/** What of an image processor's config decides whether the page can arrive already its size. */
interface SquareConfig {
  do_resize?: boolean
  do_convert_rgb?: boolean
  do_crop_margin?: boolean
  do_thumbnail?: boolean
  do_center_crop?: boolean
  size?: { width?: number, height?: number }
}

interface Loaded {
  processor: Processor
  session: OnnxSession
  makeSizes: (width: number, height: number) => Tensor
}

/** See `manga.ts` — same guard, same reason: a hung download should say so. */
const STALL_MS = 90_000

/**
 * Each build, made once and shared. Keyed by precision too where one was asked
 * for, so a bench can hold `full` at both and run the same page through each.
 */
const loading = new Map<string, Promise<Loaded>>()

function loadOnce (variant: ComicBuild, onProgress?: MangaProgress, asked?: FullPrecision): Promise<Loaded> {
  const key = asked ? `${variant}:${asked}` : variant
  const held = loading.get(key)

  if (held) return held

  const made = (async () => {
    await opfsModelCache()

    const { AutoProcessor, AutoModelForObjectDetection, Tensor } = await transformersOnce()

    const backend = detectorBackend(variant, webGpuOffered())

    // Only `full` has a second precision, and only on the GPU: fp16 is read
    // where WebGPU has `shader-f16`, and never on WebAssembly, which has no
    // fp16 arithmetic to be quicker at.
    const half = variant === 'full'
      && (asked ?? fullPrecision(backend === 'webgpu', await webGpuHalf())) === 'fp16'

    let beat = Date.now()

    const track = (p: { status: string, file?: string, progress?: number }) => {
      beat = Date.now()

      if (onProgress && p.file && p.status === 'progress') {
        onProgress(`Fetching ${p.file} — ${Math.round(p.progress ?? 0)}%`, { done: p.progress ?? 0, total: 100 })
      }
    }

    const work = (async () => {
      const processor = await AutoProcessor.from_pretrained(DETECTOR_MODEL, { progress_callback: track })

      // The repo keeps its graphs in the root under their own names rather
      // than the `onnx/model.onnx` convention, hence the explicit file — and
      // `fp32` because that is the dtype whose file suffix is none, so the
      // build's own name is the file whatever its weights are.
      const open = (device: Backend, fp16 = half) => AutoModelForObjectDetection.from_pretrained(fp16 ? DETECTOR_HALF_MODEL : DETECTOR_MODEL, {
        subfolder: '',
        model_file_name: fp16 ? 'detector_fp16' : DETECTOR_FILES[variant],
        dtype: 'fp32',
        device,
        progress_callback: track,
      })

      // A GPU on offer can still refuse the session, and a half-precision one
      // may not be here at all. The build then runs at full precision, on
      // WebAssembly if it has to — as `sessionFor` does for the raw sessions.
      // A precision asked for is not fallen back from: that is the bench, and
      // a quiet fallback would compare a build with itself.
      const model = backend === 'webgpu'
        ? await open('webgpu').catch((error: unknown) => {
            if (asked) throw error

            console.info('[kemolate] WebGPU would not open the text detector — running it at full precision instead.', error)

            return half ? open('webgpu', false).catch(() => open('wasm', false)) : open('wasm')
          })
        : await open('wasm')

      const sessions = (model as PreTrainedModel & { sessions: Record<string, OnnxSession> }).sessions

      return {
        processor,
        session: sessions.model!,
        makeSizes: (width, height) =>
          new Tensor('int64', BigInt64Array.from([BigInt(width), BigInt(height)]), [1, 2]),
      } satisfies Loaded
    })()

    const stalled = new Promise<never>((_resolve, reject) => {
      const watch = setInterval(() => {
        if (Date.now() - beat < STALL_MS) return

        clearInterval(watch)
        reject(new Error(`The text detector stopped loading — nothing heard for ${STALL_MS / 1000}s.`))
      }, 5_000)

      work.then(() => clearInterval(watch), () => clearInterval(watch))
    })

    return Promise.race([work, stalled])
  })().catch((error) => {
    loading.delete(key)
    throw error
  })

  loading.set(key, made)

  return made
}

/**
 * How much of each edge to shave off a box, as a share of its smaller side.
 *
 * The detector draws with a little balloon air around the lettering, and the
 * air is padding everywhere the box goes next — the overlay, the block a
 * workspace would keep, the crop. Trimming it here is free: the reader adds
 * its own margin back when it crops (see `manga.ts`), so a tighter box costs
 * the reading nothing and everything drawn from it hugs the words.
 */
const TRIM = 0.06

/** How much of the smaller box the overlap covers — the duplicate test. */
function overlap (a: Region, b: Region): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)

  if (w <= 0 || h <= 0) return 0

  return (w * h) / Math.min(a.w * a.h, b.w * b.h)
}

/**
 * The lettering on a page, in reading-relevant boxes.
 *
 * Only the text labels come back — the balloon outlines the detector also
 * draws are the same speech twice, and the reader wants the words, not the
 * shape around them. Near-duplicate boxes are folded to the surest one, in
 * score order, so a slot RT-DETR spent twice on one balloon costs one crop
 * rather than two readings of the same thing.
 */
export async function detectWithComic (
  page: Readable,
  onProgress?: MangaProgress,
  variant: ComicBuild = 'full',
  /** A precision for `full` to run at instead of this machine's own choice — for the bench. */
  precision?: FullPrecision,
): Promise<DetectedText[]> {
  const loaded = await loadOnce(variant, onProgress, precision)

  onProgress?.('Finding the lettering…')

  const { RawImage } = await transformersOnce()

  // One decode, and its sides are the page's — what a separate decode for the
  // size used to read, at 70 ms a full-size page, spent on two numbers.
  //
  // Read and brought down to the processor's square on the background thread,
  // by the same steps the processor takes — `RawImage.fromBlob`, `rgb()`, and
  // the canvas resize — so it is handed a picture already the size it wants
  // and its own resize is a copy. Done here, those steps went over every pixel
  // of the page in script: frames of 240–370 ms on a 3732 × 5197 page. A
  // processor asking for anything but a fixed square is handed the whole page,
  // as before.
  const images = (loaded.processor as unknown as { image_processor?: SquareConfig }).image_processor
  const square = images?.do_resize && images.do_convert_rgb && !images.do_crop_margin && !images.do_thumbnail
    && !images.do_center_crop && Number.isInteger(images.size?.width) && Number.isInteger(images.size?.height)
    ? { width: images.size!.width!, height: images.size!.height! }
    : null

  const drawn = await scanJob(jobKey('detect'), page.file, square
    ? { what: 'pixels', canvas: square, via: 'rgb', readable: false }
    : { what: 'pixels', canvas: 'page', readable: false })

  if (!drawn?.pixels) throw new Error('The page could not be drawn — no 2d context.')

  const width = drawn.width
  const height = drawn.height
  const image = new RawImage(drawn.pixels, square?.width ?? width, square?.height ?? height, 4)
  const inputs = await loaded.processor(image)

  const pixels = (inputs as { pixel_values: Tensor }).pixel_values
  const raw = (t: Tensor) => (t as Tensor & { ort_tensor?: unknown }).ort_tensor ?? t

  const out = await loaded.session.run({
    images: raw(pixels),
    orig_target_sizes: raw(loaded.makeSizes(width, height)),
  })

  const labels = out.labels!.data as BigInt64Array
  const boxes = out.boxes!.data as Float32Array
  const scores = out.scores!.data as Float32Array

  const found: DetectedText[] = []

  // The balloon shapes, kept rather than dropped. They are not text and never
  // go back as text — they are collected here so each text region can be
  // paired with the one it sits in. See `DetectedText.bubble`.
  const shapes: Region[] = []

  for (let i = 0; i < scores.length; i++) {
    const score = scores[i]!

    // The slots arrive sorted by score, so the first miss ends the walk.
    if (score < MIN_SCORE) break

    const label = LABELS[Number(labels[i]!)]

    if (label === undefined) continue

    const wide = boxes[i * 4 + 2]! - boxes[i * 4]!
    const tall = boxes[i * 4 + 3]! - boxes[i * 4 + 1]!

    // A balloon is taken whole; only a text box is trimmed. See `TRIM`, and
    // the note on `DetectedText.bubble` for why the difference matters.
    const inset = label === 'bubble' ? 0 : Math.min(wide, tall) * TRIM

    const box: Region = {
      x: boxes[i * 4]! + inset,
      y: boxes[i * 4 + 1]! + inset,
      w: wide - inset * 2,
      h: tall - inset * 2,
    }

    if (box.w < 2 || box.h < 2) continue

    if (label === 'bubble') {
      // Deduped against other balloons only. A balloon overlaps the lettering
      // inside it almost entirely, so testing it against `found` would drop
      // every one of them as a duplicate of its own text.
      if (shapes.some((kept) => overlap(kept, box) > 0.7)) continue

      shapes.push(box)
      continue
    }

    if (found.some((kept) => overlap(kept, box) > 0.7)) continue

    found.push({ ...box, label, score })
  }

  for (const region of found) {
    const host = hostBubble(region, shapes)

    if (host) region.bubble = host
  }

  return found
}

/**
 * The balloon a run of lettering belongs to, or nothing where it is loose on
 * the page.
 *
 * Containment first, and by area second rather than by overlap: a text box that
 * sits inside two nested balloons belongs to the tighter one, and the tighter
 * one is the useful bound. A box the detector drew a little proud of its
 * balloon still needs an answer, so anything covering most of the lettering
 * counts — but a balloon that holds only a corner of it is somebody else's and
 * is worse than no bound at all, which is what `ENOUGH` is for.
 */
const ENOUGH = 0.8

function hostBubble (text: Region, shapes: Region[]): Region | null {
  let best: Region | null = null

  for (const shape of shapes) {
    const w = Math.min(text.x + text.w, shape.x + shape.w) - Math.max(text.x, shape.x)
    const h = Math.min(text.y + text.h, shape.y + shape.h) - Math.max(text.y, shape.y)

    if (w <= 0 || h <= 0) continue
    if ((w * h) / (text.w * text.h) < ENOUGH) continue

    if (!best || shape.w * shape.h < best.w * best.h) best = shape
  }

  return best
}
