/**
 * A line's history, waiting for somewhere to put it.
 *
 * The awkward corner of importing a project, and it is worth setting out why it
 * needs a store of its own rather than being done during the import.
 *
 * A revision hangs off a *translation*, which hangs off a **block row on the
 * server**. An import has neither: it has just put pages on screen, and the
 * blocks on them are the client's own until `useBlockSync` creates rows for
 * them — which it does one page at a time, for the page being looked at,
 * because that is what the whole sync layer is built around. So at the moment
 * the archive is unpacked there is nothing anywhere to attach a history to, and
 * waiting for one would mean blocking the import on the reader turning pages.
 *
 * So the history is parked here, per page, and put back at the first moment it
 * *can* be: `useTranslationSync` sends a page's translations, and the same
 * settle then flushes whatever was parked for that page. By then the blocks
 * have rows and the translations exist, which are exactly the two things a
 * revision needs.
 *
 * ## Keyed by block index, not by anything on the block
 *
 * The manifest keys a page's history by each block's index in the page — see
 * `ProjectPage.revisions` — because a block has no name that survives being
 * exported. That index is still the key here, and it is resolved against the
 * live blocks at flush time, when they finally have rows.
 *
 * The consequence, stated rather than discovered: this is only correct while
 * the page's blocks are in the order they were imported in. That holds for the
 * gap this is meant to cover — a page goes from imported to synced without
 * anybody having touched it — and stops holding if somebody sorts or deletes
 * blocks first. What then lands is a history against the wrong balloon, which
 * is why the flush is a *one-shot on arrival* rather than something that waits
 * around: the record is taken as soon as it is used, and the longer it sits the
 * less it is worth. Nothing re-parks one.
 *
 * ## In IndexedDB rather than in memory
 *
 * A forty-page chapter is not read in one sitting, and the pages whose
 * translations have not synced yet are most of it. Holding this in a ref would
 * lose the history of every page the reader had not reached before closing the
 * tab — which is the majority of the chapter, and the part they are least
 * likely to notice missing.
 */
import type { ProjectLine } from '~/utils/project'

import { idbKey, idbPrefix } from '~/utils/idbKeys'

/** What is written per page. Versioned so a later shape can be recognised. */
interface ParkedHistory {
  v: 1
  /** By the block's index in the page, as the manifest keys it. */
  blocks: Record<number, ProjectLine[]>
}

const VERSION = 1

/**
 * The name a page's parked history is filed under.
 *
 * Scoped to the workspace for the reason `useBlockCache` is: this is a set of
 * decisions somebody made inside one piece of work, not a fact about the bytes
 * of a page. Dropping the same file into a second workspace must not resurrect
 * the first one's history there.
 */
const keyOf = (workspace: string, pageId: string) => idbKey.history(workspace, pageId)

/** Put a page's history aside until there is something to attach it to. */
export async function parkHistory (
  workspace: string,
  pageId: string,
  blocks: Record<number, ProjectLine[]>,
): Promise<void> {
  if (!Object.keys(blocks).length) return

  await idb.set(keyOf(workspace, pageId), { v: VERSION, blocks } satisfies ParkedHistory).catch(() => {
    // Not worth failing an import over. What is lost is the history behind the
    // words, and every word itself is already on the page.
    console.warn('[kemolate] imported history not kept for', pageId)
  })
}

/** Whatever is waiting for this page, or nothing. */
export async function takeHistory (
  workspace: string,
  pageId: string,
): Promise<Record<number, ProjectLine[]> | null> {
  const held = await idb.get<ParkedHistory>(keyOf(workspace, pageId)).catch(() => null)

  return held?.v === VERSION && Object.keys(held.blocks).length ? held.blocks : null
}

/**
 * Let go of it, whether or not every line found a home.
 *
 * Dropped on any answer from the server rather than only on a complete one, and
 * that is a decision about which failure to prefer. The server skips a line
 * that already has revisions — permanently true, and no amount of retrying
 * changes it — so a record kept until everything landed would be kept for ever
 * on exactly the chapters somebody is working on. A request that never got
 * there at all is the case worth retrying, and the caller keeps the record for
 * that one.
 */
export async function dropHistory (workspace: string, pageId: string): Promise<void> {
  await idb.del(keyOf(workspace, pageId)).catch(() => {})
}

/** Everything still parked for a workspace — for a reset to clear. */
export async function forgetHistory (workspace: string): Promise<void> {
  const keys = await idb.keys(idbPrefix.histories(workspace)).catch(() => [])

  for (const key of keys) await idb.del(key).catch(() => {})
}
