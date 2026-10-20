/**
 * The scan decoder, on a thread of its own — see `decode.ts` for the work and
 * `decoder.ts` for who asks. Each bitmap is transferred back, not copied.
 */
import { decodeHost } from './decode'

import type { DecodeRequest } from './decode'

const host = decodeHost((reply, transfer) => self.postMessage(reply, { transfer }))

self.onmessage = (event: MessageEvent<DecodeRequest>) => host(event.data)
