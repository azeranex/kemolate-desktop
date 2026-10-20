/**
 * The bitmaps the page canvas has been given, kept between draws.
 *
 * Module-level on purpose: the canvas is remade whenever the board is, and the
 * pages either side of the one on screen are decoded before any canvas shows
 * them. Both of those want the bitmaps to outlive the component.
 *
 * Bounded both ways. Fit levels are kept for the page on screen and its two
 * neighbours and nothing else — `keepFits` — which is about 80 MB at the
 * largest pages measured, against the 234 MB the three full decodes used to
 * be. Tiles are kept to a byte budget, oldest first out, and every tile of a
 * page goes when the page does: a tile is only ever wanted by a zoom into the
 * page on screen.
 */
import { release } from './engine/gpu'

/** A page drawn whole at one size. */
export interface Fit {
  width: number
  height: number
  bitmap: ImageBitmap
}

const fits = new Map<string, Fit>()

/** The fit level held for this scan, whatever size it was made at. */
export function fitOf (key: string): Fit | undefined {
  return fits.get(key)
}

/** Keep a fit level for this scan, in place of any it had. */
export function holdFit (key: string, fit: Fit) {
  const old = fits.get(key)

  if (old && old.bitmap !== fit.bitmap) release(old.bitmap)
  fits.set(key, fit)
}

/** Let go of every fit level but these scans'. */
export function keepFits (keys: Set<string>) {
  for (const [key, fit] of fits) {
    if (keys.has(key)) continue

    release(fit.bitmap)
    fits.delete(key)
  }
}

/** What the tiles may hold between them. About 16 tiles of 1024². */
const TILE_BUDGET = 64 * 1024 * 1024

const tiles = new Map<string, { bitmap: ImageBitmap, bytes: number }>()
let tileBytes = 0

const tileKey = (key: string, id: string) => `${key}|${id}`

export function tileOf (key: string, id: string): ImageBitmap | undefined {
  const name = tileKey(key, id)
  const held = tiles.get(name)

  if (!held) return undefined

  // Most recently drawn last, so the budget lets the oldest go first.
  tiles.delete(name)
  tiles.set(name, held)

  return held.bitmap
}

export function holdTile (key: string, id: string, bitmap: ImageBitmap) {
  const name = tileKey(key, id)

  dropTile(name)

  const bytes = bitmap.width * bitmap.height * 4

  tiles.set(name, { bitmap, bytes })
  tileBytes += bytes

  for (const [oldest] of tiles) {
    if (tileBytes <= TILE_BUDGET || oldest === name) break

    dropTile(oldest)
  }
}

function dropTile (name: string) {
  const held = tiles.get(name)

  if (!held) return

  release(held.bitmap)
  tiles.delete(name)
  tileBytes -= held.bytes
}

/** Every picture held, let go of — a GPU device lost takes the textures they had become. */
export function dropHeld () {
  keepFits(new Set())

  for (const name of [...tiles.keys()]) dropTile(name)
}

/** Every tile but this scan's. */
export function keepTilesOf (key: string) {
  for (const name of [...tiles.keys()]) {
    if (!name.startsWith(`${key}|`)) dropTile(name)
  }
}
