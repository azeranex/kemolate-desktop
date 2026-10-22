/**
 * Cleaning blocks an agent changed — asked of the window, which is the only
 * place the cleaner runs. Desktop.
 *
 * A repair is made for one block's box and is the block's: a join makes a new
 * balloon nothing has cleaned, and a cut deletes the block whose repair covered
 * the parts (the cascade takes it with the row), so the original lettering is
 * back under both. The window cleans a block when somebody presses Clean; an
 * agent has no button, so `join_blocks` and `split_block` ask for it here — the
 * window's own `cleanBlock` per block, which reuses a cached repair of the same
 * box and runs the model only for what is new. Errand as `fits.ts` runs one.
 *
 * Never a refusal of the tool that asked. The blocks are joined or cut either
 * way; whether they could be cleaned — no chapter open, no cleaner chosen, a
 * block the cleaner found nothing in — is said beside the answer, with what to do.
 */
import { begin, holders, tell } from './errand'
import { createError, HttpError } from './errors'

import type { SwarmServerMessage } from './swarm'

/** What the window says it cleaned. */
export interface CleanReport {
  ok: boolean
  /** Blocks, by row, with a repair drawn now. */
  cleaned?: number[]
  /** Blocks it could not clean, and why. */
  skipped?: { blockId: number, why: string }[]
  error?: string
}

/** What a tool says beside its answer. */
export type Cleaning =
  | { cleaned: number[], skipped?: { blockId: number, why: string }[] }
  | { cleaned: false, why: string }

/** How long the asker waits: the window waits for the new blocks to arrive, and a cold cleaner loads its model. */
const TIMEOUT = 120_000

export async function requestClean (publicId: string, hash: string, blockIds: number[]): Promise<CleanReport> {
  const [peer] = holders(publicId, hash)

  if (!peer) return { ok: false, error: 'Kemolate does not have this chapter open.' }

  const { request, waiting } = begin<CleanReport>(publicId, TIMEOUT, () => createError({
    statusCode: 504,
    statusMessage: 'Kemolate did not finish cleaning in time.',
  }))

  tell([peer], JSON.stringify({ type: 'clean', request, hash, blockIds } satisfies SwarmServerMessage))

  return waiting
}

/** Clean what a join or a cut made, and say how it went — see the header. */
export async function cleanAfter (publicId: string, hash: string | null, blockIds: number[]): Promise<Cleaning> {
  const later = 'Ask the user to open the chapter in Kemolate and press Clean page (Detect panel) on this page.'

  if (!hash) return { cleaned: false, why: `This page has not been hashed yet. ${later}` }

  try {
    const report = await requestClean(publicId, hash, blockIds)

    if (!report.ok) return { cleaned: false, why: `${report.error ?? 'Kemolate could not clean.'} ${later}` }

    return { cleaned: report.cleaned ?? [], ...(report.skipped?.length ? { skipped: report.skipped } : {}) }
  } catch (thrown) {
    const why = thrown instanceof HttpError ? thrown.statusMessage : thrown instanceof Error ? thrown.message : String(thrown)

    return { cleaned: false, why: `${why} ${later}` }
  }
}
