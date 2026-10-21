/**
 * Getting a mark to the server and back, for everything that makes one.
 *
 * Two tools draw on this app's surfaces and they render nothing alike: the
 * paint tools composite anti-aliased colour through `PaintSession`, the mask
 * brush lays hard binary coverage that the repair rasterises at whatever scale
 * its tile needs. That difference is real and this file does not touch it.
 *
 * What they had no business doing twice is the part in between — which surface,
 * which layer row, the POST, the retraction, the read-back. Both wrote their own
 * and the copies drifted, which is not a tidiness complaint but an account of
 * where the bugs were:
 *
 * - the surfaces endpoint's key pattern was written for one writer's keys and
 *   refused the other's `paint:<id>` outright, so paint on a blank layer had
 *   never once been saved — silently, because the local cache kept showing it;
 * - `plate` defaulting to `clean` sent every blank sheet's marks to the cleaned
 *   plate's row under a key nothing would look for again;
 * - each carried a private copy of "which row is this page", one of them still
 *   matching on a name, which files a stroke against the wrong page;
 * - only one of them ever learned to broadcast a gesture, so mask brushing
 *   still has no live preview.
 *
 * **The paint tools have since gone their own way.** Their strokes go up in
 * batches through `usePaintSync`, which needs a queue this file's one mark per
 * request cannot give, and a page's paint arrives in its one read
 * (`pages/:id/paint`). What is left here is the mask brush's path — and
 * `retractStroke`, which undo uses for a mask correction — so the list above is
 * history now, kept for what it cost.
 *
 * Plain functions rather than a composable, deliberately. `useMaskEdits` holds
 * many surfaces at once — one per block, resolved lazily and cached — while a
 * paint canvas holds exactly one for its own lifetime. A composable would fit
 * the second and fight the first.
 *
 * ## Not here: `seq`
 *
 * The two clients disagree about what a `seq` is — a counter past the highest
 * seen, or a timestamp — and both are writing the same column. It wants
 * settling, and not in the same change as this: `seq` is the order strokes
 * composite in, so changing how it is chosen reorders paint that already
 * exists. See `strokesOn`, which is where a reader would want to know.
 */
import type { PlateId } from '#shared/utils/layers'
import type { Stroke, StrokeParams } from '~~/server/database'

/** A mark on its way to a surface, in the shape the endpoint takes. */
export interface StrokeDraft {
  /** The client's own clock, not a timestamp — see the note above. */
  seq: number
  clientId: string
  tool: string
  composite?: string | null
  params: StrokeParams
  /** Flat `x y` pairs in page pixels. */
  points: number[]
  x: number
  y: number
  w: number
  h: number
}

/** Which layer row a surface hangs off. */
export interface StrokeLayer {
  /**
   * A stack row's id, for anything that is not a plate — a blank sheet.
   *
   * Resolved by the caller, which already holds the stack's row ids and is
   * inside a component where reading them is reactive. Asked about *first*:
   * `plate` carries a default in `CanvasPaint` and the board gives a sheet only
   * its surface, so "is there a plate" answered yes for every blank layer, and
   * each one filed its marks under the cleaned plate's row.
   */
  layerId?: number | null
  /** One of the five a page is made of — its row is made on demand. */
  plate?: PlateId | null
}

/**
 * The surface a mark belongs on, made if it is not there yet.
 *
 * Null rather than a throw for the ordinary refusals — a viewer, a signed-out
 * browser, a workspace nobody has claimed. Every caller's answer to that is the
 * same: keep the mark locally and carry on, which is what this app does
 * everywhere else.
 */
export async function resolveSurface (
  workspace: string,
  where: { pageId: number, layer: StrokeLayer, key: string, blockId?: number | null },
): Promise<number | null> {
  try {
    const layerId = where.layer.layerId
      ?? (where.layer.plate
        ? await $fetch<{ id: number }>(`/api/workspaces/${workspace}/layers/ensure`, {
            method: 'POST',
            body: { plate: where.layer.plate, pageId: where.pageId },
          }).then((layer) => layer.id)
        : null)

    // A stack that has not synced yet has no row for this sheet. Waiting is
    // right — the caller asks again when the id lands.
    if (!layerId) return null

    const surface = await $fetch<{ id: number }>(`/api/workspaces/${workspace}/surfaces`, {
      method: 'POST',
      body: { pageId: where.pageId, layerId, key: where.key, blockId: where.blockId ?? null },
    })

    return surface.id
  } catch (error) {
    // In the console regardless: this exact catch once swallowed a 400 for a
    // whole debugging session, and a surface that fails silently looks like a
    // brush that does not work.
    console.warn('[kemolate] surface unavailable:', error)

    return null
  }
}

/**
 * Every mark on a surface, live and retracted both.
 *
 * `since: 0` every time rather than since the highest seq held, which looks
 * wasteful and is not: a retraction does not add a row, it flips one already in
 * the log, so an incremental read would never see a mark leave. It is also the
 * only read that stays correct when a peer's stroke has to be ordered *before*
 * one already here — which is what `seq` decides, and why the two clients
 * choosing it differently is worth settling.
 */
export async function strokesOn (workspace: string, surfaceId: number): Promise<Stroke[] | null> {
  return $fetch<Stroke[]>(`/api/workspaces/${workspace}/surfaces/${surfaceId}/strokes`, {
    query: { since: 0 },
  }).catch(() => null)
}

/**
 * Lay a mark down on the server.
 *
 * Stamped with this tab's peer id so the change notice it raises skips the tab
 * that made it — the mark is already on that canvas. Null for a write that did
 * not land, which every caller treats the same way: the stroke is on the page
 * either way, and a failed upload is not a reason to take it off.
 */
export async function appendStroke (
  workspace: string,
  surfaceId: number,
  draft: StrokeDraft,
): Promise<Stroke | null> {
  return $fetch<Stroke | null>(`/api/workspaces/${workspace}/surfaces/${surfaceId}/strokes`, {
    method: 'POST',
    body: draft,
    headers: peerHeader(workspace),
  }).catch((error: unknown) => {
    console.warn('[kemolate] stroke not shared:', error)

    return null
  })
}

/**
 * Take a mark back, or put it back — by flipping the row, never by deleting it.
 *
 * A deleted row cannot be reconciled with a peer who never saw it go, and redo
 * would have nothing to bring back. The same call serves undo, redo and the
 * eraser, which is the point: there is one way a mark leaves the page.
 */
export async function retractStroke (
  workspace: string,
  strokeId: number,
  retracted = true,
): Promise<boolean> {
  return $fetch(`/api/workspaces/${workspace}/strokes/${strokeId}`, {
    method: 'PATCH',
    body: { retracted },
    headers: peerHeader(workspace),
  }).then(() => true).catch((error: unknown) => {
    console.warn('[kemolate] stroke not retracted:', error)

    return false
  })
}
