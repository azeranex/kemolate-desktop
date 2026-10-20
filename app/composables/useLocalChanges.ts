/**
 * A local workspace's other tabs, told what changed.
 *
 * A cloud workspace hears about other tabs' edits through the swarm — the server
 * relays a change notice to every connection in the room (see `onSwarmChange`).
 * A local workspace has no room: it never joins the swarm, because joining needs
 * a ticket for a workspace the server knows. So two tabs on one local chapter
 * each read the shared browser storage once, on opening, and then drifted apart
 * — a term learned in one tab was invisible in the other until a reload, and the
 * next write from the stale tab put the old list back.
 *
 * `BroadcastChannel` is the browser's own messaging between same-origin tabs,
 * and a local workspace's tabs are exactly those. Every tab reads and writes the
 * same storage; this only says "read again". It carries the workspace and what
 * kind of thing changed and nothing else, for the reason `SwarmChange` carries
 * only a scope: the lists are small, and a re-read cannot disagree with storage.
 *
 * Decided 2026-09-23: a local workspace syncs between its own tabs this way
 * rather than over the WebRTC swarm, which would need a signalling path for
 * workspaces the server has never heard of and would still only ever reach this
 * browser's tabs.
 */

/**
 * What changed, as far as another tab needs to know.
 *
 * `blocks` and `layers` name a page by its scan's hash and `paint` a surface by
 * its stroke-log key, in `key`: each is one page's list, written whole, and a
 * tab that went on holding the old one wrote it back over the new one the next
 * time anything on that page changed — a reading corrected in one tab undone by
 * a keystroke in the other. The glossary and the cast are one list each and
 * carry no key.
 */
export type LocalScope = 'glossary' | 'cast' | 'blocks' | 'layers' | 'paint'

const SCOPES: readonly LocalScope[] = ['glossary', 'cast', 'blocks', 'layers', 'paint']

type LocalListener = (workspace: string, scope: LocalScope, key?: string) => void

const listeners = new Set<LocalListener>()

let channel: BroadcastChannel | null = null

/** The one channel, opened on first use — and never on the server. */
function open (): BroadcastChannel | null {
  if (!import.meta.client || typeof BroadcastChannel === 'undefined') return null

  if (!channel) {
    channel = new BroadcastChannel('kemolate-local')
    channel.onmessage = (event: MessageEvent<{ workspace?: unknown, scope?: unknown, key?: unknown }>) => {
      const { workspace, scope, key } = event.data ?? {}

      if (typeof workspace !== 'string' || !SCOPES.includes(scope as LocalScope)) return

      for (const listener of listeners) listener(workspace, scope as LocalScope, typeof key === 'string' ? key : undefined)
    }
  }

  return channel
}

/**
 * Tell this browser's other tabs that a local workspace's `scope` changed.
 *
 * Not heard by the tab that says it — a `BroadcastChannel` never delivers to its
 * own sender — which is right: that tab already has what it wrote.
 */
export function announceLocal (workspace: string, scope: LocalScope, key?: string): void {
  if (!workspace) return

  open()?.postMessage(key ? { workspace, scope, key } : { workspace, scope })
}

/** Hear about other tabs' changes, for as long as the caller's scope lives. */
export function onLocalChange (listener: LocalListener): () => void {
  open()
  listeners.add(listener)

  const off = () => listeners.delete(listener)

  if (getCurrentScope()) onScopeDispose(off)

  return off
}
