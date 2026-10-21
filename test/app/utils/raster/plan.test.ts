import { describe, expect, it } from 'vitest'

import { fitLevel, fittedHeight, TILE, tilesFor } from '~/utils/raster/plan'

/**
 * What of a scan the page canvas draws, at what resolution.
 *
 * The report: flicking through a chapter of 3732 × 5197 pages stalled for
 * 100–220 ms a turn, the browser decoding each whole scan on the main thread
 * for a picture shown a third of its size. The page is now drawn from a fit
 * level — the page at its laid-out size — and tiles cut from the full decode
 * only once a zoom asks for more. These are the rules for which is which.
 *
 * Seam: the pure functions in `utils/raster/plan`, in scan pixels.
 */

/** The chapter that prompted it: one of its 38 full-size pages. */
const PAGE = { width: 3732, height: 5197 }

describe('the fit level', () => {
  it('is the page at its laid-out size, in device pixels', () => {
    // 1169 CSS pixels tall at DPR 2 — the page as the board lays it out.
    expect(fitLevel(PAGE, 1169, 2)).toEqual({ width: 1679, height: 2338 })
  })

  it('is never larger than the scan', () => {
    expect(fitLevel({ width: 800, height: 1200 }, 1169, 2)).toEqual({ width: 800, height: 1200 })
  })

  it('fits the same room the board lays the page out in', () => {
    // A tall room: the width runs out first.
    expect(fittedHeight({ w: 1000, h: 3000 }, 0.5)).toBe((1000 - 48) / 0.5)
    // A wide room: the height does.
    expect(fittedHeight({ w: 3000, h: 1000 }, 0.5)).toBe(1000 - 48)
    // Never below the floor, however small the room.
    expect(fittedHeight({ w: 10, h: 10 }, 0.5)).toBe(120)
  })
})

describe('tiles', () => {
  const fit = fitLevel(PAGE, 1169, 2)
  const whole = { x: 0, y: 0, w: PAGE.width, h: PAGE.height }

  it('are not cut while the fit level has pixels enough', () => {
    // The page at its fit: the fit level is exactly as dense as the screen.
    expect(tilesFor(PAGE, whole, fit.width / PAGE.width, fit)).toEqual([])
  })

  it('come at the coarsest level that is still dense enough', () => {
    // The fit level has 0.45 device pixels per scan pixel. Just past that, the
    // half level is enough; past a half, only the scan's own pixels are.
    expect(new Set(tilesFor(PAGE, whole, 0.48, fit).map((tile) => tile.scale))).toEqual(new Set([0.5]))
    expect(new Set(tilesFor(PAGE, whole, 0.6, fit).map((tile) => tile.scale))).toEqual(new Set([1]))
  })

  it('are the scan itself from 1:1 on, and never finer', () => {
    const tiles = tilesFor(PAGE, { x: 1000, y: 1000, w: 500, h: 500 }, 8, fit)

    expect(tiles.every((tile) => tile.scale === 1)).toBe(true)
    expect(tiles.every((tile) => tile.width === tile.sw && tile.height === tile.sh)).toBe(true)
  })

  it('cover the view and nothing far outside it', () => {
    const view = { x: 1500, y: 2500, w: 600, h: 900 }
    const tiles = tilesFor(PAGE, view, 2, fit)

    // Every point of the view is inside some tile.
    for (const [x, y] of [[view.x, view.y], [view.x + view.w - 1, view.y + view.h - 1], [1800, 2950]] as const) {
      expect(tiles.some((tile) => x >= tile.sx && x < tile.sx + tile.sw && y >= tile.sy && y < tile.sy + tile.sh)).toBe(true)
    }

    // And each tile touches it.
    for (const tile of tiles) {
      expect(tile.sx < view.x + view.w && tile.sx + tile.sw > view.x).toBe(true)
      expect(tile.sy < view.y + view.h && tile.sy + tile.sh > view.y).toBe(true)
    }
  })

  it('are cut short at the page edge rather than past it', () => {
    const tiles = tilesFor(PAGE, whole, 1, fit)

    for (const tile of tiles) {
      expect(tile.sx + tile.sw).toBeLessThanOrEqual(PAGE.width)
      expect(tile.sy + tile.sh).toBeLessThanOrEqual(PAGE.height)
      expect(tile.width).toBeLessThanOrEqual(TILE)
    }

    // The whole page at 1:1 is a grid of four by six.
    expect(tiles).toHaveLength(Math.ceil(PAGE.width / TILE) * Math.ceil(PAGE.height / TILE))
  })
})
