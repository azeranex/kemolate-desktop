/**
 * A cloud workspace's record of its pages — a stand-in, because the desktop app
 * has no cloud.
 *
 * In the web build `useShared` holds the server's copy of a shared workspace
 * (`shared`) and keeps the open chapter and it agreeing. Every caller already
 * treats `shared` being `null` as "this is a local workspace" and steps around
 * the server: `push` returns early, `pageRowOf` finds no row, `forgetPage` has
 * nothing to forget, `asking` is never raised, and `setTarget`/`setDirection`
 * — which record a choice on the server — have no server to record it on (the
 * local half of each is kept by its own composable). So that is all this is:
 * the web build's answers for a local workspace, in the web build's shape, so
 * `useLibrary`, `useOcr` and the rest are carried across unchanged.
 *
 * `pathOfPage` and `rowOfPage` are pure and are the web build's, verbatim.
 */
import type { ComicPage } from '~/composables/useComic'
import type { WorkspaceRole } from '#shared/utils/roles'

/** The parts of a shared workspace's page rows that the app reads. */
export interface RemotePage {
  id: number
  uid: string | null
  path: string
  hash: string | null
}

/** The parts of a shared workspace that the app reads. */
export interface SharedWorkspace {
  role: WorkspaceRole
  workspace: {
    publicId: string
    name: string
    direction: 'ltr' | 'rtl'
    targetLocale: string | null
  }
  pages: RemotePage[]
}

/**
 * The path a page is filed under, which is what its local id carries — unless
 * the page came from the workspace rather than from a folder, in which case it
 * was told, and being told beats being inferred. See `ComicPage.path`.
 */
export const pathOfPage = (page: ComicPage) =>
  page.path ?? (page.id.startsWith('scan:') ? page.id.slice('scan:'.length) : page.name)

/**
 * Which row an open page is — the one answer, used everywhere it is asked.
 *
 * By `uid` first, because that is the page saying who it is and cannot be two
 * pages at once. By hash second, but *only where the hash picks out one row*:
 * two blank pages are byte-identical, and a hash shared by two rows names
 * neither. By path last, for a page whose bytes have not been read yet.
 */
export function rowOfPage (rows: RemotePage[], page: ComicPage): RemotePage | undefined {
  if (!rows.length) return undefined

  if (page.uid) {
    const named = rows.find((row) => row.uid === page.uid)

    if (named) return named
  }

  const hash = page.scan?.hash

  if (hash) {
    const alike = rows.filter((row) => row.hash === hash)

    if (alike.length === 1) return alike[0]
  }

  return rows.find((row) => row.path === pathOfPage(page))
}

export function useShared () {
  const shared = useState<SharedWorkspace | null>('shared-workspace', () => null)
  const asking = useState('shared-asking', () => false)

  return {
    shared,
    asking,
    push: async (_list?: ComicPage[]) => {},
    // Tell the server what the chapter is made of — editors of a shared
    // workspace only; returns at once without one, as the web build's does.
    syncPages: async () => {},
    pageRowOf: (_target: ComicPage): number | null => null,
    forgetPage: (_rowId: number) => {},
    setTarget: async (_locale: string) => {},
    setDirection: async (_direction: 'ltr' | 'rtl') => {},
  }
}
