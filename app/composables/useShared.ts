/**
 * A cloud workspace's record of its pages — a stand-in, because the desktop app
 * has no cloud.
 *
 * In the web build `useShared` holds the server's copy of a shared workspace
 * (`shared`) and keeps the open chapter and it agreeing. Every caller already
 * treats `shared` being `null` as "this is a local workspace" and steps around
 * the server: `push` returns early, `pageRowOf` finds no row, `forgetPage` has
 * nothing to forget, `asking` is never raised. So that is all this is — the web
 * build's answers for a local workspace, kept in the web build's shape, so
 * `useLibrary` and the rest are carried across unchanged.
 *
 * `pathOfPage` is pure and is the web build's, verbatim.
 */
import type { ComicPage } from '~/composables/useComic'

/**
 * The path a page is filed under, which is what its local id carries — unless
 * the page came from the workspace rather than from a folder, in which case it
 * was told, and being told beats being inferred. See `ComicPage.path`.
 */
export const pathOfPage = (page: ComicPage) =>
  page.path ?? (page.id.startsWith('scan:') ? page.id.slice('scan:'.length) : page.name)

/** The parts of a shared workspace's page rows that the app reads. */
interface RemotePage {
  id: number
  uid: string | null
  path: string
  hash: string | null
}

interface SharedWorkspace {
  pages: RemotePage[]
}

export function useShared () {
  const shared = useState<SharedWorkspace | null>('shared-workspace', () => null)
  const asking = useState('shared-asking', () => false)

  return {
    shared,
    asking,
    push: async (_list?: ComicPage[]) => {},
    pageRowOf: (_target: ComicPage): number | null => null,
    forgetPage: (_rowId: number) => {},
  }
}
