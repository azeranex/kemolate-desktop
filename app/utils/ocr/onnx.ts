/**
 * Raw ONNX sessions, for the models transformers.js cannot house.
 *
 * Most of the engines here ride on transformers.js, which fetches, caches
 * and stands sessions up for anything in its expected repo layout. Some of
 * the best models are not in that layout — manga-ocr-2025 keeps its graphs
 * in the repo root rather than under `onnx/` — and for those this file does
 * the same three jobs by hand: fetch the bytes once, keep them in the model
 * store (`store.ts`, on OPFS), and open an onnxruntime session on them.
 *
 * The runtime is pinned to the exact version transformers.js depends on, and
 * its wasm binaries come from a CDN path versioned to match. The same version
 * is not the same copy, though, and this used to say it was: this file imports
 * `onnxruntime-web`, whose WebGPU is the older JSEP kernels, and transformers.js
 * imports `onnxruntime-web/webgpu`, the native WebGPU provider — two bundles,
 * each with its own settings, wasm, worker and GPU device. `transformersOnce`
 * says why they are left that way, and is the one door into the library.
 */

import type { InferenceSession, Tensor as OrtTensor } from 'onnxruntime-web'

export type { InferenceSession, OrtTensor }

/** Where the Hub's files are named from, and what this install serves instead. */
const HUB = 'https://huggingface.co/'

/**
 * A model's address, pointed at this install rather than at the Hub.
 *
 * The weights are identical for everybody, so fetching them once per install
 * beats once per browser — and in development, where a new dev server port
 * is a new origin with an empty cache, it is the difference between a
 * second and several minutes. See `server/api/models/[...path]`, which
 * fetches and keeps them on first ask.
 *
 * Anything not on the Hub is left alone, so a URL can still be pointed
 * straight at a file while it is being tried out.
 */
export function localModel (url: string): string {
  return url.startsWith(HUB) ? `/api/models/${url.slice(HUB.length)}` : url
}

/**
 * Where both runtimes find their wasm and loaders in the desktop app: on the
 * page's own origin, at `/ort/` — the one change from the web build's file,
 * which points both at a CDN.
 */
const ORT_FILES = `${location.origin}/ort/`

let runtime: Promise<typeof import('onnxruntime-web')> | null = null

/** The runtime, configured once — see the header for why the CDN path. */
export function ortOnce (): Promise<typeof import('onnxruntime-web')> {
  runtime ??= import('onnxruntime-web').then((ort) => {
    // Desktop: the runtime's own files from beside the page (`/ort/`, put
    // there by the build and served by the dev server — see `vite.config.ts`)
    // rather than the CDN the web build uses. Same pinned version; the CSP
    // allows no other script origin, and the app has to read offline.
    ort.env.wasm.wasmPaths = ORT_FILES

    /**
     * Inference in a worker, not on this thread.
     *
     * The compute is WebAssembly either way, but wasm on the main thread
     * *blocks* it: a balloon's repair is seconds of a page that will not
     * scroll, and a release of the mask brush that queues three balloons is
     * a browser that looks locked up. The proxy moves the session — create
     * and run both — into a worker the runtime owns; tensors cross by
     * structured clone, and the awaits here stay awaits.
     */
    ort.env.wasm.proxy = true

    return ort
  })

  return runtime
}

let library: Promise<typeof import('@huggingface/transformers')> | null = null

/**
 * transformers.js, imported once, with its inference moved off this thread.
 *
 * Every use of the library goes through here — the detector, manga-ocr, and
 * the model store's cache hook — because importing it has a side effect this
 * app cannot live with. The library brings its own runtime (see the header),
 * and as it is imported it sets that runtime's `wasm.proxy` to `false`, on the
 * reasoning that WebGPU needs no worker. So every session it stood up ran on
 * the page's thread. Without WebGPU that was the whole reading: one page held
 * the thread for 6.1 s at a stretch, measured, where in a worker the longest
 * hold is 0.2 s. With it, the int8 detector and encoder ran their integer
 * operators there too — WebGPU has none, so ORT hands those nodes to its CPU
 * provider — in pieces between trips to the GPU. Put back to `true` here,
 * before the caller can stand anything up: ORT consults the flag on every
 * create and run, not once, so it has to be true before the first session and
 * never change after.
 *
 * ## Why the library keeps a runtime of its own
 *
 * transformers.js 4.x will take a runtime handed to it under
 * `globalThis[Symbol.for('onnxruntime')]`, which would make it one runtime,
 * one worker and one GPU device. Tried and measured (Chrome, M-series Mac):
 *
 * - `ortOnce`'s bundle cannot run the comic detector on WebGPU at all — its
 *   JSEP kernels reject the graph's `MaxPool` (`ceil()` in shape computation)
 *   at the first run — and a failed JSEP kernel leaves the runtime refusing
 *   every kernel after it ("not allowed to be called recursively"), which
 *   shared would have taken the cleaners down with the detector.
 * - The `full` detector build runs in 162 ms on the library's native provider.
 *   Moved to wasm to avoid the above, it takes 3.6 s.
 * - manga-ocr's encoder and decoder run alike on either: 28 against 29 ms a
 *   crop, 64 against 71 ms a balloon at a batch of eight.
 * - Taking that door also leaves the library with no devices registered, so
 *   `device: 'webgpu'` — and even `'wasm'` — throws "Unsupported device", and
 *   only `'auto'` with explicit providers loads anything.
 *
 * One runtime is worth having if the cleaners are ever moved to the native
 * provider too, which needs their repairs compared again first.
 */
export function transformersOnce (): Promise<typeof import('@huggingface/transformers')> {
  library ??= import('@huggingface/transformers').then((transformers) => {
    const flags = transformers.env.backends.onnx.wasm

    if (flags) flags.proxy = true
    // Desktop: its runtime's files from beside the page too — see `ortOnce`.
    // Set before any session, which is when the runtime first fetches them.
    if (flags) flags.wasmPaths = ORT_FILES

    return transformers
  }).catch((error) => {
    library = null
    throw error
  })

  return library
}

/**
 * The bytes of a model, from the store or the network — and into the store
 * on the way past, so every model is a one-time download like the rest of
 * the engines. The store is the OPFS one in `store.ts`; progress is
 * reported from the stream because a hundred silent megabytes reads as a
 * hang.
 */
export async function fetchModel (url: string, onProgress?: MangaProgress): Promise<ArrayBuffer> {
  const held = await readModel(url).catch(() => null)

  if (held) return held.arrayBuffer()

  // Asked of this install, which fetches it from the Hub once and keeps it.
  // The browser's own copy is still cached under the Hub's address, so a
  // model kept from before this existed is still found above.
  const response = await fetch(localModel(url))

  if (!response.ok || !response.body) throw new Error(`The model could not be fetched (${response.status}): ${url}`)

  const total = Number(response.headers.get('content-length')) || 0
  const name = url.split('/').pop() ?? url
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []

  let got = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break

    parts.push(value)
    got += value.length

    if (total) onProgress?.(`Fetching ${name} — ${Math.round((got / total) * 100)}%`, { done: got, total })
  }

  const bytes = new Uint8Array(got)

  let at = 0

  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }

  // Store failures (private windows, full quotas) cost a re-download later,
  // not the reading now.
  await writeModel(url, new Blob([bytes])).catch(() => {})

  return bytes.buffer
}

/** Sessions that were opened on WebGPU — see `sessionFor` and `isOnGpu`. */
const onGpu = new WeakSet<InferenceSession>()

/** Whether a session from `sessionFor` is running on WebGPU rather than wasm. */
export const isOnGpu = (session: InferenceSession): boolean => onGpu.has(session)

/**
 * A session on a model at a URL, cached bytes and all.
 *
 * WebAssembly unless `gpu` is asked for. It used to be WebAssembly for
 * everything, on the grounds that every model had been measured fast enough
 * there and one backend that always works beats two that need telling apart.
 * The inpainters stopped being fast enough: this page was not cross-origin
 * isolated then, so there was no `SharedArrayBuffer` and the wasm backend ran
 * on **one thread**. LaMa on a 512 tile was 17–19 s — a page of large
 * captions took 23 s to clean — and the same tile on WebGPU is 0.47 s. (The
 * page is isolated since 2026-09-30 — see `routeRules` in nuxt.config.ts — and
 * wasm takes up to four threads, which roughly halves a wasm model's time:
 * nowhere near what the GPU gives.) AOT went from
 * 4.2 s to 0.12 s with identical output, MI-GAN from 1.3 s to 0.11 s within
 * one level in 255. Measured on an M-series Mac, on page 19 of the istani
 * chapter.
 *
 * So a caller that has been measured on WebGPU can ask for it, and wasm is
 * still the answer wherever there is no `navigator.gpu` or the session will
 * not open there. A GPU that fails *later*, mid-run, is the caller's to
 * handle — `isOnGpu` is how it tells which kind of session it holds. The
 * cleaners and the segmenter ask (see `segmenterOnce` for its numbers). The
 * readers opened here — manga-ocr 2025 and PP-OCR — have not been measured
 * there and stay on wasm. The comic detector and manga-ocr's original are not
 * opened here at all: they come through transformers.js, and each chooses its
 * backend by what its graph can use on it (`detectorBackend`,
 * `mangaPrecision`).
 *
 * The bytes are copied for the GPU attempt, because a session may take the
 * buffer it is given and the fallback still needs it.
 */
export async function sessionFor (url: string, onProgress?: MangaProgress, options: { gpu?: boolean } = {}): Promise<InferenceSession> {
  const ort = await ortOnce()
  const bytes = await fetchModel(url, onProgress)

  onProgress?.('Preparing the model…')

  if (options.gpu && typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const session = await ort.InferenceSession.create(bytes.slice(0), { executionProviders: ['webgpu'] })

      onGpu.add(session)

      return session
    } catch (error) {
      console.info('[kemolate] WebGPU would not open this model — running it on WebAssembly instead.', error)
    }
  }

  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
}
