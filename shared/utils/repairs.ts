/**
 * Cleaned balloons kept on the server — the rules both sides have to agree on.
 *
 * A repair is the artwork under one block with its lettering painted out, made
 * in the browser by an inpainter (see `app/utils/ocr/clean.ts`). For a cloud
 * workspace it is also kept on the server, which is the one kind of picture the
 * server holds that came from a page: see the invariant in CLAUDE.md, rewritten
 * for exactly this. The page itself still never goes up.
 *
 * Here rather than in either half because the server refuses what the browser
 * must not send, and a rule written twice is two rules the day one of them is
 * edited.
 */
import type { Rect } from './raster'

/** One repair as the server lists it. */
export interface RepairRow {
  /** The recipe it was made from — `patchKey`, and the name the browser files it under. */
  key: string
  /** SHA-256 of the PNG's bytes, which is what it is fetched by. */
  hash: string
  pageId: number
  /** The block it was made for, while that block exists. */
  blockId: number | null
  /** The block's box when it was made, in page pixels — the rectangle it repairs. */
  from: Rect
  /** Where the image is laid: `from` padded, in page pixels. */
  box: Rect
  /** Seconds since the epoch. The newest repair for a block is the one it shows. */
  createdAt: number
}

/**
 * What a `patchKey` looks like: the scan's hash prefix, the box, the model, the
 * mask recipe, and optionally the segmenter and a corrections fingerprint.
 *
 * Checked on the server so a key is a name and never a path; the rest of what
 * it says is the browser's business.
 */
export const REPAIR_KEY = /^[0-9a-f]{16}-\d+-\d+-\d+-\d+-(?:aot|lama|migan)-m\d+(?:-seg)?(?:-e[0-9a-z]+)?$/

/** A SHA-256, hex — the only thing a stored repair is ever named by. */
export const REPAIR_HASH = /^[0-9a-f]{64}$/

/**
 * The largest repair accepted.
 *
 * A repair is a balloon, not a page: they measure in tens of kilobytes. Eight
 * megabytes is room for a full-width caption strip on a very large scan and
 * nowhere near room for a page, which is the point of having a limit at all.
 */
export const MAX_REPAIR_BYTES = 8 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

/** Whether these bytes start the way every PNG does. Repairs are only ever PNG. */
export function isPng (bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

/** A rectangle out of `x,y,w,h`, or null for anything that is not four finite numbers. */
export function parseRect (text: string | null | undefined): Rect | null {
  const parts = (text ?? '').split(',').map(Number)

  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null

  const [x, y, w, h] = parts as [number, number, number, number]

  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/**
 * Which of the server's repairs a block should show.
 *
 * By recipe first, in the order given — the caller puts what the current
 * settings would make first, as `restoreKeys` does for this browser's own files.
 *
 * Then the newest repair made for this block, whatever box it was cut for. That
 * second step is what the server's record makes possible and a key never could:
 * a repair is named by the box it was made for, so a block moved or resized
 * after cleaning asks for a name nobody ever made and came back bare. The row
 * says which block it belongs to and where it goes, so the repair is found and
 * laid over the artwork it was cut from — exactly where it sat before the
 * reload. See `patchStands` for why that is the right place for it.
 */
export function repairFor (rows: readonly RepairRow[], keys: readonly string[], blockId: number | null): RepairRow | null {
  for (const key of keys) {
    const found = rows.find((row) => row.key === key)

    if (found) return found
  }

  if (blockId === null) return null

  let newest: RepairRow | null = null

  for (const row of rows) {
    if (row.blockId === blockId && (!newest || row.createdAt > newest.createdAt)) newest = row
  }

  return newest
}
