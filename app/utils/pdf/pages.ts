/**
 * The pages of a PDF, arriving one at a time — off the main thread where the
 * browser will give us one, and on it where it will not.
 *
 * This is the only thing the rest of the app opens a PDF with. Both routes
 * hand back the same generator, so nothing above here knows or cares which
 * one it got: what it gets is pages, in order, as they come.
 *
 * It is also where what is known of the book's pages is gathered
 * (`known.ts`), on this thread because that is where the stores and the
 * workspace record are, and handed to whichever route reads the file — see
 * `identity.ts` for what it decides.
 */
import { PdfPasswordError } from './decrypt'
import { asPicked, readPdf } from './extract'
import { NOTHING_KNOWN } from './identity'
import { knownFor } from './known'

import type { PdfPage } from './extract'
import type { Known } from './identity'
import type { FromPdfWorker, ToPdfWorker } from './worker'
import type { PickedImage } from '../images'

/** A page out of a book, and how far through that book we are. */
export interface Arrival {
  image: PickedImage
  /** Images considered so far, and how many the book holds. */
  done: number
  total: number
}

/**
 * Everything inside one PDF, in order.
 *
 * The file's bytes are read here and handed to the worker, which is the one
 * copy this makes: a `File` cannot be transferred, and a worker reading the
 * blob itself would only move the read rather than remove it.
 *
 * `reopening` is a chapter coming back from its kept folder — see `knownFor`.
 */
export async function * pdfPages (
  file: File,
  path = file.name,
  { password, reopening = false }: { password?: string, reopening?: boolean } = {},
): AsyncGenerator<Arrival> {
  // Started now and not waited for: the file is parsed and its first pages
  // inflated while the stores are listed, and only a page with two possible
  // files needs the answer.
  const known = knownFor(path, { reopening })
  const bytes = await file.arrayBuffer()
  const worker = spawn()

  if (!worker) {
    // No worker to be had. The same work, on this thread — slower to look at,
    // but a chapter that opens beats a chapter that does not, and the
    // generator still yields between pages so nothing is frozen solid.
    for await (const { page, done, total } of readPdf(new Uint8Array(bytes), password, known)) {
      if (page) yield { image: asPicked(page, path), done, total }
    }

    return
  }

  try {
    for await (const message of listen(worker, bytes, password, known)) {
      if (message.kind !== 'page') continue

      const page: PdfPage = { name: message.name, type: message.type, data: new Uint8Array(message.data) }

      yield { image: asPicked(page, path), done: message.done, total: message.total }
    }
  } finally {
    // Whatever ended this — the last page, an error, or a caller that walked
    // away mid-chapter — the thread goes with it. A generator abandoned by a
    // `break` or a closed workspace runs this too, which is the point of
    // having it here rather than after the loop.
    worker.terminate()
  }
}

/**
 * The worker's messages as something a `for await` can walk.
 *
 * A queue rather than a promise per message, because messages arrive whether
 * or not anybody is currently waiting on one — a fast little PDF can be
 * finished before the first pull, and dropping those would drop the chapter.
 */
function listen (worker: Worker, bytes: ArrayBuffer, password: string | undefined, known: Promise<Known>): AsyncGenerator<FromPdfWorker> {
  const queue: FromPdfWorker[] = []
  let wake: (() => void) | null = null
  let failed: Error | null = null
  let ended = false

  const push = (message: FromPdfWorker) => {
    queue.push(message)
    wake?.()
    wake = null
  }

  worker.addEventListener('message', (event: MessageEvent<FromPdfWorker>) => push(event.data))
  worker.addEventListener('error', (event) => {
    // A worker that dies of its own accord — a bad import, an out-of-memory —
    // says nothing on the message channel, so without this the loop below
    // would wait for a page that is never coming.
    failed = new Error(event.message || 'The reader stopped unexpectedly.')
    push({ kind: 'error', message: failed.message })
  })

  const message: ToPdfWorker = { kind: 'open', bytes, password }

  worker.postMessage(message, [bytes])

  // A set does not cross; its members do. A worker already terminated — the
  // book finished, or abandoned — takes the message and ignores it.
  // Sent whatever happens — a worker never told would wait on its first
  // compressed page for ever — and as knowing nothing if gathering failed.
  known.catch(() => NOTHING_KNOWN).then(({ scans, held }) => {
    const told: ToPdfWorker = { kind: 'known', scans: [...scans], held }

    worker.postMessage(told)
  })

  return (async function * () {
    while (!ended) {
      if (!queue.length) {
        await new Promise<void>((resolve) => (wake = resolve))

        continue
      }

      const next = queue.shift()!

      if (next.kind === 'done') {
        ended = true

        return
      }

      if (next.kind === 'error') {
        ended = true

        // Rebuilt as the class it was raised as. It crossed the thread as
        // plain data, and the retry above cares which kind of failure this is,
        // not what it says.
        throw next.locked ? new PdfPasswordError(Boolean(next.wrong)) : new Error(next.message)
      }

      yield next
    }
  })()
}

/**
 * A worker, where there is one to be had.
 *
 * Never during SSR, where `Worker` does not exist and neither does the file
 * being opened. A browser that refuses to make one — an old Safari with no
 * module workers, a page served under a policy that forbids them — gets the
 * main-thread route rather than an error, since the work is the same work.
 */
function spawn (): Worker | null {
  if (typeof Worker === 'undefined') return null

  try {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    console.warn('[kemolate] no worker for reading PDFs; falling back to this thread', error)

    return null
  }
}
