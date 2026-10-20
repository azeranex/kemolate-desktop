/**
 * A cloud workspace's change notices — a stand-in, because the desktop app has
 * no server to send them.
 *
 * The one thing the migrated files import is `agreeArrived`: record that blocks
 * the server just wrote are what this browser holds, so the sync does not send
 * them back. It is only called on the branch for a page with a server row,
 * which no page here has, and there is no sync to tell. A local workspace's
 * other windows hear about changes through `useLocalChanges` instead.
 */
import type { ComicPage } from '~/composables/useComic'

export function agreeArrived (
  _epoch: number,
  _here: ComicPage,
  _scan: { width: number, height: number },
  _locale: string,
  _held: (blockId: string) => boolean = () => false,
) {}
