/**
 * The extractor, on a thread of its own.
 *
 * Pulling a chapter out of a PDF is real work — inflating a couple of hundred
 * scans, wrapping the bare ones into PNG — and on the main thread it is work
 * done instead of drawing. That was the whole complaint: the canvas sat behind
 * a spinner until the last page was out. Here it is done beside the page
 * instead, and each image is posted across the moment it exists, so page one
 * can be looked at while page two is still being inflated.
 *
 * The bytes go both ways as transfers rather than copies: the file is handed
 * over to this worker (the sender loses it, which is why the sender hands over
 * a copy it no longer needs), and each image is handed back the same way.
 *
 * What the book's pages might already be (`identity.ts`) follows the file in a
 * second message rather than with it: gathering it means listing the page's
 * stores and perhaps waiting for the workspace record, and parsing the file
 * need not wait for that. Only a page with two files to choose between does.
 */
import { PdfPasswordError } from './decrypt'
import { readPdf } from './extract'

import type { Known } from './identity'

/**
 * What the driver sends: the file and the password if one is known, once, and
 * then what is known of the book's pages, once.
 */
export type ToPdfWorker =
  | { kind: 'open', bytes: ArrayBuffer, password?: string }
  | { kind: 'known', scans: string[], held: boolean }

/** What comes back, in order, ending with exactly one `done` or `error`. */
export type FromPdfWorker =
  | { kind: 'page', name: string, type: string, data: ArrayBuffer, done: number, total: number }
  | { kind: 'skip', done: number, total: number }
  | { kind: 'done' }
  /**
   * `locked` is the one failure the caller can do something about, so it
   * crosses as a flag rather than a sentence to match against — `wrong` tells
   * "we never asked" apart from "what you typed was not it".
   */
  | { kind: 'error', message: string, locked?: boolean, wrong?: boolean }

/** Settled by the `known` message, whenever it comes; the book may be well under way. */
let learn: (known: Known) => void = () => {}
const known = new Promise<Known>((resolve) => (learn = resolve))

self.addEventListener('message', async (event: MessageEvent<ToPdfWorker>) => {
  const post = (message: FromPdfWorker, transfer: Transferable[] = []) => self.postMessage(message, { transfer })

  if (event.data.kind === 'known') {
    learn({ scans: new Set(event.data.scans), held: event.data.held })

    return
  }

  try {
    for await (const { page, done, total } of readPdf(new Uint8Array(event.data.bytes), event.data.password, known)) {
      if (!page) {
        post({ kind: 'skip', done, total })

        continue
      }

      // Copied out of whatever it was a view onto before being transferred: a
      // JPEG comes back as a subarray of the whole file, and handing that
      // buffer over would hand over the file with it — every page after this
      // one reads from those same bytes.
      const data = page.data.slice().buffer

      post({ kind: 'page', name: page.name, type: page.type, data, done, total }, [data])
    }

    post({ kind: 'done' })
  } catch (error) {
    // The message, not the error: an `Error` crosses a worker boundary only as
    // whatever `structuredClone` makes of it — a custom class arrives as a
    // plain one with its own fields gone — so what the other side needs to act
    // on travels as data beside the sentence.
    post({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      locked: error instanceof PdfPasswordError,
      wrong: error instanceof PdfPasswordError && error.wrong,
    })
  }
})
