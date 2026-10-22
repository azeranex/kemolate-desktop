/**
 * How each line on a page is lettered — asked of the window, which is the only
 * place it is known. Desktop.
 *
 * A line's size is not stored. Automatic lettering is measured in the window,
 * in the face it is drawn in, against the frame it is drawn in (`useLetteringFit`),
 * and kept in that window's own storage. So an agent reviewing lettering cannot
 * read it from the database; it has to ask the window that drew it — the same
 * errand `relay.ts` and `reading.ts` run (`errand.ts`), answered through
 * `/api/workspaces/:id/fits/:request` (`electron/data.ts`).
 *
 * One holder, as `reading.ts` asks one: a fit is the window's own measurement,
 * and there is only ever one window.
 */
import { begin, holders, noHolder, tell } from './errand'
import { createError } from './errors'

import type { SwarmServerMessage } from './swarm'

/** One line's lettering, as the window measured it. */
export interface LineFit {
  /** The block's row. */
  blockId: number
  /** The size it is set at, in the scan's pixels. */
  size: number
  /** What decided that size: fitted to its frame, held to the chapter's standard, or chosen for it. */
  set: 'auto' | 'standard' | 'chosen'
  /** The size it would take filling its frame with nothing holding it, or null where unmeasured. */
  capacity: number | null
  /** Does not fit even at the smallest size allowed: set there, clipped, and flagged. */
  over: boolean
  /** Set a hair tighter than its face's own spacing to go. */
  tight: boolean
  /** A long word broken to go. */
  hyphens: boolean
  /** The multiple of the standard it is aimed at: 1 unless held to a standard and emphasised. */
  emphasis?: number
  /** How much bigger than the chapter's ordinary lettering the original's characters are, as an emphasis (1 for ordinary). */
  measuredEmphasis?: number
  /** The emphasis was chosen for the line rather than measured. */
  emphasisChosen?: boolean
  /** Each line as drawn, a word broken across two ending in "-". */
  drawn?: string[]
  /** How many of those breaks the wrap made, rather than a newline in the text. */
  wrapped?: number
  /** How many words were broken across lines. */
  broken?: number
  /** The text carries line breaks somebody typed. */
  byHand?: boolean
  /** Broken by hand, and wrapped again because no size kept those breaks. */
  rewrapped?: boolean
}

/** What the window says about a page. */
export interface FitReport {
  ok: boolean
  /** The chapter's standard size, or null where it has none. */
  standard?: number | null
  lines?: LineFit[]
  error?: string
}

/** How long the asker waits: fitting a page lays every line out a few times, and a cold face has to load first. */
const TIMEOUT = 30_000

export async function requestFits (publicId: string, hash: string, chapter: string): Promise<FitReport> {
  const [peer] = holders(publicId, hash)

  if (!peer) noHolder(chapter)

  const { request, waiting } = begin<FitReport>(publicId, TIMEOUT, () => createError({
    statusCode: 504,
    statusMessage: 'Kemolate did not measure the page\'s lettering in time.',
  }))

  tell([peer], JSON.stringify({ type: 'fits', request, hash } satisfies SwarmServerMessage))

  return waiting
}
