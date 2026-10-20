/**
 * The swarm — a stand-in, because the desktop app shares nothing peer to peer.
 *
 * In the web build this is the WebRTC side of sharing a workspace. The one
 * thing the migrated files ask of it is `peerHeader`, which marks a request to
 * the server as coming from this tab's peer so the server does not echo it
 * back; with no socket for the workspace the web build answers `{}`, and so
 * does this, always. The live-stroke half below is the same: a hand drawing is
 * told to nobody and hears from nobody.
 */
import type { StrokeParams } from '~~/server/database'

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

/**
 * A gesture in progress, sent to the room — the web build's union, from its
 * `server/utils/swarm.ts`, so `useLiveStrokes` narrows on `kind` as written.
 */
export type SwarmLive =
  | {
    kind: 'stroke'
    surfaceId: number
    pageId: number
    key: string
    clientId: string
    seq: number
    tool: string
    composite?: string | null
    params: StrokeParams
    points: number[]
    replace?: boolean
  }
  | { kind: 'stroke-end', surfaceId: number, clientId: string }
  | { kind: 'adjust', uid: string, adjust: unknown }

/** Somebody else in the room. Nobody ever is; `id` is all `useLiveStrokes` reads. */
export interface SwarmPeer {
  id: string
}

/**
 * Tell the room what this hand is doing — `useLiveStrokes`, while a stroke is
 * being drawn, so a collaborator sees it before it lands. There is no room.
 */
export function sendLive (_workspace: string, _live: SwarmLive) {}

/** Hear somebody else's hand. Nobody's ever arrives; returns the unsubscribe. */
export function onSwarmLive (_listener: (workspace: string, from: string, live: SwarmLive) => void): () => void {
  return () => {}
}

/**
 * The room, as the web build's `useSwarm()` answers for it — reduced to what a
 * ported file reads: `peers`, which `useLiveStrokes` watches to drop the strokes
 * of somebody who left mid-gesture. Always empty.
 */
const nobody = computed<SwarmPeer[]>(() => [])

export function useSwarm () {
  return { peers: nobody }
}
