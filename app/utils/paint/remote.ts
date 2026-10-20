/**
 * The server's half of a page's paint, as this browser holds it — and the
 * rules for folding each answer into what is already held.
 *
 * Pure functions over plain data, and deliberately apart from the composable
 * that fetches: every rule here is a way of not losing a mark or not drawing
 * one twice, and each of them should be checkable without standing up a
 * server, a socket and a canvas to watch it happen.
 *
 * ## Why a cursor, and why this one
 *
 * A collaborator's stroke used to send every other tab back for the surface's
 * whole log — `since: 0`, because a retraction flips a row in place and rows
 * "since" anything can never say a mark left. K strokes on a page were K whole
 * reads, each of everything so far: quadratic in the length of the log. Now a
 * notice reads only rows past a cursor, with the page's retractions sent whole
 * as ids (see `paint.onPage`), and the cost of a stroke landing is that stroke.
 *
 * The cursor is the answer's `horizon` — the newest row on the page when it
 * was read — and not the newest row held. Rows this browser learned of from
 * its own batch can be newer than rows somebody else laid a moment before;
 * a cursor moved past those would skip them for good.
 */
import type { Stroke } from '~~/server/database'

/** One surface of a page, as the server answers for it. */
export interface RemoteSurface {
  id: number
  key: string
  strokes: Stroke[]
  /** Past a cursor only: every row taken back, by id, and how many rows there are. */
  retracted?: number[]
  total?: number
}

/** A page's paint as `GET …/pages/:id/paint` answers — with the stack, when asked for it. */
export interface RemotePagePaint<Layer = unknown> {
  horizon: number
  surfaces: RemoteSurface[]
  layers?: Layer[]
}

/** One surface as held: its row id and every mark on it, in paint order. */
export interface SurfaceLog {
  id: number
  rows: readonly Stroke[]
}

/** A page's paint as held, by surface key. */
export interface PageLog {
  /** Every row on the page at or below this is held — the next read's cursor. */
  cursor: number
  surfaces: Readonly<Record<string, SurfaceLog>>
  /**
   * Rows this browser's own batches landed that no read has spoken for yet.
   *
   * What lets a read that was already in the air when a batch landed be
   * applied without taking the batch's strokes off the page: a row here newer
   * than the read's horizon is kept, anything else the read does not mention
   * is not on the server and goes.
   */
  landed: readonly number[]
}

/** The order every machine draws a surface in: `seq`, then `clientId`. */
export function paintOrder<Row extends { seq: number, clientId: string }> (rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => a.seq - b.seq || (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0))
}

/**
 * Fold a read into what is held.
 *
 * `after` is the cursor the read was asked with — nought for a whole page.
 * Rows held at or below it are the ones the read vouches for without sending;
 * rows above the read's horizon are kept only if they are this browser's own
 * and landed since. Everything else comes from the answer.
 *
 * `agrees` is false when a read past a cursor does not add up — the rows held
 * for a surface are not as many as the server says it has — and the caller
 * then reads the page whole. It should never happen; it is here so that if the
 * reasoning above is ever wrong, the page heals on the next notice rather than
 * showing a stale surface until somebody reloads.
 */
export function mergeRead (held: PageLog | undefined, answer: RemotePagePaint, after: number): { log: PageLog, agrees: boolean } {
  const horizon = answer.horizon
  const landed = new Set(held?.landed ?? [])
  const newer = (row: Stroke) => row.id > horizon && landed.has(row.id)

  const surfaces: Record<string, SurfaceLog> = {}
  let agrees = true

  for (const surface of answer.surfaces) {
    const before = held?.surfaces[surface.key]
    const rows = new Map<number, Stroke>()

    // The same surface, and not a new one made under an old key — a sheet
    // deleted and another added in its place is a different set of marks.
    if (before?.id === surface.id) {
      for (const row of before.rows) if ((after && row.id <= after) || newer(row)) rows.set(row.id, row)
    }

    for (const row of surface.strokes) rows.set(row.id, row)

    if (surface.retracted) {
      const off = new Set(surface.retracted)

      for (const [id, row] of rows) {
        if (id <= horizon && row.retracted !== off.has(id)) rows.set(id, { ...row, retracted: off.has(id) })
      }

      if (surface.total !== undefined && [...rows.keys()].filter((id) => id <= horizon).length !== surface.total) agrees = false
    }

    surfaces[surface.key] = { id: surface.id, rows: paintOrder([...rows.values()]) }
  }

  // A surface the read did not mention is gone — unless what it holds is this
  // browser's own and newer than the read, which is a surface its first batch
  // made while the read was in the air.
  for (const [key, surface] of Object.entries(held?.surfaces ?? {})) {
    if (surfaces[key]) continue

    const kept = surface.rows.filter(newer)

    if (kept.length) surfaces[key] = { id: surface.id, rows: kept }
  }

  return {
    log: { cursor: horizon, surfaces, landed: [...landed].filter((id) => id > horizon) },
    agrees,
  }
}

/**
 * This browser's own marks, as the server filed them, added to what is held —
 * the moment between a batch landing and the next read.
 *
 * Kept apart from reads because they are not one: a batch says nothing about
 * anybody else's marks, so it cannot move the cursor, only add rows and say
 * which surface they are on (the first stroke on a surface is what makes it).
 */
export function mergeLanded (held: PageLog | undefined, key: string, surfaceId: number, rows: readonly Stroke[]): PageLog {
  const before = held?.surfaces[key]
  const mine = new Map<number, Stroke>(before?.id === surfaceId ? before.rows.map((row) => [row.id, row]) : [])

  for (const row of rows) mine.set(row.id, row)

  return {
    cursor: held?.cursor ?? 0,
    surfaces: { ...held?.surfaces, [key]: { id: surfaceId, rows: paintOrder([...mine.values()]) } },
    landed: [...new Set([...(held?.landed ?? []), ...rows.map((row) => row.id)])],
  }
}

/**
 * The server's marks and this browser's, as one log to draw — each mark once.
 *
 * Merged on `(clientId, seq)`, which is what a mark *is*. The two halves meet
 * while a batch is in the air or a read lands before its answer: the same
 * stroke in both, once as the server filed it and once as this browser keeps
 * it. Laid twice, a soft brush darkens where it overlaps itself. The local copy
 * wins because it is the newer word on the one thing that can differ — whether
 * the mark was taken back before the server heard.
 */
export function mergeLogs<Row extends { seq: number, clientId: string }> (theirs: readonly Row[], mine: readonly Row[]): Row[] {
  if (!mine.length) return [...theirs]

  const local = new Set(mine.map((row) => `${row.clientId}:${row.seq}`))

  return paintOrder([...theirs.filter((row) => !local.has(`${row.clientId}:${row.seq}`)), ...mine])
}
