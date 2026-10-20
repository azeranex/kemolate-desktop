/**
 * A cloud workspace's marks, one request at a time — a stand-in.
 *
 * In the web build these are `$fetch` calls on the server's surface and stroke
 * endpoints: the mask brush's path to the server, and the undo of a mask
 * correction that is already there. Every one of them is about a *cloud*
 * workspace, and the desktop app has none — a local workspace's strokes live
 * in this machine's stroke log (`usePaintCache`), under negative ids, and
 * `useUndo` takes those back itself without ever calling here.
 *
 * So the signatures are the web build's, kept so the files that import them
 * are carried across unchanged, and the answers are the ones those callers
 * already treat as "the server would not": `null` for nothing found, `false`
 * for nothing changed. When the local database arrives (`server/database`),
 * these become its calls.
 */
import type { PlateId } from '#shared/utils/layers'
import type { Stroke, StrokeParams } from '~~/server/database'

/** A mark on its way to a surface, in the shape the endpoint takes. */
export interface StrokeDraft {
  /** The client's own clock, not a timestamp. */
  seq: number
  clientId: string
  tool: string
  composite?: string | null
  params: StrokeParams
  /** Flat `x y` pairs in page pixels. */
  points: number[]
  x: number
  y: number
  w: number
  h: number
}

/** Which layer row a surface hangs off. */
export interface StrokeLayer {
  /** A stack row's id, for anything that is not a plate — a blank sheet. */
  layerId?: number | null
  /** One of the five a page is made of — its row is made on demand. */
  plate?: PlateId | null
}

export async function resolveSurface (
  _workspace: string,
  _where: { pageId: number, layer: StrokeLayer, key: string, blockId?: number | null },
): Promise<number | null> {
  return null
}

export async function strokesOn (_workspace: string, _surfaceId: number): Promise<Stroke[] | null> {
  return null
}

export async function appendStroke (_workspace: string, _surfaceId: number, _draft: StrokeDraft): Promise<Stroke | null> {
  return null
}

export async function retractStroke (_workspace: string, _strokeId: number, _retracted = true): Promise<boolean> {
  return false
}
