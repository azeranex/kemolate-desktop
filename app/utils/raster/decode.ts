/**
 * The work behind `decoder.ts`, written once and run wherever there is a thread
 * for it — the decode worker, or this one where no worker can be had.
 *
 * A scan is decoded here and nowhere near the page. Measured on a 3732 × 5197
 * JPEG, inside a worker: 125 ms to decode it whole, 91 ms more to scale that to
 * the screen, 2–4 ms to cut a 1024 px tile from it. On the main thread the same
 * picture through an `<img>` was frames of 80–156 ms while flicking pages; from
 * here, none over 9.
 *
 * One full decode is held — the page on screen, which is the one zoom tiles are
 * cut from — and a request for another page's tiles or a `keep` level lets it
 * go. A neighbour's level is decoded, scaled and dropped in one go: it is asked
 * for ahead of a turn that may not come, and 78 MB held for a maybe is how the
 * old prefetch cost what it did.
 *
 * Requests run one at a time, the on-screen page's first. Decoding is the
 * expensive part and each decoder is one thread doing it, so running two at
 * once on it would only make both late; and a reader flicking past a page
 * withdraws what was asked for it (`cancel`) before any of it is started. The
 * background work runs on several of these (`decoders` in `decoder.ts`); each
 * of them is still one thread, taking one request at a time.
 */

import { runJob } from './jobs'

import type { Job } from './jobs'

export type DecodeRequest =
  /** The whole page at a size; `keep` holds the full decode for tiles after. */
  | { kind: 'level', id: number, key: string, file: Blob, width: number, height: number, keep: boolean, urgent: boolean, quality?: ResizeQuality }
  /** A piece of the page, from the held full decode. */
  | { kind: 'tile', id: number, key: string, file: Blob, sx: number, sy: number, sw: number, sh: number, width: number, height: number, urgent: boolean }
  /**
   * The whole page at a size, encoded — a preview to keep on disk (see
   * `previews.ts`). Lossless WebP: measured on 3732 × 5197 pages it is exact,
   * 2.4–3 MB, and decodes in 33–41 ms, where lossy WebP decoded in 120–185 ms
   * and was not exact.
   */
  | { kind: 'preview', id: number, key: string, file: Blob, width: number, height: number, urgent: boolean }
  /** The page's own size, for a page whose header would not say. */
  | { kind: 'size', id: number, key: string, file: Blob, urgent: boolean }
  /**
   * Anything else made from the whole page — see `jobs.ts`. A job that needs
   * the full decode uses the held one where it is this page's, and lets it go
   * after: nothing is kept for a job.
   */
  | { kind: 'job', id: number, key: string, file: Blob, job: Job, urgent: boolean }
  /** Asked-for work that is no longer wanted and has not started. */
  | { kind: 'cancel', ids: number[] }
  /** The held full decode, if it is this page's. */
  | { kind: 'release', key: string }

export type DecodeReply =
  | { id: number, ok: true, width: number, height: number, bitmap?: ImageBitmap, blob?: Blob, pixels?: Uint8ClampedArray, same?: boolean, empty?: boolean }
  | { id: number, ok: false, error: string }

type Work = Extract<DecodeRequest, { id: number }>

/**
 * A decode host: give it requests, it answers through `send`. `transfer` names
 * the bitmap so a worker can hand it over rather than copy it.
 */
export function decodeHost (send: (reply: DecodeReply, transfer: Transferable[]) => void): (request: DecodeRequest) => void {
  const queue: Work[] = []
  let busy = false

  /** The one full decode held, and which page it is. */
  let held: { key: string, bitmap: Promise<ImageBitmap> } | null = null

  function drop () {
    held?.bitmap.then((bitmap) => bitmap.close()).catch(() => {})
    held = null
  }

  /** The full decode of this page — the held one, or a new one that is held from now on. */
  function full (key: string, file: Blob): Promise<ImageBitmap> {
    if (held?.key === key) return held.bitmap

    drop()

    const bitmap = createImageBitmap(file)

    held = { key, bitmap }
    // A decode that fails is not kept, so asking again tries again.
    bitmap.catch(() => { if (held?.bitmap === bitmap) held = null })

    return bitmap
  }

  async function run (work: Work): Promise<DecodeReply & { transfer: Transferable[] }> {
    if (work.kind === 'job') {
      try {
        const made = await runJob(work.file, work.job, () => full(work.key, work.file))

        if (!made) return { id: work.id, ok: true, width: 0, height: 0, empty: true, transfer: [] }

        return { id: work.id, ok: true, ...made, transfer: made.pixels ? [made.pixels.buffer] : [] }
      } finally {
        if (held?.key === work.key) drop()
      }
    }

    if (work.kind === 'size') {
      const bitmap = await full(work.key, work.file)

      return { id: work.id, ok: true, width: bitmap.width, height: bitmap.height, transfer: [] }
    }

    if (work.kind === 'preview') {
      const size = { resizeWidth: work.width, resizeHeight: work.height, resizeQuality: 'high' as const }
      const bitmap = held?.key === work.key
        ? await createImageBitmap(await held.bitmap, size)
        : await createImageBitmap(work.file, size)
      const canvas = new OffscreenCanvas(work.width, work.height)

      canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      bitmap.close()

      // Quality 1 is lossless for WebP.
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 })

      return { id: work.id, ok: true, width: work.width, height: work.height, blob, transfer: [] }
    }

    if (work.kind === 'tile') {
      const source = await full(work.key, work.file)
      const bitmap = await createImageBitmap(source, work.sx, work.sy, work.sw, work.sh, {
        resizeWidth: work.width,
        resizeHeight: work.height,
        resizeQuality: 'high',
      })

      return { id: work.id, ok: true, width: source.width, height: source.height, bitmap, transfer: [bitmap] }
    }

    // High unless asked otherwise: what is drawn wants the best downscale there
    // is. The paper sampler asks for low, because it takes a median of a ring
    // of balloon, and an averaging downscale blends the balloon's outline and
    // lettering into the paper it is meant to find — see `readScanSheet`.
    const size = { resizeWidth: work.width, resizeHeight: work.height, resizeQuality: work.quality ?? 'high' }

    if (work.keep) {
      const source = await full(work.key, work.file)
      const bitmap = await createImageBitmap(source, size)

      return { id: work.id, ok: true, width: source.width, height: source.height, bitmap, transfer: [bitmap] }
    }

    // From the full decode where this page's is the one held — the page on
    // screen, asked for at another size (the paper sampler's 640 px read) —
    // and straight from the file otherwise, nothing kept. The scan's own size
    // is not known this way, and a neighbour's is known from its header.
    const bitmap = held?.key === work.key
      ? await createImageBitmap(await held.bitmap, size)
      : await createImageBitmap(work.file, size)

    return { id: work.id, ok: true, width: 0, height: 0, bitmap, transfer: [bitmap] }
  }

  async function pump () {
    if (busy) return

    busy = true

    try {
      for (let work = queue.shift(); work; work = queue.shift()) {
        try {
          const { transfer, ...reply } = await run(work)

          send(reply, transfer)
        } catch (error) {
          send({ id: work.id, ok: false, error: error instanceof Error ? error.message : String(error) }, [])
        }
      }
    } finally {
      busy = false
    }
  }

  return (request) => {
    if (request.kind === 'cancel') {
      const gone = new Set(request.ids)

      for (let i = queue.length - 1; i >= 0; i--) {
        if (!gone.has(queue[i]!.id)) continue

        send({ id: queue[i]!.id, ok: false, error: 'cancelled' }, [])
        queue.splice(i, 1)
      }

      return
    }

    if (request.kind === 'release') {
      if (held?.key === request.key) drop()

      return
    }

    // The page on screen goes ahead of anything asked for a neighbour, and in
    // the order it was asked for among itself.
    if (request.urgent) {
      const at = queue.findIndex((work) => !work.urgent)

      queue.splice(at === -1 ? queue.length : at, 0, request)
    } else {
      queue.push(request)
    }

    pump()
  }
}
