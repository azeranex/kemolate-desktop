/**
 * A workspace kept in this window's storage, moved into the app's database —
 * desktop only, and without being asked.
 *
 * Until 2026-10-21 the desktop kept everything a workspace had in IndexedDB,
 * and Chromium deletes a corrupt IndexedDB and starts empty: a 114-page
 * chapter's reading and translation went that way. The work now lives in
 * `<profile>/kemolate.db` (`electron/database.ts`), and a workspace made since
 * starts there. One made before is still in IndexedDB, and this moves it the
 * first time it is opened — there is no reason to leave somebody's work where
 * it can be lost, and nothing to ask them.
 *
 * The web build's `toCloud` does most of it: the record, the page list, every
 * page's blocks and translations, the glossary and the cast, and (through
 * `useBlockSync.adopt`) each block's mask corrections. What it leaves to be
 * carried "as each page is shown" is two things a desktop keeps for good in
 * IndexedDB, and so must be carried now, before the storage they are in can be
 * lost — every page's **layer stack** (`useLayerCache`), and every page's
 * **retouching and sheet strokes** (`usePaintCache`). The stacks are read
 * before the record exists, because the moment it does `useLayerSync` starts
 * reading the database's (still empty) rows over the page on screen; every page
 * is also claimed (`useLayerClaims`), so a page shown meanwhile sends its stack
 * rather than taking the default.
 *
 * The IndexedDB copy is left where it is. Nothing reads it once the workspace
 * has a record, and it is the last thing standing if the move went wrong.
 */
import type { PaintDestination } from '~/composables/usePaintSync'

import { layerDrafts, useLayerClaims } from '~/composables/useLayerSync'
import { usePaintSync } from '~/composables/usePaintSync'

/** Workspaces moved this session — a second open does not move one again. */
const moved = new Set<string>()

let moving = false

/** Every move forgotten — for tests, which share this module across cases. */
export function forgetMoves () {
  moved.clear()
  moving = false
}

/** Whether a stack holds a row with this uid, at any depth. */
function holds (stack: StackLayer[], uid: string): boolean {
  return stack.some((layer) => layer.id === uid || holds(layer.children ?? [], uid))
}

export function useMoveIn () {
  const route = useRoute()
  const { open, pages } = useComic()
  const { shared, pageRowOf } = useShared()
  const { keeping, toCloud } = useWorkspaceName()
  const claims = useLayerClaims()
  const paint = usePaintCache()

  /**
   * Move the open workspace in, if it is still this window's and ready to go:
   * open, and every page with a scan hashed, since everything kept is filed by
   * hash. Answers whether a move happened. Safe to call on every pass of the
   * restore chain — see the workspace page.
   */
  async function moveIn (): Promise<boolean> {
    const workspace = String(route.params.workspaceId ?? '')

    if (!workspace || moving || moved.has(workspace) || keeping.value !== 'local') return false
    if (!open.value || !pages.value.length || pages.value.some((page) => page.scan && !page.scan.hash)) return false

    moving = true

    try {
      // Before the record exists — see the header.
      const stacks = new Map(pages.value.map((page) => [page.id, page.stack]))

      claims.value = [...new Set([...claims.value, ...pages.value.map((page) => page.id)])]

      if (!await toCloud() || !shared.value) {
        toast.error('This chapter could not be moved into Kemolate’s database', {
          description: 'It is still kept where it was. Opening it again tries once more.',
        })

        return false
      }

      moved.add(workspace)

      // Every page's stack, not only the one on screen.
      for (const page of pages.value) {
        const row = pageRowOf(page)
        const stack = stacks.get(page.id)

        if (!row || !stack) continue

        await $fetch(`/api/workspaces/${workspace}/layers`, {
          method: 'PUT',
          body: { pageId: row, layers: layerDrafts(stack) },
        }).catch((error: unknown) => { console.warn('[kemolate] a layer stack was not moved:', error) })
      }

      // And every page's strokes. The paint sync sends a log once it is told
      // where it goes, and lets the local copy go only once the database has it.
      const sync = usePaintSync()

      for (const page of pages.value) {
        const hash = page.scan?.hash
        const row = pageRowOf(page)
        const stack = stacks.get(page.id) ?? []

        if (!hash || !row) continue

        const prefix = `paint:${hash}:`

        for (const key of await idb.keys(prefix).catch(() => [] as string[])) {
          const surface = key.slice(prefix.length)

          // Mask corrections go with their blocks (`useMaskEdits.carryLocal`);
          // a sheet's strokes need the sheet, and a sheet that is gone has none.
          if (surface.startsWith('mask-')) continue

          const sheet = surface !== 'bg'

          if (sheet && !holds(stack, surface)) continue

          const store = `${hash}:${surface}`

          if (!(await paint.load(store)).length) continue

          sync.upload({
            workspace,
            store,
            pageId: row,
            key: surface,
            plate: sheet ? null : 'clean',
            layer: sheet ? surface : null,
          } satisfies PaintDestination)
        }
      }

      toast.success('Moved into Kemolate’s database', {
        description: 'This chapter’s work is now kept in the app’s own database and backed up — see Settings › Your data.',
      })

      return true
    } finally {
      moving = false
    }
  }

  return { moveIn }
}
