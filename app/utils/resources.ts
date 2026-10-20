/**
 * What this machine can give a model: where it runs, and how much work one run
 * may carry.
 *
 * Two questions every bulk inference asks and none should answer for itself.
 * Where: `webgpu` wherever the browser has it, `wasm` everywhere — and what a
 * model is *given* on each (which graph, which precision) is its loader's call,
 * because that is a fact about the weights rather than the machine; see
 * `detectorBackend` and `mangaPrecision`. How much: the batch. And, for the
 * other bulk job that is bound by this machine rather than the network, how
 * many pages an export may encode at once — see `exportEncoders` below. Every
 * pool here should ask this file rather than pick a number of its own.
 *
 * ## Why batches, and why these sizes
 *
 * A run has a fixed cost before it does any arithmetic — a message to the
 * runtime's worker and back, a graph walked, on the GPU a round of dispatches
 * and a read-back — and a balloon read one at a time pays it once per balloon,
 * per decoder step. Measured in Chrome on an M-series Mac against manga-ocr's
 * fp32 encoder and its cacheless decoder (20 greedy steps), per balloon:
 *
 * | WebGPU  | batch 1 | 4     | 8     | 16    |
 * | ------- | ------- | ----- | ----- | ----- |
 * | encoder | 28 ms   | 20 ms | 21 ms | 41 ms |
 * | decoder | 236 ms  | 76 ms | 64 ms | 56 ms |
 *
 * Eight is where the encoder bottoms out, and past it the encoder gets *worse*
 * per crop while the decoder barely improves.
 *
 * WebAssembly is another story. It ran here on one thread when these were
 * measured — the page was not cross-origin isolated until 2026-09-30, so there
 * was no `SharedArrayBuffer` — and one thread is busy arithmetic from end to
 * end, with little overhead left to share out (with up to four threads now, a
 * run is shorter but no less arithmetic, so the knee is not expected to move;
 * not measured again):
 *
 * | wasm        | batch 1 | 2      | 4      |
 * | ----------- | ------- | ------ | ------ |
 * | encoder, q8 | 918 ms  | 928 ms | 933 ms |
 * | decoder     | 776 ms  | 745 ms | 743 ms |
 *
 * Two takes the whole of the decoder's four per cent, and four would only hold
 * twice the rows for it.
 *
 * Halved where the browser says the machine has four gigabytes or less
 * (`navigator.deviceMemory` — coarse, but coarse at the top, not down here): a
 * batch of eight balloons is a few tens of megabytes of activations per decoder
 * step, nothing on a desktop and worth not doubling on a machine that is
 * already swapping. A browser that does not say — Firefox, Safari — is taken at
 * its best, as it was before there was a batch at all.
 *
 * Imported by hand where it is used rather than leaned on as an auto-import:
 * a dev server that is already running does not see a new auto-imported export
 * until it restarts, and a reading that fails with "not defined" is a worse
 * first impression than one import line.
 */

/** Where an inference session runs. */
export type Backend = 'webgpu' | 'wasm'

/**
 * Whether this browser offers WebGPU at all.
 *
 * Only that it is on offer: an adapter can still be refused, and a session can
 * still fail to open on it, which is why every loader that asks for `webgpu`
 * keeps `wasm` as its fallback.
 */
export function webGpuOffered (): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

let half: Promise<boolean> | null = null

/**
 * Whether this browser's GPU can run half-precision graphs — WebGPU's
 * `shader-f16` feature, which onnxruntime asks its device for wherever the
 * adapter has it and which every fp16 kernel needs.
 *
 * Asked of an adapter, so a promise, and asked once. False wherever WebGPU is
 * not on offer or the adapter will not come: a model that picks fp16 on the
 * strength of this must still keep its fp32 build for everywhere else.
 */
export function webGpuHalf (): Promise<boolean> {
  half ??= (async () => {
    if (!webGpuOffered()) return false

    const adapter = await navigator.gpu.requestAdapter().catch(() => null)

    return Boolean(adapter?.features.has('shader-f16'))
  })()

  return half
}

/**
 * How many items one run may carry, by backend, on a machine with memory to
 * spare — the knees in the header's two tables. Measured on manga-ocr; a model
 * with a very different shape may have its knee somewhere else, and should be
 * measured before it borrows these.
 */
export const BATCH: Readonly<Record<Backend, number>> = { webgpu: 8, wasm: 2 }

/** Below this many gigabytes, halve the batch — see the header. */
const SPARSE_MEMORY_GB = 4

/**
 * The batch for a run on `backend`.
 *
 * `memory` is in gigabytes, as `navigator.deviceMemory` reports it; left out,
 * this browser's own answer is used. Never less than one.
 */
export function batchSize (backend: Backend, memory: number | undefined = deviceMemory()): number {
  const size = BATCH[backend]

  return memory !== undefined && memory <= SPARSE_MEMORY_GB ? Math.max(1, Math.floor(size / 2)) : size
}

/** `navigator.deviceMemory`, where the browser has it — Chromium only. */
function deviceMemory (): number | undefined {
  if (typeof navigator === 'undefined') return undefined

  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory

  return typeof memory === 'number' && Number.isFinite(memory) ? memory : undefined
}

/* ---------- exports ---------- */

/** `navigator.hardwareConcurrency` — logical cores — or two where it is not said. */
function logicalCores (): number {
  return (typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency) || 2
}

/**
 * What one page in flight costs an export, in megabytes: the composed page's
 * bitmap handed to an encoder (78 MB at 3732 × 5197), the canvas it is encoded
 * from, and the file the encoder makes. Measured on those pages, the largest
 * this app is used with. A smaller page costs less; on any machine where that
 * would change the answer, the core bound in `exportEncoders` decides it first.
 */
const EXPORT_PAGE_MB = 170

/**
 * How many pages an export encodes at once — see `export/encoder.ts` and
 * `export/pipeline.ts`, which holds the export to this many pages in flight.
 *
 * Half the cores, because the main thread is drawing the next page all the
 * while and the browser has its own work to do; and never more than four,
 * which is where it stopped paying — four encoders measured 2.8× one on a
 * ten-core Mac, so a fifth would buy little and hold another 170 MB. Then no
 * more than an eighth of the machine's memory will hold, so a small device
 * encodes a page at a time as exports always did, rather than four at 680 MB.
 * (`deviceMemory` is coarse and capped — 8 in older Chrome, 32 in this Mac's —
 * which only matters well past the four this stops at.) Two where the browser
 * will not say how much memory there is: enough to keep the encoding behind
 * the drawing, at a price any machine running a browser can pay.
 */
export function exportEncoders (cores: number = logicalCores(), memory: number | undefined = deviceMemory()): number {
  const byCores = Math.max(1, Math.min(4, Math.floor(cores / 2)))

  if (memory === undefined) return Math.min(2, byCores)

  return Math.max(1, Math.min(byCores, Math.floor((memory * 1024) / 8 / EXPORT_PAGE_MB)))
}

/* ---------- repairs ---------- */

/**
 * How many cleaned balloons a clean downloads from the server at once — `borrow`
 * in `useClean`, fetching the repairs a collaborator has already made.
 *
 * The one pool here bound by the network rather than by this machine, and so by
 * a number the browser sets rather than one measured: six is how many
 * connections Chrome, Firefox and Safari keep to one host over HTTP/1.1, which
 * is what a browser speaks to a server without TLS — the development server
 * included. A seventh request only waits in the browser's own queue for one of
 * those six, and everything else the app sends meanwhile — a block saved, a
 * stroke sent — would queue behind every download still waiting there. Held to
 * six, it waits for one at most. One at a time, which is what cleaning did,
 * paid a round trip per balloon in a row.
 */
export const REPAIR_DOWNLOADS = 6

/* ---------- opening a chapter ---------- */

/**
 * How many background decoders a tab runs — the threads behind `scanJob`,
 * `scanPreview` and `scanAside` in `raster/decoder.ts`. The scan decoder, the
 * one the page on screen is drawn from, is always one and is not counted here.
 *
 * It was one, and one thread made every page's preview, every thumbnail and
 * every model's input in turn. Measured on the CGu chapter (3732 × 5197
 * JPEGs, 14–24 MB) on a ten-core Mac: a preview is 590 ms of decoding,
 * scaling and lossless WebP there, so eight took 4.7 s whether one caller
 * asked or four did, and a thumbnail asked for meanwhile waited out whichever
 * preview was running.
 *
 * A third of the cores, because each decoder is one busy thread and the page
 * has its own decoder, the main thread and the GPU process to leave room for;
 * never more than three, since every thread in flight holds a scan's full
 * decode (78 MB at the size above) and the preview it is making. One at four
 * gigabytes or less, where that is worth more than the time. Two where the
 * browser will not say, for the reason `exportEncoders` gives.
 */
export function backgroundDecoders (cores: number = logicalCores(), memory: number | undefined = deviceMemory()): number {
  const byCores = Math.max(1, Math.min(3, Math.floor(cores / 3)))

  if (memory === undefined) return Math.min(2, byCores)

  return memory <= SPARSE_MEMORY_GB ? 1 : byCores
}

/**
 * How many files are read and hashed at once — `identify` opening a chapter,
 * and a drop hashing what it is about to add (`useLibrary`).
 *
 * `crypto.subtle` has no streaming digest, so every file being hashed is in
 * memory whole: the bound is what stops a drop of sixty 25 MB scans from being
 * a gigabyte and a half at once, which an unbounded `Promise.all` was. And it
 * is not one, which is what opening was: the reading of one file and the
 * digest of another overlap. Measured on the CGu chapter's eight pages (143 MB)
 * from the private filesystem, memo cold: 207–219 ms one at a time, 151–183 ms
 * four at a time — more on a slower disk, where the reading is the larger
 * part. Half the cores up to four; two at four gigabytes or less.
 */
export function hashLanes (cores: number = logicalCores(), memory: number | undefined = deviceMemory()): number {
  const byCores = Math.max(1, Math.min(4, Math.floor(cores / 2)))

  return memory !== undefined && memory <= SPARSE_MEMORY_GB ? Math.min(2, byCores) : byCores
}
