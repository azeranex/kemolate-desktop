/**
 * Every page's retouching and sheets, as strokes — out of this browser's cache
 * and, for a shared workspace, off the server — for anything that needs a
 * chapter's paint whole rather than one surface at a time.
 *
 * Two callers: the project file (`useProjectFile.save`), which carries the
 * strokes, and the page export (`usePageExport`), which replays them. It was
 * private to the first; the second needs exactly the same reading, and two
 * readings of one store is how a mark ends up in one and not the other.
 *
 * Both logs, because either may be the only one holding a mark: the local
 * copy is forgotten once a stroke's batch has landed (`usePaintSync`), and a
 * mark made before a workspace was shared, or while it was offline, may be
 * here alone.
 */
import type { LocalStroke } from '~/composables/usePaintCache'
import type { ProjectStroke } from '~/utils/project'

import { idb } from '~/utils/idb'
import { idbPrefix } from '~/utils/idbKeys'

/** What one surface's log looks like on the way out of the local cache. */
interface CachedPaint {
  v: number
  strokes: LocalStroke[]
}

/** What the server answers for a shared workspace's paint — see `paint.everything`. */
interface RemotePaint {
  uid: string
  surfaces: { key: string, strokes: ProjectStroke[] }[]
}

/** A page's paint: every surface's live strokes, in paint order, by surface key. */
export type PagePaint = Record<string, ProjectStroke[]>

/**
 * Every surface this browser has marks for, for one scan.
 *
 * Read out of the store by prefix rather than worked out from the page,
 * because the surfaces a page has been painted on are not derivable from it:
 * a block since deleted, or a sheet from before somebody rearranged the
 * stack, still has marks filed against it. See `idb.keys`.
 */
export async function localPaint (hash: string): Promise<PagePaint> {
  const out: PagePaint = {}
  const keys = await idb.keys(idbPrefix.paint(hash)).catch(() => [])

  for (const key of keys) {
    const held = await idb.get<CachedPaint>(key).catch(() => null)

    if (!held?.strokes?.length) continue

    const surface = key.slice(idbPrefix.paint(hash).length)

    // Retracted marks are dropped rather than carried. A stroke somebody
    // undid is one they took back, and restoring it on the other end would
    // be the app arguing with a decision.
    const laid = held.strokes
      .filter((row) => !row.retracted)
      .map(({ id: _local, ...rest }) => ({ ...rest, retracted: false }))

    if (laid.length) out[surface] = laid
  }

  return out
}

/**
 * The same, from the server, by page uid — for a workspace somebody has
 * shared. `workspace` is null for one that is not, which has nothing there.
 */
export async function remotePaint (workspace: string | null): Promise<Map<string, PagePaint>> {
  const out = new Map<string, PagePaint>()

  if (!workspace) return out

  const answered = await $fetch<RemotePaint[]>(`/api/workspaces/${workspace}/surfaces`)
    .catch(() => null)

  if (!answered) return out

  for (const page of answered) {
    const surfaces: PagePaint = {}

    for (const surface of page.surfaces) surfaces[surface.key] = surface.strokes

    out.set(page.uid, surfaces)
  }

  return out
}

/**
 * One page's paint, from both logs.
 *
 * Merged on `(clientId, seq)`, which is what a mark *is* — the pair the
 * `strokes` table is uniquely indexed on, and the pair that decides paint
 * order on every machine. A stroke that has been uploaded is in both logs
 * under one name, and a naive concatenation would lay it down twice.
 */
export function mergePaint (mine: PagePaint, theirs: PagePaint | undefined): PagePaint {
  if (!theirs) return mine

  const out: PagePaint = {}

  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const seen = new Set<string>()
    const laid: ProjectStroke[] = []

    for (const row of [...(theirs[key] ?? []), ...(mine[key] ?? [])]) {
      const name = `${row.clientId}:${row.seq}`

      if (seen.has(name)) continue

      seen.add(name)
      laid.push(row)
    }

    // Sorted rather than left in the order the two lists happened to
    // concatenate in. `seq` then `clientId` is the order every machine agrees
    // on, and it is what a replay has to see.
    laid.sort((a, b) => a.seq - b.seq || a.clientId.localeCompare(b.clientId))

    if (laid.length) out[key] = laid
  }

  return out
}
