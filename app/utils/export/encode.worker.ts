/**
 * A page encoder, on a thread of its own — see `encode.ts` for the work and
 * `encoder.ts` for the pool that asks. Each page's bitmap is transferred in,
 * not copied; the file goes back as a `Blob`, which crosses by reference.
 */
import { encodePage } from './encode'

import type { EncodeReply, EncodeRequest } from './encode'

const post = (reply: EncodeReply) => self.postMessage(reply)

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { id, bitmap, ...job } = event.data

  try {
    post({ kind: 'done', id, ...await encodePage(bitmap, job) })
  } catch (error) {
    post({ kind: 'failed', id, error: error instanceof Error ? error.message : String(error) })
  }
}

post({ kind: 'ready', canvas: typeof OffscreenCanvas !== 'undefined' })
