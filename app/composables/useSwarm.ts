/**
 * The swarm — a stand-in, because the desktop app shares nothing peer to peer.
 *
 * In the web build this is the WebRTC side of sharing a workspace. The one
 * thing the migrated files ask of it is `peerHeader`, which marks a request to
 * the server as coming from this tab's peer so the server does not echo it
 * back; with no socket for the workspace the web build answers `{}`, and so
 * does this, always.
 */
export function peerHeader (_workspace: string): Record<string, string> {
  return {}
}

/**
 * One room's change notice — the web build's union, from its
 * `server/utils/swarm.ts`, so the listeners that narrow on `scope` type-check
 * as written.
 */
export type SwarmChange =
  | { scope: 'pages' }
  | { scope: 'blocks', pageId: number }
  | { scope: 'translations', pageId: number, locale: string }
  | { scope: 'strokes', surfaceId: number, pageId: number, key: string }
  | { scope: 'layers' }
  | { scope: 'cast' }
  | { scope: 'glossary', locale: string }

/**
 * Hear another window of a shared workspace change something. Nothing is ever
 * heard — a local workspace's windows hear each other through `useLocalChanges`.
 * Returns the unsubscribe, as the web build's does.
 */
export function onSwarmChange (_listener: (room: string, change: SwarmChange) => void): () => void {
  return () => {}
}
