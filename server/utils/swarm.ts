/**
 * The window, as the one peer an agent's errands can reach — desktop.
 *
 * In the web build this file is the signalling server: a websocket room per
 * workspace, every tab in it a peer saying which scans it holds, and the MCP
 * server's two errands (`relay.ts`, `reading.ts`) are asks sent down one of
 * those sockets to a tab holding the page. Here there is no room and no
 * socket, and one window — but the errands are the same errands, and
 * `errand.ts`, `relay.ts` and `reading.ts` are the web build's files. So this
 * keeps the shape they read, `swarmState`, with the window standing in it:
 *
 * - **One peer per workspace the window has open, and at most one workspace.**
 *   The workspace page says which scans it holds (`mcp:have`, from
 *   `useHolding`); that is the peer's `have`, and an empty list takes it out.
 *   A chapter that is not open is held by nobody, which is what the web build's
 *   server says when every tab is closed — and what the tools already explain.
 * - **Its "socket" is the window's IPC.** `send` hands the frame to the
 *   renderer with the workspace it was asked under, so the window can refuse an
 *   errand that arrives for a chapter it has just left — the race the web
 *   build's per-room socket closed by being per room.
 * - **The answers come back as the web build's do**, as requests to
 *   `/api/workspaces/:id/relay/:request` and `/reading/:request` — rows in
 *   `electron/data.ts` here — and settle the errand there.
 *
 * Pinned on `globalThis` as the web build pins its own, though here nothing
 * re-imports it while it lives; kept so `errand.ts` reads it the same way.
 */

/** Somebody in a workspace who can be asked for a page — here, only ever the window. */
export interface SwarmPeer {
  id: string
  /** Content hashes this peer says it can serve. */
  have: string[]
}

/** What a frame is sent down. The web build's is a crossws `Peer`. */
export interface SwarmSocket {
  send: (frame: string) => void
}

/**
 * What the server asks a peer to do — the web build's two errands, from its
 * `server/utils/swarm.ts`, which explains both. Nothing else crosses here.
 */
export type SwarmServerMessage =
  | {
    type: 'render'
    request: string
    hash: string
    maxEdge: number
    quality: number
    region: { x: number, y: number, w: number, h: number } | null
  }
  | { type: 'read', request: string, hashes: string[], pageIds: number[] }
  /** Go and re-read this much; an agent edited it. See `announce`. */
  | { type: 'changed', change: SwarmChange }

export interface SwarmState {
  /** workspace publicId -> peer id -> what they hold. */
  swarms: Map<string, Map<string, SwarmPeer>>
  /** peer id -> where a frame for them goes. */
  sockets: Map<string, SwarmSocket>
  /**
   * What the window has open — the chapter, and the page on screen by its row
   * id (null until the page has a row). Desktop only: a tab in the web build is
   * one of many, and nothing there asks which one is "the" open chapter. Here
   * it is what lets an agent work on "this chapter" and "this page" without an
   * id (`server/mcp/index.ts`).
   */
  active: { publicId: string, pageId: number | null } | null
}

export const swarmState: SwarmState = ((globalThis as { __kemolateSwarm?: SwarmState }).__kemolateSwarm ??= {
  swarms: new Map(),
  sockets: new Map(),
  active: null,
})

/** The window's peer id in a workspace's room. One per room, so a frame knows which room it was for. */
const peerIn = (publicId: string) => `window:${publicId}`

/**
 * Say what the window holds, replacing whatever it held before.
 *
 * One workspace at a time, because that is what the window shows: opening
 * another chapter is leaving this one, and a page of the chapter left behind
 * can no longer be shown to anybody. `null` is the window in no workspace —
 * the list, or a reload under way. A workspace with no hashes yet (its pages
 * absent, or still being hashed) keeps the window in its room all the same:
 * nothing can be shown from it, but an agent's changes are still news to it.
 *
 * `pageId` is the page on screen, by its row — see `SwarmState.active`.
 */
export function hold (
  publicId: string | null,
  have: string[],
  send: (publicId: string, frame: string) => void,
  pageId: number | null = null,
): void {
  swarmState.swarms.clear()
  swarmState.sockets.clear()
  swarmState.active = publicId ? { publicId, pageId } : null

  if (!publicId) return

  const id = peerIn(publicId)

  swarmState.swarms.set(publicId, new Map([[id, { id, have }]]))
  swarmState.sockets.set(id, { send: (frame: string) => send(publicId, frame) })
}

/**
 * One room's change notice — the web build's union, from its
 * `server/utils/swarm.ts`. The window has its own copy (`useSwarm`), since the
 * window's project does not reach `server/utils`.
 */
export type SwarmChange =
  | { scope: 'pages' }
  | { scope: 'blocks', pageId: number }
  | { scope: 'translations', pageId: number, locale: string }
  | { scope: 'strokes', surfaceId: number, pageId: number, key: string }
  | { scope: 'layers' }
  | { scope: 'cast' }
  | { scope: 'glossary', locale: string }
  | { scope: 'repairs', pageId: number }

/**
 * Tell the window that some of a workspace's record has changed — the web
 * build's `announce`, to a room of one. Called by `notify` only for a change an
 * agent made (`server/services/access.ts`): the window's own writes already
 * brought their answer back to it, and the web build spares the author too.
 *
 * Best effort, as there. A window that has gone sees the change when it opens
 * the chapter again.
 */
export function announce (publicId: string, change: SwarmChange): void {
  const room = swarmState.swarms.get(publicId)

  if (!room) return

  const frame = JSON.stringify({ type: 'changed', change } satisfies SwarmServerMessage)

  for (const id of room.keys()) {
    try {
      swarmState.sockets.get(id)?.send(frame)
    } catch {
      // A window on its way out.
    }
  }
}
