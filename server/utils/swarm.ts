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
 * - **One peer per tab.** Every tab of the window is a page of its own, and
 *   says which chapter it has open and which scans of it it holds (`mcp:have`,
 *   from `useHolding`); that is the peer's `have`, in that chapter's room, and
 *   a tab in no chapter is in no room. A chapter open in no tab is held by
 *   nobody, which is what the web build's server says when every tab is closed
 *   — and what the tools already explain. A chapter is open in one tab at most
 *   (`electron/tabs.ts`), but nothing here depends on it: a room of two is the
 *   web build's ordinary case.
 * - **Its "socket" is that tab's IPC.** `send` hands the frame to the tab's
 *   renderer with the workspace it was asked under, so the tab can refuse an
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
    /** Desktop: the page as lettered — the window's export of it — rather than the scan. */
    lettered?: boolean
  }
  | { type: 'read', request: string, hashes: string[], pageIds: number[] }
  /** Desktop: how each line on a page is fitted — see `server/utils/fits.ts`. */
  | { type: 'fits', request: string, hash: string }
  /** Desktop: clean these blocks of a page — see `server/utils/cleaning.ts`. */
  | { type: 'clean', request: string, hash: string, blockIds: number[] }
  /** Go and re-read this much; an agent edited it. See `announce`. */
  | { type: 'changed', change: SwarmChange }

export interface SwarmState {
  /** workspace publicId -> peer id -> what they hold. */
  swarms: Map<string, Map<string, SwarmPeer>>
  /** peer id -> where a frame for them goes. */
  sockets: Map<string, SwarmSocket>
  /**
   * What the tab on screen has open — the chapter, and the page on screen by
   * its row id (null until the page has a row). Desktop only: a tab in the web
   * build is one of many, and nothing there asks which one is "the" open
   * chapter. Here it is what lets an agent work on "this chapter" and "this
   * page" without an id (`server/mcp/index.ts`). The other tabs' chapters are
   * still open, and answer anything asked of them by id — see `tabs`.
   */
  active: { publicId: string, pageId: number | null } | null
  /** Desktop: every tab that is in a chapter, by tab id — what `openChapters` lists. */
  tabs: Map<string, TabRecord>
  /** Desktop: the tab on screen, whether or not it is in a chapter. */
  focused: string | null
  /**
   * Desktop: how a chapter is opened in a tab — the main process's `Tabs`, set
   * once the window exists (`opensTabs` in `electron/mcp.ts`). Null while there
   * is no window to open one in. See `open_workspace`.
   */
  opener: Opener | null
}

/**
 * Open a chapter in a tab, or find the tab it is already open in — put on
 * screen if `show`, else left behind the one the reader is looking at. Null
 * where there is no window to open it in.
 */
export type Opener = (publicId: string, show: boolean) => { already: boolean } | null

/** One tab's chapter, what it holds of it, and where its frames go. */
export interface TabRecord {
  publicId: string
  pageId: number | null
  have: string[]
  send: (publicId: string, frame: string) => void
}

export const swarmState: SwarmState = ((globalThis as { __kemolateSwarm?: SwarmState }).__kemolateSwarm ??= {
  swarms: new Map(),
  sockets: new Map(),
  active: null,
  tabs: new Map(),
  focused: null,
  opener: null,
})

/** A tab's peer id. One per tab, so a frame knows which tab it was for. */
export const peerOf = (tab: string) => `tab:${tab}`

/** The rooms, the sockets and `active`, made again from the tabs — the one place they are written. */
function rebuild (): void {
  swarmState.swarms.clear()
  swarmState.sockets.clear()

  for (const [tab, record] of swarmState.tabs) {
    const id = peerOf(tab)
    const room = swarmState.swarms.get(record.publicId) ?? new Map<string, SwarmPeer>()

    room.set(id, { id, have: record.have })
    swarmState.swarms.set(record.publicId, room)
    swarmState.sockets.set(id, { send: (frame: string) => record.send(record.publicId, frame) })
  }

  const focused = swarmState.focused ? swarmState.tabs.get(swarmState.focused) : undefined

  swarmState.active = focused ? { publicId: focused.publicId, pageId: focused.pageId } : null
}

/**
 * Say what one tab holds, replacing whatever it held before.
 *
 * One workspace per tab, because that is what a tab shows: opening another
 * chapter in it is leaving this one, and a page of the chapter left behind can
 * no longer be shown from it. `null` is the tab in no workspace — the list, a
 * reload under way, the tab closed. A workspace with no hashes yet (its pages
 * absent, or still being hashed) keeps the tab in its room all the same:
 * nothing can be shown from it, but an agent's changes are still news to it.
 *
 * `pageId` is the page on screen in that tab, by its row — see `SwarmState.active`.
 */
export function holdIn (
  tab: string,
  publicId: string | null,
  have: string[],
  send: (publicId: string, frame: string) => void,
  pageId: number | null = null,
): void {
  if (publicId) swarmState.tabs.set(tab, { publicId, pageId, have, send })
  else swarmState.tabs.delete(tab)

  rebuild()
}

/** The tab now on screen — whose chapter "the open chapter" means. */
export function focusTab (tab: string | null): void {
  swarmState.focused = tab
  rebuild()
}

/**
 * One window with one tab, as the app was before tabs: every other tab
 * forgotten. The tests speak to the app this way.
 */
export function hold (
  publicId: string | null,
  have: string[],
  send: (publicId: string, frame: string) => void,
  pageId: number | null = null,
): void {
  swarmState.tabs.clear()
  swarmState.focused = 'window'
  holdIn('window', publicId, have, send, pageId)
}

/** Every chapter open in a tab, and whether it is the one on screen. */
export function openChapters (): { publicId: string, pageId: number | null, focused: boolean }[] {
  const seen = new Map<string, { publicId: string, pageId: number | null, focused: boolean }>()

  for (const [tab, record] of swarmState.tabs) {
    const focused = tab === swarmState.focused

    if (!seen.has(record.publicId) || focused) seen.set(record.publicId, { publicId: record.publicId, pageId: record.pageId, focused })
  }

  return [...seen.values()]
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
  // Desktop: the workspace's own record — its standard lettering size, for one.
  | { scope: 'workspace' }

/**
 * Tell the tabs that have a workspace open that some of its record has changed
 * — the web build's `announce`. Called by `notify` only for a change an
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
