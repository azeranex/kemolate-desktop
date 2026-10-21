/**
 * The layer stack, kept somewhere other than this tab's memory.
 *
 * ## Desktop: a partial port
 *
 * The web build's file is the wire between a page's stack and the server's
 * `layers` rows, and `useLayerSync()` itself — the watchers that pull and push —
 * has nothing to talk to here: a local workspace's stacks are `useLayerCache`'s,
 * as they are in the web build. What comes across, verbatim, is what the rest
 * of the app reaches *from* this file: `useLayerRows`, `useLayerClaims` (an
 * imported project file stakes its claim through it), `stackOf` and
 * `serverStacks`, which `useProjectFile` calls only under a shared workspace.
 * Left out with `useLayerSync()` are its two imports, `readPaint` and the
 * server's `LayerDraft` type, and its `SETTLE`, which nothing else here needs.
 *
 * The web build's header — why a whole stack at a time, why upsert and never
 * rewrite, why a stack belongs to a page — is about the sync, and is there.
 */
import type { PlacedImage, StackLayer } from '#shared/utils/layers'

/** One row of the stack as the server keeps it. */
interface StoredLayer {
  id: number
  uid: string
  parentId: number | null
  position: number
  label: string
  hint: string | null
  plate: PlateId | null
  visible: boolean
  opacity: number
  locked: boolean
  paint: boolean
  fixed: boolean
  clipped: boolean
  adjust: Adjustment | null
  image: PlacedImage | null
}

/**
 * The row id each layer was filed under, by its uid.
 *
 * Kept because a surface had to name a layer and the canvas only knew the
 * stack's own names. It used to be able to ask `layers/ensure` for one, which
 * works for the five plates and for nothing else: a blank sheet somebody added
 * has no plate, so the ask was a 400 and every mark drawn on it stayed in the
 * tab that drew it, unsaved and unshared.
 *
 * Nothing reads it now. A batch of strokes names a sheet by its uid and the
 * server finds the row (`paint.appendMany`), so the canvas no longer needs the
 * id — and needing it was what made the first marks on a new sheet wait for
 * the stack to come back. Still written, and still cleared on the way out of
 * a workspace, until whoever owns `useWorkspaceReset` takes both out.
 */
export const useLayerRows = () => useState<Record<string, number>>('layer-rows', () => ({}))

/**
 * Pages whose stack came from somewhere with a better claim than the server's —
 * which today means one thing: an imported project file.
 *
 * State of its own, and reached the way `useLayerRows` is, because the claim is
 * made from `useProjectFile` and honoured in `pull`. Calling `useLayerSync`
 * from the importer to reach it would register a second set of its watchers,
 * which is the hazard `useWorkspaceReset` sets out at length.
 *
 * Holds the **client's own page id** rather than a `uid` or a row id, and both
 * alternatives fail for reasons worth writing down. A row id does not exist
 * when the claim has to be made: the pages have only just been put on screen
 * and nothing has synced them. A `uid` is nearly right and is sometimes absent
 * — a project file's uid is dropped when it is not a uuid, and the workspace
 * then mints its own. The local id is the one name that exists before anything
 * has been told about the page and does not change afterwards.
 *
 * A claim is **spent the first time it is honoured**, so this says "the file's
 * stack wins once, on arrival" and not "this page never pulls again". A page
 * turned to next week reads the server's rows like any other.
 */
export const useLayerClaims = () => useState<string[]>('layer-claimed', () => [])

/**
 * A page's stored rows, folded back into the tree the canvas draws.
 *
 * `open` comes from `twirls` where given — the rows do not carry it and should
 * not, see the header — and a group nobody has seen before opens, which is what
 * a group somebody else has just made should do.
 */
export function stackOf (rows: StoredLayer[], twirls: ReadonlyMap<string, boolean> = new Map()): StackLayer[] {
  const under = (parent: number | null): StackLayer[] => rows
    .filter((row) => row.parentId === parent)
    .sort((a, b) => a.position - b.position)
    .map((row) => {
      const children = under(row.id)

      return {
        id: row.uid,
        label: row.label,
        visible: row.visible,
        opacity: row.opacity,
        ...(row.hint ? { hint: row.hint } : {}),
        ...(row.plate ? { plate: row.plate } : {}),
        ...(row.locked ? { locked: true } : {}),
        ...(row.paint ? { paint: true } : {}),
        ...(row.fixed ? { fixed: true } : {}),
        ...(row.clipped ? { clipped: true } : {}),
        ...(row.adjust ? { adjust: row.adjust } : {}),
        ...(row.image ? { image: row.image } : {}),
        ...(children.length ? { children, open: twirls.get(row.uid) ?? true } : {}),
      } satisfies StackLayer
    })

  return under(null)
}

/**
 * Every page's stack as the server keeps it, by the page's own id here — for a
 * workspace carrying all of itself somewhere else. A stack is only read from
 * the server when its page is shown, so the ones in memory are the pages this
 * session looked at, and every other page holds the default it was opened
 * with; moving back to local and exporting both used to write those defaults
 * down as if they were the page's.
 *
 * Null when any page's answer did not arrive: the caller is about to delete the
 * server's copy, or to call this the chapter, and half an answer is not one. A
 * page the server holds no stack for is left out and keeps its own.
 */
export async function serverStacks (
  workspace: string,
  pages: readonly ComicPage[],
  rowOf: (page: ComicPage) => number | null,
): Promise<Map<string, StackLayer[]> | null> {
  const out = new Map<string, StackLayer[]>()

  for (const page of pages) {
    const row = rowOf(page)

    if (!row) continue

    const stored = await $fetch<StoredLayer[]>(`/api/workspaces/${workspace}/layers`, { query: { pageId: row } }).catch(() => null)

    if (!stored) return null
    if (stored.length) out.set(page.id, stackOf(stored))
  }

  return out
}
