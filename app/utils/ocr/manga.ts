/**
 * Reading lettering with manga-ocr, entirely in the browser.
 *
 * The model is kha-white's manga-ocr — a vision encoder-decoder trained on
 * Manga109, at home with vertical text, furigana and dialogue set over
 * artwork — in the ONNX conversion at `DigitalLarynx/manga-ocr-onnx`. It
 * runs on WebGPU where the browser has it and WebAssembly where it does
 * not, and the page never leaves the machine either way. The weights arrive
 * from the Hugging Face Hub on first use — a one-off download around two
 * hundred megabytes, kept on this machine afterwards — so what travels is
 * the engine and never the page.
 *
 * ## Why this file does not just call `pipeline()`
 *
 * It tried. Two separate things are wrong with the obvious route, and both
 * were found the hard way, so they are written down:
 *
 * 1. **The stock image processor mangles the input.** The conversions carry
 *    manga-ocr's original `"size": 224` — an integer, the old config style —
 *    which Python's ViTFeatureExtractor read as "stretch to 224×224" and
 *    transformers.js reads as "fit the aspect ratio". The encoder then sees
 *    the wrong number of patches, and either dies in its first Add node or
 *    limps on to garbage. The model also expects the grayscale conversion
 *    the reference implementation applies and the processor does not.
 *
 * 2. **`generate()` cannot drive these decoders.** Every available
 *    conversion ships a `decoder_model_merged` with no cache inputs — just
 *    `input_ids` and `encoder_hidden_states`. transformers.js assumes a
 *    merged decoder carries its KV cache, feeds it one new token at a time,
 *    and the decoder — re-reading only that token — loses the sentence it
 *    was writing. The output is a deterministic spray of `[CLS]` that looks
 *    like a broken model and is actually a broken conversation with it.
 *
 * So the library is used for what it is good at — resolving, downloading
 * and caching the weights, standing up ONNX sessions on the right backend,
 * and decoding token ids — while the two failing parts are done by hand:
 * the preprocessing reproduces the reference implementation exactly
 * (stretch to 224×224, PIL-style grayscale, normalise to ±1), and the
 * decoding is a plain greedy loop that re-feeds the whole sequence each
 * step, which is what a cacheless decoder needs. Greedy is also what the
 * production ONNX ports (comic-translate, koharu) use. Verified against the
 * upstream example crops: byte-identical readings.
 *
 * ## The shape of the engine
 *
 * manga-ocr *recognises* and does not *detect*. Hand it a crop with one
 * piece of lettering in it and it reads it beautifully; hand it a whole
 * page and it reads it as if it were one piece of lettering, which is only
 * useful for a page that really is one. So the unit here is the region — a
 * box somebody else found, whether a detector or a reader dragging the
 * region tool — and a whole-page reading is just the degenerate single
 * region. Output goes through the neutral `Detection` shape and
 * `shared/utils/ocr.ts` like every other engine's.
 *
 * ## Why a page is read in batches
 *
 * A page's balloons are encoded together and decoded together, a batch at a
 * time (`readBatch`), rather than one balloon after another. Each run has a
 * fixed cost before any arithmetic — a trip to the runtime's worker and back,
 * and on a GPU a round of dispatches and a read-back — and a balloon read on
 * its own paid it once for the encoder and again for every token. On WebGPU a
 * twenty-token balloon's decode was 236 ms alone and 64 ms as one of eight;
 * how many go together is `batchSize`'s to say, by backend.
 */

import { quadWorthy, tiltedQuad, uprightRegion, worthStraightening } from './deskew'
import { isOnGpu, transformersOnce } from './onnx'
import { detBoxFor, detLeanFor, detLines, segFor, segmentedAlready } from './segment'

import type { PreTrainedModel, PreTrainedTokenizer } from '@huggingface/transformers'
import type { Backend } from '~/utils/resources'

import { batchSize, webGpuHalf, webGpuOffered } from '~/utils/resources'

export const MANGA_OCR_MODEL = 'DigitalLarynx/manga-ocr-onnx'

/**
 * The 2026 retrain of the same architecture, in jzhang533's lineage — a far
 * smaller vision encoder, the same tokenizer contract, and a repo layout
 * (graphs in the root) transformers.js cannot load, so its sessions come
 * through `onnx.ts` instead. Reads the upstream examples identically to the
 * original and roughly three times as fast.
 */
export const MANGA_OCR_2025_MODEL = 'l0wgear/manga-ocr-2025-onnx'

/**
 * Kemolate OCR — the multilingual (ja/ko/zh) retrain from this project's own
 * training runs, sixth beta: checkpoint out26, which replaced out25 on
 * 2026-10-02 (out17 → out19 → out21 the day before; out22, then out25, that
 * day).
 *
 * out21 was the first that could write 읏. The vocabulary was cut at 99.99% of
 * a prose corpus, and comic moans are not prose: 읏, 흣 and 큿 had no token, so
 * every earlier beta read the commonest moan in Korean lettering as 웃. From
 * out21 on the base has 152 such syllables appended (every existing id kept)
 * and trains on sound-effect lines built around them.
 *
 * out22 is out21's recipe with about 2,500 more real Korean labels from four
 * letterers, and it is the first change that made Korean read better overall
 * rather than only spell more. On a held-out benchmark of six Korean books no
 * run trained on (975 crops), CER 0.079 → 0.073 and exact matches 67% → 72%
 * against out21, better on every book; crop by crop it wins 74 to 27. Real
 * Chinese chapters, the ECLIPSE holdout and ja-REAL are within run-to-run
 * noise — two runs of one recipe differ by 0.5–1.5 points of exact matches,
 * so a smaller gap is a tie.
 *
 * out25 is out22 plus about 3,100 more real Chinese labels and 300 Korean,
 * trained on a larger draw from the synthetic corpus (Korean 30k → 45k crops,
 * each Chinese script 40k → 60k). Two lessons came out of the runs between.
 * The Chinese labels lifted real Chinese only for the letterer they came
 * from — two raymond158 books fell from 0.107 and 0.078 CER to 0.063 and
 * 0.061 while every other chapter stayed flat — so new letterers, not more
 * pages of known ones, are what move it. And the larger synthetic draw,
 * tried on its own against identical labels, helped Korean and nothing else:
 * on the held-out Korean benchmark 0.071 → 0.065 CER and 72% → 74% exact,
 * winning 113 crops to 59 and better on five of six books, while real
 * Chinese, ECLIPSE and ja-REAL stayed within noise. Against out22 the
 * benchmark reads 0.073 → 0.065.
 *
 * out26 is out25's recipe with about 3,800 more real Chinese labels drawn
 * from some twenty letterers no earlier run had seen, which is what the
 * lesson above asked for — and it worked the way that lesson predicts. On
 * real Chinese chapters neither run trained on (2,025 crops), CER 0.054 →
 * 0.049, winning 123 crops to 88, and the gain is spread rather than pooled:
 * nine of eleven books read better, the largest on letterers absent from the
 * new labels (球社更衣室 0.077 → 0.062, The Anecdate of Gifted 0.091 →
 * 0.076). Korean, ECLIPSE and ja-REAL are ties.
 *
 * Paragraph-shaped crops (23+ characters in a box no taller than wide) have
 * been left out of training since out19, so a long disclaimer block reads
 * worse than it did from out18.
 *
 * The same architecture again — a vision encoder-decoder on manga-ocr's
 * tokenizer, extended from 6,144 tokens to 11,179 for hangul and simplified
 * and traditional Chinese, then to 11,331 for the comic syllables above, with
 * every earlier id kept each time — exported the way the
 * 2025 retrain is laid out (`export_onnx.py` in the training pipeline: a
 * cacheless decoder, `enc_to_dec_proj` pulled in from the parent model), so
 * it loads as raw sessions like that one and reads through the same batched
 * greedy decode.
 *
 * Not on the Hub. The name is a path in this server's model cache
 * (`.data/models/kemolate/kemolate-ocr-<run>/resolve/main/`), which
 * `/api/models` answers from and never looks past — so the beta runs wherever
 * the files have been put, and a server without them says so with a 404 on
 * the first file rather than reading with something else.
 *
 * The training run is in the name. Every cache between here and the file —
 * the route's `immutable`, the OPFS store, the library's own — is keyed by the
 * path and trusts it never to change, so the next beta put down under this
 * one's path would be read by nobody who had opened this one. A revision would
 * be the natural place for the run, and transformers.js 4.2 cannot load a
 * tokenizer from one: before fetching anything it checks that
 * `tokenizer_config.json` exists at `main`, whatever revision it was asked
 * for, and a repo with nothing at `main` has no tokenizer.
 *
 * Precision by backend, for the reason `mangaPrecision` gives: fp32 whole on
 * the GPU, q8 on WebAssembly, where integer arithmetic is the cheap kind. q8
 * costs nothing measurable here — out26 scored with the browser's own greedy,
 * cacheless decode, 100 crops a language, CER and exact matches, q8 then fp32:
 *
 * | ja-REAL       | ja            | ko            | zh-Hans       | zh-Hant       |
 * | ------------- | ------------- | ------------- | ------------- | ------------- |
 * | 0.015 / 95%   | 0.058 / 77%   | 0.079 / 78%   | 0.098 / 82%   | 0.089 / 84%   |
 * | 0.020 / 95%   | 0.057 / 77%   | 0.074 / 79%   | 0.098 / 82%   | 0.097 / 83%   |
 *
 * Every column but ja-REAL is the run's own synthetic eval slice, drawn afresh
 * for each run and landing in the other runs' training data — out21's same
 * table read 0.100 on ko — so the rows compare builds of one checkpoint, never
 * one checkpoint with another; the real-page figures above do that. The fp16
 * pair read 499 of those 500 crops exactly as fp32 did, on CUDA.
 *
 * The lab service reads the same checkpoint with a four-beam search, so the
 * two can differ on a hard balloon; greedy is what every reader here does.
 *
 * The checkpoint keeps a BertJapaneseTokenizer (`vocab.txt` and
 * `added_tokens.json`), which transformers.js cannot read, so the install
 * carries a `tokenizer.json` made from them — every one of the 11,331 ids
 * checked to decode as the original does. No token is a space: Korean comes
 * back without its word spacing, as it does from the lab, because the
 * tokenizer never had a way to say one. Its ellipsis is three periods — the
 * training labels write a Korean dot run as `...` and Japanese and Chinese as
 * `…`, as their pages do.
 */
export const KEMOLATE_OCR_BETA_MODEL = 'kemolate/kemolate-ocr-out26'

/**
 * How a reading's graphs are held. `fp32` and `fp16` run whole on the GPU; `q8`
 * is WebAssembly's, for the reason `mangaPrecision` gives.
 */
export type Precision = 'fp32' | 'fp16' | 'q8'

/**
 * The graphs a beta install holds, by precision — see `KEMOLATE_OCR_BETA_MODEL`.
 *
 * The fp16 pair was converted from the fp32 one with its inputs and outputs
 * kept fp32, so it is fed and read exactly as the others are; each layer
 * norm's squaring and variance mean stay fp32 too, because the encoder's
 * squared activations reach a fifth of fp16's range and a backend that sums a
 * 768-wide mean in fp16 would overflow.
 */
export const KEMOLATE_OCR_BETA_FILES: Readonly<Record<Precision, { encoder: string, decoder: string }>> = {
  fp32: { encoder: 'encoder_model.onnx', decoder: 'decoder_model.onnx' },
  fp16: { encoder: 'encoder_model_fp16.onnx', decoder: 'decoder_model_fp16.onnx' },
  q8: { encoder: 'encoder_model_quantized.onnx', decoder: 'decoder_model_quantized.onnx' },
}

/** Which of the beta's graphs to read with, by precision. */
export function betaFiles (precision: Precision) {
  return KEMOLATE_OCR_BETA_FILES[precision]
}

/**
 * The precision the beta reads at on this machine, left to itself: fp16 on a
 * GPU with `shader-f16` (`half`), fp32 on any other GPU, q8 on WebAssembly.
 *
 * fp16 was measured before it was the default, on WebGPU, against fp32 on the
 * same sixty balloons of the large-page test chapter: every line either build
 * reads came out the same, and it was no slower — 26.2 and 24.7 s against 27.7
 * and 27.0. The seven that differed are seven neither reads: screentone and
 * artwork the detector boxed, and a hand-drawn sound effect, which both builds
 * answer with invented text or runs of marks, different ones. For half the
 * download — 246 MB where fp32 is 492.
 */
export function betaPrecision (gpu: boolean, half: boolean): Precision {
  if (!gpu) return 'q8'

  return half ? 'fp16' : 'fp32'
}

/** The retrains the reader can be, where 'base' is kha-white's original. */
export type MangaModel = 'base' | '2025' | 'beta'

/** The square the model eats, and the token ids its sentences are built from. */
const MODEL_EDGE = 224
const START_TOKEN = 2
const END_TOKEN = 3
const MAX_TOKENS = 300

/** One crop as the encoder takes it: three planes of the square. */
const CROP = 3 * MODEL_EDGE * MODEL_EDGE

/** An upright region of the page, in image pixels from the top left. */
export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What an engine says while it works, for whoever is watching.
 *
 * The sentence is for reading; `step` is the same thing as a fraction, for
 * drawing. It is optional because not every wait can be measured — a session
 * being built says nothing until it is done — and a bar that invents a
 * number for those is a bar that lies. Given both, a caller can move a bar
 * *within* one page, which is what makes a hundred-megabyte download and a
 * twelve-balloon page feel like progress rather than a hang.
 */
export type MangaProgress = (message: string, step?: { done: number, total: number }) => void

/**
 * The little a session and a tensor need to be here, whichever runtime made
 * them — transformers.js's wrapped sessions and onnxruntime's raw ones both
 * fit, which is what lets the two loaders below share one reading loop.
 */
interface TensorLike {
  data: unknown
  dims: readonly number[]
}

interface OnnxLikeSession {
  run (feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>
}

/** The two sessions a reading runs, and how their inputs are made — what `readBatch` needs. */
export interface ReadingSessions {
  encoder: OnnxLikeSession
  decoder: OnnxLikeSession
  makeTensor: (kind: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: number[]) => TensorLike
}

interface Loaded extends ReadingSessions {
  tokenizer: PreTrainedTokenizer
  /** Where both sessions run, which decides how many crops go together. */
  backend: Backend
}

/**
 * How long the load may go silent before it is declared stuck.
 *
 * Generous on purpose: a download reports progress constantly, but building
 * the session afterwards says nothing and can take half a minute compiling
 * shaders on first use. What this catches is a repo missing a file the
 * library waits forever on, and it turns an endless spinner into an error
 * somebody can read.
 */
const STALL_MS = 90_000

/**
 * Each model, made once and shared — as promises, so two callers arriving
 * together wait on one load instead of starting two. Keyed by precision too
 * where one was asked for, so a bench can hold two builds of one model side by
 * side and read the same crops with each.
 */
const loading = new Map<string, Promise<Loaded>>()

/**
 * What the original's two graphs are loaded as, on each backend.
 *
 * The decoder is fp32 everywhere — the only merged decoder in the repo is full
 * precision, and at 117 MB it is the bulk of the first wait. The encoder is
 * where the choice is. Its q8 build is dynamically quantised: its matrix
 * products are `MatMulInteger`, which WebGPU cannot run, so on a GPU ORT sent
 * those nodes to its CPU provider and copied every activation there and back —
 * 0.96 s a crop, no better than WebAssembly's 0.92 s, and on the page's thread
 * besides. The fp32 build runs whole on the GPU at 28 ms a crop, 20 in a
 * batch. It costs a larger first download — 343 MB against 87 — and it is the
 * model itself rather than an approximation of it; q8 was chosen because it
 * read the upstream examples exactly as fp32 did. Given the same boxes on four
 * pages of the large-page test chapter, the two read 20 of 22 balloons alike;
 * the other two were hand-lettered — an aside the box cut through, and a
 * brushed sound effect — and both builds misread both.
 *
 * And where the GPU has `shader-f16` (`half`), the encoder is the repo's fp16
 * build: 172 MB where fp32 is 343, which takes the first download from 461 MB
 * to 289, and no slower — sixty balloons of the large-page test chapter in
 * 20.4 and 20.1 s against 20.9 and 20.7 on WebGPU. It read them the same, bar
 * four that neither build reads: a balloon the box cut through and a
 * hand-lettered cry, where the two invent different tails, and two runs of
 * dots of different lengths.
 *
 * WebAssembly keeps q8, where integer arithmetic is the cheap kind.
 */
export function mangaPrecision (backend: Backend, half = false): { encoder_model: Precision, decoder_model_merged: 'fp32' } {
  return mangaDtypes(backend === 'webgpu' ? (half ? 'fp16' : 'fp32') : 'q8')
}

/**
 * The original's graphs at one precision of its encoder. The decoder is fp32 at
 * every one: the repo's fp16 decoder does not load — a cast in its attention
 * yields fp16 where the graph declares fp32, and onnxruntime refuses the whole
 * session — and its merged decoder has no other build.
 */
function mangaDtypes (encoder: Precision): { encoder_model: Precision, decoder_model_merged: 'fp32' } {
  return { encoder_model: encoder, decoder_model_merged: 'fp32' }
}

/** The original, through transformers.js — see the header for the caveats. */
async function loadBase (onProgress?: MangaProgress, asked?: Precision): Promise<Loaded> {
  await opfsModelCache()

  const { AutoTokenizer, AutoModelForVision2Seq, Tensor } = await transformersOnce()

  let beat = Date.now()

  const track = (p: { status: string, file?: string, progress?: number }) => {
    beat = Date.now()

    if (onProgress && p.file && p.status === 'progress') {
      onProgress(`Fetching ${p.file} — ${Math.round(p.progress ?? 0)}%`, { done: p.progress ?? 0, total: 100 })
    }
  }

  const work = (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(MANGA_OCR_MODEL, { progress_callback: track })

    const open = async (backend: Backend, dtype = mangaPrecision(backend)) => ({
      backend,
      model: await AutoModelForVision2Seq.from_pretrained(MANGA_OCR_MODEL, {
        device: backend,
        dtype,
        progress_callback: track,
      }),
    })

    const half = await webGpuHalf()

    // A precision asked for is read at on its own backend, and nothing is
    // fallen back to: that is the bench comparing two, and a quiet fallback
    // would compare a build with itself. Otherwise a GPU on offer can still
    // refuse the session — the half-precision one first, the full one after
    // it — and the reading then happens on WebAssembly, as `sessionFor` does
    // for the raw sessions.
    const { backend, model } = asked
      ? await open(asked === 'q8' ? 'wasm' : 'webgpu', mangaDtypes(asked))
      : webGpuOffered()
        ? await open('webgpu', mangaPrecision('webgpu', half)).catch((error: unknown) => {
            console.info('[kemolate] WebGPU would not open manga-ocr — reading at full precision, or on WebAssembly.', error)

            return half ? open('webgpu').catch(() => open('wasm')) : open('wasm')
          })
        : await open('wasm')

    const sessions = (model as PreTrainedModel & { sessions: Record<string, OnnxLikeSession> }).sessions

    return {
      tokenizer,
      encoder: sessions.model!,
      decoder: sessions.decoder_model_merged!,
      makeTensor: (kind, data, dims) => new Tensor(kind as 'float32', data as Float32Array, dims),
      backend,
    } satisfies Loaded
  })()

  // The guard polls the heartbeat rather than racing one long timer, so a
  // slow download that is still moving is never mistaken for a hang.
  const stalled = new Promise<never>((_resolve, reject) => {
    const watch = setInterval(() => {
      if (Date.now() - beat < STALL_MS) return

      clearInterval(watch)
      reject(new Error(`The manga-ocr model stopped loading — nothing heard for ${STALL_MS / 1000}s.`))
    }, 5_000)

    work.then(() => clearInterval(watch), () => clearInterval(watch))
  })

  return Promise.race([work, stalled])
}

/**
 * The 2025 retrain, through raw sessions — its repo layout leaves no other
 * door, and `onnx.ts` narrates its own downloads, so no separate stall
 * guard stands over it. The tokenizer still comes through transformers.js:
 * a tokenizer is just files, and the layout problem is the graphs'.
 */
async function load2025 (onProgress?: MangaProgress): Promise<Loaded> {
  await opfsModelCache()

  const { AutoTokenizer } = await transformersOnce()
  const ort = await ortOnce()

  const base = `https://huggingface.co/${MANGA_OCR_2025_MODEL}/resolve/main`

  const tokenizer = await AutoTokenizer.from_pretrained(MANGA_OCR_2025_MODEL)
  const encoder = await sessionFor(`${base}/encoder_model.onnx`, onProgress)
  const decoder = await sessionFor(`${base}/decoder_model.onnx`, onProgress)

  return {
    tokenizer,
    encoder,
    decoder,
    makeTensor: (kind, data, dims) => new ort.Tensor(kind, data as Float32Array, dims),
    // WebAssembly today — `sessionFor` is not asked for the GPU here — but read
    // off the session, so the batch follows if that changes.
    backend: isOnGpu(encoder) && isOnGpu(decoder) ? 'webgpu' : 'wasm',
  }
}

/**
 * Kemolate OCR's beta — the 2025 retrain's road (raw sessions, tokenizer
 * through transformers.js) with the precision chosen by backend, since unlike
 * the 2025 build it ships both. See `KEMOLATE_OCR_BETA_MODEL`.
 */
async function loadBeta (onProgress?: MangaProgress, asked?: Precision): Promise<Loaded> {
  await opfsModelCache()

  const { AutoTokenizer } = await transformersOnce()
  const ort = await ortOnce()

  const base = `https://huggingface.co/${KEMOLATE_OCR_BETA_MODEL}/resolve/main`
  const chosen = asked ?? betaPrecision(webGpuOffered(), await webGpuHalf())

  const open = async (precision: Precision) => {
    const files = betaFiles(precision)
    const gpu = precision !== 'q8'

    return {
      encoder: await sessionFor(`${base}/${files.encoder}`, onProgress, { gpu }),
      decoder: await sessionFor(`${base}/${files.decoder}`, onProgress, { gpu }),
    }
  }

  /*
   * Desktop: the first file asked for, so the one that finds out whether the
   * reader is here at all. The model route answers a missing one with a 404
   * when it has no address to download it from (`server/models.ts`), which
   * transformers.js reports as "Could not locate file" and a URL — said here
   * in words a reader can act on instead, since this is the default reader and
   * the first thing a fresh install tries.
   */
  const tokenizer = await AutoTokenizer.from_pretrained(KEMOLATE_OCR_BETA_MODEL).catch((error: unknown) => {
    if (error instanceof Error && /could not locate file/i.test(error.message)) {
      throw new Error('Kemolate OCR isn’t on this computer yet, and there’s no address set to download it from. Pick another reader in Detect for now.')
    }

    throw error
  })

  // An install that holds only the fp32 pair answers the fp16 one with a 404,
  // and a GPU may still refuse it; either way the beta reads at full precision.
  // Not for a precision asked for — that is the bench, see `loadBase`.
  const { encoder, decoder } = await open(chosen).catch((error: unknown) => {
    if (asked || chosen !== 'fp16') throw error

    console.info('[kemolate] The beta\'s fp16 graphs would not open — reading at full precision.', error)

    return open('fp32')
  })

  return {
    tokenizer,
    encoder,
    decoder,
    makeTensor: (kind, data, dims) => new ort.Tensor(kind, data as Float32Array, dims),
    // Read off the sessions, not assumed: a GPU that would not open a graph
    // hands it to WebAssembly, and the batch has to follow where it landed.
    backend: isOnGpu(encoder) && isOnGpu(decoder) ? 'webgpu' : 'wasm',
  }
}

/**
 * `precision` is honoured by the original and the beta, the two with more than
 * one build to choose between; the 2025 retrain has one, and reads with it.
 */
function loadOnce (model: MangaModel, onProgress?: MangaProgress, precision?: Precision): Promise<Loaded> {
  const key = precision ? `${model}:${precision}` : model

  if (!loading.has(key)) {
    const load = model === 'beta'
      ? loadBeta(onProgress, precision)
      : model === '2025' ? load2025(onProgress) : loadBase(onProgress, precision)

    const work = load.catch((error) => {
      // A failed load must not poison every later attempt with the same
      // rejection — clear it so the next call tries again.
      loading.delete(key)
      throw error
    })

    loading.set(key, work)
  }

  return loading.get(key)!
}

/**
 * The model reads token by token, and the tokenizer hands the tokens back
 * with spaces between them — "こ ん に ち は" for a greeting that has none.
 * The reference implementation strips every space for exactly this reason,
 * and so does this one, but only when the reading is CJK enough for spaces
 * to be artefacts: a Latin aside on the page keeps the spaces that separate
 * its words. The quarter test is `tidyText`'s own.
 */
function detokenise (raw: string): string {
  const text = raw.trim()
  const cjk = text.match(CJK)?.length ?? 0

  return cjk >= Math.max(1, Math.floor(text.length / 4)) ? text.replace(/\s+/g, '') : text
}

/**
 * One region of the page, cropped and squared onto the model's 224×224.
 *
 * Cropped with a small margin — the model was trained on balloons with their
 * surroundings, and a box shaved to the glyphs' edge reads worse than one with a
 * little air. Lettering that leans is turned upright on the way, because these
 * decoders have almost no tolerance for rotation; see `deskew.ts`. Upright text
 * takes the plain path and is not resampled twice.
 *
 * Exported because the geometry is the part every reader agrees on. The local
 * reader turns this into a tensor; the lab reader posts it to a machine with the
 * weights on it. Sharing the crop is what stops the two drifting apart and
 * quietly measuring different pipelines.
 */
/**
 * How large a native crop may get before it is worth scaling down.
 *
 * Only a bound on what travels: whoever receives it squares it to 224 anyway,
 * so beyond a few hundred pixels the extra is paid for and thrown away. Normal
 * balloons run to two or three hundred and never reach this.
 */
const NATIVE_CAP = 768

export function regionCanvas (
  bitmap: ImageBitmap,
  region: Region,
  fit: 'square' | 'native' = 'square',
  /**
   * The lean to straighten by, where a better instrument than the ink has
   * measured one — the det head's, in practice (`detBoxFor`).
   *
   * Threading it in fixes a split the det work left behind: the good angle
   * reached the *stored quad* and never the *crop the reader sees*, so every
   * balloon was still being straightened — or not — by the ink measurement,
   * whose sign is wrong on exactly the balloons that fail. On ECLIPSE page 22
   * `不是說…` reads `うおお・・・` unturned and `不是說…` exactly once turned by
   * the det lean; `要去拿…` likewise. Two measurements of one quantity, and
   * the reader was handed the worse one.
   */
  lean?: number | null,
): OffscreenCanvas {
  const margin = Math.round(Math.min(region.w, region.h) * 0.08)

  const x = Math.max(0, region.x - margin)
  const y = Math.max(0, region.y - margin)
  const w = Math.max(1, Math.min(bitmap.width - x, region.w + margin * 2))
  const h = Math.max(1, Math.min(bitmap.height - y, region.h + margin * 2))

  // Only a steep lean is worth the resample — a shallow one is real geometry
  // (the emitted quad carries it) but turning the crop for it costs stroke
  // sharpness and buys no reading. See `worthStraightening`.
  //
  // A supplied lean is trusted over the ink's own: it comes from the det head,
  // which measures from dense strokes rather than a handful of clusters, and
  // the *box* still comes from the ink because that is what frames the crop.
  const measured = uprightRegion(bitmap, region)
  const supplied = lean != null && Number.isFinite(lean)
  const turned = measured && supplied ? { ...measured, tilt: lean } : measured
  const leaning = turned && worthStraightening(turned, supplied) ? turned : null
  const air = leaning ? Math.min(leaning.w, leaning.h) * 0.08 : 0

  // What the crop measures in the page, upright: its own box where it leans,
  // the padded detection box where it does not.
  const sourceW = leaning ? leaning.w + air * 2 : w
  const sourceH = leaning ? leaning.h + air * 2 : h

  // Square is what the encoder eats, and is right when this canvas *is* the
  // input. Native keeps the page's own pixels for a reader that resizes at the
  // other end — measured, that is worth a syllable a balloon: the browser
  // squeezing 213×294 down to 224² read `x기` where sending the pixels and
  // letting the reader resize read `x끼`.
  let outW = MODEL_EDGE
  let outH = MODEL_EDGE

  if (fit === 'native') {
    const shrink = Math.min(1, NATIVE_CAP / Math.max(sourceW, sourceH))

    outW = Math.max(1, Math.round(sourceW * shrink))
    outH = Math.max(1, Math.round(sourceH * shrink))
  }

  const canvas = new OffscreenCanvas(outW, outH)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) throw new Error('The page could not be cropped — no 2d context.')

  context.imageSmoothingQuality = 'high'

  if (leaning) {
    // Read as one transform applied to the page, in the order the canvas walks
    // it — last call first. The lettering's middle goes to the origin, the lean
    // is undone, its own box is scaled onto the output, and the result is
    // centred. Scaling each axis to its own side means a square output stretches
    // and a native one does not, which is the only difference between the two.
    context.translate(outW / 2, outH / 2)
    context.scale(outW / sourceW, outH / sourceH)
    context.rotate((-leaning.tilt * Math.PI) / 180)
    context.translate(-leaning.cx, -leaning.cy)
    context.drawImage(bitmap, 0, 0)
    context.setTransform(1, 0, 0, 1, 0, 0)
  } else {
    context.drawImage(bitmap, x, y, w, h, 0, 0, outW, outH)
  }

  return canvas
}

/**
 * The same crop, as this encoder wants it: grayscale by PIL's own luminosity
 * weights and normalised to ±1, which is what the reference implementation
 * does and what the stock processor does not. Written into a batch's input at
 * crop `at`, so a batch is one array rather than one per crop copied together.
 */
function writeCrop (into: Float32Array, at: number, bitmap: ImageBitmap, region: Region,
  lean?: number | null): void {
  const canvas = regionCanvas(bitmap, region, 'square', lean)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) throw new Error('The page could not be read back — no 2d context.')

  const { data } = context.getImageData(0, 0, MODEL_EDGE, MODEL_EDGE)
  const plane = MODEL_EDGE * MODEL_EDGE
  const start = at * CROP

  for (let i = 0; i < plane; i++) {
    const grey = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!
    const value = (grey / 255 - 0.5) / 0.5

    into[start + i] = value
    into[start + plane + i] = value
    into[start + 2 * plane + i] = value
  }
}

/** The raw tensor under a transformers.js one, which is what `run` wants. */
const raw = (tensor: TensorLike) => (tensor as TensorLike & { ort_tensor?: unknown }).ort_tensor ?? tensor

/**
 * Crops read greedily to their end markers, together: every crop's token ids,
 * start marker first, in the order the crops were given.
 *
 * `pixels` is `count` crops back to back, as `writeCrop` lays them out. They
 * are encoded in one run and then decoded side by side, one token each per
 * step, and a crop that reaches its end marker leaves the batch — so a short
 * balloon neither waits for a long one nor is carried along beside it. The
 * whole sequence goes back through the decoder every step because the decoder
 * keeps no cache: quadratic in tokens, and fine for a balloon's worth. Every
 * row still in play has said as many tokens as every other, since they all
 * started together, so there is nothing to pad and no mask to keep.
 *
 * Each crop's reading is the one it would get alone: a row of a batch meets no
 * other row anywhere in either graph. Checked on WebGPU, where the arithmetic is
 * most likely to depend on the shape — batches of one and of eight read the
 * eighteen balloons of three pages character for character alike, and so did
 * one and two for the 2025 retrain on WebAssembly.
 *
 * ## Why every step's inputs are new
 *
 * The obvious code builds one tensor from `last_hidden_state` and hands it to
 * the decoder each time round. That dies with a message that names no cause:
 * *ArrayBuffer at index 1 is already detached*. Both runtimes here run in a
 * worker (`ortOnce`, `transformersOnce`), and an input tensor's buffer is
 * *transferred* to that worker rather than copied — so the second step posts a
 * buffer the first step gave away, and the encoder's own output is emptied the
 * first time it is used as an input.
 *
 * So the encoder's output is copied once up front, so that nothing ever hands
 * over the only version it has; the rows still in play are packed out of that
 * copy whenever one leaves; and every step sends a copy of the pack — about
 * six hundred kilobytes a crop, against a decoder pass that costs far more.
 */
export async function readBatch (sessions: ReadingSessions, pixels: Float32Array, count: number): Promise<number[][]> {
  if (!count) return []

  const { last_hidden_state: hidden } = await sessions.encoder.run({
    pixel_values: raw(sessions.makeTensor('float32', pixels, [count, 3, MODEL_EDGE, MODEL_EDGE])),
  })

  const [, length, width] = hidden!.dims as number[]
  const row = length! * width!
  const source = new Float32Array(hidden!.data as Float32Array)

  const tokens = Array.from({ length: count }, () => [START_TOKEN])

  let playing = tokens.map((_, index) => index)
  let states: Float32Array = source

  for (let step = 0; step < MAX_TOKENS && playing.length; step++) {
    const said = step + 1
    const ids = new BigInt64Array(playing.length * said)

    for (const [at, index] of playing.entries()) {
      for (const [position, id] of tokens[index]!.entries()) ids[at * said + position] = BigInt(id)
    }

    const { logits } = await sessions.decoder.run({
      input_ids: raw(sessions.makeTensor('int64', ids, [playing.length, said])),
      encoder_hidden_states: raw(sessions.makeTensor('float32', states.slice(), [playing.length, length!, width!])),
    })

    // A score for every position of every row; each row's next token is read
    // off its last position.
    const [, positions, vocab] = logits!.dims as number[]
    const scores = logits!.data as Float32Array

    for (const [at, index] of playing.entries()) {
      tokens[index]!.push(bestId(scores, (at * positions! + positions! - 1) * vocab!, vocab!))
    }

    const still = playing.filter((index) => tokens[index]!.at(-1) !== END_TOKEN)

    if (still.length < playing.length) {
      playing = still
      states = pack(source, still, row)
    }
  }

  return tokens
}

/** The highest of `vocab` scores from `from` — the first of equals, as greedy decoding here always took it. */
function bestId (scores: Float32Array, from: number, vocab: number): number {
  let best = 0
  let bestScore = -Infinity

  for (let id = 0; id < vocab; id++) {
    const score = scores[from + id]!

    if (score > bestScore) {
      bestScore = score
      best = id
    }
  }

  return best
}

/** The encoder states of the given rows, in that order, `row` values each. */
function pack (source: Float32Array, rows: number[], row: number): Float32Array {
  const packed = new Float32Array(rows.length * row)

  for (const [at, index] of rows.entries()) packed.set(source.subarray(index * row, (index + 1) * row), at * row)

  return packed
}

/** One piece of lettering to read, and the block it belongs to. */
interface Piece {
  block: number
  region: Region
  lean: number | null
}

/**
 * Every piece of a page, read `batchSize` at a time: the text of each, in
 * order. Progress is told per batch, in blocks — the unit the caller counts.
 */
async function readPieces (loaded: Loaded, bitmap: ImageBitmap, pieces: Piece[], blocks: number,
  onProgress?: MangaProgress): Promise<string[]> {
  const size = batchSize(loaded.backend)
  const texts: string[] = []

  for (let start = 0; start < pieces.length; start += size) {
    const batch = pieces.slice(start, start + size)
    const first = batch[0]!.block

    onProgress?.(`Reading ${first + 1} of ${blocks}…`, { done: first, total: blocks })

    const pixels = new Float32Array(batch.length * CROP)

    for (const [at, piece] of batch.entries()) writeCrop(pixels, at, bitmap, piece.region, piece.lean)

    for (const ids of await readBatch(loaded, pixels, batch.length)) {
      texts.push(detokenise(loaded.tokenizer.decode(ids, { skip_special_tokens: true })))
    }
  }

  return texts
}

/**
 * Read the given regions of a page, and hand back blocks the app can use.
 *
 * No regions means the whole page as one — the right call for a raw panel
 * crop or a single balloon saved as its own image, and a knowingly blunt
 * one for a full page. Regions are read a batch at a time (see the header)
 * rather than raced: the model holds the machine's attention either way, and
 * two readings interleaved do not make an autoregressive decoder faster.
 */
export async function readWithMangaOcr (
  page: Readable,
  regions?: Region[],
  onProgress?: MangaProgress,
  model: MangaModel = 'base',
  /** A precision to read at instead of this machine's own choice — for the bench. */
  precision?: Precision,
): Promise<ReadBlock[]> {
  const loaded = await loadOnce(model, onProgress, precision)
  const bitmap = await createImageBitmap(page.file)

  try {
    const boxes: Region[] = regions?.length
      ? regions
      : [{ x: 0, y: 0, w: bitmap.width, h: bitmap.height }]

    const detections: Detection[] = []

    /**
     * The det head's text lines, when somebody already segmented this page —
     * the better geometry source, measured from dense strokes by a
     * manga-trained line detector rather than reconstructed from a handful
     * of ink clusters. Strictly a bonus: a Read never triggers the model
     * download itself (`segmentedAlready`), and a page nobody segmented
     * falls back to the ink measurement below, block by block.
     */
    const segmented = await segmentedAlready(page.file)?.catch(() => null) ?? null
    const lines = segmented ? detLines(segmented) : null

    // Every piece of lettering on the page, gathered before any is read so the
    // page can be read in batches. Prose comes back as several pieces, read in
    // order and joined — see `prose.ts`; a balloon comes back as itself. Each
    // carries its block's det-head lean where there is one — the same
    // measurement the stored quad uses, here also straightening the crop.
    const pieces: Piece[] = boxes.flatMap((region, block) => {
      const lean = lines ? detLeanFor(lines, region) : null

      return (proseParts(bitmap, region) ?? [region]).map((part) => ({ block, region: part, lean }))
    })

    const texts = await readPieces(loaded, bitmap, pieces, boxes.length, onProgress)

    for (const [index, region] of boxes.entries()) {
      const text = pieces.flatMap((piece, at) => (piece.block === index ? [texts[at]!] : [])).join('')

      // Where the lettering actually is, not where the detector's rectangle is.
      // The det head's oriented line box where the page has been segmented;
      // the ink measurement otherwise. `regionCanvas` measures the same lean
      // to straighten the crop and throws it away; measuring it again here
      // costs a mask over one tile against a decode that has just run, and
      // the alternative is threading the result out through a signature two
      // other engines depend on.
      //
      // `null` means upright or unreadable lean, and both take the detector's
      // box unchanged — see `uprightRegion`, which declines rather than guesses.
      // Prose is measured on the whole region rather than per part: the parts
      // are reading order within one block, and the block is what is filed.
      // Det boxes are stored as given, with one exception: det's *level*
      // verdict is a claim about the lines it saw, and on a one-glyph
      // balloon with an ellipsis trail it sees the glyph and misses the
      // flow. A real ink lean outranks a level det box there; a tilted det
      // box outranks everything. Ink must also sit outside the ambiguity
      // band -- see `quadWorthy`.
      const fromDet = lines && detBoxFor(lines, region)
      const fromInk = fromDet === null || fromDet.tilt === 0
        ? uprightRegion(bitmap, region,
            segmented ? (crop) => segFor(segmented, crop) : undefined)
        : null
      const inkWorthy = fromInk && quadWorthy(fromInk) ? fromInk : null
      // One bar for the ink, whatever det said. It used to hold only where
      // det measured level; where det saw nothing the ink was taken at any
      // size (`fromDet ?? inkWorthy`), and that is how 5–7° leans on upright
      // lettering reached the database — the ink was the only witness and it
      // was believed on less than it needs anywhere else. Under the bar the
      // detector's upright box is stored, which is where that block was
      // before any lean was measured.
      const leaning = fromDet && fromDet.tilt !== 0
        ? fromDet
        : inkWorthy && Math.abs(inkWorthy.tilt) >= 8 ? inkWorthy : fromDet

      detections.push({
        quad: leaning
          ? tiltedQuad(leaning)
          : [
              { x: region.x, y: region.y },
              { x: region.x + region.w, y: region.y },
              { x: region.x + region.w, y: region.y + region.h },
              { x: region.x, y: region.y + region.h },
            ],
        text,
      })
    }

    return readPage(detections, page.width || bitmap.width)
  } finally {
    bitmap.close()
  }
}
