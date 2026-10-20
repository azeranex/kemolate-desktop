/**
 * A cloud workspace's blocks, kept in step with the server — a stand-in,
 * because the desktop app has no server.
 *
 * In the web build `useBlockSync` sends every block edit up as a row and reads
 * the server's answers back. A local workspace keeps its blocks in this
 * machine's store instead (`useBlockCache`), and every place the web build's
 * files reach in here is on the branch for a page with a server row — which no
 * page here has (`useShared().pageRowOf` is always `null`). What they import is
 * kept, in its shape, so they are carried across unchanged:
 *
 * - `agreed` — note that a row the server sent is what this browser holds, so
 *   it is not sent back. Nothing to note.
 * - `rewriting` — hold a page's rows while a whole-page write is out. Never
 *   called without a row; answers as a write that changed nothing.
 * - `uploadChapterBlocks` — give every row-less block a row, for a chapter
 *   becoming a cloud workspace or an import into one. Called only under a
 *   shared workspace; there are no rows to give.
 */
import type { ComicPage } from '~/composables/useComic'

export function agreed (_row: number, _patch: unknown) {}

export function rewriting (_epoch: number, _here: ComicPage) {
  return {
    written (_now: ComicPage) {},
    refused (_now: ComicPage) {},
    end () {},
  }
}

/**
 * Note which rows a page holds once a write has settled, so a later diff does
 * not read them as new. Tracks server rows, and a local page has none.
 */
export function settled (_epoch: number, _pageId: string, _rows: number[]) {}

export function uploadChapterBlocks (): Promise<void> {
  return Promise.resolve()
}

/** Forget which rows were agreed, on leaving a workspace (`useWorkspaceReset`). Nothing was. */
export function forgetAgreed () {}
