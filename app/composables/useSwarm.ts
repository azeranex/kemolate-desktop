/**
 * The swarm — a stand-in, because the desktop app shares nothing peer to peer.
 *
 * In the web build this is the WebRTC side of sharing a workspace. The one
 * thing the migrated files ask of it is `peerHeader`, which marks a request to
 * the server as coming from this tab's peer so the server does not echo it
 * back; with no socket for the workspace the web build answers `{}`, and so
 * does this, always. The live-stroke half below is the same: a hand drawing is
 * told to nobody and hears from nobody.
 *
 * What is real here is the part of the swarm an agent reaches. The web build's
 * MCP server asks a tab holding a scan to show it (`render`) or to read it
 * (`read`), and tells every tab what an agent changed (`changed`) — all down
 * the room's socket. Here the same frames come from the main process
 * (`electron/mcp.ts`, `server/utils/swarm.ts`) over the bridge, and are handled
 * as the web build's `handle` handles them; the window says which scans it
 * holds through `holdScans`, called by `useHolding`.
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
  | { scope: 'repairs', pageId: number }
  // Desktop: the workspace's own record — its standard lettering size, for one.
  | { scope: 'workspace' }

/**
 * What the main process asks of the window on an agent's behalf — the web
 * build's `SwarmServerMessage`, the three kinds that reach here. See
 * `server/utils/swarm.ts`.
 */
export type SwarmServerMessage =
  | {
    type: 'render'
    request: string
    hash: string
    maxEdge: number
    quality: number
    region: { x: number, y: number, w: number, h: number } | null
    /** The page as lettered, rather than the scan — see `useLetteringErrands`. */
    lettered?: boolean
  }
  | { type: 'read', request: string, hashes: string[], pageIds: number[] }
  | { type: 'fits', request: string, hash: string }
  | { type: 'clean', request: string, hash: string, blockIds: number[] }
  | { type: 'changed', change: SwarmChange }

const changeListeners = new Set<(room: string, change: SwarmChange) => void>()

/**
 * Hear a change somebody else made to a workspace — here, only ever an agent
 * over MCP; the window's own writes are not told back to it. Taken off the list
 * when the caller's scope ends, as the web build's is. Returns the unsubscribe.
 */
export function onSwarmChange (listener: (room: string, change: SwarmChange) => void): () => void {
  changeListeners.add(listener)

  const off = () => changeListeners.delete(listener)

  if (getCurrentScope()) onScopeDispose(off)

  return off
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

/** A job the server is asking this window to do — see `SwarmServerMessage`. */
export type ErrandListener = (
  workspace: string,
  errand: Extract<SwarmServerMessage, { type: 'read' }>,
) => void

/**
 * Who is willing to read pages on an agent's behalf — the web build's: the
 * frame is handed on rather than done here, because reading needs the open
 * chapter and the OCR, which `useReadErrands` has and a bridge callback does
 * not. Nothing is queued.
 */
const hands = new Set<ErrandListener>()

export function onSwarmErrand (listener: ErrandListener): () => void {
  hands.add(listener)

  const off = () => hands.delete(listener)

  if (getCurrentScope()) onScopeDispose(off)

  return off
}

/** A lettering job the server asks of this window — a picture of the page as lettered, or its fits. */
export type LetterErrand = Extract<SwarmServerMessage, { type: 'fits' }> | Extract<SwarmServerMessage, { type: 'render' }>

/**
 * Who answers an agent's questions about the lettering — `useLetteringErrands`,
 * for the reason `hands` above exists: the page as lettered and how each line
 * is fitted need the open chapter and its composables, which this module does
 * not have.
 */
const letterers = new Set<(workspace: string, errand: LetterErrand) => void>()

export function onLetterErrand (listener: (workspace: string, errand: LetterErrand) => void): () => void {
  letterers.add(listener)

  const off = () => letterers.delete(listener)

  if (getCurrentScope()) onScopeDispose(off)

  return off
}

/** Hand a lettering job on, best effort, as a read is handed on. */
function toLetterers (workspace: string, errand: LetterErrand) {
  for (const letterer of letterers) {
    try {
      letterer(workspace, errand)
    } catch (error) {
      console.warn('[kemolate] a lettering errand failed:', error)
    }
  }
}

/** Desktop: blocks the server asks this window to clean — see `useCleanErrands`. */
export type CleanErrand = Extract<SwarmServerMessage, { type: 'clean' }>

/** Who cleans for an agent — `useCleanErrands`, which has the open chapter's cleaner. */
const cleaners = new Set<(workspace: string, errand: CleanErrand) => void>()

export function onCleanErrand (listener: (workspace: string, errand: CleanErrand) => void): () => void {
  cleaners.add(listener)

  const off = () => cleaners.delete(listener)

  if (getCurrentScope()) onScopeDispose(off)

  return off
}

/** The workspace the window holds pages of, and those pages by hash — see `holdScans`. */
let holding: { workspace: string, files: Map<string, File> } | null = null

/**
 * Say which scans the window holds — the web build's `have`, sent when a room
 * is joined and whenever the inventory changes. `null` is holding nothing: the
 * workspace page has gone. `pageId` is the page on screen, by its row, so an
 * agent can be asked about "this page". Best effort: a main process that did not hear it
 * answers an agent that nobody is holding the page, which is what it says when
 * no chapter is open.
 */
export function holdScans (workspace: string | null, files: Map<string, File>, pageId: number | null = null) {
  holding = workspace ? { workspace, files } : null

  window.kemolate?.mcp.have(workspace, workspace ? [...files.keys()] : [], pageId).catch(() => {})
}

/**
 * Show a page to an agent — the web build's `render`: a bounded rendition made
 * for the asking, posted to the relay row (`electron/data.ts`), which hands it
 * straight on. Silent about everything, as there: a hash not held here, or an
 * answer that arrives late, is nobody's fault.
 */
async function render (workspace: string, ask: Extract<SwarmServerMessage, { type: 'render' }>) {
  const file = holding?.workspace === workspace ? holding.files.get(ask.hash) : undefined

  if (!file) return

  const made = await renditionOf(file, ask.maxEdge, ask.quality, ask.region).catch(() => null)

  if (!made) return

  await $fetch(`/api/workspaces/${workspace}/relay/${ask.request}`, {
    method: 'POST',
    body: made.blob,
    // Desktop: the type as a query — `$fetch` carries no headers over the bridge.
    query: { type: made.blob.type || 'image/jpeg' },
  }).catch(() => {})
}

function handle (workspace: string, payload: SwarmServerMessage) {
  if (payload.type === 'render' && payload.lettered) {
    toLetterers(workspace, payload)
  } else if (payload.type === 'render') {
    // Not awaited, as in the web build: `render` swallows its own failures.
    render(workspace, payload)
  } else if (payload.type === 'fits') {
    // With nobody to measure, said so at once rather than left to time out.
    if (!letterers.size) {
      $fetch(`/api/workspaces/${workspace}/fits/${payload.request}`, {
        method: 'POST',
        body: { ok: false, error: 'Kemolate has no chapter open to measure.' },
      }).catch(() => {})
    }

    toLetterers(workspace, payload)
  } else if (payload.type === 'clean') {
    // With nobody to clean, said so at once rather than left to time out.
    if (!cleaners.size) {
      $fetch(`/api/workspaces/${workspace}/clean/${payload.request}`, {
        method: 'POST',
        body: { ok: false, error: 'Kemolate has no chapter open to clean.' },
      }).catch(() => {})
    }

    for (const cleaner of cleaners) {
      try {
        cleaner(workspace, payload)
      } catch (error) {
        console.warn('[kemolate] a cleaning errand failed:', error)
      }
    }
  } else if (payload.type === 'read') {
    // With nobody to hand it to, said so at once — see the web build's `handle`.
    if (!hands.size) {
      $fetch(`/api/workspaces/${workspace}/reading/${payload.request}`, {
        method: 'POST',
        body: { ok: false, error: 'Kemolate has no chapter open to read with.' },
      }).catch(() => {})
    }

    for (const hand of hands) {
      try {
        hand(workspace, payload)
      } catch (error) {
        console.warn('[kemolate] an errand listener failed:', error)
      }
    }
  } else if (payload.type === 'changed') {
    for (const listener of changeListeners) {
      try {
        listener(workspace, payload.change)
      } catch (error) {
        console.warn('[kemolate] a change listener failed:', error)
      }
    }
  }
}

// Once, for the window's life — the bridge is the room's socket. Absent in a
// plain browser and in the tests, where nothing ever arrives.
if (typeof window !== 'undefined') {
  window.kemolate?.mcp?.onFrame((workspace, frame) => {
    try {
      handle(workspace, JSON.parse(frame) as SwarmServerMessage)
    } catch (error) {
      console.warn('[kemolate] an unreadable frame from the MCP server:', error)
    }
  })
}
